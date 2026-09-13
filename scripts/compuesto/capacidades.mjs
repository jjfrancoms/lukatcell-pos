// P2.H/P2.I · Capacidades centralizadas, sobre el esquema compuesto real.
//
// Todos en la Sede A (base y activa):
//   admin      administrador
//   enc        cajero/encargado
//   tec        cajero/técnico, flags en true
//   tecSinTall cajero/técnico, puede_taller = false, puede_inventario = false
//   tecSinFila cajero/técnico, sin fila en staff_locations (no debe perder nada)
//   vend       cajero/vendedor
import crypto from 'node:crypto'

const ids = () => crypto.randomUUID()

export default async function ({ db, comprobar }) {
  const q = (sql, p) => db.query(sql, p)
  await q('begin')
  await q(`set local session_replication_role = replica`)
  const A = ids()
  const actores = {
    admin: { rol: 'administrador', puesto: 'jefa', fila: [true, true, true] },
    enc: { rol: 'cajero', puesto: 'encargado', fila: [true, true, true] },
    tec: { rol: 'cajero', puesto: 'tecnico', fila: [true, true, true] },
    tecSinTall: { rol: 'cajero', puesto: 'tecnico', fila: [true, false, false] },
    tecSinFila: { rol: 'cajero', puesto: 'tecnico', fila: null },
    vend: { rol: 'cajero', puesto: 'vendedor', fila: [true, true, false] },
  }
  await q(`insert into public.locations(id, nombre) values ($1, 'Sede A')`, [A])
  for (const [clave, a] of Object.entries(actores)) {
    a.uid = ids(); a.sid = ids()
    await q(`insert into auth.users(id) values ($1)`, [a.uid])
    await q(`insert into public.staff(id, nombre, username, rol, puesto, activo, user_id, location_id) values ($1, $2, $3, $4, $5, true, $6, $7)`,
      [a.sid, `Cap ${clave}`, `cap-${clave.toLowerCase()}`, a.rol, a.puesto, a.uid, A])
    if (a.fila) {
      await q(`insert into public.staff_locations(staff_id, location_id, puede_vender, puede_inventario, puede_taller) values ($1, $2, $3, $4, $5)`,
        [a.sid, A, ...a.fila])
    }
  }
  const orden = ids()
  await q(`insert into public.ordenes_servicio(id, location_id, cliente_nombre, problema, estado) values ($1, $2, 'Cliente', 'Pantalla', 'recibido')`, [orden, A])
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
  const caps = async (clave) => {
    const r = await como(actores[clave].uid, `select public.mis_capacidades() as c`)
    return r.error ? { error: r.error } : r.filas[0].c
  }
  const igual = (c, esperado) => !c.error && Object.entries(esperado).every(([k, v]) => c[k] === v)

  const esperados = {
    admin: { supervisar: true, operar_inventario: true, operar_taller: true, vender: true },
    enc: { supervisar: true, operar_inventario: true, operar_taller: true, vender: true },
    tec: { supervisar: false, operar_inventario: true, operar_taller: true, vender: true },
    tecSinTall: { supervisar: false, operar_inventario: false, operar_taller: false, vender: true },
    tecSinFila: { supervisar: false, operar_inventario: true, operar_taller: true, vender: true },
    vend: { supervisar: false, operar_inventario: false, operar_taller: false, vender: true },
  }
  for (const [clave, esp] of Object.entries(esperados)) {
    const c = await caps(clave)
    comprobar(`mis_capacidades · ${clave}`, igual(c, esp), JSON.stringify(c))
  }

  const desconocida = await como(actores.tec.uid, `select private.tiene_capacidad('borrar_todo')`)
  comprobar('una capacidad desconocida se rechaza', /Capacidad desconocida/.test(desconocida.error || ''), desconocida.error || 'no falló')

  // Aplicación real en una función generada (_p2_i) y en la policy (_p2_h).
  const inicioTec = await como(actores.tec.uid, `select (public.iniciar_inventario_fisico('Conteo de prueba')).id`)
  comprobar('técnico con permiso de inventario inicia un conteo', !inicioTec.error, inicioTec.error)
  const inicioSin = await como(actores.tecSinTall.uid, `select (public.iniciar_inventario_fisico('Conteo de prueba')).id`)
  comprobar('técnico con puede_inventario = false NO inicia un conteo (antes el flag no se aplicaba)', /Sin permiso/.test(inicioSin.error || ''), inicioSin.error || 'no falló')
  const inicioVend = await como(actores.vend.uid, `select (public.iniciar_inventario_fisico('Conteo de prueba')).id`)
  comprobar('un vendedor sigue sin poder iniciar conteos', /Sin permiso/.test(inicioVend.error || ''), inicioVend.error || 'no falló')

  const updTec = await como(actores.tec.uid, `update public.ordenes_servicio set problema = problema || '.' where id = $1 returning id`, [orden])
  comprobar('técnico con permiso de taller actualiza la orden (policy)', !updTec.error && updTec.filas.length === 1, updTec.error || String(updTec.filas?.length))
  const updSin = await como(actores.tecSinTall.uid, `update public.ordenes_servicio set problema = problema || '.' where id = $1 returning id`, [orden])
  comprobar('técnico con puede_taller = false no actualiza la orden (policy)', !updSin.error && updSin.filas.length === 0, updSin.error || String(updSin.filas?.length))
}
