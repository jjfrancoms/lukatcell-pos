// P2.B · Sucursal ACTIVA en el servidor, sobre el esquema compuesto real.
//
// Actores (base = Sede A):
//   admin  — acceso a A y B, activa = B
//   vend   — vendedor, acceso a A y B, activa = B
//   rancio — admin con active_location_id = B pero SIN acceso a B: el servidor
//            debe ignorar esa activa y usar su base (A).
//
// Sin _p2_b (sucursal base en las funciones) fallan: abrir caja en B, rechazar
// caja en A, origen de la transferencia, despacho, autorización y movimiento.
import crypto from 'node:crypto'

const ids = () => crypto.randomUUID()

export default async function ({ db, comprobar }) {
  const q = (sql, p) => db.query(sql, p)
  await q('begin')
  await q(`set local session_replication_role = replica`)

  const A = ids(), B = ids(), P = ids(), V = ids()
  const uAdm = ids(), uVen = ids(), uRan = ids(), sAdm = ids(), sVen = ids(), sRan = ids()
  const cajaVen = ids()
  await q(`insert into auth.users(id) values ($1), ($2), ($3)`, [uAdm, uVen, uRan])
  await q(`insert into public.locations(id, nombre, activo) values ($1, 'Sede A', true), ($2, 'Sede B', true)`, [A, B])
  await q(`insert into public.staff(id, nombre, username, rol, activo, user_id, location_id, active_location_id) values
           ($1, 'Admin Multi', 'multi-admin', 'administrador', true, $4, $7, $8),
           ($2, 'Vendedor Multi', 'multi-vend', 'vendedor', true, $5, $7, $8),
           ($3, 'Admin Rancio', 'multi-rancio', 'administrador', true, $6, $7, $8)`, [sAdm, sVen, sRan, uAdm, uVen, uRan, A, B])
  await q(`insert into public.staff_locations(staff_id, location_id, puede_vender, puede_inventario, puede_taller) values
           ($1, $4, true, true, true), ($1, $5, true, true, true),
           ($2, $4, true, true, true), ($2, $5, true, true, true),
           ($3, $4, true, true, true)`, [sAdm, sVen, sRan, A, B])
  for (const s of [sAdm, sVen, sRan]) {
    await q(`insert into public.asistencias(staff_id, fecha, entrada, estado) values ($1, (now() at time zone 'America/Lima')::date, now(), 'presente')`, [s])
  }
  await q(`insert into public.products(id, nombre, sku, is_test, control_serial) values ($1, 'Accesorio', 'ACC-1', false, false)`, [P])
  await q(`insert into public.product_variants(id, product_id) values ($1, $2)`, [V, P])
  await q(`insert into public.inventory(variant_id, location_id, cantidad) values ($1, $2, 10), ($1, $3, 10)`, [V, A, B])
  await q(`insert into public.cash_sessions(id, cajero_id, location_id, monto_inicial, apertura) values ($1, $2, $3, 50, now())`, [cajaVen, sVen, B])
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

  const act = await como(uAdm, `select private.auth_location_id() as l`)
  comprobar('auth_location_id() del admin multi-sucursal es la activa (B)', act.filas?.[0]?.l === B, act.error || act.filas?.[0]?.l)

  // Abrir caja: el admin ya tiene jornada activa y ninguna caja abierta.
  const cajaB = await como(uAdm, `insert into public.cash_sessions(cajero_id, location_id, monto_inicial) values ($1, $2, 20) returning location_id`, [sAdm, B])
  comprobar('abre caja en su sucursal activa (B)', !cajaB.error, cajaB.error)
  const cajaA = await como(uAdm, `insert into public.cash_sessions(cajero_id, location_id, monto_inicial) values ($1, $2, 20) returning location_id`, [sAdm, A])
  comprobar('NO abre caja en su sucursal base cuando la activa es otra (A)', /La caja debe pertenecer a tu sucursal/.test(cajaA.error || ''), cajaA.error || 'no falló')

  // Transferencia creada y despachada desde la activa (una sola evaluación por llamada).
  const tr = await como(uAdm, `select to_jsonb(public.despachar_transferencia_stock(
      (public.crear_transferencia_stock($1::uuid, $2::jsonb)).id)) as t`, [A, JSON.stringify([{ variant_id: V, cantidad: 2 }])])
  comprobar('la transferencia nace con origen en la sucursal activa y su creador puede despacharla',
    !tr.error && tr.filas[0].t.origen_id === B && tr.filas[0].t.estado === 'en_transito', tr.error || JSON.stringify(tr.filas[0].t))

  const au = await como(uAdm, `select to_jsonb(public.solicitar_autorizacion('otro', 'Prueba de sucursal activa', null, null, '{}'::jsonb)) as a`)
  comprobar('la autorización queda en la sucursal activa (donde se busca al consumirla)', !au.error && au.filas[0].a.location_id === B, au.error || JSON.stringify(au.filas[0].a))

  const mov = await como(uVen, `select to_jsonb(public.registrar_movimiento_caja($1::uuid, 'ingreso', 10, 'Fondo adicional de prueba')) as m`, [cajaVen])
  comprobar('un vendedor registra movimientos en la caja de su sucursal activa', !mov.error, mov.error)

  // Activa sin acceso: el servidor usa la base.
  const ran = await como(uRan, `select private.auth_location_id() as l`)
  comprobar('una sucursal activa sin acceso se ignora (usa la base A)', ran.filas?.[0]?.l === A, ran.error || ran.filas?.[0]?.l)
  const ranB = await como(uRan, `insert into public.cash_sessions(cajero_id, location_id, monto_inicial) values ($1, $2, 20) returning id`, [sRan, B])
  comprobar('con activa sin acceso NO abre caja en esa sucursal', /La caja debe pertenecer a tu sucursal/.test(ranB.error || ''), ranB.error || 'no falló')
  const ranA = await como(uRan, `insert into public.cash_sessions(cajero_id, location_id, monto_inicial) values ($1, $2, 20) returning id`, [sRan, A])
  comprobar('con activa sin acceso sí abre caja en su base', !ranA.error, ranA.error)
}
