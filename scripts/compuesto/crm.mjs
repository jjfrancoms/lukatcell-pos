// P2.D · CRM sobre el esquema compuesto real.
//
// 1. perfil_cliente_crm (SECURITY DEFINER) no puede saltarse la RLS de ventas:
//    un no-administrador sólo ve compras, reparaciones y puntos de su sucursal
//    activa; nadie ve ventas is_test en el perfil ni en los totales.
// 2. actualizar_cliente_crm es sólo de administración (su único llamador es la
//    ruta /crm, AdminRoute); null = sin cambio; todo cambio de consentimiento
//    (también el retiro) fecha consentimiento_at.
// 3. Escritura directa a clientes: el personal sigue creando clientes y
//    editando nombre/teléfono/email/notas, pero no puede fijar puntos ni
//    consentimientos saltándose el ledger y la RPC.
import crypto from 'node:crypto'

const ids = () => crypto.randomUUID()
const n = (v) => Number(v)

export default async function ({ db, comprobar }) {
  const q = (sql, p) => db.query(sql, p)
  await q('begin')
  await q(`set local session_replication_role = replica`)
  const A = ids(), B = ids(), uAdm = ids(), uVen = ids(), sAdm = ids(), sVen = ids()
  const C1 = ids(), C2 = ids(), C3 = ids()
  await q(`insert into auth.users(id) values ($1), ($2)`, [uAdm, uVen])
  await q(`insert into public.locations(id, nombre) values ($1, 'Sede A'), ($2, 'Sede B')`, [A, B])
  await q(`insert into public.staff(id, nombre, username, rol, activo, user_id, location_id) values
           ($1, 'Admin CRM', 'crm-admin', 'administrador', true, $3, $5),
           ($2, 'Vendedor CRM', 'crm-vend', 'vendedor', true, $4, $5)`, [sAdm, sVen, uAdm, uVen, A])
  await q(`insert into public.clientes(id, nombre, consentimiento_whatsapp, consentimiento_email, consentimiento_at) values
           ($1, 'Cliente Dos Sedes', true, false, '2026-01-01T00:00:00Z'),
           ($2, 'Cliente Sede B', false, false, null),
           ($3, 'Cliente Consentido', true, true, '2026-01-01T00:00:00Z')`, [C1, C2, C3])
  const venta = (loc, cli, total, isTest = false) => q(
    `insert into public.sales(id, location_id, cajero_id, cliente_id, fecha, business_date, subtotal, impuesto, total, estado, is_test)
     values ($1, $2, $3, $4, now(), (now() at time zone 'America/Lima')::date, $5, 0, $5, 'completada', $6)`, [ids(), loc, sAdm, cli, total, isTest])
  await venta(A, C1, 100); await venta(B, C1, 200); await venta(A, C1, 1000, true); await venta(B, C2, 50)
  await q(`insert into public.ordenes_servicio(id, location_id, cliente_id, cliente_nombre, problema) values
           ($1, $3, $5, 'Cliente Dos Sedes', 'Pantalla'), ($2, $4, $5, 'Cliente Dos Sedes', 'Batería')`, [ids(), ids(), A, B, C1])
  await q(`insert into public.cliente_puntos_movimientos(cliente_id, puntos, motivo) values ($1, 10, 'Compra'), ($2, 5, 'Compra')`, [C1, C2])
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
  const perfil = async (uid, cli) => {
    const r = await como(uid, `select public.perfil_cliente_crm($1) as p`, [cli])
    return r.error ? r : { p: r.filas[0].p }
  }

  // --- 1. Alcance del perfil ---------------------------------------------------
  const pv = await perfil(uVen, C1)
  comprobar('perfil (vendedor): sólo compras de su sucursal activa y sin ventas de prueba',
    !pv.error && pv.p.compras.length === 1 && n(pv.p.resumen.total_gastado) === 100 && n(pv.p.resumen.compras) === 1,
    pv.error || JSON.stringify({ compras: pv.p.compras.length, resumen: pv.p.resumen }))
  comprobar('perfil (vendedor): sólo reparaciones de su sucursal activa', !pv.error && pv.p.reparaciones.length === 1,
    pv.error || String(pv.p.reparaciones.length))
  comprobar('perfil (vendedor): ve los puntos de un cliente que compró en su sucursal', !pv.error && pv.p.puntos_movimientos.length === 1,
    pv.error || String(pv.p.puntos_movimientos.length))
  const pv2 = await perfil(uVen, C2)
  comprobar('perfil (vendedor): cliente de otra sucursal → datos maestros sí, compras y puntos no',
    !pv2.error && pv2.p.cliente?.id === C2 && pv2.p.compras.length === 0 && pv2.p.puntos_movimientos.length === 0 && n(pv2.p.resumen.total_gastado) === 0,
    pv2.error || JSON.stringify({ compras: pv2.p.compras.length, puntos: pv2.p.puntos_movimientos.length }))
  const pa = await perfil(uAdm, C1)
  comprobar('perfil (admin): todas las sucursales, sin ventas de prueba',
    !pa.error && pa.p.compras.length === 2 && n(pa.p.resumen.total_gastado) === 300 && pa.p.reparaciones.length === 2,
    pa.error || JSON.stringify({ compras: pa.p.compras.length, resumen: pa.p.resumen, rep: pa.p.reparaciones.length }))

  // --- 2. actualizar_cliente_crm ------------------------------------------------
  const upV = await como(uVen, `select public.actualizar_cliente_crm($1, '123', 'Av. 1', 'vip', false, false)`, [C1])
  comprobar('un vendedor no puede cambiar datos CRM ni consentimientos por RPC', /Solo administración/.test(upV.error || ''), upV.error || 'no falló')

  // Llamada y relectura en el mismo savepoint (una sentencia no ve su propio UPDATE).
  await q('savepoint dos')
  let tras
  try {
    await q('set local role authenticated')
    await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uAdm, role: 'authenticated' })])
    await q(`select public.actualizar_cliente_crm($1, null, null, null, false, null)`, [C1])
    await q(`select public.actualizar_cliente_crm($1, '20123456789', null, null, null, null)`, [C3])
    // Así llama /crm (CRM.tsx): strings tal cual; '' vacía el campo, null no lo toca.
    await q(`select public.actualizar_cliente_crm($1, 'DOC-TEMP', 'Calle Temporal', 'general', true, false)`, [C2])
    await q(`select public.actualizar_cliente_crm($1, '', '', 'general', true, false)`, [C2])
    tras = (await q(`select id, consentimiento_whatsapp, consentimiento_email, consentimiento_at, documento, direccion, segmento from public.clientes where id = any($1)`, [[C1, C2, C3]])).rows
  } catch (e) {
    tras = { error: e.message }
  } finally {
    await q('rollback to savepoint dos')
  }
  comprobar('el administrador puede actualizar', Array.isArray(tras), tras?.error)
  const c1 = Array.isArray(tras) ? tras.find((x) => x.id === C1) : null
  const c3 = Array.isArray(tras) ? tras.find((x) => x.id === C3) : null
  comprobar('retirar un consentimiento lo fecha y null no toca el otro',
    !!c1 && c1.consentimiento_whatsapp === false && c1.consentimiento_email === false && new Date(c1.consentimiento_at) > new Date('2026-01-02'),
    JSON.stringify(tras))
  const c2 = Array.isArray(tras) ? tras.find((x) => x.id === C2) : null
  comprobar('un string vacío desde /crm vacía documento y dirección', !!c2 && c2.documento === null && c2.direccion === null && c2.consentimiento_whatsapp === true,
    JSON.stringify(c2))
  comprobar('con null en consentimientos y segmento no se tocan (antes se ponían en false/general)', !!c3 && c3.consentimiento_whatsapp === true && c3.consentimiento_email === true
    && new Date(c3.consentimiento_at).toISOString() === '2026-01-01T00:00:00.000Z' && c3.documento === '20123456789',
    JSON.stringify(tras))

  // --- 3. Escritura directa ------------------------------------------------------
  const puntos = await como(uVen, `update public.clientes set puntos = 999 where id = $1`, [C1])
  comprobar('UPDATE directo de puntos rechazado', /permission denied/i.test(puntos.error || ''), puntos.error || 'no falló')
  const consen = await como(uVen, `update public.clientes set consentimiento_whatsapp = true where id = $1`, [C2])
  comprobar('UPDATE directo de consentimiento rechazado', /permission denied/i.test(consen.error || ''), consen.error || 'no falló')
  const insPuntos = await como(uVen, `insert into public.clientes(nombre, puntos) values ('Inflado', 5000)`)
  comprobar('INSERT directo con puntos rechazado', /permission denied/i.test(insPuntos.error || ''), insPuntos.error || 'no falló')
  const notas = await como(uVen, `update public.clientes set notas = 'Prefiere WhatsApp', telefono = '999888777' where id = $1 returning id`, [C1])
  comprobar('el personal sigue editando notas y teléfono', !notas.error && notas.filas.length === 1, notas.error)
  const alta = await como(uVen, `insert into public.clientes(nombre, telefono, email, notas) values ('Nuevo', '911', 'n@x.pe', 'alta POS') returning id`)
  comprobar('el personal sigue dando de alta clientes como hace el POS', !alta.error && alta.filas.length === 1, alta.error)
}
