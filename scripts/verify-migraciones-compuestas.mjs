#!/usr/bin/env node
// ============================================================================
// ENSAYO COMPUESTO DE MIGRACIONES
//
// Cada suite de P1 aplica SÓLO su migración sobre un esquema mínimo. Este
// ensayo aplica, sobre un PostgreSQL real local, las 153 migraciones de
// producción en orden y compara la HUELLA del esquema resultante con la de
// producción. Sólo si coincide aplica encima las 4 migraciones de P1 y
// comprueba el esquema compuesto.
//
// Por qué la huella: que los archivos locales coincidan en versión con
// producción no garantiza que produzcan el mismo esquema. Algo cambiado a mano
// desde el panel no deja rastro en los archivos.
//
// Shim de Supabase: roles, auth, storage, extensiones en `extensions` y los
// privilegios por defecto reales de producción. `pg_net` no existe en local:
// net.http_post es un DOBLE que registra la llamada y nunca hace HTTP.
//
// Falla CERRADO: exit 1 ante cualquier fallo. Nunca un SKIP en verde.
// ============================================================================

import fs from 'node:fs'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { sustituirCapacidades, quedaAutorizacionPorPuesto } from './lib/capacidades.mjs'

const RAIZ = new URL('..', import.meta.url).pathname
const AISLADO = RAIZ + '.p04-pgtest/'
// Referencias de producción por función (firmas y md5, sin datos ni secretos), capturadas con consultas de
// sólo lectura. Versionadas para que el ensayo corra igual en CI.
const REFERENCIAS = RAIZ + 'scripts/referencias/'
const MIGRACIONES = RAIZ + 'supabase/migrations/'

function abortar(motivo) {
  console.error('ENSAYO COMPUESTO: NO EJECUTADO\n')
  console.error(`  ${motivo}\n`)
  console.error('  Para ejecutarlo: cd .p04-pgtest && npm install   (una vez)')
  process.exit(1)
}

let EmbeddedPostgres, pg
try {
  EmbeddedPostgres = (await import('file://' + AISLADO + 'node_modules/embedded-postgres/dist/index.js')).default
  pg = createRequire(AISLADO + 'package.json')('pg')
} catch (e) {
  abortar(`Falta el entorno aislado .p04-pgtest/: ${e.message}`)
}

// Huella de producción (PostgreSQL 17.6), con la MISMA consulta de abajo.
const REFERENCIA = {
  n_funciones: 167, huella_funciones: 'ed988c8a85460e0e956b42c1d1195b55',
  n_columnas: 674, huella_columnas: '7aaead311dbd533a1813f40c4e311385',
  n_constraints: 321, huella_constraints: 'abad724db5ca022d5e7df8de18b8392d',
  n_policies: 99, huella_policies: '9fb4d1d46180af522f48f580d30720f8',
  huella_grants_funciones: '3662a3f9571e5f825c37848cb61e9407',
  n_tablas: 66, huella_rls: 'ee832627414c44e6f075f58aee8b5f6b',
  n_privilegios_columna: 5169, huella_privilegios_columna: 'a487b9e78cd244d17acfe76c1d27c498',
}

// COLLATE "C" en cada ORDER BY de texto: la collation de producción es en_US y
// la local puede no serlo. contype <> 'n' porque PG18 cataloga los NOT NULL
// como constraints y PG17 no.
const SQL_HUELLA = `
select jsonb_build_object(
  'n_funciones', (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')),
  'huella_funciones', (select md5(string_agg(n.nspname::text||'.'||p.proname::text||'('||pg_get_function_identity_arguments(p.oid)||')|'||p.prosecdef::text||'|'||md5(p.prosrc), E'\\n' order by n.nspname::text collate "C", p.proname::text collate "C", pg_get_function_identity_arguments(p.oid) collate "C")) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')),
  'n_columnas', (select count(*) from information_schema.columns where table_schema in ('public','private')),
  'huella_columnas', (select md5(string_agg(table_schema::text||'.'||table_name::text||'.'||column_name::text||':'||data_type::text||':'||is_nullable::text, E'\\n' order by table_schema::text collate "C", table_name::text collate "C", column_name::text collate "C")) from information_schema.columns where table_schema in ('public','private')),
  'n_constraints', (select count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in ('public','private') and c.contype <> 'n'),
  'huella_constraints', (select md5(string_agg(c.conrelid::regclass::text||'.'||c.conname::text||':'||c.contype::text, E'\\n' order by c.conrelid::regclass::text collate "C", c.conname::text collate "C")) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in ('public','private') and c.contype <> 'n'),
  'n_policies', (select count(*) from pg_policies where schemaname in ('public','private')),
  'huella_policies', (select md5(string_agg(schemaname::text||'.'||tablename::text||'.'||policyname::text||':'||cmd::text, E'\\n' order by schemaname::text collate "C", tablename::text collate "C", policyname::text collate "C")) from pg_policies where schemaname in ('public','private')),
  'huella_grants_funciones', (select md5(string_agg(n.nspname::text||'.'||p.proname::text||'('||pg_get_function_identity_arguments(p.oid)||'):'||has_function_privilege('anon',p.oid,'EXECUTE')::text||has_function_privilege('authenticated',p.oid,'EXECUTE')::text, E'\\n' order by n.nspname::text collate "C", p.proname::text collate "C", pg_get_function_identity_arguments(p.oid) collate "C")) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')),
  'n_tablas', (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('public','private')),
  'huella_rls', (select md5(string_agg(n.nspname::text||'.'||c.relname::text||':'||c.relrowsecurity::text, E'\\n' order by n.nspname::text collate "C", c.relname::text collate "C")) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('public','private')),
  'n_privilegios_columna', (select count(*) from information_schema.column_privileges where table_schema in ('public','private') and grantee in ('anon','authenticated','service_role')),
  'huella_privilegios_columna', (select md5(string_agg(table_schema::text||'.'||table_name::text||'.'||column_name::text||':'||grantee::text||':'||privilege_type::text, E'\\n' order by table_schema::text collate "C", table_name::text collate "C", column_name::text collate "C", grantee::text collate "C", privilege_type::text collate "C")) from information_schema.column_privileges where table_schema in ('public','private') and grantee in ('anon','authenticated','service_role'))
) as h`

// --- Shim de Supabase, con las formas verificadas contra producción ----------
const SHIM = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth; create schema storage; create schema extensions; create schema net;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
alter database ensayo set search_path to "$user", public, extensions;
set search_path to "$user", public, extensions;

grant usage on schema public, extensions, auth, storage to anon, authenticated, service_role;

-- Privilegios por defecto reales de producción para objetos creados por postgres
-- en public (pg_default_acl). NO incluyen anon.
alter default privileges for role postgres in schema public grant all on tables to authenticated, service_role;
alter default privileges for role postgres in schema public grant execute on functions to authenticated, service_role;
alter default privileges for role postgres in schema public grant usage, select, update on sequences to authenticated, service_role;

-- auth.*: copia literal de producción.
create or replace function auth.uid() returns uuid language sql stable as $function$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$function$;
create or replace function auth.role() returns text language sql stable as $function$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text
$function$;
create or replace function auth.jwt() returns jsonb language sql stable as $function$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$function$;
grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated, service_role;

create table auth.users (
  instance_id uuid, id uuid primary key, aud varchar, role varchar, email varchar, encrypted_password varchar,
  email_confirmed_at timestamptz, invited_at timestamptz, confirmation_token varchar, confirmation_sent_at timestamptz,
  recovery_token varchar, recovery_sent_at timestamptz, email_change_token_new varchar, email_change varchar,
  email_change_sent_at timestamptz, last_sign_in_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb,
  is_super_admin boolean, created_at timestamptz, updated_at timestamptz, phone text, phone_confirmed_at timestamptz,
  phone_change text, phone_change_token varchar, phone_change_sent_at timestamptz, confirmed_at timestamptz,
  email_change_token_current varchar, email_change_confirm_status smallint, banned_until timestamptz,
  reauthentication_token varchar, reauthentication_sent_at timestamptz, is_sso_user boolean, deleted_at timestamptz,
  is_anonymous boolean);

create type auth.factor_type as enum ('totp','webauthn','phone');
create type auth.factor_status as enum ('unverified','verified');
create table auth.mfa_factors (
  id uuid primary key, user_id uuid references auth.users(id), friendly_name text, factor_type auth.factor_type,
  status auth.factor_status, created_at timestamptz, updated_at timestamptz, secret text, phone text,
  last_challenged_at timestamptz, web_authn_credential jsonb, web_authn_aaguid uuid, last_webauthn_challenge_data jsonb);

create type storage.buckettype as enum ('STANDARD','ANALYTICS');
create table storage.buckets (
  id text primary key, name text, owner uuid, created_at timestamptz, updated_at timestamptz, public boolean,
  avif_autodetection boolean, file_size_limit bigint, allowed_mime_types text[], owner_id text,
  type storage.buckettype default 'STANDARD', versioning_status text);
create table storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid,
  created_at timestamptz, updated_at timestamptz, last_accessed_at timestamptz, metadata jsonb, path_tokens text[],
  version text, owner_id text, user_metadata jsonb, archived_at timestamptz, is_delete_marker boolean, is_versioned boolean);
alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;

-- pg_net: DOBLE. Registra la llamada; nunca hace HTTP.
create table net.llamadas_doble (id bigserial primary key, url text, headers jsonb, body jsonb, params jsonb,
  creado timestamptz default now());
create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer default 5000)
returns bigint language sql as $function$
  insert into net.llamadas_doble(url, headers, body, params) values (url, headers, body, params) returning id
$function$;

create publication supabase_realtime;
`

const P1 = ['_p1_a_transferencias_parciales.sql', '_p1_b_recepcion_idempotente.sql',
  '_p1_c_caja_umbral_autorizacion.sql', '_p1_d_pagos_conciliacion.sql',
  // Se reaplica tras P1, como irá a producción: debe ser un no-op exacto.
  '_p1_e_reconcilia_resolver_turno_fecha.sql',
  // OLA 2 · Fase 22.
  '_p2_a_reportes_business_date.sql',
  // OLA 2 · sucursal activa en todo el servidor (GENERADA por scripts/generar-p2b.mjs; va tras P1 porque redefine funciones de P1).
  '_p2_b_sucursal_activa.sql',
  // OLA 2 · policy tautológica de puntos de cliente.
  '_p2_c_rls_puntos_cliente.sql',
  // OLA 2 · CRM: alcance del perfil, RPC de actualización y columnas escribibles de clientes.
  '_p2_d_crm_alcance.sql',
  // OLA 3 · Fase 20: cierre diario con verificaciones P0/P1/warning (va tras _p2_b: redefine funciones que genera).
  '_p2_e_cierre_diario_clasificado.sql',
  // OLA 3 · Fase 21: centro de incidencias (usa checks_cierre_diario de _p2_e).
  '_p2_f_incidencias.sql',
  // OLA 4 · Fase 23: reimpresión con rastro y número de copia.
  '_p2_g_reimpresiones.sql',
  // OLA 4 · Fase 24: capacidades (a mano) y funciones que las usan (GENERADA por scripts/generar-p2i.mjs).
  '_p2_h_capacidades.sql',
  '_p2_i_capacidades_funciones.sql',
  // Fase 18: terminal de conciliación y reembolsos a través del proveedor.
  '_p2_j_reembolsos_proveedor.sql']

// MUTACIÓN: ENSAYO_OMITIR=archivo.sql[,otro.sql] no aplica esas migraciones
// nuevas, para demostrar que las pruebas de negocio FALLAN sin la corrección.
// Sólo puede quitar, nunca añadir, y el resultado se marca como mutación: un
// PASS con omisiones se reporta como FAIL.
const OMITIR = (process.env.ENSAYO_OMITIR || '').split(',').map((s) => s.trim()).filter(Boolean)
for (const f of OMITIR) if (!P1.includes(f)) { console.error(`ENSAYO_OMITIR: ${f} no es una migración nueva`); process.exit(2) }
if (OMITIR.length) P1.splice(0, P1.length, ...P1.filter((f) => !OMITIR.includes(f)))

const P0_INTOCABLES = [
  ['public', 'registrar_venta'], ['public', 'descontar_inventario'], ['public', 'cerrar_inventario_fisico'],
  ['public', 'iniciar_inventario_fisico'], ['private', 'sincronizar_stock_serializado'],
  ['public', 'dashboard_operativo_admin'], ['public', 'inventario_valorizado_admin'],
  ['public', 'p04_invariantes_admin'], ['public', 'resolver_reconciliacion_serial'],
]

const RPC_P1 = ['registrar_movimiento_caja', 'despachar_transferencia_stock', 'recibir_transferencia_stock',
  'recibir_transferencia_parcial', 'cerrar_transferencia_stock', 'conciliar_pago_admin',
  'sincronizar_conciliaciones_pago_admin', 'resumen_conciliacion_pagos_admin', 'auto_conciliar_pagos_digitales_admin',
  'cuadre_pagos_venta_admin', 'registrar_confirmacion_proveedor_admin',
  // _p2_a hace DROP de la firma vieja: exactamente 1 firma prueba que no quedó sobrecarga.
  'reportes_avanzados_admin', 'resumen_ganancias', 'top_productos_ganancia']

// Misma regla que scripts/generar-p2b.mjs: <var_staff>.location_id → private.auth_location_id().
const RE_STAFF_ACTOR = /into\s+([a-z_][a-z0-9_]*)\s+from\s+(?:public\.)?staff\s+where\s+(?:[a-z_]+\.)?user_id\s*=\s*auth\.uid\(\)/gi
function sustituirSucursalActiva(src) {
  const vars = [...new Set([...src.matchAll(RE_STAFF_ACTOR)].map((m) => m[1].toLowerCase()))]
  if (vars.length !== 1) return src
  return src.replace(new RegExp(`(?<![a-z0-9_])${vars[0]}\\.location_id(?![a-z0-9_])`, 'gi'), 'private.auth_location_id()')
}
const CON_P2B = () => P1.includes('_p2_b_sucursal_activa.sql')
const CON_P2I = () => P1.includes('_p2_i_capacidades_funciones.sql')
// Cuerpo esperado de una función P0 intocable tras las sustituciones mecánicas admitidas.
function esperadoTrasSustituciones(funcion, src) {
  let t = CON_P2B() ? sustituirSucursalActiva(src) : src
  if (CON_P2I()) { try { t = sustituirCapacidades(funcion, t).texto } catch { return null } }
  return t
}

const porUnidadDeCodigo = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// Una migración nueva se nombra por su nombre lógico (`_p2_a_reportes_business_date.sql`). Antes de
// aplicarse en producción el archivo lleva ese nombre; después, la versión real que asignó Supabase
// (`20260913123456_p2_a_reportes_business_date.sql`). Se acepta cualquiera de las dos, nunca ambas.
function resolverMigracion(logico) {
  const sinGuion = logico.replace(/^_/, '')
  const candidatos = fs.readdirSync(MIGRACIONES).filter((f) => f === logico || new RegExp(`^\\d{14}_${sinGuion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(f))
  if (candidatos.length !== 1) throw new Error(`migración ${logico}: ${candidatos.length ? `ambigua (${candidatos.join(', ')})` : 'no encontrada'}`)
  return candidatos[0]
}

const DIR = AISLADO + 'pgdata-compuesto'
const PUERTO = 54360
fs.rmSync(DIR, { recursive: true, force: true })
const servidor = new EmbeddedPostgres({ databaseDir: DIR, user: 'postgres', password: 'postgres', port: PUERTO,
  persistent: false, onLog: () => {}, onError: () => {} })

const fallos = []
const notas = []
const lineas = []
let db

async function ejecutarMigracion(nombre, sql) {
  try {
    await db.query('begin')
    await db.query(sql)
    await db.query('commit')
  } catch (e) {
    await db.query('rollback').catch(() => {})
    if (/cannot run inside a transaction block/i.test(e.message)) {
      await db.query(sql)
      notas.push(`${nombre}: ejecutada sin transacción envolvente (contiene algo no transaccional)`)
      return
    }
    throw new Error(`${nombre}: ${e.message}${e.position ? ` (posición ${e.position})` : ''}`)
  }
}

try {
  await servidor.initialise()
  await servidor.start()
  await servidor.createDatabase('ensayo')
  db = new pg.Client({ connectionString: `postgresql://postgres:postgres@localhost:${PUERTO}/ensayo` })
  await db.connect()
  await db.query(SHIM)

  // --- FASE 1 --------------------------------------------------------------
  // Base = las 153 migraciones que YA estaban en producción, congeladas en una lista versionada. No se
  // deduce contando archivos: al aplicar las nuevas en producción sus archivos pasan a llevar versión.
  const archivos = fs.readFileSync(REFERENCIAS + 'migraciones-produccion-base.txt', 'utf8').trim().split('\n').sort(porUnidadDeCodigo)
  if (archivos.length !== 153) throw new Error(`se esperaban 153 migraciones de producción y la lista base tiene ${archivos.length}`)
  const faltan = archivos.filter((f) => !fs.existsSync(MIGRACIONES + f))
  if (faltan.length) throw new Error(`faltan archivos de la base de producción: ${faltan.join(', ')}`)

  // ÚNICA excepción de orden, explícita y justificada. configuracion_singleton
  // tiene versión 035000, anterior a initial_schema_pos (035046), pero su policy
  // referencia `staff`, que crea esta última. El propio archivo dice "Corre esto
  // en el SQL Editor": se ejecutó a mano en el panel —por eso producción no
  // guardó sus sentencias— cuando `staff` ya existía, y quedó registrado con un
  // timestamp anterior al orden real. Se aplica tras su dependencia; si eso
  // alterara el esquema, la huella lo delataría.
  const REORDENADAS = { '20260716035000_configuracion_singleton.sql': '20260716035046_initial_schema_pos.sql' }
  const orden = archivos.filter((f) => !REORDENADAS[f])
  for (const [mover, trasDe] of Object.entries(REORDENADAS)) {
    const i = orden.indexOf(trasDe)
    if (i === -1 || !archivos.includes(mover)) throw new Error(`reordenamiento imposible: ${mover} tras ${trasDe}`)
    orden.splice(i + 1, 0, mover)
    notas.push(`${mover}: aplicada tras ${trasDe} (ejecutada a mano en producción; depende de staff)`)
  }
  // DERIVA DE PRODUCCIÓN reconciliada. private.resolver_turno_fecha existe en
  // producción sin que ninguna migración la cree; la migración forward-only
  // _p1_e la codifica con la definición exacta capturada. Aquí se aplica justo
  // antes de la primera migración que la necesita, y se declara. Si la huella
  // de producción cuadra después, queda demostrado que repo + _p1_e reproduce
  // producción, y que ésa era la única diferencia.
  const DERIVA = '_p1_e_reconcilia_resolver_turno_fecha.sql'
  const ANTES_DE_DERIVA = '20260824124052_monthly_attendance_respects_shift_overrides.sql'
  if (!orden.includes(ANTES_DE_DERIVA)) throw new Error(`no se encuentra ${ANTES_DE_DERIVA}`)
  for (const f of orden) {
    if (f === ANTES_DE_DERIVA) {
      await ejecutarMigracion(DERIVA, fs.readFileSync(MIGRACIONES + resolverMigracion(DERIVA), 'utf8'))
      notas.push(`${DERIVA}: aplicada antes de ${f} — reconcilia private.resolver_turno_fecha (existe en producción sin migración que la cree) y public.registrar_justificacion_asistencia (reescrita a mano en producción)`)
    }
    let sql = fs.readFileSync(MIGRACIONES + f, 'utf8')
    const pgNet = /create\s+extension[^;]*\bpg_net\b[^;]*;/gi
    if (pgNet.test(sql)) {
      sql = sql.replace(pgNet, '-- [ensayo] omitido: create extension pg_net (no existe en local; net.http_post es un doble)\n')
      notas.push(`${f}: omitido create extension pg_net`)
    }
    await ejecutarMigracion(f, sql)
  }
  lineas.push(`Fase 1 · ${archivos.length} migraciones de producción aplicadas`)

  await db.query('set search_path to "$user", public, extensions')
  const { rows: [{ h: local }] } = await db.query(SQL_HUELLA)
  const categorias = ['funciones', 'columnas', 'constraints', 'policies', 'grants_funciones', 'rls', 'privilegios_columna']
  const estado = []
  let huellaOk = true
  for (const c of categorias) {
    const clave = `huella_${c}`
    const nClave = { funciones: 'n_funciones', columnas: 'n_columnas', constraints: 'n_constraints',
      policies: 'n_policies', rls: 'n_tablas', privilegios_columna: 'n_privilegios_columna' }[c]
    const ok = local[clave] === REFERENCIA[clave] && (!nClave || Number(local[nClave]) === REFERENCIA[nClave])
    if (!ok) {
      huellaOk = false
      fallos.push(`huella ${c}: local ${nClave ? `${local[nClave]}/` : ''}${local[clave]} ≠ producción ${nClave ? `${REFERENCIA[nClave]}/` : ''}${REFERENCIA[clave]}`)
    }
    estado.push(`${c} ${ok ? 'PASS' : 'FAIL'}`)
  }
  if (local.huella_funciones !== REFERENCIA.huella_funciones) {
    // Volcado por función (misma normalización que la huella) para poder
    // compararlo línea a línea con producción y localizar la diferencia.
    const { rows } = await db.query(`select n.nspname::text||'.'||p.proname::text||'('||pg_get_function_identity_arguments(p.oid)||')' as firma,
        p.prosecdef::text as secdef, md5(p.prosrc) as crudo, p.prosrc,
        md5(btrim(regexp_replace(p.prosrc, '\\s+', ' ', 'g'))) as colapsado,
        md5(regexp_replace(p.prosrc, '\\s+', '', 'g')) as sin_espacios
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')
      order by n.nspname::text collate "C", p.proname::text collate "C", pg_get_function_identity_arguments(p.oid) collate "C"`)
    fs.writeFileSync(AISLADO + 'huella-local-funciones.txt', rows.map((r) => `${r.firma}|${r.secdef}|${r.crudo}`).join('\n') + '\n')
    notas.push('volcado por función en .p04-pgtest/huella-local-funciones.txt')

    // Producción ejecutó varias migraciones con un texto de otro formato que el
    // del repo (mismo código, distintos saltos de línea/sangría), así que
    // md5(prosrc) difiere sin que la lógica difiera. Se acepta SÓLO si, función
    // por función: la firma y SECURITY DEFINER coinciden exactamente y el cuerpo
    // coincide con los espacios colapsados. Si hace falta quitar TODOS los
    // espacios para que coincida, se reporta aparte como FAIL (un espacio dentro
    // de un literal podría ser un cambio real). Sin las referencias de
    // producción (consulta de sólo lectura, guardadas localmente) no se acepta.
    const refCrudo = REFERENCIAS + 'huella-prod-funciones.txt'
    const refNorm = REFERENCIAS + 'huella-prod-funciones-normalizada.txt'
    if (fs.existsSync(refCrudo) && fs.existsSync(refNorm)) {
      const leer = (f) => new Map(fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => {
        const partes = l.split('|'); return [partes[0], partes.slice(1)]
      }))
      const prodCrudo = leer(refCrudo), prodNorm = leer(refNorm)
      // Tercer nivel, revisado a mano el 2026-09-13 (diff línea a línea de las 23
      // funciones): producción ejecutó una redacción anterior de los comentarios
      // DENTRO del cuerpo y otra disposición de líneas. Se compara el cuerpo sin
      // comentarios `--` y sin espacios, sólo para las funciones de esta lista de
      // referencia (consulta de sólo lectura). Una función nueva que difiera así
      // no está en la lista y sigue fallando.
      const refSinCom = REFERENCIAS + 'huella-prod-funciones-sincomentarios.txt'
      const prodSinCom = fs.existsSync(refSinCom) ? leer(refSinCom) : new Map()
      const refRevisadas = REFERENCIAS + 'huella-funciones-revisadas.txt'
      const revisadas = fs.existsSync(refRevisadas) ? leer(refRevisadas) : new Map()
      const md5 = (s) => crypto.createHash('md5').update(s).digest('hex')
      const localFirmas = new Set(rows.map((r) => r.firma))
      const problemas = []
      let soloFormato = 0, soloComentarios = 0
      for (const f of prodCrudo.keys()) if (!localFirmas.has(f)) problemas.push(`falta en local: ${f}`)
      for (const r of rows) {
        const pc = prodCrudo.get(r.firma), pn = prodNorm.get(r.firma)
        if (!pc || !pn) { problemas.push(`sobra en local: ${r.firma}`); continue }
        if (pc[0] !== r.secdef) { problemas.push(`SECURITY DEFINER distinto: ${r.firma}`); continue }
        if (pc[1] === r.crudo) continue
        if (pn[0] === r.colapsado) { soloFormato++; continue }
        // Revisadas a mano con el par exacto (md5 local, md5 producción) fijado:
        // si cambia cualquiera de los dos lados, deja de coincidir y vuelve a fallar.
        const rv = revisadas.get(r.firma.slice(0, r.firma.indexOf('(')))
        if (rv && rv[0] === r.crudo && rv[1] === pc[1]) { soloComentarios++; continue }
        const sc = prodSinCom.get(r.firma.slice(0, r.firma.indexOf('(')))
        if (sc && sc[0] === md5(r.prosrc.replace(/--[^\n]*/g, '').replace(/[ \t\r\n\f\v]+/g, ''))) { soloComentarios++; continue }
        problemas.push(`${pn[1] === r.sin_espacios ? 'cuerpo difiere sólo en espacios pegados (revisar a mano)' : 'cuerpo distinto'}: ${r.firma}`)
      }
      if (problemas.length === 0) {
        const i = fallos.findIndex((x) => x.startsWith('huella funciones:'))
        if (i >= 0) fallos.splice(i, 1)
        estado[categorias.indexOf('funciones')] = `funciones PASS (${soloFormato} sólo formato · ${soloComentarios} sólo comentarios/disposición)`
        huellaOk = !fallos.some((x) => x.startsWith('huella '))
        notas.push(`funciones: firma y SECURITY DEFINER exactos en las 167; ${soloFormato} difieren sólo en espacios, ${soloComentarios} sólo en comentarios internos y disposición de líneas (revisadas a mano)`)
      } else {
        // Lista completa + cuerpo local de cada función señalada, para diffs a mano.
        fs.writeFileSync(AISLADO + 'huella-local-problemas.txt', problemas.join('\n') + '\n')
        const dir = AISLADO + 'huella-local-prosrc/'
        fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir)
        const señaladas = new Set(problemas.map((p) => p.slice(p.indexOf(': ') + 2)))
        for (const r of rows) if (señaladas.has(r.firma)) fs.writeFileSync(dir + r.firma.slice(0, r.firma.indexOf('(')) + '.sql', r.prosrc)
        notas.push(`lista completa en .p04-pgtest/huella-local-problemas.txt; cuerpos en .p04-pgtest/huella-local-prosrc/`)
        for (const p of problemas.slice(0, 15)) fallos.push(`funciones: ${p}`)
        if (problemas.length > 15) fallos.push(`funciones: … y ${problemas.length - 15} más`)
      }
    } else {
      notas.push('sin referencias de producción por función en .p04-pgtest/: la huella de funciones no puede explicarse')
    }
  }
  lineas.push(`Fase 1 · huella vs producción: ${estado.join(' · ')}`)

  const { rows: [{ n: anonSecdefBase }] } = await db.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where p.prosecdef and n.nspname in ('public','private') and has_function_privilege('anon', p.oid, 'EXECUTE')`)
  if (anonSecdefBase !== 0) fallos.push(`antes de P1 ya hay ${anonSecdefBase} funciones SECURITY DEFINER ejecutables por anon`)

  // --- FASE 2 --------------------------------------------------------------
  const md5P0 = async () => Object.fromEntries((await db.query(
    `select n.nspname||'.'||p.proname as f, p.prosrc as h from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where (n.nspname, p.proname) in (${P0_INTOCABLES.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(',')})`,
    P0_INTOCABLES.flat())).rows.map((r) => [r.f, r.h]))
  const antesP0 = await md5P0()

  // Instantáneas por paso para verificar el release en producción migración a migración: huella por
  // categoría + md5(prosrc) por función, antes de las nuevas (paso 0) y tras cada una (paso N).
  const dirPasos = AISLADO + 'pasos-release/'
  fs.rmSync(dirPasos, { recursive: true, force: true }); fs.mkdirSync(dirPasos)
  const instantanea = async (paso, migracion) => {
    const { rows: [{ h }] } = await db.query(SQL_HUELLA)
    const { rows } = await db.query(`select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' as firma, md5(p.prosrc) as m
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')`)
    fs.writeFileSync(`${dirPasos}paso-${String(paso).padStart(2, '0')}.json`,
      JSON.stringify({ paso, migracion, huella: h, funciones: Object.fromEntries(rows.map((r) => [r.firma, r.m])) }, null, 1))
  }
  await instantanea(0, null)

  let aplicadas = 0
  for (const f of P1) {
    try {
      await ejecutarMigracion(f, fs.readFileSync(MIGRACIONES + resolverMigracion(f), 'utf8'))
      aplicadas++
      await instantanea(aplicadas, f)
    } catch (e) {
      fallos.push(`P1 no aplica: ${e.message}`)
      break
    }
  }
  lineas.push(`Fase 2 · migraciones P1 aplicadas: ${aplicadas}/${P1.length}`)

  const comprobaciones = []
  const comprobar = (nombre, ok, detalle) => {
    comprobaciones.push(ok)
    if (!ok) fallos.push(`${nombre}${detalle ? ` — ${detalle}` : ''}`)
  }

  if (aplicadas === P1.length) {
    const cuenta = async (esquema, nombre) => (await db.query(
      `select count(*)::int n from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname=$1 and p.proname=$2`,
      [esquema, nombre])).rows[0].n
    comprobar('recibir_orden_compra tiene exactamente 2 firmas', await cuenta('public', 'recibir_orden_compra') === 2)
    for (const f of RPC_P1) {
      const n = await cuenta('public', f)
      comprobar(`public.${f} tiene exactamente 1 firma`, n === 1, `tiene ${n}`)
    }
    comprobar('private.insertar_movimiento_caja tiene exactamente 1 firma', await cuenta('private', 'insertar_movimiento_caja') === 1)

    const { rows: [{ n: anonSecdef }] } = await db.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where p.prosecdef and n.nspname in ('public','private') and has_function_privilege('anon', p.oid, 'EXECUTE')`)
    comprobar('0 funciones SECURITY DEFINER ejecutables por anon', anonSecdef === 0, `hay ${anonSecdef}`)

    const { rows: sinExec } = await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname = any($1) and not has_function_privilege('authenticated', p.oid, 'EXECUTE')`,
      [[...RPC_P1, 'recibir_orden_compra']])
    comprobar('authenticated puede ejecutar todas las RPC de P1', sinExec.length === 0, sinExec.map((r) => r.proname).join(', '))

    const { rows: [inv] } = await db.query(`select
      (select is_nullable from information_schema.columns where table_schema='public' and table_name='products' and column_name='is_test') as is_test_nullable,
      (select is_nullable from information_schema.columns where table_schema='public' and table_name='product_variants' and column_name='product_id') as product_id_nullable,
      has_column_privilege('authenticated','public.products','is_test','SELECT') as ve_is_test,
      has_column_privilege('authenticated','public.products','costo','SELECT') as ve_costo,
      (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='cerrar_inventario_fisico') as cierre,
      (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='descontar_inventario') as descontar`)
    comprobar('P0.4 · products.is_test NOT NULL', inv.is_test_nullable === 'NO')
    comprobar('P0.4 · product_variants.product_id NOT NULL', inv.product_id_nullable === 'NO')
    comprobar('P0.4 · authenticated ve products.is_test y no products.costo', inv.ve_is_test === true && inv.ve_costo === false)
    comprobar('P0.4 · el cierre de conteo delega en sincronizar_stock_serializado',
      /sincronizar_stock_serializado/.test(inv.cierre || '') && !/product_serials/.test(inv.cierre || ''))
    comprobar('P0.4 · la venta escribe en el libro mayor', /inventory_movements/.test(inv.descontar || ''))

    const despuesP0 = await md5P0()
    // Única excepción admitida: con _p2_b, el cuerpo final debe ser EXACTAMENTE el
    // anterior con la sustitución de sucursal activa, y nada más.
    const cambiadas = Object.keys(antesP0).filter((k) => antesP0[k] !== despuesP0[k])
    const noJustificadas = cambiadas.filter((k) => esperadoTrasSustituciones(k, antesP0[k]) !== despuesP0[k])
    comprobar(`P1/P2 no alteran las ${Object.keys(antesP0).length} funciones de P0 intocables (salvo las sustituciones mecánicas de _p2_b y _p2_i)`,
      noJustificadas.length === 0 && Object.keys(antesP0).length === P0_INTOCABLES.length,
      noJustificadas.length ? `cambiadas sin justificar: ${noJustificadas.join(', ')}` : `encontradas ${Object.keys(antesP0).length}/${P0_INTOCABLES.length} · sustitución verificada en ${cambiadas.length}`)

    if (CON_P2B()) {
      const { rows: todas } = await db.query(`select n.nspname||'.'||p.proname as f, p.prosrc from pg_proc p
        join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f'`)
      const restantes = todas.filter((r) => r.f !== 'private.auth_location_id' && sustituirSucursalActiva(r.prosrc) !== r.prosrc).map((r) => r.f)
      comprobar('_p2_b · ninguna función decide la sucursal del actor con la sucursal base', restantes.length === 0, restantes.join(', '))
    }

    if (CON_P2I()) {
      const { rows: todas } = await db.query(`select n.nspname||'.'||p.proname as f, p.prosrc from pg_proc p
        join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f'`)
      const conPuesto = todas.filter((r) => quedaAutorizacionPorPuesto(r.prosrc)).map((r) => r.f)
      comprobar('_p2_i · ninguna función autoriza con una lista literal de puestos', conPuesto.length === 0, conPuesto.join(', '))
      const { rows: pol } = await db.query(`select count(*)::int n from pg_policies where schemaname='public'
        and (coalesce(qual,'')||coalesce(with_check,'')) ~* '\\mpuesto\\M'`)
      // Palabra completa: "orden_servicio_repuestos" contiene "puesto" y daba un falso positivo.
      comprobar('_p2_h · ninguna policy autoriza por puesto', pol[0].n === 0, `hay ${pol[0].n}`)
    }

    // _p1_e reaplicada tras P1 (orden real de producción): cuerpo idéntico byte a
    // byte al de producción y sin EXECUTE para anon. md5 de producción capturados
    // por consulta de sólo lectura.
    const { rows: reconc } = await db.query(`select n.nspname||'.'||p.proname as f, md5(p.prosrc) as h,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where (n.nspname, p.proname) in (('private','resolver_turno_fecha'), ('public','registrar_justificacion_asistencia'))`)
    const esperado = { 'private.resolver_turno_fecha': '816505d4273d272124ac6a7e09963d19',
      'public.registrar_justificacion_asistencia': 'f81ed6d75748bae9551219851ed3e889' }
    comprobar('_p1_e · las 2 funciones reconciliadas quedan idénticas a producción, sin anon y con authenticated',
      reconc.length === 2 && reconc.every((r) => esperado[r.f] === r.h && !r.anon && r.auth),
      JSON.stringify(reconc))

    // Humo de C3 sobre el esquema compuesto: las dos formas posicionales reales.
    try {
      await db.query('begin')
      const loc = crypto.randomUUID(), staff = crypto.randomUUID(), caja = crypto.randomUUID()
      await db.query(`insert into public.locations(id, nombre) values ($1, 'Ensayo')`, [loc])
      await db.query(`insert into public.staff(id, nombre, rol, username, location_id, activo) values ($1, 'Ensayo', 'administrador', 'ensayo-compuesto', $2, true)`, [staff, loc])
      await db.query(`insert into public.cash_sessions(id, cajero_id, location_id, monto_inicial) values ($1, $2, $3, 100)`, [caja, staff, loc])
      const { rows: [m7] } = await db.query(`select * from private.insertar_movimiento_caja($1::uuid, 'venta_efectivo'::text, 25::numeric, 'Venta en efectivo'::text, $2::uuid, 'sale'::text, $3::uuid)`,
        [caja, staff, crypto.randomUUID()])
      const { rows: [m8] } = await db.query(`select * from private.insertar_movimiento_caja($1::uuid, 'venta_efectivo'::text, (-25)::numeric, 'Reversión'::text, $2::uuid, 'sale'::text, $3::uuid, $4::uuid)`,
        [caja, staff, m7.referencia_id, m7.id])
      comprobar('C3 · llamadas de 7 y 8 argumentos resuelven sobre el esquema compuesto', !!m7.id && m8.reversa_de === m7.id)
    } catch (e) {
      comprobar('C3 · llamadas de 7 y 8 argumentos resuelven sobre el esquema compuesto', false, e.message)
    } finally {
      await db.query('rollback').catch(() => {})
    }
    // to_regprocedure: si la función no existe (p. ej. en una mutación) es un
    // FAIL de esta comprobación, no una excepción que aborte el resto.
    const { rows: [helper] } = await db.query(`select f is not null as existe,
        f is not null and has_function_privilege('authenticated', f, 'EXECUTE') as auth,
        f is not null and has_function_privilege('anon', f, 'EXECUTE') as anon
      from (select to_regprocedure('private.reporte_resumen_periodo(date, date, uuid)') as f) x`)
    comprobar('_p2_a · private.reporte_resumen_periodo existe y no es invocable directamente', helper.existe && !helper.auth && !helper.anon, JSON.stringify(helper))

    lineas.push(`Fase 2 · comprobaciones estructurales: ${comprobaciones.filter(Boolean).length}/${comprobaciones.length}`)

    // Volcado de definiciones del esquema compuesto final (entrada del
    // generador de migraciones mecánicas, p. ej. scripts/generar-p2b.mjs).
    const dirDefs = AISLADO + 'defs-despues/'
    fs.rmSync(dirDefs, { recursive: true, force: true }); fs.mkdirSync(dirDefs)
    const { rows: defs } = await db.query(`select n.nspname||'.'||p.proname as f, pg_get_functiondef(p.oid) as d,
        coalesce(p.proacl::text, '') as acl
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f'`)
    for (const r of defs) fs.appendFileSync(dirDefs + r.f + '.sql', `-- acl: ${r.acl}\n${r.d};\n`)
    notas.push(`definiciones finales volcadas en .p04-pgtest/defs-despues/ (${defs.length})`)

    // --- FASE 3 · pruebas de negocio sobre el esquema compuesto -------------
    // Cada módulo de scripts/compuesto/ recibe la conexión y `comprobar`, y es
    // responsable de aislar sus datos (transacción con rollback) y de ejecutar
    // las llamadas de negocio como `authenticated`, no como postgres.
    const antesNegocio = comprobaciones.length
    const dirNegocio = RAIZ + 'scripts/compuesto/'
    const modulos = fs.existsSync(dirNegocio) ? fs.readdirSync(dirNegocio).filter((f) => f.endsWith('.mjs')).sort() : []
    for (const m of modulos) {
      try {
        const { default: prueba } = await import('file://' + dirNegocio + m)
        await prueba({ db, comprobar: (nombre, ok, detalle) => comprobar(`${m} · ${nombre}`, ok, detalle) })
      } catch (e) {
        comprobar(`${m} · se ejecuta sin excepción`, false, e.message)
      } finally {
        await db.query('rollback').catch(() => {})
      }
    }
    const negocio = comprobaciones.slice(antesNegocio)
    lineas.push(`Fase 3 · pruebas de negocio (${modulos.length} módulos): ${negocio.filter(Boolean).length}/${negocio.length}`)
    if (modulos.length === 0) fallos.push('Fase 3 · no hay módulos de prueba en scripts/compuesto/')
  }

  if (!huellaOk) notas.push('La huella no coincide: sin explicación verificada es deriva de producción y bloquea el deploy.')
} catch (e) {
  fallos.push(`EXCEPCIÓN: ${e.message}`)
} finally {
  if (db) await db.end().catch(() => {})
  await servidor.stop().catch(() => {})
}

console.log(`ENSAYO COMPUESTO — PostgreSQL local · 153 migraciones de producción + ${P1.length} nuevas (P1/P2)`)
console.log('Shim: auth/storage/roles/extensiones · pg_net: DOBLE (sin HTTP)')
if (OMITIR.length) {
  console.log(`*** MUTACIÓN: sin ${OMITIR.join(', ')} — se espera FAIL ***`)
  fallos.push(`mutación activa (omitidas: ${OMITIR.join(', ')}): este resultado nunca cuenta como PASS`)
}
for (const l of lineas) console.log(l)
for (const n of notas) console.log(`  nota: ${n}`)
if (fallos.length) {
  console.log('\nFallos:')
  for (const f of fallos) console.log(`  [FAIL] ${f}`)
  console.log('\nSTATUS: FAIL')
  process.exit(1)
}
console.log('STATUS: PASS')
