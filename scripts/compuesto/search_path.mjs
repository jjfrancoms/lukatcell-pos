// P3.A · search_path fijado en TODA función de public/private.
//
// Invariante que vigila este módulo: ninguna función de `public` ni de `private`
// puede quedarse con proconfig sin search_path. Una función así resuelve los
// nombres sin cualificar con el camino de búsqueda que traiga quien la llame, que
// es exactamente lo que marca el linter de Supabase como
// `function_search_path_mutable`.
//
// FALLO CERRADO. La comprobación no es "la consulta no devolvió culpables". Es
// "la consulta devolvió un censo creíble de funciones Y dentro de él no hay
// culpables". Si el censo viniera vacío o absurdamente corto —esquema a medias,
// migración que no aplicó, consulta rota— esto es FAIL, nunca PASS.
//
// Además comprueba que la corrección no se llevó nada por delante: las 4
// funciones que _p3_a tocó conservan su cuerpo (md5(prosrc) de producción), su
// ACL restringida y su comportamiento, y siguen sin ser ejecutables por el rol
// real `authenticated` (con SET ROLE, no de palabra).

// md5(prosrc) capturados de producción. Si cambian, alguien tocó el cuerpo.
const CUERPOS = {
  'private.hash_recepcion(uuid,jsonb)': '16e0a66e09b12894dc8e8b85dea0f1ce',
  'private.incidencia_eventos_append_only()': '783661bb6b9b135421337abfb9367cd9',
  'private.reimpresiones_venta_append_only()': '8387ba0622be6cb193781c690e7afc69',
  'private.reembolsos_proveedor_append_only()': '039d88da4845fd322ca197e79c2a4dfa',
}

// Producción tenía 167 funciones en public+private antes de las migraciones
// nuevas, y éstas sólo añaden. Un censo por debajo de esto no es un esquema sano.
const CENSO_MINIMO = 167

// Firma canónica, independiente del search_path de la sesión y sin nombres de
// parámetro: `private.hash_recepcion(uuid,jsonb)`. Ni regprocedure (que omite el
// esquema si la función es visible) ni pg_get_function_identity_arguments (que
// incluye los nombres) sirven aquí.
const FIRMA = `n.nspname || '.' || p.proname || '(' ||
  coalesce((select string_agg(format_type(t, null), ',' order by o)
              from unnest(p.proargtypes) with ordinality as a(t, o)), '') || ')'`

export default async function ({ db, comprobar }) {
  const q = (sql, p) => db.query(sql, p)
  await q('begin')

  // --- 1. Censo completo: ninguna función sin search_path fijado -------------
  let censo = null
  try {
    censo = (await q(`
      select count(*)::int as total,
             count(*) filter (where not exists (
               select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search\\_path=%'
             ))::int as sin_fijar,
             coalesce(array_agg(${FIRMA} order by ${FIRMA} collate "C")
                      filter (where not exists (
                        select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search\\_path=%'
                      )), '{}'::text[]) as culpables
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private')`)).rows[0]
  } catch (e) {
    censo = { error: e.message }
  }

  comprobar('el censo de funciones de public/private se puede leer y es creíble',
    !censo.error && Number.isInteger(censo.total) && censo.total >= CENSO_MINIMO,
    censo.error || `censo = ${censo.total} funciones (mínimo creíble ${CENSO_MINIMO}); sin censo no hay veredicto`)

  comprobar('ninguna función de public/private queda con el search_path a merced de quien llame',
    !censo.error && censo.total >= CENSO_MINIMO && censo.sin_fijar === 0,
    censo.error || (censo.total < CENSO_MINIMO
      ? 'no se comprueba: el censo no es creíble'
      : `${censo.sin_fijar} sin search_path: ${(censo.culpables || []).join(', ')}`))

  // --- 2. Las 4 corregidas: search_path mínimo, cuerpo intacto, ACL intacta --
  const { rows: cuatro } = await q(`
    select ${FIRMA} as firma, md5(p.prosrc) as md5, coalesce(p.proconfig::text, '<nulo>') as proconfig,
           coalesce((select c from unnest(coalesce(p.proconfig, '{}'::text[])) c
                      where c like 'search\\_path=%' limit 1), '<sin search_path>') as sp,
           coalesce(p.proacl::text, '<nulo>') as acl, p.prosecdef, a.rolname as owner,
           p.provolatile, p.prorettype::regtype::text as rettype,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_authid a on a.oid = p.proowner
     where ${FIRMA} = any($1)`, [Object.keys(CUERPOS)])

  comprobar('las 4 funciones que corrige _p3_a existen, una sola vez cada una',
    cuatro.length === 4, `encontradas ${cuatro.length}: ${cuatro.map((r) => r.firma).join(', ')}`)

  for (const firma of Object.keys(CUERPOS)) {
    const f = cuatro.find((r) => r.firma === firma)
    if (!f) { comprobar(`${firma} · presente`, false, 'no encontrada'); continue }
    // proconfig EXACTO: `search_path=` (vacío). Ni public ni extensions: estas 4
    // sólo usan pg_catalog, que es implícito y no se puede quitar.
    comprobar(`${firma} · search_path fijado al mínimo (vacío)`,
      f.sp === 'search_path=""', `entrada de proconfig = ${f.sp} · proconfig = ${f.proconfig}`)
    comprobar(`${firma} · el cuerpo no cambió`, f.md5 === CUERPOS[firma], `md5(prosrc) = ${f.md5}, esperado ${CUERPOS[firma]}`)
    comprobar(`${firma} · sigue con la ACL restringida {postgres=X/postgres}`,
      f.acl === '{postgres=X/postgres}' && f.anon === false && f.auth === false,
      `acl = ${f.acl}, anon = ${f.anon}, authenticated = ${f.auth}`)
    comprobar(`${firma} · sigue SECURITY INVOKER y propiedad de postgres`,
      f.prosecdef === false && f.owner === 'postgres', `prosecdef = ${f.prosecdef}, owner = ${f.owner}`)
  }

  const hr = cuatro.find((r) => r.firma === 'private.hash_recepcion(uuid,jsonb)')
  comprobar('hash_recepcion sigue siendo immutable y devolviendo text',
    hr?.provolatile === 'i' && hr?.rettype === 'text', `${hr?.provolatile} / ${hr?.rettype}`)
  const triggers = cuatro.filter((r) => r.firma !== 'private.hash_recepcion(uuid,jsonb)')
  comprobar('las 3 funciones append-only siguen siendo volatile y devolviendo trigger',
    triggers.length === 3 && triggers.every((r) => r.provolatile === 'v' && r.rettype === 'trigger'),
    triggers.map((r) => `${r.firma}:${r.provolatile}/${r.rettype}`).join(', '))

  // --- 3. Los triggers que las usan siguen en pie y apuntando a lo mismo -----
  const esperados = [
    ['incidencia_eventos', 'incidencia_eventos_append_only', 'incidencia_eventos_append_only'],
    ['reimpresiones_venta', 'reimpresiones_venta_append_only', 'reimpresiones_venta_append_only'],
    ['reembolsos_proveedor', 'reembolsos_proveedor_append_only', 'reembolsos_proveedor_append_only'],
    ['reembolso_proveedor_eventos', 'reembolso_proveedor_eventos_append_only', 'reembolsos_proveedor_append_only'],
    ['conciliaciones_pago', 'trg_conciliacion_pago_deriva_venta', null],
  ]
  const { rows: trg } = await q(`
    select c.relname as tabla, t.tgname as trigger, pn.nspname || '.' || p.proname as funcion
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_proc p on p.oid = t.tgfoid
      join pg_namespace pn on pn.oid = p.pronamespace
     where not t.tgisinternal and n.nspname = 'public' and t.tgname = any($1)`,
    [esperados.map(([, nombre]) => nombre)])
  for (const [tabla, nombre, funcion] of esperados) {
    const f = trg.find((r) => r.tabla === tabla && r.trigger === nombre)
    comprobar(`el trigger ${nombre} sigue en public.${tabla}${funcion ? ` apuntando a private.${funcion}` : ''}`,
      !!f && (!funcion || f.funcion === `private.${funcion}`), f ? `apunta a ${f.funcion}` : 'no existe')
  }

  // --- 4. Comportamiento: siguen funcionando con el search_path vacío --------
  // hash_recepcion debe dar el MISMO hash venga el llamante con el search_path
  // que venga. Antes dependía del ambiente; ahora no puede depender.
  const muestra = JSON.stringify([{
    orden_item_id: '11111111-1111-1111-1111-111111111111', cantidad: '3.0', cantidad_danada: '',
    acepta_sobrante: true, observacion: '  raya en la caja  ',
    seriales: [{ serial_number: ' B222 ', imei2: '', danado: false }, { serial_number: 'A111', danado: true }],
  }])
  const hashes = []
  let errHash = null
  for (const camino of [`pg_catalog, public`, `public`, `pg_temp`, `''`]) {
    await q('savepoint camino')
    try {
      await q(`set local search_path = ${camino}`)
      hashes.push((await q(`select private.hash_recepcion($1::uuid, $2::jsonb) as h`,
        ['22222222-2222-2222-2222-222222222222', muestra])).rows[0].h)
    } catch (e) { errHash = e.message } finally { await q('rollback to savepoint camino') }
  }
  comprobar('hash_recepcion sigue calculando y da el mismo resultado con cualquier search_path del llamante',
    !errHash && hashes.length === 4 && /^[0-9a-f]{32}$/.test(hashes[0]) && new Set(hashes).size === 1,
    errHash || JSON.stringify(hashes))

  // Las 3 de trigger, montadas sobre tablas de usar y tirar: se comprueba que con
  // el search_path vacío siguen levantando su excepción (y que tg_table_name, que
  // usa la de reembolsos, se sigue resolviendo).
  for (const [funcion, tabla, patron] of [
    ['incidencia_eventos_append_only', 'p3a_inc', /incidencia_eventos es de sólo inserción/],
    ['reimpresiones_venta_append_only', 'p3a_reimp', /reimpresiones_venta es de sólo inserción/],
    ['reembolsos_proveedor_append_only', 'p3a_reemb', /^p3a_reemb es de sólo inserción$/],
  ]) {
    await q('savepoint trg')
    let upd = null, del = null
    try {
      await q(`create table pg_temp.${tabla}(id int)`)
      await q(`create trigger t_${tabla} before update or delete on pg_temp.${tabla}
               for each row execute function private.${funcion}()`)
      await q(`insert into pg_temp.${tabla}(id) values (1)`)
      // Cada intento en su propio savepoint: el primero aborta la transacción y
      // sin esto el segundo no llegaría a ejecutarse.
      const intento = async (sql) => {
        await q('savepoint intento')
        const e = await q(sql).then(() => null, (err) => err.message)
        await q(e ? 'rollback to savepoint intento' : 'release savepoint intento')
        return e
      }
      upd = await intento(`update pg_temp.${tabla} set id = 2`)
      del = await intento(`delete from pg_temp.${tabla}`)
    } catch (e) { upd = `montaje: ${e.message}` } finally { await q('rollback to savepoint trg') }
    comprobar(`private.${funcion} sigue bloqueando UPDATE y DELETE con el search_path vacío`,
      patron.test(upd || '') && patron.test(del || ''), `update: ${upd || 'no falló'} · delete: ${del || 'no falló'}`)
  }

  // --- 5. Permisos con el rol REAL, no de palabra ---------------------------
  const llamadas = [
    [`select private.hash_recepcion(null::uuid, null::jsonb)`, 'private.hash_recepcion'],
    [`select private.incidencia_eventos_append_only()`, 'private.incidencia_eventos_append_only'],
    [`select private.reimpresiones_venta_append_only()`, 'private.reimpresiones_venta_append_only'],
    [`select private.reembolsos_proveedor_append_only()`, 'private.reembolsos_proveedor_append_only'],
  ]
  for (const rol of ['authenticated', 'anon']) {
    for (const [sql, nombre] of llamadas) {
      await q('savepoint rol')
      let err = null
      try {
        await q(`set local role ${rol}`)
        await q(sql)
      } catch (e) { err = e.message } finally { await q('rollback to savepoint rol') }
      comprobar(`${rol} no puede ejecutar ${nombre}`, /permission denied/i.test(err || ''), err || 'la ejecutó')
    }
  }

  await q('rollback').catch(() => {})
}
