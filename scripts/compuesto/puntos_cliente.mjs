// P2.C · RLS de cliente_puntos_movimientos sobre el esquema compuesto real.
// Un vendedor de la sucursal A ve los puntos de un cliente que compró en A y
// NO los de un cliente que sólo compró en B. Con la policy anterior
// (s.cliente_id = s.cliente_id) veía ambos.
import crypto from 'node:crypto'

const ids = () => crypto.randomUUID()

export default async function ({ db, comprobar }) {
  const q = (sql, p) => db.query(sql, p)
  await q('begin')
  await q(`set local session_replication_role = replica`)
  const L1 = ids(), L2 = ids(), uV = ids(), sV = ids(), cA = ids(), cB = ids()
  await q(`insert into auth.users(id) values ($1)`, [uV])
  await q(`insert into public.locations(id, nombre) values ($1, 'Sede A'), ($2, 'Sede B')`, [L1, L2])
  await q(`insert into public.staff(id, nombre, username, rol, activo, user_id, location_id)
           values ($1, 'Vendedor Puntos', 'pts-vend', 'vendedor', true, $2, $3)`, [sV, uV, L1])
  await q(`insert into public.clientes(id, nombre) values ($1, 'Cliente A'), ($2, 'Cliente B')`, [cA, cB])
  for (const [cli, loc] of [[cA, L1], [cB, L2]]) {
    await q(`insert into public.sales(id, location_id, cajero_id, cliente_id, fecha, business_date, subtotal, impuesto, total, estado, is_test)
             values ($1, $2, $3, $4, now(), (now() at time zone 'America/Lima')::date, 10, 1.8, 11.8, 'completada', false)`, [ids(), loc, sV, cli])
    await q(`insert into public.cliente_puntos_movimientos(cliente_id, puntos, motivo) values ($1, 5, 'Compra')`, [cli])
  }
  await q(`set local session_replication_role = origin`)

  await q('savepoint v')
  let visibles
  try {
    await q('set local role authenticated')
    await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uV, role: 'authenticated' })])
    visibles = (await q(`select cliente_id from public.cliente_puntos_movimientos where cliente_id = any($1)`, [[cA, cB]])).rows.map((r) => r.cliente_id)
  } finally {
    await q('rollback to savepoint v')
  }
  comprobar('el vendedor ve los puntos del cliente que compró en su sucursal', visibles.includes(cA), JSON.stringify(visibles))
  comprobar('el vendedor NO ve los puntos de un cliente de otra sucursal', !visibles.includes(cB), JSON.stringify(visibles))
}
