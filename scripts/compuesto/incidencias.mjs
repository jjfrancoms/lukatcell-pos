// P2.F · Centro de incidencias sobre el esquema compuesto real.
// Sede A: caja olvidada (P0 CAJAS_ABIERTAS) y stock crítico (warning).
import crypto from 'node:crypto'

const ids = () => crypto.randomUUID()

export default async function ({ db, comprobar }) {
  const q = (sql, p) => db.query(sql, p)
  await q('begin')
  await q(`set local session_replication_role = replica`)
  const A = ids(), uA = ids(), uV = ids(), sA = ids(), sV = ids(), P = ids(), V = ids(), caja = ids()
  await q(`insert into auth.users(id) values ($1), ($2)`, [uA, uV])
  await q(`insert into public.locations(id, nombre) values ($1, 'Sede A')`, [A])
  await q(`insert into public.staff(id, nombre, username, rol, activo, user_id, location_id) values
           ($1, 'Admin Inc', 'inc-admin', 'administrador', true, $3, $5),
           ($2, 'Vendedor Inc', 'inc-vend', 'vendedor', true, $4, $5)`, [sA, sV, uA, uV, A])
  await q(`insert into public.products(id, nombre, is_test) values ($1, 'Real', false)`, [P])
  await q(`insert into public.product_variants(id, product_id) values ($1, $2)`, [V, P])
  await q(`insert into public.inventory(variant_id, location_id, cantidad, stock_minimo) values ($1, $2, 1, 5)`, [V, A])
  await q(`insert into public.cash_sessions(id, cajero_id, location_id, monto_inicial, apertura) values ($1, $2, $3, 50, now() - interval '3 days')`, [caja, sV, A])
  await q(`set local session_replication_role = origin`)

  // Sesión como un usuario: varias sentencias que se ven entre sí; cada una en su
  // propio savepoint para que un error esperado no aborte la transacción.
  const sesion = async (uid, fn) => {
    await q('savepoint sesion')
    await q(`set local role ${uid ? 'authenticated' : 'anon'}`)
    if (uid) await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
    const intento = async (sql, params = []) => {
      await q('savepoint paso')
      try {
        const r = await q(sql, params)
        await q('release savepoint paso')
        return { filas: r.rows }
      } catch (e) {
        await q('rollback to savepoint paso')
        return { error: e.message }
      }
    }
    try {
      return await fn(intento)
    } finally {
      await q('rollback to savepoint sesion')
    }
  }

  await sesion(uA, async (run) => {
    const d1 = await run(`select public.detectar_incidencias_admin() as r`)
    comprobar('el detector abre incidencias nuevas', !d1.error && d1.filas[0].r.nuevas >= 2, d1.error || JSON.stringify(d1.filas[0].r))
    const lista = await run(`select public.incidencias_admin() as l`)
    const porCodigo = Object.fromEntries((lista.filas?.[0]?.l || []).map((i) => [i.codigo, i]))
    comprobar('CAJAS_ABIERTAS queda como incidencia P0 abierta y STOCK_CRITICO como warning',
      porCodigo.CAJAS_ABIERTAS?.severidad === 'P0' && porCodigo.CAJAS_ABIERTAS?.estado === 'abierta' && porCodigo.STOCK_CRITICO?.severidad === 'warning',
      lista.error || JSON.stringify(Object.keys(porCodigo)))
    comprobar('el listado ordena P0 primero', lista.filas?.[0]?.l?.[0]?.severidad === 'P0', JSON.stringify(lista.filas?.[0]?.l?.map((i) => i.severidad)))

    const d2 = await run(`select public.detectar_incidencias_admin() as r`)
    const veces = await run(`select codigo, veces from public.incidencias where location_id = $1 and estado = 'abierta'`, [A])
    comprobar('detectar dos veces no duplica: redetecta y cuenta', !d2.error && d2.filas[0].r.nuevas === 0 && d2.filas[0].r.redetectadas >= 2
      && (veces.filas || []).every((f) => f.veces === 2), d2.error || JSON.stringify({ r: d2.filas[0].r, veces: veces.filas }))

    const idCaja = porCodigo.CAJAS_ABIERTAS?.id, idStock = porCodigo.STOCK_CRITICO?.id
    const desc = await run(`select public.actualizar_incidencia_admin($1, 'descartada', 'No aplica hoy')`, [idCaja])
    comprobar('una P0 no se puede descartar', /P0 no se descarta/.test(desc.error || ''), desc.error || 'no falló')
    const corta = await run(`select public.actualizar_incidencia_admin($1, 'resuelta', 'ok')`, [idStock])
    comprobar('resolver exige una nota', /mínimo 5 caracteres/.test(corta.error || ''), corta.error || 'no falló')
    const rev = await run(`select (public.actualizar_incidencia_admin($1, 'en_revision', null, $2)).estado as e`, [idCaja, sA])
    comprobar('pasa a revisión y se asigna responsable', !rev.error && rev.filas[0].e === 'en_revision', rev.error)

    // Se corrige la causa (la caja se cierra, como postgres y sin triggers: el
    // flujo de cierre de caja no es objeto de esta prueba) y el detector auto-resuelve.
    await run(`reset role`)
    await run(`set local session_replication_role = replica`)
    await run(`update public.cash_sessions set cierre = now(), diferencia = 0 where id = $1`, [caja])
    await run(`set local session_replication_role = origin`)
    await run(`set local role authenticated`)
    await run(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uA, role: 'authenticated' })])
    const d3 = await run(`select public.detectar_incidencias_admin() as r`)
    const cajaTras = await run(`select estado, resolucion from public.incidencias where id = $1`, [idCaja])
    const eventos = await run(`select accion from public.incidencia_eventos where incidencia_id = $1 order by id`, [idCaja])
    comprobar('corregida la causa, el detector la auto-resuelve y lo registra',
      !d3.error && d3.filas[0].r.auto_resueltas === 1 && cajaTras.filas?.[0]?.estado === 'resuelta'
      && JSON.stringify((eventos.filas || []).map((e) => e.accion)) === JSON.stringify(['detectada', 'redetectada', 'estado', 'asignada', 'auto_resuelta']),
      d3.error || JSON.stringify({ r: d3.filas?.[0]?.r, caja: cajaTras.filas, ev: eventos.filas }))

    const res = await run(`select (public.actualizar_incidencia_admin($1, 'resuelta', 'Se pidió reposición al proveedor')).estado as e`, [idStock])
    comprobar('un warning se resuelve con nota', !res.error && res.filas[0].e === 'resuelta', res.error)
    const otra = await run(`select public.actualizar_incidencia_admin($1, 'abierta')`, [idStock])
    comprobar('una incidencia cerrada no se reabre ni se edita', /ya está cerrada/.test(otra.error || ''), otra.error || 'no falló')
    const d4 = await run(`select public.detectar_incidencias_admin() as r`)
    const nuevas = await run(`select id, veces from public.incidencias where codigo = 'STOCK_CRITICO' and estado = 'abierta'`)
    comprobar('si la condición persiste tras resolver, se abre una NUEVA incidencia visible',
      !d4.error && d4.filas[0].r.nuevas === 1 && nuevas.filas?.length === 1 && nuevas.filas[0].id !== idStock && nuevas.filas[0].veces === 1,
      d4.error || JSON.stringify(nuevas.filas))
  })

  // --- Acceso -------------------------------------------------------------------
  await q(`set local session_replication_role = replica`)
  const incId = ids()
  await q(`insert into public.incidencias(id, location_id, codigo, severidad, titulo, clave_dedup) values ($1, $2, 'MANUAL', 'warning', 'Prueba', 'manual-prueba')`, [incId, A])
  await q(`insert into public.incidencia_eventos(incidencia_id, accion, estado_nuevo) values ($1, 'detectada', 'abierta')`, [incId])
  await q(`set local session_replication_role = origin`)

  await sesion(uV, async (run) => {
    const det = await run(`select public.detectar_incidencias_admin()`)
    comprobar('un vendedor no ejecuta el detector', /Solo administración/.test(det.error || ''), det.error || 'no falló')
    const ver = await run(`select count(*)::int n from public.incidencias where location_id = $1`, [A])
    comprobar('el personal de la sucursal lee sus incidencias', !ver.error && ver.filas[0].n >= 1, ver.error)
    const ins = await run(`insert into public.incidencias(location_id, codigo, severidad, titulo, clave_dedup) values ($1, 'X', 'P0', 'X', 'x')`, [A])
    comprobar('el personal no inserta incidencias directamente', /permission denied/i.test(ins.error || ''), ins.error || 'no falló')
    const upd = await run(`update public.incidencias set estado = 'descartada' where id = $1`, [incId])
    comprobar('el personal no cambia incidencias directamente', /permission denied/i.test(upd.error || ''), upd.error || 'no falló')
  })
  await sesion(null, async (run) => {
    const an = await run(`select count(*) from public.incidencias`)
    comprobar('anon no lee incidencias', /permission denied/i.test(an.error || ''), an.error || 'no falló')
  })

  const borrar = await q(`delete from public.incidencia_eventos where incidencia_id = $1`, [incId]).then(() => null, (e) => e.message)
  await q('rollback').catch(() => {})
  comprobar('el historial es append-only incluso para el dueño de la tabla', /sólo inserción/.test(borrar || ''), borrar || 'no falló')
}
