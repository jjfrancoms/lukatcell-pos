// POS · INVARIANTES DE INTEGRIDAD DEL REGISTRO
//
// Las 21 comprobaciones de la auditoría de producción del 2026-09-27, convertidas en prueba
// permanente para que ninguna migración futura pueda romper la coherencia de lo registrado.
//
// Disciplina de este módulo (regla 1 del repo: fallo CERRADO):
//   · Cada invariante se comprueba sobre un escenario POS coherente Y exige que el CENSO no esté
//     vacío: "la consulta no devolvió culpables" sobre cero filas no es un PASS, es un FAIL.
//   · Cada invariante calculado se rompe a propósito en un savepoint y se comprueba que la
//     consulta lo DETECTA. Una comprobación que no puede fallar no comprueba nada.
//   · Los invariantes sostenidos por una restricción (serial único, línea huérfana, recibir más de
//     lo pedido) se prueban intentando violarlos de verdad: deben ser RECHAZADOS.
//
// Nota de alcance: este módulo verifica el MECANISMO, no los datos históricos de producción. La
// auditoría del 2026-09-27 encontró stock sembrado sin libro y cierres de caja de prueba, que son
// decisiones de negocio y están documentados en CURRENT_EXECUTION.
import crypto from 'node:crypto'

const ids = () => crypto.randomUUID()

export default async function ({ db, comprobar }) {
  const q = (sql, p) => db.query(sql, p)
  const uno = async (sql, p) => (await q(sql, p)).rows[0]

  await q('begin')
  await q(`set local session_replication_role = replica`)

  const A = ids(), uA = ids(), sA = ids()
  const pNS = ids(), vNS = ids(), pS = ids(), vS = ids(), pNS2 = ids(), vNS2 = ids()
  const caja = ids(), venta = ids()

  await q(`insert into auth.users(id) values ($1)`, [uA])
  await q(`insert into public.locations(id, nombre) values ($1, 'Sede POS')`, [A])
  await q(`insert into public.staff(id, nombre, username, rol, activo, user_id, location_id)
           values ($1, 'Admin POS', 'pos-admin', 'administrador', true, $2, $3)`, [sA, uA, A])
  await q(`insert into public.products(id, nombre, sku, is_test, control_serial) values
           ($1, 'Accesorio POS', 'POS-NS', false, false),
           ($2, 'Equipo POS', 'POS-S', false, true)`, [pNS, pS])
  await q(`insert into public.product_variants(id, product_id) values ($1, $2), ($3, $4)`, [vNS, pNS, vS, pS])

  // Stock CON libro que lo explica: 10 unidades y un movimiento de +10. Es la forma correcta,
  // y es justo lo que a los datos históricos de producción les falta.
  await q(`insert into public.inventory(variant_id, location_id, cantidad, stock_minimo) values ($1, $2, 10, 2)`, [vNS, A])
  await q(`insert into public.inventory_movements(variant_id, location_id, cantidad_delta, motivo, staff_id)
           values ($1, $2, 10, 'Carga inicial con responsable', $3)`, [vNS, A, sA])

  // Producto con IMEI: el stock se DERIVA del catálogo de unidades (2 disponibles = 2).
  await q(`insert into public.product_serials(variant_id, location_id, serial_number, estado) values
           ($1, $2, 'POS-IMEI-1', 'disponible'), ($1, $2, 'POS-IMEI-2', 'disponible')`, [vS, A])
  // Variante SIN inventario todavía: es la que usa el alta atómica de _p4_b.
  await q(`insert into public.products(id, nombre, sku, is_test, control_serial) values ($1, 'Accesorio nuevo POS', 'POS-NS2', false, false)`, [pNS2])
  await q(`insert into public.product_variants(id, product_id) values ($1, $2)`, [vNS2, pNS2])
  await q(`insert into public.inventory(variant_id, location_id, cantidad, stock_minimo) values ($1, $2, 2, 1)`, [vS, A])

  // Venta con pago mixto que cuadra: 100 = 60 efectivo + 40 yape; total = subtotal + impuesto.
  await q(`insert into public.cash_sessions(id, cajero_id, location_id, monto_inicial, apertura)
           values ($1, $2, $3, 50, now())`, [caja, sA, A])
  await q(`insert into public.sales(id, location_id, cajero_id, cash_session_id, fecha, business_date,
             subtotal, impuesto, total, estado, is_test)
           values ($1, $2, $3, $4, now(), (now() at time zone 'America/Lima')::date, 84.75, 15.25, 100, 'completada', false)`,
    [venta, A, sA, caja])
  await q(`insert into public.sale_items(id, sale_id, variant_id, cantidad, precio_unitario, descuento, subtotal, costo_snapshot)
           values ($1, $2, $3, 1, 84.75, 0, 84.75, 40)`, [ids(), venta, vNS])
  await q(`insert into public.payments(id, sale_id, metodo, monto) values ($1, $3, 'efectivo', 60), ($2, $3, 'yape', 40)`,
    [ids(), ids(), venta])

  await q(`set local session_replication_role = origin`)

  // --------------------------------------------------------------------------------------------
  // Invariantes calculados: consulta de violaciones + censo, y rotura deliberada que debe cazarse.
  // --------------------------------------------------------------------------------------------
  const INVARIANTES = [
    {
      nombre: 'el dinero cobrado cuadra con el total de la venta',
      censo: `select count(*)::int as n from public.sales where estado='completada' and not is_test`,
      violaciones: `select count(*)::int as n from (
          select s.id, s.total, coalesce(sum(p.monto),0) as pagado from public.sales s
          left join public.payments p on p.sale_id = s.id
          where s.estado='completada' and not s.is_test group by s.id, s.total) d
        where abs(d.pagado - d.total) > 0.005`,
      romper: `update public.payments set monto = monto + 7 where sale_id = $1`, params: () => [venta],
    },
    {
      nombre: 'el total de la venta es subtotal + impuesto',
      censo: `select count(*)::int as n from public.sales where estado='completada' and not is_test`,
      violaciones: `select count(*)::int as n from public.sales
        where estado='completada' and not is_test and abs(total - (subtotal + impuesto)) > 0.005`,
      romper: `update public.sales set impuesto = impuesto + 3 where id = $1`, params: () => [venta],
    },
    {
      nombre: 'cada línea vale (precio − descuento) × cantidad',
      censo: `select count(*)::int as n from public.sale_items`,
      violaciones: `select count(*)::int as n from public.sale_items si join public.sales s on s.id = si.sale_id
        where not s.is_test and abs(si.subtotal - (si.precio_unitario - coalesce(si.descuento,0)) * si.cantidad) > 0.005`,
      romper: `update public.sale_items set subtotal = subtotal + 5 where sale_id = $1`, params: () => [venta],
    },
    {
      nombre: 'el día comercial es el de Lima, no el UTC',
      censo: `select count(*)::int as n from public.sales`,
      violaciones: `select count(*)::int as n from public.sales
        where business_date is distinct from (fecha at time zone 'America/Lima')::date`,
      romper: `update public.sales set business_date = business_date + 1 where id = $1`, params: () => [venta],
    },
    {
      nombre: 'el stock agregado lo explica el libro de movimientos',
      censo: `select count(*)::int as n from public.inventory where variant_id = $1`,
      // Acotado a las variantes de ESTE escenario: las filas que siembran las migraciones
      // (el centinela de «Servicio técnico» y los fixtures históricos) no tienen libro por
      // diseño, y mezclarlas convertiría el invariante en ruido. Lo que se prueba es que el
      // MECANISMO mantiene stock y libro cuadrados.
      violaciones: `select count(*)::int as n from (
          select i.variant_id, i.location_id, i.cantidad,
                 coalesce((select sum(m.cantidad_delta) from public.inventory_movements m
                            where m.variant_id = i.variant_id and m.location_id = i.location_id), 0) as libro
          from public.inventory i
          where i.variant_id = $1) d
        where d.cantidad <> d.libro`,
      censoParams: () => [vNS],
      romper: `update public.inventory set cantidad = cantidad + 4 where variant_id = $1`, params: () => [vNS],
    },
    {
      nombre: 'el stock de un producto con IMEI = sus unidades disponibles',
      censo: `select count(*)::int as n from public.inventory i
        join public.product_variants pv on pv.id = i.variant_id
        join public.products p on p.id = pv.product_id where p.control_serial`,
      violaciones: `select count(*)::int as n from (
          select i.cantidad,
                 (select count(*) from public.product_serials ps
                   where ps.variant_id = i.variant_id and ps.location_id = i.location_id
                     and ps.estado = 'disponible') as disponibles
          from public.inventory i
          join public.product_variants pv on pv.id = i.variant_id
          join public.products p on p.id = pv.product_id
          where p.control_serial) d
        where d.cantidad <> d.disponibles`,
      romper: `update public.product_serials set estado = 'vendido' where serial_number = 'POS-IMEI-1'`, params: () => [],
    },
    {
      nombre: 'todo movimiento de inventario tiene responsable',
      censo: `select count(*)::int as n from public.inventory_movements`,
      violaciones: `select count(*)::int as n from public.inventory_movements where staff_id is null`,
      romper: `update public.inventory_movements set staff_id = null where variant_id = $1`, params: () => [vNS],
    },
  ]

  for (const inv of INVARIANTES) {
    const pc = inv.censoParams ? inv.censoParams() : []
    const censo = (await uno(inv.censo, pc)).n
    const violaciones = (await uno(inv.violaciones, pc)).n
    comprobar(`${inv.nombre} — se comprobó sobre datos reales (censo ${censo}) y sin violaciones`,
      censo > 0 && violaciones === 0, `censo=${censo} violaciones=${violaciones}`)

    // La misma consulta tiene que CAZAR la incoherencia. Sin esto, un PASS no significa nada.
    await q('savepoint romper')
    await q(`set local session_replication_role = replica`)
    await q(inv.romper, inv.params())
    const cazadas = (await uno(inv.violaciones, pc)).n
    await q(`set local session_replication_role = origin`)
    await q('rollback to savepoint romper')
    comprobar(`${inv.nombre} — la comprobación detecta la incoherencia cuando existe`,
      cazadas > 0, `tras romperlo, violaciones=${cazadas} (debería ser > 0)`)
  }

  // --------------------------------------------------------------------------------------------
  // Invariantes sostenidos por la base: se intenta violarlos de verdad y deben ser RECHAZADOS.
  // --------------------------------------------------------------------------------------------
  const rechazado = async (sql, params) => {
    await q('savepoint intento')
    try { await q(sql, params); await q('rollback to savepoint intento'); return null }
    catch (e) { await q('rollback to savepoint intento'); return e.message }
  }

  const eSerial = await rechazado(
    `insert into public.product_serials(variant_id, location_id, serial_number, estado)
     values ($1, $2, 'POS-IMEI-1', 'disponible')`, [vS, A])
  comprobar('un IMEI repetido es rechazado por la base, no sólo por la aplicación',
    eSerial !== null, eSerial || 'ACEPTÓ un serial duplicado')

  const eHuerfana = await rechazado(
    `insert into public.sale_items(id, sale_id, variant_id, cantidad, precio_unitario, descuento, subtotal, costo_snapshot)
     values ($1, $2, $3, 1, 10, 0, 10, 5)`, [ids(), ids(), vNS])
  comprobar('una línea sin venta es rechazada (no puede haber huérfanas)',
    eHuerfana !== null, eHuerfana || 'ACEPTÓ una línea huérfana')

  const eNegativo = await rechazado(
    `update public.inventory set cantidad = -1 where variant_id = $1 and location_id = $2`, [vNS, A])
  comprobar('el stock negativo lo rechaza la BASE, no sólo el código de cada función (P4.A)',
    eNegativo !== null && /inventory_cantidad_no_negativa|cantidad >= 0/.test(eNegativo),
    eNegativo || 'ACEPTÓ stock negativo')

  // --------------------------------------------------------------------------------------------
  // P4.B · el alta de inventario es atómica y es la ÚNICA vía: fila y movimiento, o nada.
  // --------------------------------------------------------------------------------------------
  const sesion = async (uid, fn) => {
    await q('savepoint sesion')
    await q(`set local role authenticated`)
    await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
    const run = async (sql, params = []) => {
      await q('savepoint paso')
      try { const r = await q(sql, params); await q('release savepoint paso'); return { filas: r.rows } }
      catch (e) { await q('rollback to savepoint paso'); return { error: e.message } }
    }
    try { return await fn(run) } finally { await q('rollback to savepoint sesion') }
  }

  await sesion(uA, async (run) => {
    // El INSERT directo ya no existe como vía: lo impide el privilegio, no una convención.
    const directo = await run(
      `insert into public.inventory(variant_id, location_id, cantidad, stock_minimo) values ($1, $2, 7, 1)`, [vNS2, A])
    comprobar('crear inventario con un INSERT directo está cerrado para authenticated (P4.B)',
      !!directo.error && /permission denied|denegado/i.test(directo.error), directo.error || 'ACEPTÓ el INSERT directo')

    // Y la RPC deja SIEMPRE fila + movimiento coherentes, en una sola llamada.
    const alta = await run(`select public.registrar_stock_inicial($1, $2, 7, 2, 'Alta desde prueba') as r`, [vNS2, A])
    comprobar('registrar_stock_inicial da de alta la variante en una sola llamada',
      !alta.error && !!alta.filas?.[0]?.r, alta.error || 'no devolvió la fila')

    const cuadre = await run(`select i.cantidad,
        coalesce((select sum(m.cantidad_delta) from public.inventory_movements m
                   where m.variant_id = i.variant_id and m.location_id = i.location_id), 0) as libro,
        (select count(*) from public.inventory_movements m
          where m.variant_id = i.variant_id and m.location_id = i.location_id and m.staff_id is not null) as con_responsable
      from public.inventory i where i.variant_id = $1`, [vNS2])
    const f = cuadre.filas?.[0]
    comprobar('el alta deja el libro explicando el stock, con responsable',
      Number(f?.cantidad) === 7 && Number(f?.libro) === 7 && Number(f?.con_responsable) === 1,
      cuadre.error || JSON.stringify(f))

    // Un segundo intento no duplica nada y remite a la vía correcta para mover stock.
    const repetido = await run(`select public.registrar_stock_inicial($1, $2, 7, 2, 'Alta repetida') as r`, [vNS2, A])
    const tras = await run(`select count(*)::int as n from public.inventory_movements where variant_id = $1`, [vNS2])
    comprobar('un segundo alta de la misma variante se rechaza y no escribe un segundo movimiento',
      !!repetido.error && /ya tiene inventario/i.test(repetido.error) && Number(tras.filas?.[0]?.n) === 1,
      repetido.error || `movimientos=${tras.filas?.[0]?.n}`)

    // Producto con IMEI: su stock se deriva de las unidades, no de una cantidad inicial.
    const serie = await run(`select public.registrar_stock_inicial($1, $2, 3, 0, 'No debería') as r`, [vS, A])
    comprobar('un producto con IMEI no acepta cantidad inicial (su stock se deriva de las unidades)',
      !!serie.error && /IMEI|serie/i.test(serie.error), serie.error || 'ACEPTÓ cantidad inicial en producto serializado')
  })

  await q('rollback')
}
