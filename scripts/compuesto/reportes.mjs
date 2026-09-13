// FASE 22 · Reportes por día comercial (America/Lima) y sucursal.
// Corre dentro del ENSAYO COMPUESTO: esquema real de las 153 migraciones de
// producción + P1 + _p2_a. Nada de andamio a mano.
//
// Siembra: como postgres con session_replication_role=replica (sin triggers ni
// FKs) para fijar exactamente fechas, costos y descuentos; business_date se
// calcula con la MISMA expresión que el trigger de P0.2. Consultas de negocio:
// como `authenticated` con un JWT realista. Todo en una transacción que se
// deshace al final.
//
// La sesión se fija en UTC, como producción. Con la definición anterior de
// reportes_avanzados_admin, los casos M1/M2 y el margen fallan.
import crypto from 'node:crypto'

const ids = () => crypto.randomUUID()
const n = (v) => Number(v)
const cerca = (a, b) => Math.abs(n(a) - n(b)) < 0.005

export default async function ({ db, comprobar }) {
  const q = (sql, p) => db.query(sql, p)
  await q('begin')
  await q(`set local timezone = 'UTC'`)
  await q(`set local session_replication_role = replica`)

  const L1 = ids(), L2 = ids(), uA = ids(), uV = ids(), sA = ids(), sV = ids(), cat = ids()
  const P = ids(), PT = ids(), V = ids(), VT = ids()
  await q(`insert into auth.users(id) values ($1), ($2)`, [uA, uV])
  await q(`insert into public.locations(id, nombre) values ($1, 'Sede A'), ($2, 'Sede B')`, [L1, L2])
  await q(`insert into public.staff(id, nombre, username, rol, activo, user_id, location_id)
           values ($1, 'Admin Reportes', 'rep-admin', 'administrador', true, $3, $5),
                  ($2, 'Vendedor Reportes', 'rep-vend', 'vendedor', true, $4, $5)`, [sA, sV, uA, uV, L1])
  await q(`insert into public.categorias(id, nombre) values ($1, 'Celulares')`, [cat])
  await q(`insert into public.products(id, nombre, sku, categoria_id, is_test) values ($1, 'Equipo', 'EQ-1', $3, false), ($2, 'Equipo QA', 'EQ-QA', $3, true)`, [P, PT, cat])
  await q(`insert into public.product_variants(id, product_id) values ($1, $2), ($3, $4)`, [V, P, VT, PT])

  // venta(ubicación, instante con offset de Lima, líneas [cantidad, precio, descuento, costo], estado, is_test)
  const venta = async (loc, instante, lineas, { estado = 'completada', isTest = false, variante = V } = {}) => {
    const id = ids()
    const subtotal = lineas.reduce((a, [c, p, d]) => a + (p - d) * c, 0)
    const impuesto = Math.round(subtotal * 18) / 100
    await q(`insert into public.sales(id, location_id, cajero_id, fecha, business_date, subtotal, impuesto, total, estado, is_test)
             values ($1, $2, $3, $4::timestamptz, ($4::timestamptz at time zone 'America/Lima')::date, $5, $6, $7, $8, $9)`,
      [id, loc, sA, instante, subtotal, impuesto, subtotal + impuesto, estado, isTest])
    const items = []
    for (const [c, p, d, costo] of lineas) {
      const it = ids(); items.push(it)
      await q(`insert into public.sale_items(id, sale_id, variant_id, cantidad, precio_unitario, descuento, subtotal, costo_snapshot)
               values ($1, $2, $3, $4, $5, $6, $7, $8)`, [it, id, variante, c, p, d, (p - d) * c, costo])
    }
    return { id, items }
  }

  const S1 = await venta(L1, '2026-09-01 14:00-05', [[2, 50, 5, 30]])          // descuento unitario 5
  await venta(L1, '2026-09-01 20:30-05', [[1, 100, 0, 60]])                     // M1: en UTC ya es 02/09
  await venta(L2, '2026-09-01 10:00-05', [[1, 200, 0, 120]])
  await venta(L1, '2026-09-01 12:00-05', [[1, 1000, 0, 1]], { isTest: true, variante: VT })
  await venta(L1, '2026-09-01 12:30-05', [[1, 500, 0, 1]], { estado: 'anulada' })
  await venta(L1, '2026-08-31 23:30-05', [[1, 10, 0, 4]])                      // M2: en UTC ya es 01/09

  const dev = ids()
  await q(`insert into public.devoluciones(id, sale_id, location_id, motivo, creado_por, estado, monto, created_at)
           values ($1, $2, $3, 'Prueba', $4, 'completada', 45, '2026-09-01 18:00-05')`, [dev, S1.id, L1, sA])
  await q(`insert into public.devolucion_items(devolucion_id, sale_item_id, variant_id, cantidad, monto) values ($1, $2, $3, 1, 45)`,
    [dev, S1.items[0], V])

  // Cerradas: el índice único real cash_sessions_one_open_per_staff admite una sola abierta por persona.
  await q(`insert into public.cash_sessions(id, cajero_id, location_id, monto_inicial, apertura, cierre, diferencia)
           values ($1, $3, $4, 100, '2026-09-01 20:00-05', '2026-09-01 23:00-05', 5),
                  ($2, $3, $5, 100, '2026-09-01 09:00-05', '2026-09-01 13:00-05', -3)`, [ids(), ids(), sA, L1, L2])
  const O1 = ids()
  await q(`insert into public.ordenes_servicio(id, location_id, cliente_nombre, problema, estado, fecha_entrega, costo_final)
           values ($1, $3, 'Cliente', 'Pantalla', 'entregado', '2026-09-01 21:00-05', 80),
                  ($2, $4, 'Cliente', 'Batería', 'entregado', '2026-09-01 11:00-05', 50)`, [O1, ids(), L1, L2])
  await q(`insert into public.orden_servicio_repuestos(orden_id, variant_id, cantidad, costo_unitario) values ($1, $2, 1, 20)`, [O1, V])
  await q(`set local session_replication_role = origin`)

  // Ejecuta como authenticated con el JWT de `uid`. Siempre deshace el savepoint
  // (también revierte SET LOCAL ROLE). Devuelve { filas } o { error }.
  const como = async (uid, sql, params = []) => {
    await q('savepoint como')
    try {
      await q('set local role authenticated')
      await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
      const r = await q(sql, params)
      return { filas: r.rows }
    } catch (e) {
      return { error: e.message }
    } finally {
      await q('rollback to savepoint como')
    }
  }
  const comoAnon = async (sql, params = []) => {
    await q('savepoint anon')
    try {
      await q('set local role anon')
      const r = await q(sql, params)
      return { filas: r.rows }
    } catch (e) {
      return { error: e.message }
    } finally {
      await q('rollback to savepoint anon')
    }
  }
  const reporte = async (uid, args) => {
    const r = await como(uid, `select public.reportes_avanzados_admin(${args}) as r`)
    return r.error ? r : { r: r.filas[0].r }
  }

  // --- Todas las sucursales, día 01/09 -------------------------------------
  const t = await reporte(uA, `p_desde => '2026-09-01', p_hasta => '2026-09-01'`)
  comprobar('el administrador obtiene el reporte', !t.error, t.error)
  if (t.error) return
  const R = t.r.resumen
  comprobar('M1/M2 · cuenta por día comercial de Lima: 3 ventas (20:30 del 01 dentro, 23:30 del 31 fuera)',
    n(R.ventas_cantidad) === 3, `ventas_cantidad=${R.ventas_cantidad}`)
  comprobar('excluye ventas is_test y anuladas', cerca(R.ventas_total, 106.2 + 118 + 236), `ventas_total=${R.ventas_total}`)
  comprobar('D3 · el ingreso es la suma de subtotales (el descuento no se resta dos veces)', cerca(R.ingreso, 390), `ingreso=${R.ingreso}`)
  comprobar('costo histórico y margen bruto', cerca(R.costo_ventas, 240) && cerca(R.margen_bruto, 150),
    `costo=${R.costo_ventas} margen=${R.margen_bruto}`)
  comprobar('descuentos = descuento unitario × cantidad', cerca(R.descuentos, 10), `descuentos=${R.descuentos}`)
  comprobar('D5 · devoluciones del día: monto y costo devuelto', n(R.devoluciones_cantidad) === 1 && cerca(R.devoluciones_monto, 45) && cerca(R.costo_devuelto, 30),
    JSON.stringify({ c: R.devoluciones_cantidad, m: R.devoluciones_monto, k: R.costo_devuelto }))
  comprobar('D5 · ingreso neto y margen neto', cerca(R.ingreso_neto, 345) && cerca(R.margen_neto, 135),
    `ingreso_neto=${R.ingreso_neto} margen_neto=${R.margen_neto}`)
  const suc = Object.fromEntries(t.r.por_sucursal.map((x) => [x.location_id, x]))
  comprobar('por sucursal', t.r.por_sucursal.length === 2 && cerca(suc[L1]?.ventas, 224.2) && n(suc[L1]?.tickets) === 2 && cerca(suc[L2]?.ventas, 236),
    JSON.stringify(t.r.por_sucursal))
  comprobar('por categoría con subtotal neto', t.r.por_categoria.length === 1 && cerca(t.r.por_categoria[0].ventas, 390) && cerca(t.r.por_categoria[0].margen, 150),
    JSON.stringify(t.r.por_categoria))
  comprobar('D2 · taller por día comercial (entrega a las 21:00 dentro)', n(t.r.taller.ordenes) === 2 && cerca(t.r.taller.ingresos, 130) && cerca(t.r.taller.costo_repuestos, 20),
    JSON.stringify(t.r.taller))
  comprobar('D2 · cajas por día comercial (apertura a las 20:00 dentro)', t.r.cajas_por_empleado.length === 1 && n(t.r.cajas_por_empleado[0].sesiones) === 2,
    JSON.stringify(t.r.cajas_por_empleado))
  comprobar('declara la base del periodo', t.r.periodo?.base === 'business_date' && t.r.periodo?.zona_horaria === 'America/Lima')

  // --- Sucursal A ------------------------------------------------------------
  const a = await reporte(uA, `'2026-09-01', '2026-09-01', '2026-08-31', '2026-08-31', '${L1}'`)
  comprobar('D4 · filtro por sucursal', !a.error && n(a.r.resumen.ventas_cantidad) === 2 && cerca(a.r.resumen.ingreso, 190) && cerca(a.r.resumen.margen_bruto, 70) && cerca(a.r.resumen.margen_neto, 55),
    a.error || JSON.stringify(a.r.resumen))
  comprobar('D4 · la sucursal filtra también taller, cajas y el desglose',
    !a.error && n(a.r.taller.ordenes) === 1 && n(a.r.cajas_por_empleado[0]?.sesiones) === 1 && a.r.por_sucursal.length === 1,
    a.error || JSON.stringify({ taller: a.r.taller, cajas: a.r.cajas_por_empleado, suc: a.r.por_sucursal }))
  comprobar('la comparación usa el mismo filtro y el mismo día comercial (sólo la venta de las 23:30 del 31)',
    !a.error && n(a.r.comparacion?.ventas_cantidad) === 1 && cerca(a.r.comparacion?.ingreso, 10), a.error || JSON.stringify(a.r.comparacion))

  // --- Compatibilidad y validaciones ------------------------------------------
  const compat = await como(uA, `select public.reportes_avanzados_admin(p_desde => '2026-09-01', p_hasta => '2026-09-01', p_comparar_desde => null, p_comparar_hasta => null) as r`)
  comprobar('compatibilidad: la llamada vieja con 4 argumentos con nombre resuelve', !compat.error, compat.error)
  const otra = await reporte(uA, `'2026-09-01', '2026-09-01', null, null, '${ids()}'`)
  comprobar('sucursal inexistente se rechaza', /Sucursal no encontrada/.test(otra.error || ''), otra.error || 'no falló')
  const largo = await reporte(uA, `'2025-01-01', '2026-09-01'`)
  comprobar('rango de más de 367 días se rechaza', /rango máximo/i.test(largo.error || ''), largo.error || 'no falló')
  const invertido = await reporte(uA, `'2026-09-02', '2026-09-01'`)
  comprobar('rango invertido se rechaza', /Rango inválido/.test(invertido.error || ''), invertido.error || 'no falló')

  // --- Acceso ------------------------------------------------------------------
  const vend = await reporte(uV, `'2026-09-01', '2026-09-01'`)
  comprobar('un vendedor no obtiene el reporte avanzado', /Solo administración/.test(vend.error || ''), vend.error || 'no falló')
  const anon = await comoAnon(`select public.reportes_avanzados_admin('2026-09-01', '2026-09-01')`)
  comprobar('anon no puede ejecutarlo', /permission denied/i.test(anon.error || ''), anon.error || 'no falló')
  const helper = await como(uA, `select private.reporte_resumen_periodo('2026-09-01', '2026-09-01', null)`)
  comprobar('ni un administrador invoca el helper privado directamente', /permission denied/i.test(helper.error || ''), helper.error || 'no falló')

  // --- resumen_ganancias / top_productos_ganancia (SECURITY INVOKER: RLS real)
  const g = await como(uA, `select * from public.resumen_ganancias('2026-09-01T00:00:00-05:00', '2026-09-02T00:00:00-05:00')`)
  comprobar('resumen_ganancias con ventana de día comercial de Lima', !g.error && cerca(g.filas[0].total_ventas, 390) && cerca(g.filas[0].total_costo, 240) && n(g.filas[0].num_ventas) === 3,
    g.error || JSON.stringify(g.filas[0]))
  const gB = await como(uA, `select * from public.resumen_ganancias(fecha_desde => '2026-09-01T00:00:00-05:00', fecha_hasta => '2026-09-02T00:00:00-05:00', p_location_id => '${L2}')`)
  comprobar('resumen_ganancias filtra por sucursal', !gB.error && cerca(gB.filas[0].total_ventas, 200) && n(gB.filas[0].num_ventas) === 1, gB.error || JSON.stringify(gB.filas[0]))
  const gV = await como(uV, `select * from public.resumen_ganancias('2026-09-01T00:00:00-05:00', '2026-09-02T00:00:00-05:00')`)
  comprobar('resumen_ganancias no revela nada a un vendedor', !gV.error && n(gV.filas[0].num_ventas) === 0 && cerca(gV.filas[0].total_ventas, 0), gV.error || JSON.stringify(gV.filas[0]))
  const top = await como(uA, `select * from public.top_productos_ganancia(fecha_desde => '2026-09-01T00:00:00-05:00', fecha_hasta => '2026-09-02T00:00:00-05:00', lim => 5, p_location_id => '${L1}')`)
  comprobar('top_productos_ganancia filtra por sucursal y excluye productos QA',
    !top.error && top.filas.length === 1 && top.filas[0].producto_nombre === 'Equipo' && n(top.filas[0].unidades_vendidas) === 3 && cerca(top.filas[0].ingreso, 190),
    top.error || JSON.stringify(top.filas))
  const topCompat = await como(uA, `select * from public.top_productos_ganancia(fecha_desde => '2026-09-01T00:00:00-05:00', fecha_hasta => '2026-09-02T00:00:00-05:00', lim => 8)`)
  comprobar('compatibilidad: top_productos_ganancia con los argumentos viejos', !topCompat.error && topCompat.filas.length === 1, topCompat.error || JSON.stringify(topCompat.filas))
}
