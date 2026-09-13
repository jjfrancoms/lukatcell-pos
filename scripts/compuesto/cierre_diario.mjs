// P2.E · Cierre diario con verificaciones clasificadas, sobre el esquema compuesto.
//
// Sede A: caja olvidada del 08/09, conciliación pendiente, serial en
//         cuarentena, comprobante con error, stock crítico real + uno QA,
//         terminal con ventas sin sincronizar.
// Sede B: cierre normal del 09/09 con un warning → se cierra y se aprueba;
//         cierre del 08/09 con diferencia crítica → exige autorización.
import crypto from 'node:crypto'

const ids = () => crypto.randomUUID()

export default async function ({ db, comprobar }) {
  const q = (sql, p) => db.query(sql, p)
  await q('begin')
  await q(`set local session_replication_role = replica`)
  const A = ids(), B = ids(), uA = ids(), uB = ids(), sA = ids(), sB = ids(), sV = ids()
  const P = ids(), PQA = ids(), V = ids(), VQA = ids(), venta = ids()
  await q(`insert into auth.users(id) values ($1), ($2)`, [uA, uB])
  await q(`insert into public.locations(id, nombre) values ($1, 'Sede A'), ($2, 'Sede B')`, [A, B])
  await q(`insert into public.staff(id, nombre, username, rol, activo, user_id, location_id) values
           ($1, 'Admin A', 'cierre-a', 'administrador', true, $4, $6),
           ($2, 'Admin B', 'cierre-b', 'administrador', true, $5, $7),
           ($3, 'Cajero A', 'cierre-caj', 'vendedor', true, null, $6)`, [sA, sB, sV, uA, uB, A, B])
  await q(`insert into public.products(id, nombre, is_test) values ($1, 'Real', false), ($2, 'QA', true)`, [P, PQA])
  await q(`insert into public.product_variants(id, product_id) values ($1, $2), ($3, $4)`, [V, P, VQA, PQA])
  await q(`insert into public.inventory(variant_id, location_id, cantidad, stock_minimo) values ($1, $3, 1, 5), ($2, $3, 0, 5)`, [V, VQA, A])
  // Sede A
  await q(`insert into public.cash_sessions(id, cajero_id, location_id, monto_inicial, apertura) values ($1, $2, $3, 50, '2026-09-08 10:00-05')`, [ids(), sV, A])
  await q(`insert into public.sales(id, location_id, cajero_id, fecha, business_date, subtotal, impuesto, total, estado, is_test)
           values ($1, $2, $3, '2026-09-10 12:00-05', '2026-09-10', 100, 18, 118, 'completada', false)`, [venta, A, sA])
  await q(`insert into public.comprobantes_electronicos(sale_id, estado, tipo_comprobante, serie, numero) values ($1, 'error', 'boleta', 'B001', 1)`, [venta])
  await q(`insert into public.conciliaciones_pago(payment_id, sale_id, location_id, metodo, monto_esperado, estado, fecha_venta) values ($1, $2, $3, 'yape', 118, 'pendiente', '2026-09-10')`, [ids(), venta, A])
  await q(`insert into public.product_serials(variant_id, location_id, serial_number, estado) values ($1, $2, 'IMEI-CUARENTENA-1', 'cuarentena')`, [V, A])
  await q(`insert into public.pos_devices(device_id, location_id, nombre, pending_sales_count, failed_sales_count, last_seen_at, fuera_de_servicio)
           values ('caja-a-1', $1, 'Caja A1', 3, 0, now(), false)`, [A])
  // Sede B
  const ventaB = ids()
  await q(`insert into public.sales(id, location_id, cajero_id, fecha, business_date, subtotal, impuesto, total, estado, is_test)
           values ($1, $2, $3, '2026-09-09 12:00-05', '2026-09-09', 50, 9, 59, 'completada', false)`, [ventaB, B, sB])
  await q(`insert into public.conciliaciones_pago(payment_id, sale_id, location_id, metodo, monto_esperado, estado, fecha_venta) values ($1, $2, $3, 'tarjeta', 59, 'pendiente', '2026-09-09')`, [ids(), ventaB, B])
  await q(`insert into public.cash_sessions(id, cajero_id, location_id, monto_inicial, apertura, cierre, diferencia) values
           ($1, $3, $4, 50, '2026-09-09 09:00-05', '2026-09-09 18:00-05', 3),
           ($2, $3, $4, 50, '2026-09-08 09:00-05', '2026-09-08 18:00-05', 50)`, [ids(), ids(), sB, B])
  await q(`set local session_replication_role = origin`)

  const como = async (uid, sql, params = []) => {
    await q('savepoint como')
    try {
      await q('set local role authenticated')
      await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
      return { filas: (await q(sql, params)).rows }
    } catch (e) {
      return { error: e.message }
    } finally {
      await q('rollback to savepoint como')
    }
  }
  const codigos = (p) => Object.fromEntries((p.checks || []).map((c) => [c.codigo, c]))

  // --- Sede A: previsualización ------------------------------------------------
  const pv = await como(uA, `select public.previsualizar_cierre_diario('2026-09-10') as p`)
  comprobar('previsualización disponible', !pv.error, pv.error)
  if (pv.error) return
  const p = pv.filas[0].p, k = codigos(p)
  comprobar('cuenta la caja olvidada de un día anterior (antes: 0 abiertas)', p.cajas_abiertas === 1, String(p.cajas_abiertas))
  comprobar('CAJAS_ABIERTAS es P0 y bloquea el cierre', k.CAJAS_ABIERTAS?.nivel === 'P0' && k.CAJAS_ABIERTAS?.bloquea === 'cierre' && p.bloquea_cierre === true,
    JSON.stringify(k.CAJAS_ABIERTAS))
  comprobar('terminal con ventas pendientes es P0 de aprobación', k.TERMINALES_VENTAS_PENDIENTES?.nivel === 'P0' && k.TERMINALES_VENTAS_PENDIENTES?.bloquea === 'aprobacion' && p.bloquea_aprobacion === true,
    JSON.stringify(k.TERMINALES_VENTAS_PENDIENTES))
  comprobar('warnings: conciliación, comprobante, serial en revisión',
    k.CONCILIACIONES_PENDIENTES?.nivel === 'warning' && k.CONCILIACIONES_PENDIENTES.cantidad === 1
    && k.COMPROBANTES_NO_EMITIDOS?.cantidad === 1 && k.SERIALES_EN_REVISION?.cantidad === 1,
    JSON.stringify({ c: k.CONCILIACIONES_PENDIENTES, e: k.COMPROBANTES_NO_EMITIDOS, s: k.SERIALES_EN_REVISION }))
  comprobar('stock crítico no cuenta productos de prueba', p.stock_critico === 1 && k.STOCK_CRITICO?.cantidad === 1,
    JSON.stringify({ resumen: p.stock_critico, check: k.STOCK_CRITICO }))
  comprobar('sin diferencia crítica no se pide autorización', p.requiere_autorizacion === false && !k.DIFERENCIA_CRITICA)

  const antes = await como(uA, `select public.previsualizar_cierre_diario('2026-09-07') as p`)
  comprobar('una fecha anterior a la caja olvidada no la cuenta', !antes.error && !codigos(antes.filas[0].p).CAJAS_ABIERTAS, antes.error)

  const cerrarA = await como(uA, `select (public.cerrar_dia('2026-09-10', null)).id`)
  comprobar('cerrar_dia rechaza con la caja olvidada abierta (mensaje de siempre)', /No puedes cerrar el día mientras existan cajas abiertas/.test(cerrarA.error || ''), cerrarA.error || 'no falló')

  // --- Sede B: cierre y aprobación normales, con warning registrado --------------
  await q('savepoint flujo')
  let flujo
  try {
    await q('set local role authenticated')
    await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uB, role: 'authenticated' })])
    const cid = (await q(`select (public.cerrar_dia('2026-09-09', 'Cierre de prueba')).id as id`)).rows[0].id
    const snap = (await q(`select snapshot from public.cierres_diarios where id = $1`, [cid])).rows[0].snapshot
    const apr = (await q(`select to_jsonb(public.aprobar_cierre_diario($1, 'Firma Prueba')) as c`, [cid])).rows[0].c
    flujo = { snap, apr }
  } catch (e) {
    flujo = { error: e.message }
  } finally {
    await q('rollback to savepoint flujo')
  }
  comprobar('sede B: cierra y aprueba con sólo warnings', !flujo.error && flujo.apr?.estado_aprobacion === 'aprobado', flujo.error || JSON.stringify(flujo.apr?.estado_aprobacion))
  comprobar('el snapshot y el reporte final registran las verificaciones',
    !flujo.error && (flujo.snap?.checks || []).some((c) => c.codigo === 'CONCILIACIONES_PENDIENTES')
    && (flujo.apr?.reporte_final?.checks || []).some((c) => c.codigo === 'CONCILIACIONES_PENDIENTES') && flujo.apr?.conciliaciones_pendientes === 1,
    flujo.error || JSON.stringify({ snap: flujo.snap?.checks, rep: flujo.apr?.reporte_final?.checks }))

  // --- Sede B: diferencia crítica → P1 --------------------------------------------
  const pvB = await como(uB, `select public.previsualizar_cierre_diario('2026-09-08') as p`)
  comprobar('diferencia crítica es P1 y pide autorización', !pvB.error && codigos(pvB.filas[0].p).DIFERENCIA_CRITICA?.nivel === 'P1' && pvB.filas[0].p.requiere_autorizacion === true,
    pvB.error || JSON.stringify(pvB.filas?.[0]?.p?.checks))
  await q('savepoint critica')
  let critica
  try {
    await q('set local role authenticated')
    await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uB, role: 'authenticated' })])
    const cid = (await q(`select (public.cerrar_dia('2026-09-08', null)).id as id`)).rows[0].id
    await q(`select public.aprobar_cierre_diario($1, 'Firma Prueba')`, [cid])
    critica = { error: null }
  } catch (e) {
    critica = { error: e.message }
  } finally {
    await q('rollback to savepoint critica')
  }
  comprobar('aprobar con diferencia crítica sin autorización se rechaza (mensaje de siempre)', /requiere autorización operativa/.test(critica.error || ''), critica.error || 'no falló')

  const helper = await como(uA, `select private.checks_cierre_diario($1, '2026-09-10')`, [A])
  comprobar('el helper de verificaciones no es invocable directamente', /permission denied/i.test(helper.error || ''), helper.error || 'no falló')
}
