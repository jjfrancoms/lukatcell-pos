// RED TEAM genérico sobre el esquema compuesto final. Se ejecuta el último (prefijo zz_).
//
// No prueba una función concreta: enumera TODO el catálogo y ataca con tres identidades.
//   A. anon: sólo puede ejecutar una lista blanca explícita.
//   B. authenticated SIN fila en staff (cuenta creada en Auth pero no vinculada): cada función
//      invocable se llama con argumentos NULL. No puede escribir nada (contadores de la
//      transacción) y no puede devolver datos salvo una lista blanca justificada.
//   C. vendedor: toda función *_admin debe fallar o no devolver nada.
//   D. crear_primer_admin no sirve para escalar cuando ya hay administrador.
//   E. search_path: ninguna función queda a merced del search_path de quien la llama.
//   F. anon: alcance real (USAGE de esquema, funciones de private, tablas y secuencias), y que
//      `authenticated` no pueda CREAR en public/private — de eso depende que `set search_path to
//      'public','private'` sea seguro en las SECURITY DEFINER.
//   G. superficie de escritura de `authenticated` a nivel de tabla (incluido TRUNCATE, que la RLS
//      NO filtra) — con explotación real, no sólo lectura del catálogo.
//   H. secuencias: USAGE/UPDATE para authenticated = setval sobre correlativos fiscales.
//   I. policies auto-cumplidas (`true`, o una columna comparada consigo misma).
//   J. privilegios de columna sobre campos de dinero o derivados, alcanzables por una policy abierta.
//   K. tablas de libro (append-only) sin trigger que bloquee UPDATE/DELETE.
// Todo ocurre en savepoints y se deshace.
//
// FALLA CERRADO. Dos reglas:
//   1. Si una enumeración no devuelve NADA, la comprobación es FAIL, no PASS: significa que la
//      consulta dejó de ver el catálogo, no que el sistema esté limpio.
//   2. Las listas blancas son estado CLASIFICADO Y FECHADO, no excepciones abiertas. Cualquier
//      objeto nuevo —lo trae la migración que lo traiga— queda fuera de ellas y FALLA nombrando
//      al culpable. Eso incluye las migraciones `_p3_*` que se estén escribiendo ahora mismo.
import crypto from 'node:crypto'

const ids = () => crypto.randomUUID()

// Funciones de `public` que anon PUEDE ejecutar. Producción (consulta de sólo lectura, 2026-09-13):
// NINGUNA; los helpers de arranque y login (hay_staff, email_por_username) sólo los ejecuta
// service_role desde Edge Functions. Cualquier función de public ejecutable por anon es un FAIL.
const ANON_PERMITIDAS = {}

// Funciones de `private` con EXECUTE para anon (herencia del EXECUTE a PUBLIC por defecto de
// PostgreSQL). Hoy NO son alcanzables porque anon no tiene USAGE sobre el esquema `private` — eso lo
// comprueba F2 aparte, y si alguna vez se concediera, estas tres quedan expuestas de golpe.
// Clasificadas una a una sobre el esquema compuesto de 5149079 (2026-09-17).
const ANON_PRIVADAS_TOLERADAS = {
  'private.auth_jornada_activa': 'sin USAGE en private no es alcanzable; sólo lee la jornada del propio auth.uid()',
  'private.calcular_business_date_lima': 'sin USAGE en private no es alcanzable; función pura de fecha, sin datos',
  'private.recalcular_total_orden_servicio': 'sin USAGE en private no es alcanzable; escribe, y por eso F3 la vigila',
}

// Funciones que un authenticated SIN staff puede ejecutar devolviendo algo no vacío, con su motivo.
// Primera ejecución del red team (2026-09-13): estas cinco devolvieron algo; clasificadas una a una.
// resumen_ganancias y mis_capacidades devolvían sólo ceros/false: no son datos (lo cubre `vacio`).
const SIN_STAFF_CON_DATOS = {
  'public.limite_descuento_actual': 'configuración no sensible (porcentaje de descuento sin autorización)',
  'public.liberar_seriales_carrito': 'devuelve true sin escribir: libera sólo reservas del propio staff, que no existe',
  'public.obtener_favoritos': 'SECURITY INVOKER: sólo devuelve catálogo que la RLS ya permite leer; sin costo (privilegio de columna)',
  'public.crear_primer_admin': 'alta del primer administrador; con uno existente falla (prueba D)',
}

// E2 — funciones sin `search_path` fijado. Ninguna es SECURITY DEFINER (E1 exige 0 y hoy se cumple:
// 155/155 lo llevan), pero las tres de append-only son triggers que corren con el search_path de
// quien dispara el INSERT/UPDATE: quien controle su search_path puede desviar las tablas que
// resuelven. `_p3_a_search_path_funciones_privadas.sql` existe en el repo para cerrarlo; mientras no
// esté aplicada en el ensayo, esta comprobación FALLA y nombra a las cuatro. NO se añaden aquí como
// toleradas a propósito: el rojo es el recordatorio.
const SIN_SEARCH_PATH_TOLERADAS = {}

// G2 — TRUNCATE no lo filtra la RLS. Ninguna tabla debe tenerlo para authenticated. Hoy lo tienen 69
// de 74 por los privilegios por defecto de producción (`grant all on tables to authenticated`), y G2
// lo demuestra vaciando auditoria_eventos dentro de un savepoint. Lista vacía a propósito.
const TRUNCATE_TOLERADO = {}

// H1 — secuencias con UPDATE (= setval) para authenticated. Las tres del release (incidencia_eventos,
// reembolso_proveedor_eventos, reimpresiones_venta) llegaron SIN privilegios: el patrón correcto ya
// se conoce. Las nueve de la base histórica son deuda abierta; van nombradas, no toleradas.
const SEQ_TOLERADAS = {}

// I — policies cuya expresión es `true` (se auto-cumplen). Clasificadas sobre 5149079 (2026-09-17).
// Sólo se toleran las de SELECT sobre maestros compartidos a propósito; ninguna de escritura.
const POLICY_ABIERTA_TOLERADA = {
  'public.clientes · clientes_lectura_autenticados · SELECT': 'clientes es un maestro compartido; _p2_d lo documenta y acota el perfil CRM aparte',
  'public.configuracion · Configuracion lectura publica · SELECT': 'parámetros no sensibles; anon no tiene SELECT de tabla (lo vigila F4)',
  'public.faqs · FAQs lectura publica · SELECT': 'contenido público de ayuda; anon no tiene SELECT de tabla (lo vigila F4)',
  'public.turnos · turnos_select_authenticated · SELECT': 'catálogo de turnos, sin datos de persona',
  // Escritura permisiva POR FILAS a propósito: el mostrador da de alta y corrige el contacto de
  // clientes que no creó él, y eso es el flujo real. Lo que acota el daño son las COLUMNAS: _p3_d
  // retira documento y direccion de `authenticated` (quedan sólo por actualizar_cliente_crm, que
  // exige administrador) y _p2_d ya había quitado puntos y consentimientos. La comprobación J
  // vigila esa lista de columnas, que es donde está de verdad el control.
  'public.clientes · clientes_actualizacion_autenticados · UPDATE': 'permisiva por filas a propósito; el control está en las columnas (J) tras _p3_d',
  'public.clientes · clientes_insercion_autenticados · INSERT': 'el alta de cliente en el mostrador es legítima; documento/direccion ya no son escribibles',
}

// K — tablas de libro: sólo se escriben añadiendo. Se detectan por convención de nombre y por lista
// explícita; si el conjunto quedara vacío la comprobación FALLA (regla 1).
const LIBRO_PATRON = /(^|_)(movimientos|eventos|historial|historia|auditoria|log|ledger|bitacora)$|^(auditoria|inventory_movements|cash_movements)/
const LIBRO_EXPLICITAS = [
  'public.auditoria_eventos', 'public.inventory_movements', 'public.cash_movements',
  'public.cliente_puntos_movimientos', 'public.orden_servicio_historial', 'public.incidencia_eventos',
  'public.reembolso_proveedor_eventos', 'public.reembolsos_proveedor', 'public.reimpresiones_venta',
  'public.product_cost_history', 'public.historial_costos_compra',
  'public.recepciones_compra', 'public.recepcion_compra_items',
]

// J — nombres de columna que son dinero o valores derivados por el servidor: nadie debería poder
// fijarlos desde el cliente si además hay una policy de escritura que se auto-cumple.
const COLUMNA_SENSIBLE = /(total|subtotal|monto|importe|saldo|costo|precio|ganancia|comision|descuento|igv|impuesto|balance|vuelto|pagado|deuda|correlativo|numero|folio|business_date|is_test|puntos|consentimiento|hash|firma)/i

// "Vacío" = sin información: null, false, 0, colecciones vacías, o filas/objetos cuyos valores son todos
// de ese tipo (p. ej. un agregado sin ventas devuelve una fila de ceros).
const vacio = (v) => {
  if (v === null || v === undefined || v === false || v === 0 || v === '0') return true
  if (Array.isArray(v)) return v.every(vacio)
  if (typeof v === 'object') return Object.values(v).every(vacio)
  return false
}

const listar = (xs, n = 12) => xs.slice(0, n).join(' | ') + (xs.length > n ? ` … (+${xs.length - n})` : '')

export default async function ({ db, comprobar }) {
  const q = (sql, p) => db.query(sql, p)
  await q('begin')

  const { rows: funciones } = await q(`
    select n.nspname || '.' || p.proname as nombre, p.oid::regprocedure::text as firma, p.proretset as conjunto,
           pg_get_function_result(p.oid) as retorno, p.pronargs as nargs, n.nspname as esquema, p.prosecdef as secdef,
           (select coalesce(array_agg(format_type(t, null) order by i), '{}') from unnest(p.proargtypes::oid[]) with ordinality as a(t, i)) as tipos,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f' and pg_get_function_result(p.oid) <> 'trigger'`)

  // --- A. anon --------------------------------------------------------------------
  comprobar('A · el catálogo de funciones de public se enumeró', funciones.length > 0, `enumeradas ${funciones.length}`)
  const anonEjecuta = funciones.filter((f) => f.anon).map((f) => f.nombre)
  const anonNoPermitidas = [...new Set(anonEjecuta.filter((n) => !ANON_PERMITIDAS[n]))]
  comprobar(`A · anon sólo ejecuta la lista blanca (${Object.keys(ANON_PERMITIDAS).length})`, anonNoPermitidas.length === 0, anonNoPermitidas.join(', '))

  // --- Identidades ------------------------------------------------------------------
  await q(`set local session_replication_role = replica`)
  const loc = ids(), uSinStaff = ids(), uVend = ids(), sVend = ids(), uAdmin = ids(), sAdmin = ids()
  await q(`insert into auth.users(id) values ($1), ($2), ($3)`, [uSinStaff, uVend, uAdmin])
  await q(`insert into public.locations(id, nombre) values ($1, 'Sede Red Team')`, [loc])
  await q(`insert into public.staff(id, nombre, username, rol, puesto, activo, user_id, location_id) values
           ($1, 'RT Vendedor', 'rt-vend', 'cajero', 'vendedor', true, $2, $5),
           ($3, 'RT Admin', 'rt-admin', 'administrador', 'jefa', true, $4, $5)`, [sVend, uVend, sAdmin, uAdmin, loc])
  await q(`set local session_replication_role = origin`)

  // Ejecuta `sql` como `authenticated` con el JWT de `uid` y lo deshace siempre.
  const comoAuth = async (uid, sql, params) => {
    await q('savepoint rt_como')
    try {
      await q('set local role authenticated')
      await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
      await q('savepoint rt_op')
      try {
        const r = await q(sql, params)
        return { ok: true, filas: r.rowCount, resultado: r.rows[0] }
      } catch (e) {
        await q('rollback to savepoint rt_op')
        return { ok: false, error: e.message.split('\n')[0] }
      }
    } finally {
      await q('rollback to savepoint rt_como')
    }
  }

  const llamar = async (uid, f) => {
    const args = f.tipos.map((t) => `null::${t}`).join(', ')
    const sql = f.conjunto ? `select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) as r from ${f.nombre}(${args}) x` : `select to_jsonb(${f.nombre}(${args})) as r`
    await q('savepoint rt')
    try {
      await q('set local role authenticated')
      await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
      const antes = (await q(`select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::bigint n from pg_stat_xact_user_tables`)).rows[0].n
      let resultado, error
      await q('savepoint llamada')
      try { resultado = (await q(sql)).rows[0]?.r } catch (e) { error = e.message; await q('rollback to savepoint llamada') }
      const despues = (await q(`select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::bigint n from pg_stat_xact_user_tables`)).rows[0].n
      return { resultado, error, escribio: Number(despues) - Number(antes) }
    } finally {
      await q('rollback to savepoint rt')
    }
  }

  const invocables = funciones.filter((f) => f.auth)

  // --- B. authenticated sin staff ------------------------------------------------------
  const escrituras = [], filtraciones = []
  for (const f of invocables) {
    const r = await llamar(uSinStaff, f)
    if (r.escribio > 0 && !SIN_STAFF_CON_DATOS[f.nombre]) escrituras.push(`${f.nombre} (${r.escribio})`)
    if (!r.error && !vacio(r.resultado) && !SIN_STAFF_CON_DATOS[f.nombre]) filtraciones.push(`${f.nombre} → ${JSON.stringify(r.resultado).slice(0, 80)}`)
  }
  comprobar(`B · ninguna de ${invocables.length} funciones escribe para un usuario sin staff`, escrituras.length === 0 && invocables.length > 0, escrituras.join(' | ') || 'no se invocó ninguna función')
  comprobar(`B · ninguna función devuelve datos a un usuario sin staff (salvo lista blanca)`, filtraciones.length === 0, listar(filtraciones))

  // --- C. vendedor contra funciones *_admin ------------------------------------------------
  const admins = invocables.filter((x) => /_admin$/.test(x.nombre))
  const adminFiltra = []
  for (const f of admins) {
    const r = await llamar(uVend, f)
    if (!r.error && !vacio(r.resultado)) adminFiltra.push(`${f.nombre} → ${JSON.stringify(r.resultado).slice(0, 80)}`)
    if (!r.error && r.escribio > 0) adminFiltra.push(`${f.nombre} escribió ${r.escribio}`)
  }
  comprobar('C · un vendedor no obtiene datos ni escribe con ninguna función *_admin', adminFiltra.length === 0 && admins.length > 0, listar(adminFiltra) || 'no se enumeró ninguna función *_admin')

  // --- D. crear_primer_admin no sirve para escalar cuando ya hay administrador -------------
  const d = await comoAuth(uSinStaff, `select public.crear_primer_admin('Intruso', 'intruso')`)
  comprobar('D · crear_primer_admin no crea un administrador si ya existe uno', !d.ok, d.error || 'creó un administrador')

  // --- E. search_path -----------------------------------------------------------------
  // Una función sin `search_path` fijado resuelve sus tablas con el search_path de quien la llama.
  // En SECURITY DEFINER eso es escalada directa; en un trigger append-only, desvío del control.
  const { rows: sp } = await q(`
    select n.nspname || '.' || p.proname as nombre, p.oid::regprocedure::text as firma, p.prosecdef as secdef
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public','private') and p.prokind = 'f'
       and (p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search\\_path=%'))
     order by 1`)
  const { rows: [{ n: nSecdef }] } = await q(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public','private') and p.prokind = 'f' and p.prosecdef`)
  comprobar('E1 · hay funciones SECURITY DEFINER que auditar', nSecdef > 0, `enumeradas ${nSecdef}`)
  const secdefSinSp = sp.filter((f) => f.secdef).map((f) => f.firma)
  comprobar('E1 · ninguna función SECURITY DEFINER queda sin search_path fijado', secdefSinSp.length === 0, listar(secdefSinSp))
  const sinSp = sp.filter((f) => !SIN_SEARCH_PATH_TOLERADAS[f.nombre]).map((f) => f.firma)
  comprobar('E2 · ninguna función de public/private queda sin search_path fijado', sinSp.length === 0, listar(sinSp))

  // --- F. alcance real de anon ---------------------------------------------------------
  const { rows: esquemas } = await q(`select nspname, has_schema_privilege('anon', oid, 'USAGE') as anon
     from pg_namespace where nspname in ('public','private') order by 1`)
  comprobar('F1 · se resolvieron los esquemas public y private', esquemas.length === 2, JSON.stringify(esquemas))
  const privAnon = esquemas.find((e) => e.nspname === 'private')
  comprobar('F2 · anon NO tiene USAGE sobre el esquema private', privAnon && privAnon.anon === false, JSON.stringify(privAnon))

  const { rows: privFn } = await q(`select n.nspname || '.' || p.proname as nombre, p.oid::regprocedure::text as firma
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'EXECUTE') order by 1`)
  const privFnNuevas = privFn.filter((f) => !ANON_PRIVADAS_TOLERADAS[f.nombre]).map((f) => f.firma)
  comprobar('F3 · ninguna función NUEVA de private queda con EXECUTE para anon', privFnNuevas.length === 0, listar(privFnNuevas))

  // Las funciones nuevas usan `set search_path to 'public','private'` en vez de `''`. Eso sólo es
  // seguro mientras `authenticated` no pueda crear objetos en esos esquemas: si pudiera, plantaría
  // una tabla o función homónima y la resolvería antes que la real.
  const { rows: creables } = await q(`select nspname, has_schema_privilege('authenticated', oid, 'CREATE') as crea
     from pg_namespace where nspname in ('public','private') order by 1`)
  const conCreate = creables.filter((e) => e.crea).map((e) => e.nspname)
  comprobar('F5 · authenticated no puede CREAR objetos en public ni private (si pudiera, el search_path `public, private` de las SECURITY DEFINER sería secuestrable)',
    conCreate.length === 0 && creables.length === 2, conCreate.join(', ') || `esquemas resueltos: ${creables.length}`)

  const { rows: anonTablas } = await q(`select table_schema || '.' || table_name as t, string_agg(distinct privilege_type, ',' order by privilege_type) as p
     from information_schema.role_table_grants where table_schema in ('public','private') and grantee = 'anon' group by 1 order by 1`)
  comprobar('F4 · anon no tiene ningún privilegio de tabla en public/private', anonTablas.length === 0, listar(anonTablas.map((r) => `${r.t}:${r.p}`)))
  const { rows: anonSeq } = await q(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'S' and n.nspname in ('public','private')
       and (has_sequence_privilege('anon', c.oid, 'USAGE') or has_sequence_privilege('anon', c.oid, 'UPDATE')
            or has_sequence_privilege('anon', c.oid, 'SELECT')) order by 1`)
  comprobar('F4 · anon no tiene ningún privilegio de secuencia', anonSeq.length === 0, listar(anonSeq.map((r) => r.relname)))

  // --- G. superficie de escritura de authenticated a nivel de tabla ----------------------
  const { rows: tablas } = await q(`select n.nspname || '.' || c.relname as t, c.relrowsecurity as rls, c.relforcerowsecurity as forzada
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r' and n.nspname in ('public','private') order by 1`)
  comprobar('G1 · se enumeraron las tablas de public/private', tablas.length > 0, `enumeradas ${tablas.length}`)
  const sinRls = tablas.filter((t) => !t.rls).map((t) => t.t)
  comprobar('G1 · ninguna tabla de public/private está sin RLS', sinRls.length === 0, listar(sinRls))

  const { rows: grants } = await q(`select table_schema || '.' || table_name as t, grantee,
       string_agg(distinct privilege_type, ',' order by privilege_type) as p
     from information_schema.role_table_grants
    where table_schema in ('public','private') and grantee = 'authenticated'
      and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE') group by 1, 2 order by 1`)
  comprobar('G2 · se enumeraron los privilegios de escritura de authenticated', grants.length > 0, `enumerados ${grants.length}`)
  const conTruncate = grants.filter((g) => g.p.includes('TRUNCATE') && !TRUNCATE_TOLERADO[g.t]).map((g) => g.t)
  comprobar(`G2 · ninguna tabla concede TRUNCATE a authenticated (la RLS no filtra TRUNCATE) — ${conTruncate.length}/${tablas.length}`,
    conTruncate.length === 0, listar(conTruncate))

  // Explotación: no basta con leer el catálogo. Se intenta vaciar de verdad el libro de auditoría
  // como un authenticated SIN fila en staff. Si el TRUNCATE pasa, el privilegio es explotable.
  const libroAuditoria = tablas.find((t) => t.t === 'public.auditoria_eventos')
  comprobar('G3 · existe public.auditoria_eventos para atacarla', !!libroAuditoria, 'no está en el catálogo')
  if (libroAuditoria) {
    const t = await comoAuth(uSinStaff, `truncate table public.auditoria_eventos`)
    comprobar('G3 · un authenticated sin staff NO puede vaciar el libro de auditoría con TRUNCATE',
      !t.ok, t.ok ? 'TRUNCATE de public.auditoria_eventos ACEPTADO: la RLS no interviene en TRUNCATE' : t.error)
  }

  // --- H. secuencias --------------------------------------------------------------------
  const { rows: seqs } = await q(`select n.nspname || '.' || c.relname as s,
       has_sequence_privilege('authenticated', c.oid, 'USAGE') as usa,
       has_sequence_privilege('authenticated', c.oid, 'UPDATE') as escribe
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'S' and n.nspname in ('public','private') order by 1`)
  comprobar('H1 · se enumeraron las secuencias', seqs.length > 0, `enumeradas ${seqs.length}`)
  const seqAbiertas = seqs.filter((s) => (s.usa || s.escribe) && !SEQ_TOLERADAS[s.s])
    .map((s) => `${s.s}(${[s.usa && 'USAGE', s.escribe && 'UPDATE'].filter(Boolean).join('+')})`)
  comprobar(`H1 · ninguna secuencia concede USAGE/UPDATE a authenticated — ${seqAbiertas.length}/${seqs.length}`,
    seqAbiertas.length === 0, listar(seqAbiertas))

  // Explotación: UPDATE sobre una secuencia es `setval`. Sobre un correlativo fiscal significa poder
  // repetir o saltar números de boleta. Se intenta de verdad sobre la primera secuencia de correlativo.
  const seqFiscal = seqs.find((s) => /correlativo|numero_seq/.test(s.s) && s.escribe)
  if (seqFiscal) {
    const r = await comoAuth(uSinStaff, `select setval($1::regclass, 1, false)`, [seqFiscal.s])
    comprobar(`H2 · un authenticated sin staff NO puede reescribir un correlativo con setval (${seqFiscal.s})`,
      !r.ok, r.ok ? `setval ACEPTADO sobre ${seqFiscal.s}: correlativo fiscal reescribible desde el cliente` : r.error)
  } else {
    comprobar('H2 · no hay secuencia de correlativo con UPDATE para authenticated que explotar', seqs.length > 0, 'sin secuencias enumeradas')
  }

  // --- I. policies que se auto-cumplen ---------------------------------------------------
  const { rows: policies } = await q(`select schemaname || '.' || tablename as t, policyname, cmd, permissive,
       coalesce(roles::text, '') as roles, coalesce(qual, '') as qual, coalesce(with_check, '') as wc
     from pg_policies where schemaname in ('public','private') order by 1, 2`)
  comprobar('I · se enumeraron las policies', policies.length > 0, `enumeradas ${policies.length}`)
  // `X = X`: la misma columna (o la misma expresión calificada) comparada consigo misma. Siempre cierta
  // salvo NULL, así que no filtra nada. Es el defecto que _p2_c corrigió en cliente_puntos_movimientos.
  const AUTOIGUAL = /\b([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)*)\s*=\s*\1\b/
  const abiertas = [], autoiguales = []
  for (const p of policies) {
    for (const [expr, cual] of [[p.qual, 'USING'], [p.wc, 'CHECK']]) {
      if (!expr) continue
      const clave = `${p.t} · ${p.policyname} · ${p.cmd}`
      if (/^\s*\(?\s*true\s*\)?\s*$/i.test(expr) && !POLICY_ABIERTA_TOLERADA[clave]) abiertas.push(`${clave} ${cual}=true roles=${p.roles}`)
      if (AUTOIGUAL.test(expr)) autoiguales.push(`${clave} ${cual}=${expr.replace(/\s+/g, ' ').slice(0, 80)}`)
    }
  }
  comprobar('I1 · ninguna policy se auto-cumple con `true` fuera de la lista clasificada', abiertas.length === 0, listar(abiertas))
  comprobar('I2 · ninguna policy compara una columna consigo misma', autoiguales.length === 0, listar(autoiguales))

  // --- J. privilegios de columna sobre dinero y campos derivados --------------------------
  const { rows: cols } = await q(`select table_schema || '.' || table_name as t, column_name as c,
       string_agg(distinct privilege_type, ',' order by privilege_type) as p
     from information_schema.column_privileges
    where table_schema in ('public','private') and grantee = 'authenticated'
      and privilege_type in ('INSERT','UPDATE') group by 1, 2 order by 1, 2`)
  comprobar('J · se enumeraron los privilegios de columna de authenticated', cols.length > 0, `enumerados ${cols.length}`)
  // Sólo son alcanzables si además existe una policy de escritura que se auto-cumple sobre esa tabla:
  // ahí el privilegio de columna es lo ÚNICO que separa al cliente del campo.
  const tablasEscrituraAbierta = new Set(policies
    .filter((p) => ['ALL', 'INSERT', 'UPDATE'].includes(p.cmd) && /^\s*\(?\s*true\s*\)?\s*$/i.test(p.wc || p.qual))
    .map((p) => p.t))
  const dinero = cols.filter((x) => COLUMNA_SENSIBLE.test(x.c) && tablasEscrituraAbierta.has(x.t))
    .map((x) => `${x.t}.${x.c} (${x.p})`)
  comprobar('J · ningún campo de dinero o derivado es escribible bajo una policy que se auto-cumple', dinero.length === 0, listar(dinero))

  // Explotación: se siembra un cliente ajeno y se intenta reescribir su documento sin ser admin.
  const cli = ids()
  await q(`set local session_replication_role = replica`)
  await q(`insert into public.clientes(id, nombre, documento) values ($1, 'Cliente Ajeno RT', '00000000')`, [cli])
  await q(`set local session_replication_role = origin`)
  const upd = await comoAuth(uSinStaff, `update public.clientes set documento = 'SUPLANTADO' where id = $1`, [cli])
  comprobar('J · un authenticated sin staff NO puede reescribir el documento de un cliente ajeno',
    !upd.ok || upd.filas === 0, upd.ok ? `UPDATE aceptado, ${upd.filas} fila(s): policy clientes_actualizacion_autenticados = true` : upd.error)

  // --- K. tablas de libro sin trigger append-only -----------------------------------------
  const { rows: trg } = await q(`select n.nspname || '.' || c.relname as t, tg.tgname,
       (tg.tgtype & 4) = 0 as after_row, ((tg.tgtype & 16) <> 0 or (tg.tgtype & 8) <> 0) as upd_o_del
     from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where not tg.tgisinternal and n.nspname in ('public','private')`)
  const bloquea = new Set(trg.filter((t) => t.upd_o_del).map((t) => t.t))
  const grantsPorTabla = new Map(grants.map((g) => [g.t, g.p]))
  const libro = tablas.map((t) => t.t).filter((t) => {
    const corto = t.split('.')[1]
    return LIBRO_EXPLICITAS.includes(t) || LIBRO_PATRON.test(corto)
  })
  comprobar('K · el conjunto de tablas de libro no está vacío', libro.length > 0, `detectadas ${libro.length}`)
  // Una tabla de libro está protegida si tiene trigger que intercepta UPDATE/DELETE, o si authenticated
  // no tiene UPDATE ni DELETE sobre ella. TRUNCATE lo vigila G2 aparte: ningún trigger lo intercepta.
  const desprotegidas = libro.filter((t) => {
    if (bloquea.has(t)) return false
    const p = grantsPorTabla.get(t) || ''
    return p.includes('UPDATE') || p.includes('DELETE')
  })
  comprobar(`K · toda tabla de libro es append-only por trigger o sin UPDATE/DELETE para authenticated (${libro.length} tablas)`,
    desprotegidas.length === 0, listar(desprotegidas.map((t) => `${t} [${grantsPorTabla.get(t)}]`)))
}
