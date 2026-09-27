// P3.B · Transferencias: deuda T3 (IMEI "no llegó" que nunca deja de contar como
// pendiente), T4 (creación sin clave de idempotencia) y T7 (IMEI conciliado en la
// línea de otra variante), sobre el esquema compuesto real.
//
// Sede A (origen) y Sede B (destino):
//   adminA  administrador en A — crea y despacha
//   encB    cajero/encargado en B, puede_inventario — recibe
//   vendB   cajero/vendedor en B — no debe poder recibir
//
// Sin _p3_b_transferencias_t3_t4.sql fallan: el cierre automático con IMEI
// faltantes, las cinco fórmulas de pendiente, la idempotencia de la creación y
// el rechazo del IMEI de otra variante.
//
// La concurrencia real (dos conexiones simultáneas) NO se prueba aquí: este
// ensayo comparte una sola conexión y una sola transacción. Va en
// scripts/verify-transferencias-parciales.mjs (T6 y T16), con dos clientes pg
// de verdad y bloqueo observado en pg_stat_activity.
import crypto from 'node:crypto'

const ids = () => crypto.randomUUID()

export default async function ({ db, comprobar }) {
  const q = (sql, p) => db.query(sql, p)
  await q('begin')
  await q(`set local session_replication_role = replica`)

  const A = ids(), B = ids()
  const uAdm = ids(), uEnc = ids(), uVen = ids()
  const sAdm = ids(), sEnc = ids(), sVen = ids()
  const pNS = ids(), pS = ids(), pS2 = ids()
  const vNS = ids(), vS = ids(), vS2 = ids()

  await q(`insert into auth.users(id) values ($1), ($2), ($3)`, [uAdm, uEnc, uVen])
  await q(`insert into public.locations(id, nombre, activo) values ($1, 'Transf A', true), ($2, 'Transf B', true)`, [A, B])
  await q(`insert into public.staff(id, nombre, username, rol, puesto, activo, user_id, location_id) values
           ($1, 'Admin Transf', 'transf-admin', 'administrador', 'jefa', true, $4, $7),
           ($2, 'Encargado Transf', 'transf-enc', 'cajero', 'encargado', true, $5, $8),
           ($3, 'Vendedor Transf', 'transf-vend', 'cajero', 'vendedor', true, $6, $8)`,
    [sAdm, sEnc, sVen, uAdm, uEnc, uVen, A, B])
  await q(`insert into public.staff_locations(staff_id, location_id, puede_vender, puede_inventario, puede_taller) values
           ($1, $4, true, true, true), ($2, $5, true, true, true), ($3, $5, true, false, false)`,
    [sAdm, sEnc, sVen, A, B])
  await q(`insert into public.products(id, nombre, sku, is_test, control_serial) values
           ($1, 'Cargador Transf', 'TRF-NS', false, false),
           ($2, 'iPhone Transf', 'TRF-S1', false, true),
           ($3, 'Galaxy Transf', 'TRF-S2', false, true)`, [pNS, pS, pS2])
  await q(`insert into public.product_variants(id, product_id) values ($1,$2),($3,$4),($5,$6)`,
    [vNS, pNS, vS, pS, vS2, pS2])
  await q(`insert into public.inventory(variant_id, location_id, cantidad) values ($1,$2,20),($3,$2,4),($4,$2,2)`,
    [vNS, A, vS, vS2])
  await q(`insert into public.product_serials(variant_id, location_id, serial_number, estado)
           select $1, $2, 'TRFS1-'||lpad(g::text,3,'0'), 'disponible' from generate_series(1,4) g`, [vS, A])
  await q(`insert into public.product_serials(variant_id, location_id, serial_number, estado)
           select $1, $2, 'TRFS2-'||lpad(g::text,3,'0'), 'disponible' from generate_series(1,2) g`, [vS2, A])
  await q(`set local session_replication_role = origin`)

  // Ejecuta como el rol REAL del usuario y conserva el efecto si sale bien; si
  // falla, deshace sólo ese paso. Las lecturas de control van como postgres.
  const como = async (uid, sql, params = []) => {
    await q('savepoint paso')
    try {
      await q(`set local role ${uid ? 'authenticated' : 'anon'}`)
      if (uid) await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
      const r = await q(sql, params)
      await q('release savepoint paso')
      await q('reset role')
      return { filas: r.rows }
    } catch (e) {
      await q('rollback to savepoint paso').catch(() => {})
      await q('reset role').catch(() => {})
      return { error: e.message }
    }
  }

  // Si la migración no está aplicada (mutación del ensayo), se usa la firma
  // vieja de 3 argumentos para que T3 y T7 sigan ejerciéndose y fallen por su
  // COMPORTAMIENTO, no por un "function does not exist" en cascada.
  const { rows: [{ n: firma4 }] } = await q(
    `select count(*)::int as n from pg_proc p join pg_namespace s on s.oid=p.pronamespace
      where s.nspname='public' and p.proname='crear_transferencia_stock'
        and pg_get_function_identity_arguments(p.oid) = 'p_destino_id uuid, p_items jsonb, p_observacion text, p_client_transaction_id uuid'`)
  const CON_CLAVE = firma4 === 1
  const SQL_CREAR = CON_CLAVE
    ? `select (public.crear_transferencia_stock($1::uuid, $2::jsonb, null, $3::uuid)).id as id`
    : `select (public.crear_transferencia_stock($1::uuid, $2::jsonb, null)).id as id`
  const crear = (items, clave, destino = B) => como(uAdm, SQL_CREAR,
    CON_CLAVE ? [destino, JSON.stringify(items), clave] : [destino, JSON.stringify(items)])
  const despachar = (tid) => como(uAdm, `select (public.despachar_transferencia_stock($1::uuid)).estado as e`, [tid])
  const recibir = (uid, tid, clave, items, cerrar = false) => como(uid,
    `select public.recibir_transferencia_parcial($1::uuid, $2::uuid, $3::jsonb, null, $4::boolean) as d`,
    [tid, clave, items === null ? null : JSON.stringify(items), cerrar])

  const inv = async (v, l) => (await q(
    `select coalesce((select cantidad from public.inventory where variant_id=$1 and location_id=$2), 0) as c`, [v, l])).rows[0].c
  const lineas = async (tid) => (await q(
    `select * from public.transferencia_stock_items where transferencia_id=$1 order by id`, [tid])).rows
  const cab = async (tid) => (await q(`select * from public.transferencias_stock where id=$1`, [tid])).rows[0]
  const nTransf = async () => (await q(
    `select count(*)::int as n from public.transferencias_stock where origen_id=$1`, [A])).rows[0].n
  // El invariante duro del proyecto: para toda variante con IMEI,
  // inventory = nº de seriales 'disponible' en esa ubicación.
  const desincronizados = async () => (await q(`
    select i.variant_id, i.location_id, i.cantidad,
      (select count(*)::int from public.product_serials ps
        where ps.variant_id=i.variant_id and ps.location_id=i.location_id and ps.estado='disponible') as disponibles
    from public.inventory i
    join public.product_variants pv on pv.id=i.variant_id
    join public.products p on p.id=pv.product_id
    where p.control_serial and i.variant_id = any($1)`, [[vS, vS2]])).rows.filter((r) => r.cantidad !== r.disponibles)

  // --- T4 · la creación es idempotente ------------------------------------
  {
    const clave = ids()
    const contenido = [{ variant_id: vNS, cantidad: 3, serial_ids: [] }]
    const sinClave = await como(uAdm,
      `select public.crear_transferencia_stock($1::uuid, $2::jsonb, null, null)`, [B, JSON.stringify(contenido)])
    comprobar('T4 · la creación exige client_transaction_id',
      /client_transaction_id/i.test(sinClave.error || ''), sinClave.error || 'creó sin clave')
    comprobar('T4 · el intento sin clave no dejó ningún borrador', await nTransf() === 0, `hay ${await nTransf()}`)

    const c1 = await crear(contenido, clave)
    const c2 = await crear(contenido, clave)
    const id1 = c1.filas?.[0]?.id ?? null
    const id2 = c2.filas?.[0]?.id ?? null
    comprobar('T4 · el doble envío con la misma clave devuelve el MISMO borrador',
      id1 !== null && id1 === id2 && await nTransf() === 1,
      c1.error || c2.error || `t1=${id1} t2=${id2} total=${await nTransf()}`)
    const n = id1 === null ? -1 : (await q(
      `select count(*)::int as n from public.transferencia_stock_items where transferencia_id=$1`, [id1])).rows[0].n
    comprobar('T4 · tampoco duplica las líneas del borrador', n === 1, `lineas=${n}`)

    const distinto = await crear([{ variant_id: vNS, cantidad: 9, serial_ids: [] }], clave)
    comprobar('T4 · la misma clave con otro contenido se RECHAZA, no devuelve el borrador anterior',
      /contenido distinto/i.test(distinto.error || ''), distinto.error || 'lo dio por creado en silencio')
    comprobar('T4 · el rechazo no creó un segundo borrador', await nTransf() === 1, `hay ${await nTransf()}`)

    const nueva = await crear(contenido, ids())
    comprobar('T4 · una clave nueva sí crea una transferencia nueva',
      !nueva.error && id1 !== null && nueva.filas[0].id !== id1 && await nTransf() === 2,
      nueva.error || `total=${await nTransf()}`)

    // El orden de las líneas no debe cambiar la huella: es la misma petición.
    const claveOrden = ids()
    const a1 = await crear([{ variant_id: vNS, cantidad: 2, serial_ids: [] }], claveOrden)
    const a2 = await crear([{ variant_id: vNS, cantidad: 2, serial_ids: [] }], claveOrden)
    comprobar('T4 · el reintento byte a byte del mismo contenido no crea otra',
      !a2.error && a1.filas?.[0]?.id === a2.filas?.[0]?.id, a2.error)
  }

  // --- T3 · las unidades identificadas cierran la transferencia ------------
  let tidS
  {
    const { rows: ser } = await q(
      `select id, serial_number from public.product_serials where variant_id=$1 order by serial_number`, [vS])
    const c = await crear([{ variant_id: vS, cantidad: 3, serial_ids: ser.slice(0, 3).map((x) => x.id) }], ids())
    comprobar('T3 · se crea la transferencia con IMEI', !c.error, c.error)
    tidS = c.filas?.[0]?.id
    const d = await despachar(tidS)
    comprobar('T3 · el despacho la pone en tránsito', d.filas?.[0]?.e === 'en_transito', d.error || JSON.stringify(d.filas))

    const it = (tidS ? await lineas(tidS) : [])[0] || { id: null }
    const noPuede = await recibir(uVen, tidS, ids(), [{ item_id: it.id, serials: [{ serial_id: ser[0].id, resultado: 'ok' }] }])
    comprobar('T3 · un vendedor sin puede_inventario no recibe (capacidad, no puesto literal)',
      /Sin permiso/.test(noPuede.error || ''), noPuede.error || 'recibió')

    // Dos llegan bien, una no llegó. NO se pide cerrar: la transferencia tiene
    // que cerrarse sola porque ya no queda nada que identificar (deuda T3).
    const r = await recibir(uEnc, tidS, ids(), [{ item_id: it.id, serials: [
      { serial_id: ser[0].id, resultado: 'ok' },
      { serial_id: ser[1].id, resultado: 'ok' },
      { serial_id: ser[2].id, resultado: 'faltante' }] }])
    comprobar('T3 · la recepción que identifica todas las unidades se aplica', !r.error, r.error)
    const l = (tidS ? await lineas(tidS) : [])[0] || {}
    const t = tidS ? await cab(tidS) : null
    comprobar('T3 · la cabecera CIERRA SOLA con un IMEI marcado "no llegó"', t?.estado === 'recibida', `estado=${t?.estado}`)
    comprobar('T3 · la línea cuadra 2 ok + 1 faltante = 3 enviadas',
      l.cantidad_recibida === 2 && l.cantidad_faltante === 1 && l.cantidad_danada === 0,
      `ok=${l.cantidad_recibida} falt=${l.cantidad_faltante} dan=${l.cantidad_danada}`)
    comprobar('T3 · el cierre automático queda marcado con diferencias',
      l.estado_linea === 'con_diferencia' && t?.tiene_diferencias === true, `linea=${l.estado_linea} dif=${t?.tiene_diferencias}`)
    comprobar('T3 · el detalle deja de anunciar un pendiente que nadie puede recibir',
      (r.filas?.[0]?.d?.lineas || []).every((x) => x.pendiente === 0), JSON.stringify(r.filas?.[0]?.d?.lineas))
    comprobar('T3 · sólo entran al destino las unidades que llegaron',
      await inv(vS, B) === 2 && await inv(vS, A) === 1, `A=${await inv(vS, A)} B=${await inv(vS, B)}`)
    const { rows: est } = await q(
      `select estado, location_id from public.product_serials where id=$1`, [ser[2].id])
    comprobar('T3 · el IMEI que no llegó queda FALTANTE y no resucita en ninguna sucursal',
      est[0].estado === 'faltante', JSON.stringify(est[0]))
    comprobar('T3 · inventory sigue cuadrando con product_serials',
      (await desincronizados()).length === 0, JSON.stringify(await desincronizados()))
  }

  // --- T7 · un IMEI sólo se concilia en la línea de SU variante ------------
  {
    // Filtrado por ubicación: tras T3 hay unidades de vS ya 'disponible' en el
    // DESTINO, y ésas no se pueden volver a enviar desde el origen.
    const { rows: s1 } = await q(
      `select id from public.product_serials where variant_id=$1 and location_id=$2 and estado='disponible' order by serial_number`, [vS, A])
    const { rows: s2 } = await q(
      `select id from public.product_serials where variant_id=$1 and location_id=$2 and estado='disponible' order by serial_number`, [vS2, A])
    const c = await crear([
      { variant_id: vS, cantidad: 1, serial_ids: [s1[0].id] },
      { variant_id: vS2, cantidad: 2, serial_ids: s2.map((x) => x.id) }], ids())
    comprobar('T7 · se crea la transferencia de dos líneas serializadas', !c.error, c.error)
    const tid = c.filas?.[0]?.id
    const d = await despachar(tid)
    comprobar('T7 · se despacha', d.filas?.[0]?.e === 'en_transito', d.error)

    const items = tid ? await lineas(tid) : []
    const itS = items.find((x) => x.variant_id === vS) || { id: null }
    const cruzado = await recibir(uEnc, tid, ids(), [{ item_id: itS.id, serials: [{ serial_id: s2[0].id, resultado: 'ok' }] }])
    comprobar('T7 · un IMEI de OTRA variante no se concilia en esta línea',
      /no está en vuelo/i.test(cruzado.error || ''), cruzado.error || 'se aceptó el IMEI de otra variante')
    comprobar('T7 · el intento cruzado no desincronizó inventory de product_serials',
      (await desincronizados()).length === 0, JSON.stringify(await desincronizados()))

    const itS2 = items.find((x) => x.variant_id === vS2) || { id: null }
    const bien = await recibir(uEnc, tid, ids(), [
      { item_id: itS.id, serials: [{ serial_id: s1[0].id, resultado: 'ok' }] },
      { item_id: itS2.id, serials: s2.map((x) => ({ serial_id: x.id, resultado: 'ok' })) }])
    comprobar('T7 · con cada IMEI en su línea la recepción entra', !bien.error, bien.error)
    comprobar('T7 · AMBOS inventarios del destino suben',
      await inv(vS, B) === 3 && await inv(vS2, B) === 2, `S=${await inv(vS, B)} S2=${await inv(vS2, B)}`)
    comprobar('T7 · la transferencia de dos líneas cierra', (await cab(tid))?.estado === 'recibida')
    comprobar('T7 · inventory cuadra con product_serials en ambas variantes',
      (await desincronizados()).length === 0, JSON.stringify(await desincronizados()))
  }

  // --- Superficie: una sola firma y nada para anon -------------------------
  {
    const { rows: [{ n: firmas }] } = await q(
      `select count(*)::int as n from pg_proc p join pg_namespace s on s.oid=p.pronamespace
        where s.nspname='public' and p.proname='crear_transferencia_stock'`)
    comprobar('crear_transferencia_stock deja UNA sola firma (PostgREST no puede quedar con dos candidatas)',
      firmas === 1, `firmas=${firmas}`)

    const { rows: acl } = await q(
      `select p.proname as f, has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
         from pg_proc p join pg_namespace s on s.oid=p.pronamespace
        where s.nspname='public' and p.proname in
          ('crear_transferencia_stock','recibir_transferencia_parcial','transferencia_detalle',
           'cerrar_transferencia_stock','despachar_transferencia_stock','recibir_transferencia_stock')`)
    comprobar('ninguna RPC de transferencias es ejecutable por anon',
      acl.length === 6 && acl.every((r) => !r.anon), acl.filter((r) => r.anon).map((r) => r.f).join(', ') || `encontradas ${acl.length}/6`)
    comprobar('authenticated puede ejecutar todas las RPC de transferencias',
      acl.every((r) => r.auth), acl.filter((r) => !r.auth).map((r) => r.f).join(', '))

    const { rows: [{ n: hash }] } = await q(
      `select count(*)::int as n from pg_proc p join pg_namespace s on s.oid=p.pronamespace
        where s.nspname='private' and p.proname='hash_transferencia_creacion'
          and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))`)
    comprobar('el helper de huella de creación no es invocable desde fuera', hash === 0, `expuesto en ${hash}`)

    const anonCrea = await como(null, SQL_CREAR, CON_CLAVE ? [B, '[]', ids()] : [B, '[]'])
    comprobar('anon no puede crear transferencias', /permission denied/i.test(anonCrea.error || ''), anonCrea.error || 'creó')
  }

  await q('rollback').catch(() => {})
}
