// P2.J · Reembolsos a través del proveedor y terminal de conciliación, sobre el esquema compuesto.
//
// Sede A: venta con pago Yape 100 y pago en efectivo 50; devolución de esa venta.
// Sede B: venta con pago con tarjeta 80 y su devolución.
import crypto from 'node:crypto'

const ids = () => crypto.randomUUID()

export default async function ({ db, comprobar }) {
  const q = (sql, p) => db.query(sql, p)
  await q('begin')
  await q(`set local session_replication_role = replica`)
  const A = ids(), B = ids(), uA = ids(), uV = ids(), sA = ids(), sV = ids()
  const ventaA = ids(), ventaB = ids(), pYape = ids(), pEfectivo = ids(), pTarjetaB = ids()
  const devA = ids(), devB = ids(), concA = ids(), concB = ids()
  await q(`insert into auth.users(id) values ($1), ($2)`, [uA, uV])
  await q(`insert into public.locations(id, nombre) values ($1, 'Sede A'), ($2, 'Sede B')`, [A, B])
  await q(`insert into public.staff(id, nombre, username, rol, activo, user_id, location_id) values
           ($1, 'Admin Reemb', 'reemb-admin', 'administrador', true, $3, $5),
           ($2, 'Vendedor Reemb', 'reemb-vend', 'vendedor', true, $4, $5)`, [sA, sV, uA, uV, A])
  for (const [v, loc, total] of [[ventaA, A, 150], [ventaB, B, 80]]) {
    await q(`insert into public.sales(id, location_id, cajero_id, fecha, business_date, subtotal, impuesto, total, estado, is_test)
             values ($1, $2, $3, now(), (now() at time zone 'America/Lima')::date, $4, 0, $4, 'completada', false)`, [v, loc, sV, total])
  }
  await q(`insert into public.payments(id, sale_id, metodo, monto) values ($1, $4, 'yape', 100), ($2, $4, 'efectivo', 50), ($3, $5, 'tarjeta', 80)`,
    [pYape, pEfectivo, pTarjetaB, ventaA, ventaB])
  await q(`insert into public.devoluciones(id, sale_id, location_id, motivo, creado_por) values ($1, $3, $5, 'Prueba', $6), ($2, $4, $7, 'Prueba', $6)`,
    [devA, devB, ventaA, ventaB, A, sA, B])
  await q(`insert into public.conciliaciones_pago(id, payment_id, sale_id, location_id, metodo, monto_esperado, fecha_venta) values
           ($1, $3, $5, $7, 'yape', 100, (now() at time zone 'America/Lima')::date),
           ($2, $4, $6, $8, 'tarjeta', 80, (now() at time zone 'America/Lima')::date)`, [concA, concB, pYape, pTarjetaB, ventaA, ventaB, A, B])
  await q(`set local session_replication_role = origin`)

  const sesion = async (uid, fn) => {
    await q('savepoint sesion')
    await q(`set local role ${uid ? 'authenticated' : 'anon'}`)
    if (uid) await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
    const run = async (sql, params = []) => {
      await q('savepoint paso')
      try { const r = await q(sql, params); await q('release savepoint paso'); return { filas: r.rows } } catch (e) { await q('rollback to savepoint paso'); return { error: e.message } }
    }
    try { return await fn(run) } finally { await q('rollback to savepoint sesion') }
  }
  const SOL = `select public.solicitar_reembolso_proveedor_admin($1, $2, $3, $4, $5) as r`
  const EVT = `select public.registrar_evento_reembolso_proveedor_admin($1, $2, $3, $4) as r`
  const r0 = (x) => x.filas?.[0]?.r

  await sesion(uA, async (run) => {
    const k1 = ids()
    const s1 = await run(SOL, [pYape, 60, 'Cliente devolvió el equipo', k1, devA])
    comprobar('solicitar un reembolso Yape parcial', r0(s1)?.estado === 'solicitado' && r0(s1)?.repetido === false, s1.error || JSON.stringify(r0(s1)))
    const s1b = await run(SOL, [pYape, 60, 'Cliente devolvió el equipo', k1, devA])
    comprobar('misma clave y mismo contenido → devuelve el existente', r0(s1b)?.repetido === true && r0(s1b)?.id === r0(s1)?.id, s1b.error || JSON.stringify(r0(s1b)))
    const s1c = await run(SOL, [pYape, 61, 'Cliente devolvió el equipo', k1, devA])
    comprobar('misma clave con otro contenido → rechazo', /contenido distinto/.test(s1c.error || ''), s1c.error || 'no falló')
    const exceso = await run(SOL, [pYape, 50, 'Segundo reembolso excesivo', ids(), null])
    comprobar('la suma de reembolsos no supera el monto del pago', /supera el monto/.test(exceso.error || ''), exceso.error || 'no falló')
    const efectivo = await run(SOL, [pEfectivo, 10, 'Reembolso en efectivo', ids(), null])
    comprobar('un pago en efectivo no se reembolsa por proveedor', /efectivo no se reembolsa/.test(efectivo.error || ''), efectivo.error || 'no falló')
    const otra = await run(SOL, [pTarjetaB, 10, 'Pago de otra sucursal', ids(), null])
    comprobar('un pago de otra sucursal se rechaza', /otra sucursal/.test(otra.error || ''), otra.error || 'no falló')
    const devAjena = await run(SOL, [pYape, 10, 'Devolución que no corresponde', ids(), devB])
    comprobar('la devolución debe ser de la misma venta', /no corresponde/.test(devAjena.error || ''), devAjena.error || 'no falló')

    const id1 = r0(s1)?.id
    const salto = await run(EVT, [id1, 'confirmado', 'OP-123', null])
    comprobar('no se salta de solicitado a confirmado', /Transición inválida/.test(salto.error || ''), salto.error || 'no falló')
    const env = await run(EVT, [id1, 'enviado', null, null])
    const env2 = await run(EVT, [id1, 'enviado', null, null])
    comprobar('enviado, y repetirlo es idempotente', r0(env)?.estado === 'enviado' && r0(env2)?.repetido === true, env.error || env2.error)
    const sinRef = await run(EVT, [id1, 'confirmado', null, null])
    comprobar('confirmar exige la referencia del proveedor', /referencia/.test(sinRef.error || ''), sinRef.error || 'no falló')
    const conf = await run(EVT, [id1, 'confirmado', 'YAPE-OP-9981', null])
    comprobar('confirmar con referencia', r0(conf)?.estado === 'confirmado', conf.error)
    const otraRef = await run(EVT, [id1, 'confirmado', 'OTRA-REF', null])
    comprobar('reconfirmar con otra referencia se rechaza', /otra referencia/.test(otraRef.error || ''), otraRef.error || 'no falló')
    const tras = await run(EVT, [id1, 'rechazado', null, 'Cambio de opinión'])
    comprobar('un reembolso confirmado no puede rechazarse después', /Transición inválida/.test(tras.error || ''), tras.error || 'no falló')

    const s2 = await run(SOL, [pYape, 40, 'Ajuste por diferencia', ids(), null])
    const rech = await run(EVT, [r0(s2)?.id, 'rechazado', null, 'El proveedor lo denegó'])
    const s3 = await run(SOL, [pYape, 40, 'Nuevo intento tras rechazo', ids(), null])
    comprobar('un reembolso rechazado libera su monto', r0(rech)?.estado === 'rechazado' && r0(s3)?.estado === 'solicitado', rech.error || s3.error)

    const lista = await run(`select public.reembolsos_proveedor_admin() as l`)
    const estados = (lista.filas?.[0]?.l || []).map((x) => x.estado).sort()
    comprobar('el listado muestra el estado vigente y el historial', JSON.stringify(estados) === JSON.stringify(['confirmado', 'rechazado', 'solicitado'])
      && (lista.filas[0].l.find((x) => x.estado === 'confirmado')?.eventos || []).length === 3, lista.error || JSON.stringify(estados))

    const term = await run(`select (public.registrar_terminal_conciliacion_admin($1, ' POS-01 ')).terminal as t`, [concA])
    comprobar('registra el terminal de una conciliación', term.filas?.[0]?.t === 'POS-01', term.error)
    const termOtra = await run(`select public.registrar_terminal_conciliacion_admin($1, 'POS-99')`, [concB])
    comprobar('no registra terminal en una conciliación de otra sucursal', /otra sucursal/.test(termOtra.error || ''), termOtra.error || 'no falló')
  })

  await sesion(uV, async (run) => {
    const v = await run(SOL, [pYape, 10, 'Vendedor intenta reembolsar', ids(), null])
    comprobar('un vendedor no solicita reembolsos', /Solo administración/.test(v.error || ''), v.error || 'no falló')
    const directo = await run(`insert into public.reembolsos_proveedor(payment_id, sale_id, location_id, metodo, monto, motivo, client_transaction_id, payload_hash, creado_por)
                               values ($1, $2, $3, 'yape', 100, 'directo', $4, 'x', $5)`, [pYape, ventaA, A, ids(), sV])
    comprobar('nadie inserta reembolsos directamente', /permission denied/i.test(directo.error || ''), directo.error || 'no falló')
  })

  await sesion(null, async (run) => {
    const an = await run(`select public.reembolsos_proveedor_admin()`)
    comprobar('anon no accede a reembolsos', /permission denied/i.test(an.error || ''), an.error || 'no falló')
  })

  await q(`set local session_replication_role = replica`)
  const rid = ids()
  await q(`insert into public.reembolsos_proveedor(id, payment_id, sale_id, location_id, metodo, monto, motivo, client_transaction_id, payload_hash, creado_por)
           values ($1, $2, $3, $4, 'yape', 1, 'fila de prueba', $5, 'x', $6)`, [rid, pYape, ventaA, A, ids(), sA])
  await q(`set local session_replication_role = origin`)
  const editar = await q(`update public.reembolsos_proveedor set monto = 99 where id = $1`, [rid]).then(() => null, (e) => e.message)
  await q('rollback').catch(() => {})
  comprobar('la cabecera del reembolso es inmutable incluso para el dueño', /sólo inserción/.test(editar || ''), editar || 'no falló')
}
