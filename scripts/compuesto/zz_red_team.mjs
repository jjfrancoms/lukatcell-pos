// RED TEAM genérico sobre el esquema compuesto final. Se ejecuta el último (prefijo zz_).
//
// No prueba una función concreta: enumera TODAS las funciones públicas y ataca con tres identidades.
//   A. anon: sólo puede ejecutar una lista blanca explícita.
//   B. authenticated SIN fila en staff (cuenta creada en Auth pero no vinculada): cada función
//      invocable se llama con argumentos NULL. No puede escribir nada (contadores de la
//      transacción) y no puede devolver datos salvo una lista blanca justificada.
//   C. vendedor: toda función *_admin debe fallar o no devolver nada.
// Todo ocurre en savepoints y se deshace.
import crypto from 'node:crypto'

const ids = () => crypto.randomUUID()

// Funciones que anon PUEDE ejecutar. Producción (consulta de sólo lectura, 2026-09-13): NINGUNA; los
// helpers de arranque y login (hay_staff, email_por_username) sólo los ejecuta service_role desde Edge
// Functions. Cualquier función ejecutable por anon es un FAIL.
const ANON_PERMITIDAS = {}

// Funciones que un authenticated SIN staff puede ejecutar devolviendo algo no vacío, con su motivo.
// Primera ejecución del red team (2026-09-13): estas cinco devolvieron algo; clasificadas una a una.
// resumen_ganancias y mis_capacidades devolvían sólo ceros/false: no son datos (lo cubre `vacio`).
const SIN_STAFF_CON_DATOS = {
  'public.limite_descuento_actual': 'configuración no sensible (porcentaje de descuento sin autorización)',
  'public.liberar_seriales_carrito': 'devuelve true sin escribir: libera sólo reservas del propio staff, que no existe',
  'public.obtener_favoritos': 'SECURITY INVOKER: sólo devuelve catálogo que la RLS ya permite leer; sin costo (privilegio de columna)',
  'public.crear_primer_admin': 'alta del primer administrador; con uno existente falla (prueba D)',
}

// "Vacío" = sin información: null, false, 0, colecciones vacías, o filas/objetos cuyos valores son todos
// de ese tipo (p. ej. un agregado sin ventas devuelve una fila de ceros).
const vacio = (v) => {
  if (v === null || v === undefined || v === false || v === 0 || v === '0') return true
  if (Array.isArray(v)) return v.every(vacio)
  if (typeof v === 'object') return Object.values(v).every(vacio)
  return false
}

export default async function ({ db, comprobar }) {
  const q = (sql, p) => db.query(sql, p)
  await q('begin')

  const { rows: funciones } = await q(`
    select n.nspname || '.' || p.proname as nombre, p.oid::regprocedure::text as firma, p.proretset as conjunto,
           pg_get_function_result(p.oid) as retorno, p.pronargs as nargs,
           (select coalesce(array_agg(format_type(t, null) order by i), '{}') from unnest(p.proargtypes::oid[]) with ordinality as a(t, i)) as tipos,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f' and pg_get_function_result(p.oid) <> 'trigger'`)

  // --- A. anon --------------------------------------------------------------------
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
  comprobar(`B · ninguna de ${invocables.length} funciones escribe para un usuario sin staff`, escrituras.length === 0, escrituras.join(' | '))
  comprobar(`B · ninguna función devuelve datos a un usuario sin staff (salvo lista blanca)`, filtraciones.length === 0, filtraciones.slice(0, 12).join(' | '))

  // --- C. vendedor contra funciones *_admin ------------------------------------------------
  const adminFiltra = []
  for (const f of invocables.filter((x) => /_admin$/.test(x.nombre))) {
    const r = await llamar(uVend, f)
    if (!r.error && !vacio(r.resultado)) adminFiltra.push(`${f.nombre} → ${JSON.stringify(r.resultado).slice(0, 80)}`)
    if (!r.error && r.escribio > 0) adminFiltra.push(`${f.nombre} escribió ${r.escribio}`)
  }
  comprobar('C · un vendedor no obtiene datos ni escribe con ninguna función *_admin', adminFiltra.length === 0, adminFiltra.slice(0, 12).join(' | '))

  // --- D. crear_primer_admin no sirve para escalar cuando ya hay administrador -------------
  const d = await llamar(uSinStaff, { nombre: 'public.crear_primer_admin', tipos: ['text', 'text'], conjunto: false })
  const dConArgs = await (async () => {
    await q('savepoint rt2')
    try {
      await q('set local role authenticated')
      await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uSinStaff, role: 'authenticated' })])
      await q('savepoint c')
      try { await q(`select public.crear_primer_admin('Intruso', 'intruso')`); return { error: null } } catch (e) { await q('rollback to savepoint c'); return { error: e.message } }
    } finally { await q('rollback to savepoint rt2') }
  })()
  comprobar('D · crear_primer_admin no crea un administrador si ya existe uno', !!dConArgs.error, dConArgs.error || 'creó un administrador')
  void d
}
