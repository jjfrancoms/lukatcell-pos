// P2.G · Reimpresión con rastro, sobre el esquema compuesto real.
import crypto from 'node:crypto'

const ids = () => crypto.randomUUID()

export default async function ({ db, comprobar }) {
  const q = (sql, p) => db.query(sql, p)
  await q('begin')
  await q(`set local session_replication_role = replica`)
  const A = ids(), B = ids(), uA = ids(), uV = ids(), sA = ids(), sV = ids()
  const vA = ids(), vB = ids(), vAnulada = ids()
  await q(`insert into auth.users(id) values ($1), ($2)`, [uA, uV])
  await q(`insert into public.locations(id, nombre) values ($1, 'Sede A'), ($2, 'Sede B')`, [A, B])
  await q(`insert into public.staff(id, nombre, username, rol, activo, user_id, location_id) values
           ($1, 'Admin Reimp', 'reimp-admin', 'administrador', true, $3, $5),
           ($2, 'Vendedor Reimp', 'reimp-vend', 'vendedor', true, $4, $5)`, [sA, sV, uA, uV, A])
  for (const [idv, loc, estado] of [[vA, A, 'completada'], [vB, B, 'completada'], [vAnulada, A, 'anulada']]) {
    await q(`insert into public.sales(id, location_id, cajero_id, fecha, business_date, subtotal, impuesto, total, estado, is_test)
             values ($1, $2, $3, now(), (now() at time zone 'America/Lima')::date, 10, 1.8, 11.8, $4, false)`, [idv, loc, sV, estado])
  }
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

  await sesion(uV, async (run) => {
    const c1 = await run(`select public.registrar_reimpresion_venta($1, 'Cliente perdió el recibo') as r`, [vA])
    const c2 = await run(`select public.registrar_reimpresion_venta($1) as r`, [vA])
    comprobar('cada reimpresión recibe un número de copia correlativo', c1.filas?.[0]?.r?.copia === 1 && c2.filas?.[0]?.r?.copia === 2, c1.error || c2.error || JSON.stringify([c1.filas, c2.filas]))
    const visibles = await run(`select sale_id, copia, staff_id, motivo from public.reimpresiones_venta order by copia`)
    comprobar('queda registrada con quién y por qué', visibles.filas?.length === 2 && visibles.filas[0].staff_id === sV && visibles.filas[0].motivo === 'Cliente perdió el recibo',
      visibles.error || JSON.stringify(visibles.filas))
    const otra = await run(`select public.registrar_reimpresion_venta($1)`, [vB])
    comprobar('el personal no reimprime ventas de otra sucursal', /otra sucursal/.test(otra.error || ''), otra.error || 'no falló')
    const anulada = await run(`select public.registrar_reimpresion_venta($1)`, [vAnulada])
    comprobar('una venta anulada no se reimprime', /anulada no se reimprime/.test(anulada.error || ''), anulada.error || 'no falló')
    const directa = await run(`insert into public.reimpresiones_venta(sale_id, copia) values ($1, 99)`, [vA])
    comprobar('el personal no inserta reimpresiones directamente', /permission denied/i.test(directa.error || ''), directa.error || 'no falló')
    const inexistente = await run(`select public.registrar_reimpresion_venta($1)`, [ids()])
    comprobar('venta inexistente se rechaza', /Venta inexistente/.test(inexistente.error || ''), inexistente.error || 'no falló')
  })

  await sesion(uA, async (run) => {
    const b = await run(`select public.registrar_reimpresion_venta($1) as r`, [vB])
    comprobar('administración reimprime ventas de cualquier sucursal', b.filas?.[0]?.r?.copia === 1, b.error)
  })

  await sesion(null, async (run) => {
    const an = await run(`select public.registrar_reimpresion_venta($1)`, [vA])
    comprobar('anon no puede registrar reimpresiones', /permission denied/i.test(an.error || ''), an.error || 'no falló')
  })

  // Append-only incluso para el dueño de la tabla.
  await q(`set local session_replication_role = replica`)
  await q(`insert into public.reimpresiones_venta(sale_id, location_id, copia) values ($1, $2, 1)`, [vA, A])
  await q(`set local session_replication_role = origin`)
  const borrar = await q(`delete from public.reimpresiones_venta where sale_id = $1`, [vA]).then(() => null, (e) => e.message)
  await q('rollback').catch(() => {})
  comprobar('el registro de reimpresiones es append-only', /sólo inserción/.test(borrar || ''), borrar || 'no falló')
}
