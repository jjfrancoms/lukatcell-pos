#!/usr/bin/env node
// ============================================================================
// FASE 14 — RECEPCIÓN DE COMPRAS IDEMPOTENTE. Prueba contra PostgreSQL REAL.
//
// BACKLOG.md daba esta fase por terminada. La versión de
// public.recibir_orden_compra que hay HOY en producción no tiene ninguna clave
// de idempotencia: un doble envío crea dos recepciones y suma el stock dos
// veces. Este script lo demuestra ejecutándolo, y después demuestra que la
// migración _p1_b_recepcion_idempotente.sql lo corrige.
//
// QUÉ SE EJERCITA: el SQL REAL de los ficheros de migración, no una
// reimplementación. Se levanta el esquema tal y como está HOY en producción
// (verificado contra fbwkclpgnsxuqycazumj: columnas, constraints, RLS, grants
// por columna de products y grants de tabla de recepciones_compra), se instala
// la versión VIEJA de la función desde su migración real
// (20260906203818_fix_null_puesto_bypass.sql), se reproduce la duplicación, y
// sólo entonces se aplica el fichero completo de la migración nueva. Si alguien
// reescribe la migración y rompe una garantía, esta prueba se pone roja.
//
// NO SE EJECUTA COMO `postgres`. Lección de P0.4: validar sólo con el rol
// dueño de todo no pasa por privilegios de tabla ni por RLS, y así se coló un
// 42501 real para todos los usuarios. Aquí cada llamada a la RPC va con
// `set local role authenticated` y un request.jwt.claims realista, y hay un
// bloque entero de pruebas de privilegios.
//
// FALLA CERRADO. Sin entorno termina con código 1 y explica cómo conseguirlo.
// No hay SKIP ni variable de escape: un test de idempotencia que imprime SKIP
// y sale con 0 es peor que no tenerlo.
//
//   P04_PG_URL=postgres://user:pass@localhost/db node scripts/verify-recepcion-compras.mjs
//   cd .p04-pgtest && npm install     (una vez; luego el script arranca solo)
// ============================================================================

import { createRequire } from 'node:module'
import fs from 'node:fs'
// Nombre lógico → archivo real (provisional `_p1_b_…` o versionado tras aplicarse en producción).
import { resolverMigracion } from './lib/migraciones.mjs'

const AISLADO = new URL('../.p04-pgtest/', import.meta.url)
const MIGRACIONES = new URL('../supabase/migrations/', import.meta.url).pathname

function abortar(motivo) {
  console.error('RECEPCIÓN DE COMPRAS (FASE 14): NO EJECUTADA\n')
  console.error(`  ${motivo}\n`)
  console.error('  Esta prueba comprueba que un reintento de recepción no duplica stock,')
  console.error('  costo, documento, serial ni movimiento. Sin un PostgreSQL real no se')
  console.error('  puede ejercitar, y no ejecutarla NO es lo mismo que pasarla.\n')
  console.error('  Para ejecutarla de verdad, cualquiera de estas dos:')
  console.error('    P04_PG_URL=postgres://user:pass@host/db node scripts/verify-recepcion-compras.mjs')
  console.error('    cd .p04-pgtest && npm install     (una vez)')
  process.exit(1)
}

let pg
try {
  pg = (await import('pg')).default
} catch {
  try {
    pg = createRequire(AISLADO)('pg')
  } catch {
    abortar('No hay cliente PostgreSQL (`pg`) ni en el repo ni en .p04-pgtest/.')
  }
}

let URL_PG = process.env.P04_PG_URL
let servidorLocal = null

// Este script CREA y DESTRUYE objetos. Un dedazo con la cadena de una Supabase
// real sería catastrófico, así que sólo se admiten destinos locales.
if (URL_PG) {
  let anfitrion
  try {
    anfitrion = new URL(URL_PG.replace(/^postgres(ql)?:\/\//, 'http://')).hostname
  } catch {
    abortar(`P04_PG_URL no es una URL válida: ${URL_PG}`)
  }
  if (!['localhost', '127.0.0.1', '::1', ''].includes(anfitrion)) {
    abortar(`P04_PG_URL apunta a "${anfitrion}", que no es local. Esta prueba crea y borra objetos: sólo contra un PostgreSQL local desechable.`)
  }
}

if (!URL_PG) {
  let EmbeddedPostgres
  try {
    EmbeddedPostgres = (await import(new URL('node_modules/embedded-postgres/dist/index.js', AISLADO).href)).default
  } catch {
    abortar('Falta P04_PG_URL y el entorno local aislado (.p04-pgtest/) no está instalado.')
  }
  const puerto = 54339
  const dir = new URL('pgdata-recepcion', AISLADO).pathname
  fs.rmSync(dir, { recursive: true, force: true })
  servidorLocal = new EmbeddedPostgres({ databaseDir: dir, user: 'p04', password: 'p04', port: puerto, persistent: false })
  await servidorLocal.initialise()
  await servidorLocal.start()
  await servidorLocal.createDatabase('p04')
  URL_PG = `postgresql://p04:p04@localhost:${puerto}/p04`
}

// ---------------------------------------------------------------------------
// Carga del SQL real
// ---------------------------------------------------------------------------
const ESQ = 'r9'

// TODO vive dentro del esquema `r9` y NADA fuera de él se toca. El único DROP
// que hace este script es el de su propio esquema desechable.
//
// Se redirige `public.`, `private.` y `auth.` al esquema de prueba, y también
// los literales 'public' / 'private' que aparecen en los bloques DO de
// autocomprobación de la migración (consultas a pg_proc/pg_indexes por
// nspname). Gracias a eso esas autocomprobaciones se EJECUTAN de verdad aquí
// en vez de quedar inertes. El orden de las sentencias y la lógica —lo único
// que se está probando— no se toca en ninguna sustitución.
const aEsquemaPrueba = (sql) => sql
  .replace(/\bpublic\./g, `${ESQ}.`)
  .replace(/\bprivate\./g, `${ESQ}.`)
  .replace(/\bauth\./g, `${ESQ}.`)
  .replace(/set search_path to '[^']*'(\s*,\s*'[^']*')*/gi, `set search_path to '${ESQ}'`)
  .replace(/'public'/g, `'${ESQ}'`)
  .replace(/'private'/g, `'${ESQ}'`)

function ficheroMigracion(nombre) {
  const ruta = MIGRACIONES + resolverMigracion(nombre)
  if (!fs.existsSync(ruta)) throw new Error(`No existe la migración ${nombre}`)
  return fs.readFileSync(ruta, 'utf8')
}

function funcionDeMigracion(fichero, nombre) {
  const sql = ficheroMigracion(fichero)
  const inicio = sql.search(new RegExp(`create or replace function\\s+(public\\.)?${nombre}\\s*\\(`, 'i'))
  if (inicio === -1) throw new Error(`No se encontró ${nombre} en ${fichero}`)
  const resto = sql.slice(inicio)
  const fin = resto.search(/\$function\$\s*;/)
  if (fin === -1) throw new Error(`No se encontró el fin del cuerpo de ${nombre} en ${fichero}`)
  return resto.slice(0, fin) + '$function$;'
}

const MIGRACION_NUEVA = '_p1_b_recepcion_idempotente.sql'
const SQL_MIGRACION = ficheroMigracion(MIGRACION_NUEVA)
const SQL_SINCRONIZAR = funcionDeMigracion('20260909043129_p04_b_ledger_delta_real.sql', 'private\\.sincronizar_stock_serializado')
const SQL_RECIBIR_VIEJA = funcionDeMigracion('20260906203818_fix_null_puesto_bypass.sql', 'recibir_orden_compra')

// ---------------------------------------------------------------------------
// Esquema PRE-migración: copia fiel de lo que hay hoy en producción.
// Columnas, constraints, RLS y grants verificados con information_schema,
// pg_constraint, pg_policy, pg_class.relacl y pg_attribute.attacl contra
// fbwkclpgnsxuqycazumj.
// ---------------------------------------------------------------------------
const ADMIN_UUID = '11111111-1111-1111-1111-111111111111'
const CAJERO_UUID = '99999999-9999-9999-9999-999999999999'
const LOC = '22222222-2222-2222-2222-222222222222'
const LOC2 = '2b2b2b2b-2222-2222-2222-222222222222'
const PROV = '66666666-6666-6666-6666-666666666666'

const ESQUEMA = `
drop schema if exists ${ESQ} cascade;
create schema ${ESQ};

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $roles$;

grant usage on schema ${ESQ} to authenticated, anon, service_role;

create table ${ESQ}.locations (id uuid primary key, nombre text);
create table ${ESQ}.proveedores (id uuid primary key, nombre text, activo boolean default true);
create table ${ESQ}.staff (
  id uuid primary key, user_id uuid, nombre text, rol varchar not null default 'cajero',
  location_id uuid, activo boolean default true, username varchar, puesto text, active_location_id uuid);

create table ${ESQ}.products (
  id uuid primary key default gen_random_uuid(), sku varchar, nombre varchar not null,
  categoria_id uuid, precio_base numeric not null default 0, activo boolean default true,
  created_at timestamptz default now(), imagen_url text, favorito boolean default false,
  costo numeric default 0, updated_at timestamptz not null default now(),
  control_serial boolean not null default false, is_test boolean not null default false);

create table ${ESQ}.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references ${ESQ}.products(id), color text, created_at timestamptz default now());

create table ${ESQ}.inventory (
  variant_id uuid not null, location_id uuid not null, cantidad int not null default 0,
  stock_minimo int not null default 0, updated_at timestamptz default now(),
  primary key (variant_id, location_id));

create table ${ESQ}.inventory_movements (
  id uuid primary key default gen_random_uuid(), variant_id uuid, location_id uuid,
  cantidad_delta int not null, motivo varchar not null, staff_id uuid,
  created_at timestamptz default now());

create table ${ESQ}.ordenes_compra (
  id uuid primary key default gen_random_uuid(), numero bigint not null unique,
  proveedor_id uuid not null references ${ESQ}.proveedores(id),
  location_id uuid not null references ${ESQ}.locations(id),
  estado text not null default 'borrador'
    check (estado in ('borrador','enviada','parcial','recibida','cancelada')),
  fecha_orden timestamptz not null default now(), fecha_esperada date, observacion text,
  creado_por uuid not null references ${ESQ}.staff(id),
  total numeric not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());

create table ${ESQ}.orden_compra_items (
  id uuid primary key default gen_random_uuid(),
  orden_id uuid not null references ${ESQ}.ordenes_compra(id) on delete cascade,
  variant_id uuid not null references ${ESQ}.product_variants(id),
  cantidad_pedida int not null check (cantidad_pedida > 0),
  cantidad_recibida int not null default 0 check (cantidad_recibida >= 0),
  costo_unitario numeric not null check (costo_unitario >= 0),
  subtotal numeric,
  check (cantidad_recibida <= cantidad_pedida),
  unique (orden_id, variant_id));

-- SIN client_transaction_id: exactamente como está hoy en producción.
create table ${ESQ}.recepciones_compra (
  id uuid primary key default gen_random_uuid(),
  orden_id uuid not null references ${ESQ}.ordenes_compra(id),
  recibido_por uuid not null references ${ESQ}.staff(id),
  fecha timestamptz not null default now(), observacion text,
  created_at timestamptz not null default now(), storage_path text);

-- SIN faltante/sobrante/dañado/producto equivocado, y con cantidad > 0.
create table ${ESQ}.recepcion_compra_items (
  id uuid primary key default gen_random_uuid(),
  recepcion_id uuid not null references ${ESQ}.recepciones_compra(id) on delete cascade,
  orden_item_id uuid not null references ${ESQ}.orden_compra_items(id),
  cantidad int not null check (cantidad > 0),
  costo_unitario numeric not null check (costo_unitario >= 0));

create table ${ESQ}.product_serials (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references ${ESQ}.product_variants(id),
  location_id uuid not null references ${ESQ}.locations(id),
  serial_number text not null unique, imei2 text,
  estado text not null default 'disponible'
    check (estado in ('disponible','vendido','en_transito','servicio','baja','cuarentena','faltante','investigacion')),
  sale_id uuid, recepcion_item_id uuid references ${ESQ}.recepcion_compra_items(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  sold_at timestamptz);

create table ${ESQ}.historial_costos_compra (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references ${ESQ}.products(id),
  variant_id uuid not null references ${ESQ}.product_variants(id),
  proveedor_id uuid references ${ESQ}.proveedores(id),
  orden_id uuid references ${ESQ}.ordenes_compra(id),
  recepcion_id uuid references ${ESQ}.recepciones_compra(id),
  costo_unitario numeric not null, cantidad int not null,
  created_at timestamptz not null default now());

-- auth.uid() real: sale del JWT, no de una constante. Así el test puede
-- cambiar de identidad y ejercitar de verdad el control de acceso.
create function ${ESQ}.uid() returns uuid language sql stable as
  $uid$ select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub','')::uuid $uid$;

create function ${ESQ}.auth_is_admin() returns boolean language sql stable security definer as
  $adm$ select exists (select 1 from ${ESQ}.staff s where s.user_id = ${ESQ}.uid() and s.activo and s.rol='administrador') $adm$;

create function ${ESQ}.auth_location_id() returns uuid language sql stable security definer as
  $lid$ select s.location_id from ${ESQ}.staff s where s.user_id = ${ESQ}.uid() and s.activo limit 1 $lid$;

-- GRANTS tal y como están en producción --------------------------------------
-- products: grant de TABLA sin SELECT (awdDxtm) + grants POR COLUMNA. costo
-- queda deliberadamente fuera del SELECT (enforce_product_cost_column_privacy).
grant insert, update, delete, truncate, references, trigger on ${ESQ}.products to authenticated;
grant select (id, sku, nombre, categoria_id, precio_base, activo, created_at,
              imagen_url, favorito, updated_at, control_serial, is_test)
  on ${ESQ}.products to authenticated;

-- El resto usa grant de TABLA (relacl arwdDxtm, attacl NULL en producción).
grant select, insert, update, delete, truncate, references, trigger on
  ${ESQ}.recepciones_compra, ${ESQ}.recepcion_compra_items, ${ESQ}.ordenes_compra,
  ${ESQ}.orden_compra_items, ${ESQ}.product_serials, ${ESQ}.inventory,
  ${ESQ}.inventory_movements, ${ESQ}.product_variants, ${ESQ}.staff,
  ${ESQ}.locations, ${ESQ}.proveedores, ${ESQ}.historial_costos_compra
  to authenticated;

-- RLS con las policies reales: sólo lectura, ninguna de escritura. RLS sin
-- policy de INSERT/UPDATE/DELETE deniega esos comandos.
alter table ${ESQ}.ordenes_compra enable row level security;
create policy oc_admin on ${ESQ}.ordenes_compra for select
  using (${ESQ}.auth_is_admin() or location_id = ${ESQ}.auth_location_id());

alter table ${ESQ}.orden_compra_items enable row level security;
create policy oci_read on ${ESQ}.orden_compra_items for select
  using (exists (select 1 from ${ESQ}.ordenes_compra o where o.id = orden_compra_items.orden_id
                 and (${ESQ}.auth_is_admin() or o.location_id = ${ESQ}.auth_location_id())));

alter table ${ESQ}.recepciones_compra enable row level security;
create policy rc_read on ${ESQ}.recepciones_compra for select
  using (exists (select 1 from ${ESQ}.ordenes_compra o where o.id = recepciones_compra.orden_id
                 and (${ESQ}.auth_is_admin() or o.location_id = ${ESQ}.auth_location_id())));

alter table ${ESQ}.recepcion_compra_items enable row level security;
create policy rci_read on ${ESQ}.recepcion_compra_items for select
  using (exists (select 1 from ${ESQ}.recepciones_compra r join ${ESQ}.ordenes_compra o on o.id = r.orden_id
                 where r.id = recepcion_compra_items.recepcion_id
                 and (${ESQ}.auth_is_admin() or o.location_id = ${ESQ}.auth_location_id())));

alter table ${ESQ}.product_serials enable row level security;
create policy serials_read on ${ESQ}.product_serials for select
  using (${ESQ}.auth_is_admin() or location_id = ${ESQ}.auth_location_id());

alter table ${ESQ}.historial_costos_compra enable row level security;
create policy hcc_admin on ${ESQ}.historial_costos_compra for select using (${ESQ}.auth_is_admin());
`

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const dormir = (ms) => new Promise((r) => setTimeout(r, ms))
const fallos = []
const pasos = []

function comprobar(nombre, ok, detalle) {
  pasos.push({ nombre, ok })
  if (!ok) fallos.push(`${nombre}${detalle ? ` — ${detalle}` : ''}`)
}

const uuid = (() => {
  let n = 0
  return () => {
    n += 1
    return `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
  }
})()

// Toda llamada a la RPC pasa por aquí: rol `authenticated` y JWT realista.
// Nunca como el dueño del esquema. Lección de P0.4.
async function comoAuth(cli, userId, fn) {
  await cli.query('begin')
  await cli.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: 'authenticated' })])
  await cli.query('set local role authenticated')
  try {
    const r = await fn()
    await cli.query('commit')
    return r
  } catch (err) {
    await cli.query('rollback').catch(() => {})
    throw err
  }
}

function recibirSQL(nArgs) {
  return nArgs === 3
    ? `select ${ESQ}.recibir_orden_compra($1::uuid, $2::jsonb, $3::text) as res`
    : `select ${ESQ}.recibir_orden_compra($1::uuid, $2::uuid, $3::jsonb, $4::text, $5::uuid) as res`
}

async function recibir(cli, userId, { orden, ctid, items, obs = null, corrige = null }) {
  return comoAuth(cli, userId, async () => {
    const { rows } = await cli.query(recibirSQL(5), [orden, ctid, JSON.stringify(items), obs, corrige])
    return rows[0].res
  })
}

// Se espera el error: si NO lo hay, es un fallo.
async function debeFallar(nombre, fn, fragmento) {
  try {
    await fn()
    comprobar(nombre, false, 'no lanzó ningún error y debía rechazarse')
    return null
  } catch (err) {
    const msg = String(err.message || err)
    const ok = !fragmento || msg.toLowerCase().includes(fragmento.toLowerCase())
    comprobar(nombre, ok, ok ? '' : `error inesperado: ${msg}`)
    return msg
  }
}

// ---------------------------------------------------------------------------
// Siembra
// ---------------------------------------------------------------------------
const admin = new pg.Client({ connectionString: URL_PG })
await admin.connect()
await admin.query(`set search_path to ${ESQ}, public`)

async function limpiar() {
  await admin.query(`truncate ${ESQ}.historial_costos_compra, ${ESQ}.product_serials,
    ${ESQ}.recepcion_compra_items, ${ESQ}.recepciones_compra, ${ESQ}.orden_compra_items,
    ${ESQ}.ordenes_compra, ${ESQ}.inventory_movements, ${ESQ}.inventory,
    ${ESQ}.product_variants, ${ESQ}.products cascade`)
}

let numeroOrden = 0
/**
 * Crea una orden con sus líneas. Cada línea: {qty, costo, serial?, is_test?}
 * Devuelve {orden, items:[{id, variant_id, product_id}]}
 */
async function sembrarOrden(lineas, { location = LOC } = {}) {
  numeroOrden += 1
  const ordenId = uuid()
  await admin.query(
    `insert into ${ESQ}.ordenes_compra(id, numero, proveedor_id, location_id, estado, creado_por, total)
     values ($1,$2,$3,$4,'enviada',$5,0)`,
    [ordenId, numeroOrden, PROV, location, ADMIN_UUID])
  const items = []
  for (const l of lineas) {
    const productId = uuid()
    const variantId = uuid()
    const itemId = uuid()
    await admin.query(
      `insert into ${ESQ}.products(id, nombre, control_serial, is_test, costo) values ($1,$2,$3,$4,0)`,
      [productId, `P-${numeroOrden}-${items.length}`, !!l.serial, !!l.is_test])
    await admin.query(`insert into ${ESQ}.product_variants(id, product_id) values ($1,$2)`, [variantId, productId])
    await admin.query(
      `insert into ${ESQ}.orden_compra_items(id, orden_id, variant_id, cantidad_pedida, costo_unitario)
       values ($1,$2,$3,$4,$5)`,
      [itemId, ordenId, variantId, l.qty, l.costo ?? 100])
    items.push({ id: itemId, variant_id: variantId, product_id: productId })
  }
  return { orden: ordenId, items }
}

async function estado(ordenId) {
  const { rows: [o] } = await admin.query(`select estado from ${ESQ}.ordenes_compra where id=$1`, [ordenId])
  // Vía to_jsonb para servir a las DOS fases: en la FASE A (esquema de hoy)
  // client_transaction_id, payload_hash y corrige_recepcion_id todavía no
  // existen, y seleccionarlas por nombre abortaba la prueba con 42703 antes de
  // reproducir el bug. Una columna ausente sale como null, no como error.
  const { rows: recsJson } = await admin.query(
    `select to_jsonb(r) as j from ${ESQ}.recepciones_compra r where r.orden_id=$1 order by r.created_at, r.id`, [ordenId])
  const recs = recsJson.map(({ j }) => ({
    id: j.id,
    client_transaction_id: j.client_transaction_id ?? null,
    payload_hash: j.payload_hash ?? null,
    corrige_recepcion_id: j.corrige_recepcion_id ?? null,
  }))
  const { rows: its } = await admin.query(
    `select oi.id, oi.variant_id, oi.cantidad_pedida, oi.cantidad_recibida,
            coalesce(i.cantidad,0) as stock,
            (select count(*)::int from ${ESQ}.product_serials ps where ps.variant_id=oi.variant_id and ps.estado='disponible') as seriales_disp,
            (select count(*)::int from ${ESQ}.product_serials ps where ps.variant_id=oi.variant_id and ps.estado='cuarentena') as seriales_cuar,
            (select coalesce(sum(m.cantidad_delta),0)::int from ${ESQ}.inventory_movements m where m.variant_id=oi.variant_id) as movs_suma,
            (select count(*)::int from ${ESQ}.inventory_movements m where m.variant_id=oi.variant_id) as movs_n,
            (select count(*)::int from ${ESQ}.historial_costos_compra h where h.variant_id=oi.variant_id) as costos_n
     from ${ESQ}.orden_compra_items oi
     left join ${ESQ}.inventory i on i.variant_id=oi.variant_id and i.location_id=(select location_id from ${ESQ}.ordenes_compra where id=$1)
     where oi.orden_id=$1 order by oi.id`, [ordenId])
  const { rows: ris } = await admin.query(
    `select ri.* from ${ESQ}.recepcion_compra_items ri
     join ${ESQ}.recepciones_compra r on r.id=ri.recepcion_id where r.orden_id=$1 order by ri.orden_item_id, ri.id`, [ordenId])
  return { estado: o?.estado, recepciones: recs, lineas: its, items_recepcion: ris }
}

const sinReintento = (res) => {
  const { reintento, ...resto } = res || {}
  return JSON.stringify(resto)
}

// ===========================================================================
// FASE A — el esquema de HOY y la función VIEJA: se reproduce la duplicación
// ===========================================================================
await admin.query(ESQUEMA)
await admin.query(`insert into ${ESQ}.locations(id,nombre) values ($1,'SJL'),($2,'Centro')`, [LOC, LOC2])
await admin.query(`insert into ${ESQ}.proveedores(id,nombre) values ($1,'Prov')`, [PROV])
await admin.query(
  `insert into ${ESQ}.staff(id,user_id,nombre,rol,location_id,activo,username,puesto)
   values ($1,$1,'Admin','administrador',$3,true,'admin','jefa'),
          ($2,$2,'Cajero','cajero',$3,true,'cajero','cajero')`,
  [ADMIN_UUID, CAJERO_UUID, LOC])
await admin.query(aEsquemaPrueba(SQL_SINCRONIZAR))
await admin.query(aEsquemaPrueba(SQL_RECIBIR_VIEJA))

{
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 10, costo: 50 }])
  const payload = [{ orden_item_id: items[0].id, cantidad: 4, seriales: [] }]
  const cli = new pg.Client({ connectionString: URL_PG }); await cli.connect()
  await comoAuth(cli, ADMIN_UUID, () => cli.query(recibirSQL(3), [orden, JSON.stringify(payload), null]))
  // Mismo envío otra vez: es lo que hace el usuario cuando la respuesta se
  // pierde por timeout. La versión vieja no tiene con qué distinguirlo.
  await comoAuth(cli, ADMIN_UUID, () => cli.query(recibirSQL(3), [orden, JSON.stringify(payload), null]))
  await cli.end()
  const e = await estado(orden)
  comprobar('A1 · la función VIEJA duplica la recepción con el mismo envío',
    e.recepciones.length === 2 && e.lineas[0].stock === 8 && e.lineas[0].cantidad_recibida === 8,
    `recepciones=${e.recepciones.length} stock=${e.lineas[0].stock} recibida=${e.lineas[0].cantidad_recibida} (se espera 2/8/8: el bug debe reproducirse o esta prueba no detecta nada)`)
}

// ===========================================================================
// FASE B — se aplica el FICHERO REAL de la migración
// ===========================================================================
await limpiar()
try {
  await admin.query(aEsquemaPrueba(SQL_MIGRACION))
  comprobar('B1 · la migración aplica sobre el esquema real de producción', true)
} catch (err) {
  comprobar('B1 · la migración aplica sobre el esquema real de producción', false, String(err.message || err))
  console.error('\nLa migración no aplica; no tiene sentido seguir.\n', err)
  await admin.query(`drop schema if exists ${ESQ} cascade`).catch(() => {})
  await admin.end().catch(() => {})
  if (servidorLocal) await servidorLocal.stop()
  process.exit(1)
}

{
  // C2 · decisión de coordinación que SUSTITUYE el diseño original de este
  // squad. La intención inicial era borrar la firma de 3 argumentos para que un
  // cliente viejo no llegara a la versión que duplica; pero la migración nunca
  // llegó a escribir ese DROP, y escribirlo rompería el gate duro de
  // compatibilidad: el frontend desplegado (70578db) y cualquier bundle viejo en
  // caché de una terminal offline llaman a esa firma. Se reemplaza EN SU SITIO
  // por un envoltorio que delega en la versión nueva: un cliente viejo ya NO llega
  // al cuerpo viejo que duplicaba, llega a la lógica nueva con todas sus
  // validaciones. Lo único que no obtiene es idempotencia entre reintentos,
  // porque no manda clave. Lección de P0.2 que se mantiene: ninguna sobrecarga
  // EXTRA más allá de estas dos, con estas identidades exactas.
  const { rows } = await admin.query(
    `select pg_get_function_identity_arguments(p.oid) as args, p.prosrc
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname=$1 and p.proname='recibir_orden_compra'`, [ESQ])
  const VIEJA = 'p_orden_id uuid, p_items jsonb, p_observacion text'
  const NUEVA = 'p_orden_id uuid, p_client_transaction_id uuid, p_items jsonb, p_observacion text, p_corrige_recepcion_id uuid'
  const firmas = rows.map((r) => r.args).sort()
  comprobar('B2 · quedan exactamente las dos firmas previstas y ninguna sobrecarga extra',
    rows.length === 2 && firmas.includes(VIEJA) && firmas.includes(NUEVA),
    `hay ${rows.length}: ${firmas.join(' | ')}`)
  const vieja = rows.find((r) => r.args === VIEJA)
  comprobar('B2b · la firma de 3 args ya NO contiene la lógica vieja: sólo delega en la nueva',
    !!vieja && /recibir_orden_compra\s*\(/i.test(vieja.prosrc) && !/insert\s+into/i.test(vieja.prosrc),
    vieja ? 'el cuerpo de 3 args inserta por su cuenta en vez de delegar' : 'no existe la firma de 3 args')
}

// Forma EXACTA en que llama PostgREST desde el frontend desplegado: argumentos
// NOMBRADOS {p_orden_id, p_items, p_observacion}. Con nombres no hay ambigüedad
// entre las dos firmas: la nueva exige p_client_transaction_id, que aquí no va.
const SQL_VIEJA_NOMBRADA = `select * from ${ESQ}.recibir_orden_compra(p_orden_id => $1, p_items => $2::jsonb, p_observacion => $3)`

{
  // B3 · el bundle viejo sigue recibiendo, y lo hace a través de la lógica NUEVA.
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 5 }])
  const cli = new pg.Client({ connectionString: URL_PG }); await cli.connect()
  let rec
  await comoAuth(cli, ADMIN_UUID, async () => {
    const r = await cli.query(SQL_VIEJA_NOMBRADA,
      [orden, JSON.stringify([{ orden_item_id: items[0].id, cantidad: 2, seriales: [] }]), null])
    rec = r.rows[0]
    return r
  })
  await cli.end()
  const e = await estado(orden)
  comprobar('B3 · la firma de 3 args (bundle viejo) recibe y devuelve la fila de recepciones_compra',
    !!rec && !!rec.id && e.recepciones.length === 1 && e.recepciones[0].id === rec.id,
    `rec=${rec && rec.id} recepciones=${e.recepciones.length}`)
  comprobar('B3b · pasa por la lógica nueva: clave generada y hash real, no la ruta vieja',
    !!e.recepciones[0] && e.recepciones[0].client_transaction_id !== null
      && /^[0-9a-f]{32}$/.test(e.recepciones[0].payload_hash || ''),
    `ctid=${e.recepciones[0] && e.recepciones[0].client_transaction_id} hash=${e.recepciones[0] && e.recepciones[0].payload_hash}`)
  comprobar('B3c · stock, cantidad recibida y UN movimiento con delta real',
    e.lineas[0].stock === 2 && e.lineas[0].cantidad_recibida === 2 && e.lineas[0].movs_n === 1 && e.lineas[0].movs_suma === 2,
    `stock=${e.lineas[0].stock} recibida=${e.lineas[0].cantidad_recibida} movs=${e.lineas[0].movs_n}/${e.lineas[0].movs_suma}`)
}

{
  // B4 · coste documentado de la compatibilidad, fijado a propósito: sin clave no
  // hay idempotencia, así que dos envíos idénticos por la firma vieja son dos
  // recepciones, igual que antes de P1. Si alguien cambiara esto para deduplicar
  // por contenido, dos recepciones parciales LEGÍTIMAS e idénticas (4 unidades el
  // lunes, 4 el martes) se fundirían en una y el stock quedaría corto en silencio.
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 10 }])
  const cli = new pg.Client({ connectionString: URL_PG }); await cli.connect()
  const payload = JSON.stringify([{ orden_item_id: items[0].id, cantidad: 4, seriales: [] }])
  await comoAuth(cli, ADMIN_UUID, () => cli.query(SQL_VIEJA_NOMBRADA, [orden, payload, null]))
  await comoAuth(cli, ADMIN_UUID, () => cli.query(SQL_VIEJA_NOMBRADA, [orden, payload, null]))
  await cli.end()
  const e = await estado(orden)
  comprobar('B4 · sin clave no hay idempotencia: dos envíos por la firma vieja son dos recepciones',
    e.recepciones.length === 2 && e.lineas[0].stock === 8,
    `recepciones=${e.recepciones.length} stock=${e.lineas[0].stock}`)
}

// ===========================================================================
// FASE C — idempotencia
// ===========================================================================
const cli = new pg.Client({ connectionString: URL_PG }); await cli.connect()

{
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 10, costo: 50 }])
  const ctid = uuid()
  const payload = [{ orden_item_id: items[0].id, cantidad: 4 }]
  const r1 = await recibir(cli, ADMIN_UUID, { orden, ctid, items: payload })
  const r2 = await recibir(cli, ADMIN_UUID, { orden, ctid, items: payload })
  const e = await estado(orden)
  comprobar('C1 · doble envío con el mismo client_transaction_id → UNA recepción',
    e.recepciones.length === 1, `hay ${e.recepciones.length}`)
  comprobar('C1b · devuelve el MISMO recepcion_id', r1.recepcion_id === r2.recepcion_id,
    `${r1.recepcion_id} vs ${r2.recepcion_id}`)
  comprobar('C1c · el resultado es idéntico salvo la marca de reintento',
    sinReintento(r1) === sinReintento(r2), `${sinReintento(r1)} vs ${sinReintento(r2)}`)
  comprobar('C1d · el primer envío no es reintento y el segundo sí',
    r1.reintento === false && r2.reintento === true, `${r1.reintento}/${r2.reintento}`)
  comprobar('C1e · el stock se suma UNA sola vez', e.lineas[0].stock === 4, `stock=${e.lineas[0].stock}`)
  comprobar('C1f · cantidad_recibida avanza UNA sola vez', e.lineas[0].cantidad_recibida === 4,
    `recibida=${e.lineas[0].cantidad_recibida}`)
  comprobar('C1g · un solo movimiento de inventario, con el delta REAL',
    e.lineas[0].movs_n === 1 && e.lineas[0].movs_suma === 4,
    `movs=${e.lineas[0].movs_n} suma=${e.lineas[0].movs_suma}`)
  comprobar('C1h · una sola línea de documento', e.items_recepcion.length === 1)
  comprobar('C1i · el historial de costo no se duplica', e.lineas[0].costos_n === 1,
    `filas=${e.lineas[0].costos_n}`)
}

{
  // Timeout DESPUÉS del commit: la transacción entró entera, el cliente no vio
  // la respuesta y reintenta desde otra conexión. Es el caso que hoy duplica.
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 10 }])
  const ctid = uuid()
  const payload = [{ orden_item_id: items[0].id, cantidad: 6 }]
  const c1 = new pg.Client({ connectionString: URL_PG }); await c1.connect()
  const r1 = await recibir(c1, ADMIN_UUID, { orden, ctid, items: payload })
  await c1.end() // la conexión "se cae" tras el commit, como en un timeout real
  const c2 = new pg.Client({ connectionString: URL_PG }); await c2.connect()
  const r2 = await recibir(c2, ADMIN_UUID, { orden, ctid, items: payload })
  await c2.end()
  const e = await estado(orden)
  comprobar('C2 · timeout tras el commit + reintento en otra conexión → sin duplicar',
    e.recepciones.length === 1 && e.lineas[0].stock === 6 && e.lineas[0].movs_n === 1
      && r1.recepcion_id === r2.recepcion_id && r2.reintento === true,
    `recepciones=${e.recepciones.length} stock=${e.lineas[0].stock} movs=${e.lineas[0].movs_n}`)
}

{
  // Misma clave, contenido distinto. Devolver el resultado viejo haría
  // desaparecer en silencio una recepción real diferente.
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 10 }])
  const ctid = uuid()
  await recibir(cli, ADMIN_UUID, { orden, ctid, items: [{ orden_item_id: items[0].id, cantidad: 3 }] })
  await debeFallar('C3 · misma clave con contenido distinto se RECHAZA (no se replica en silencio)',
    () => recibir(cli, ADMIN_UUID, { orden, ctid, items: [{ orden_item_id: items[0].id, cantidad: 7 }] }),
    'contenido distinto')
  const e = await estado(orden)
  comprobar('C3b · el rechazo no dejó basura', e.recepciones.length === 1 && e.lineas[0].stock === 3,
    `recepciones=${e.recepciones.length} stock=${e.lineas[0].stock}`)
}

{
  // El orden de líneas y de IMEI no puede cambiar la identidad del envío.
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 4 }, { qty: 4 }])
  const ctid = uuid()
  const a = [{ orden_item_id: items[0].id, cantidad: 1 }, { orden_item_id: items[1].id, cantidad: 2 }]
  const b = [{ orden_item_id: items[1].id, cantidad: 2 }, { orden_item_id: items[0].id, cantidad: 1 }]
  const r1 = await recibir(cli, ADMIN_UUID, { orden, ctid, items: a })
  const r2 = await recibir(cli, ADMIN_UUID, { orden, ctid, items: b })
  comprobar('C4 · el hash es canónico: reordenar las líneas sigue siendo el mismo envío',
    r1.recepcion_id === r2.recepcion_id && r2.reintento === true)
}

{
  // Reutilizar la clave contra OTRA orden nunca puede devolver el resultado de
  // la primera.
  await limpiar()
  const o1 = await sembrarOrden([{ qty: 5 }])
  const o2 = await sembrarOrden([{ qty: 5 }])
  const ctid = uuid()
  await recibir(cli, ADMIN_UUID, { orden: o1.orden, ctid, items: [{ orden_item_id: o1.items[0].id, cantidad: 2 }] })
  await debeFallar('C5 · la misma clave contra otra orden se rechaza',
    () => recibir(cli, ADMIN_UUID, { orden: o2.orden, ctid, items: [{ orden_item_id: o2.items[0].id, cantidad: 2 }] }),
    'ya se usó en la orden')
}

{
  // Una línea repetida dentro del MISMO payload sumaría dos veces bajo un solo
  // hash: es idempotencia rota por dentro.
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 10 }])
  await debeFallar('C6 · línea repetida dentro del mismo envío se rechaza',
    () => recibir(cli, ADMIN_UUID, {
      orden, ctid: uuid(),
      items: [{ orden_item_id: items[0].id, cantidad: 2 }, { orden_item_id: items[0].id, cantidad: 3 }],
    }), 'dos veces')
}

{
  // B1 · la huella tiene que cubrir TODO lo que se envía (hallazgo del squad de UI).
  // La original ignoraba la observación general, la de línea, acepta_sobrante e
  // imei2 y la recepción corregida: la misma clave con esos campos cambiados se
  // devolvía como reintento y el cambio se perdía sin error.
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 10 }])
  const ctid = uuid()
  const base = { orden, ctid, items: [{ orden_item_id: items[0].id, cantidad: 2 }] }
  await recibir(cli, ADMIN_UUID, base)
  await debeFallar('C7 · misma clave con OTRA observación general se RECHAZA',
    () => recibir(cli, ADMIN_UUID, { ...base, obs: 'observación añadida después' }), 'contenido distinto')
  await debeFallar('C7b · misma clave con OTRA observación de línea se RECHAZA',
    () => recibir(cli, ADMIN_UUID, {
      ...base, items: [{ orden_item_id: items[0].id, cantidad: 2, observacion: 'caja abollada' }],
    }), 'contenido distinto')
  await debeFallar('C7c · misma clave aceptando ahora el sobrante se RECHAZA',
    () => recibir(cli, ADMIN_UUID, {
      ...base, items: [{ orden_item_id: items[0].id, cantidad: 2, acepta_sobrante: true }],
    }), 'contenido distinto')
  const recId = (await estado(orden)).recepciones[0].id
  await debeFallar('C7d · misma clave marcándola ahora como corrección se RECHAZA',
    () => recibir(cli, ADMIN_UUID, { ...base, corrige: recId }), 'contenido distinto')
  const e = await estado(orden)
  comprobar('C7e · los rechazos por contenido distinto no dejaron recepciones ni stock de más',
    e.recepciones.length === 1 && e.lineas[0].stock === 2,
    `recepciones=${e.recepciones.length} stock=${e.lineas[0].stock}`)
}

{
  // B2 · la misma clave presentada por OTRA persona no devuelve el resultado ajeno.
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 10 }])
  const ctid = uuid()
  await recibir(cli, ADMIN_UUID, { orden, ctid, items: [{ orden_item_id: items[0].id, cantidad: 3 }] })
  const OTRA = 'dddddddd-dddd-4ddd-8ddd-dddddddddd21'
  await admin.query(
    `insert into ${ESQ}.staff(id,user_id,nombre,rol,location_id,activo,username,puesto)
     values ($1,$1,'Otra jefa','administrador',$2,true,'otra-jefa','jefa')`, [OTRA, LOC])
  await debeFallar('C8 · la misma clave presentada por otra persona se RECHAZA (no devuelve el resultado ajeno)',
    () => recibir(cli, OTRA, { orden, ctid, items: [{ orden_item_id: items[0].id, cantidad: 3 }] }), 'otra persona')
  await admin.query(`delete from ${ESQ}.staff where id=$1`, [OTRA])
}

// ===========================================================================
// FASE D — recepción parcial e incidencias
// ===========================================================================
{
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 10 }])
  await recibir(cli, ADMIN_UUID, { orden, ctid: uuid(), items: [{ orden_item_id: items[0].id, cantidad: 4 }] })
  let e = await estado(orden)
  comprobar('D1 · recepción parcial deja la orden en `parcial`', e.estado === 'parcial', `estado=${e.estado}`)
  await recibir(cli, ADMIN_UUID, { orden, ctid: uuid(), items: [{ orden_item_id: items[0].id, cantidad: 6 }] })
  e = await estado(orden)
  comprobar('D1b · completarla la deja en `recibida` con stock 10 y dos movimientos reales',
    e.estado === 'recibida' && e.lineas[0].stock === 10 && e.lineas[0].movs_n === 2 && e.lineas[0].movs_suma === 10,
    `estado=${e.estado} stock=${e.lineas[0].stock} movs=${e.lineas[0].movs_n}/${e.lineas[0].movs_suma}`)
  await debeFallar('D1c · una orden ya recibida no admite más recepciones',
    () => recibir(cli, ADMIN_UUID, { orden, ctid: uuid(), items: [{ orden_item_id: items[0].id, cantidad: 1 }] }),
    'no recepcionable')
}

{
  // FALTANTE: llegaron 3 de 5. El faltante NO entra a stock y la línea sigue
  // pendiente para poder reclamar o recibir el resto.
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 5 }])
  await recibir(cli, ADMIN_UUID, {
    orden, ctid: uuid(),
    items: [{ orden_item_id: items[0].id, cantidad: 3, cantidad_faltante: 2, observacion: 'Faltaron 2 cajas' }],
  })
  const e = await estado(orden)
  const ri = e.items_recepcion[0]
  comprobar('D2 · faltante: stock sólo por lo que llegó, línea sigue pendiente',
    e.lineas[0].stock === 3 && e.lineas[0].cantidad_recibida === 3 && e.estado === 'parcial'
      && ri.cantidad_faltante === 2 && ri.cantidad === 3 && e.lineas[0].movs_suma === 3,
    `stock=${e.lineas[0].stock} recibida=${e.lineas[0].cantidad_recibida} estado=${e.estado} faltante=${ri.cantidad_faltante}`)
  comprobar('D2b · la observación de la incidencia queda registrada', ri.observacion === 'Faltaron 2 cajas')
}

{
  // DAÑADO: llegaron 5, 2 rotas. Sólo entran 3 al stock vendible.
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 5 }])
  await recibir(cli, ADMIN_UUID, {
    orden, ctid: uuid(),
    items: [{ orden_item_id: items[0].id, cantidad: 3, cantidad_danada: 2 }],
  })
  const e = await estado(orden)
  const ri = e.items_recepcion[0]
  comprobar('D3 · dañado: lo roto NO entra al stock vendible y el delta es el real',
    e.lineas[0].stock === 3 && e.lineas[0].movs_suma === 3 && ri.cantidad_danada === 2
      && e.lineas[0].cantidad_recibida === 3,
    `stock=${e.lineas[0].stock} movs=${e.lineas[0].movs_suma} danada=${ri.cantidad_danada} recibida=${e.lineas[0].cantidad_recibida}`)
}

{
  // SOBRANTE: quedaban 2 pendientes y llegaron 5.
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 2 }])
  await debeFallar('D4 · sobrante sin aceptación explícita se rechaza (un dedazo no infla stock)',
    () => recibir(cli, ADMIN_UUID, { orden, ctid: uuid(), items: [{ orden_item_id: items[0].id, cantidad: 5 }] }),
    'acepta_sobrante')
  let e = await estado(orden)
  comprobar('D4b · el rechazo no dejó recepción ni stock', e.recepciones.length === 0 && e.lineas[0].stock === 0)

  await recibir(cli, ADMIN_UUID, {
    orden, ctid: uuid(),
    items: [{ orden_item_id: items[0].id, cantidad: 5, acepta_sobrante: true }],
  })
  e = await estado(orden)
  const ri = e.items_recepcion[0]
  comprobar('D4c · sobrante aceptado: se registra, el stock refleja lo físico y la orden no se pasa de lo pedido',
    ri.cantidad_sobrante === 3 && e.lineas[0].stock === 5 && e.lineas[0].cantidad_recibida === 2
      && e.estado === 'recibida',
    `sobrante=${ri.cantidad_sobrante} stock=${e.lineas[0].stock} recibida=${e.lineas[0].cantidad_recibida} estado=${e.estado}`)
}

{
  // El sobrante lo calcula el SERVIDOR. Si el cliente lo miente, se ignora.
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 10 }])
  await recibir(cli, ADMIN_UUID, {
    orden, ctid: uuid(),
    items: [{ orden_item_id: items[0].id, cantidad: 3, cantidad_sobrante: 99 }],
  })
  const e = await estado(orden)
  comprobar('D5 · cantidad_sobrante la deriva el servidor; el valor del cliente se ignora',
    e.items_recepcion[0].cantidad_sobrante === 0, `sobrante=${e.items_recepcion[0].cantidad_sobrante}`)
}

{
  // PRODUCTO EQUIVOCADO: no se stockea automáticamente lo que no se pidió.
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 5 }])
  const otra = await sembrarOrden([{ qty: 1 }])
  const variantAjena = otra.items[0].variant_id
  await recibir(cli, ADMIN_UUID, {
    orden, ctid: uuid(),
    items: [{
      orden_item_id: items[0].id, cantidad: 2, cantidad_producto_equivocado: 3,
      variant_id_recibido: variantAjena, observacion: 'Mandaron otro modelo',
    }],
  })
  const e = await estado(orden)
  const ri = e.items_recepcion[0]
  const { rows: [aj] } = await admin.query(
    `select coalesce(sum(cantidad),0)::int as n from ${ESQ}.inventory where variant_id=$1`, [variantAjena])
  comprobar('D6 · producto equivocado: se registra con la variante que llegó y NO entra a inventario',
    ri.cantidad_producto_equivocado === 3 && ri.variant_id_recibido === variantAjena
      && Number(aj.n) === 0 && e.lineas[0].stock === 2 && e.lineas[0].cantidad_recibida === 2,
    `equivocado=${ri.cantidad_producto_equivocado} stock_ajeno=${aj.n} stock=${e.lineas[0].stock}`)

  await debeFallar('D6b · declarar producto equivocado sin decir cuál se rechaza',
    () => recibir(cli, ADMIN_UUID, {
      orden, ctid: uuid(),
      items: [{ orden_item_id: items[0].id, cantidad_producto_equivocado: 1 }],
    }), 'a la vez')
  await debeFallar('D6c · la variante "equivocada" no puede ser la misma que se pidió',
    () => recibir(cli, ADMIN_UUID, {
      orden, ctid: uuid(),
      items: [{ orden_item_id: items[0].id, cantidad_producto_equivocado: 1, variant_id_recibido: items[0].variant_id }],
    }), 'misma que se pidió')
}

{
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 5 }])
  await debeFallar('D7 · una línea sin ninguna cantidad se rechaza',
    () => recibir(cli, ADMIN_UUID, { orden, ctid: uuid(), items: [{ orden_item_id: items[0].id, cantidad: 0 }] }),
    'no declara ninguna cantidad')
  await debeFallar('D7b · una línea de otra orden se rechaza',
    () => recibir(cli, ADMIN_UUID, { orden, ctid: uuid(), items: [{ orden_item_id: uuid(), cantidad: 1 }] }),
    'Línea inválida')
}

// ===========================================================================
// FASE E — IMEI exactos y stock serializado derivado (invariante P0.2/P0.4)
// ===========================================================================
{
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 5, serial: true }])
  const it = items[0].id

  await debeFallar('E1 · faltan IMEI → rechazo exacto',
    () => recibir(cli, ADMIN_UUID, {
      orden, ctid: uuid(),
      items: [{ orden_item_id: it, cantidad: 3, seriales: [{ serial_number: 'IMEI-A' }] }],
    }), 'requiere exactamente 3')

  await debeFallar('E1b · sobran IMEI → rechazo exacto',
    () => recibir(cli, ADMIN_UUID, {
      orden, ctid: uuid(),
      items: [{ orden_item_id: it, cantidad: 1, seriales: [{ serial_number: 'IMEI-A' }, { serial_number: 'IMEI-B' }] }],
    }), 'requiere exactamente 1')

  await debeFallar('E1c · IMEI repetidos dentro de la misma línea → rechazo',
    () => recibir(cli, ADMIN_UUID, {
      orden, ctid: uuid(),
      items: [{ orden_item_id: it, cantidad: 2, seriales: [{ serial_number: 'IMEI-A' }, { serial_number: 'IMEI-A' }] }],
    }), 'repetidos')

  let e = await estado(orden)
  comprobar('E1d · ningún rechazo de IMEI dejó recepción a medias',
    e.recepciones.length === 0 && e.lineas[0].stock === 0 && e.lineas[0].seriales_disp === 0)

  // 2 buenas + 1 dañada. El dañado existe y queda trazado, pero en cuarentena:
  // no es stock vendible.
  await recibir(cli, ADMIN_UUID, {
    orden, ctid: uuid(),
    items: [{
      orden_item_id: it, cantidad: 2, cantidad_danada: 1,
      seriales: [
        { serial_number: 'IMEI-1', imei2: 'IMEI-1B' },
        { serial_number: 'IMEI-2' },
        { serial_number: 'IMEI-3', danado: true },
      ],
    }],
  })
  e = await estado(orden)
  comprobar('E2 · el stock serializado se DERIVA de product_serials (P0.2/P0.4)',
    e.lineas[0].stock === e.lineas[0].seriales_disp && e.lineas[0].stock === 2,
    `stock=${e.lineas[0].stock} disponibles=${e.lineas[0].seriales_disp}`)
  comprobar('E2b · el IMEI dañado existe en cuarentena, fuera del stock vendible',
    e.lineas[0].seriales_cuar === 1, `cuarentena=${e.lineas[0].seriales_cuar}`)
  comprobar('E2c · un solo movimiento con el delta REAL (+2, no +3)',
    e.lineas[0].movs_n === 1 && e.lineas[0].movs_suma === 2,
    `movs=${e.lineas[0].movs_n} suma=${e.lineas[0].movs_suma}`)
  comprobar('E2d · cantidad_recibida sólo avanza con lo bueno', e.lineas[0].cantidad_recibida === 2)
  comprobar('E2e · el IMEI2 se guarda', (await admin.query(
    `select imei2 from ${ESQ}.product_serials where serial_number='IMEI-1'`)).rows[0].imei2 === 'IMEI-1B')

  await debeFallar('E3 · declarar dañadas y no marcar esos IMEI → rechazo',
    () => recibir(cli, ADMIN_UUID, {
      orden, ctid: uuid(),
      items: [{
        orden_item_id: it, cantidad: 1, cantidad_danada: 1,
        seriales: [{ serial_number: 'IMEI-9' }, { serial_number: 'IMEI-10' }],
      }],
    }), 'marca 0 IMEI como dañados')

  await debeFallar('E4 · un IMEI ya registrado no se puede volver a recibir',
    () => recibir(cli, ADMIN_UUID, {
      orden, ctid: uuid(),
      items: [{ orden_item_id: it, cantidad: 1, seriales: [{ serial_number: 'IMEI-1' }] }],
    }), 'ya está registrado')

  e = await estado(orden)
  comprobar('E4b · el rechazo por IMEI duplicado no desincronizó inventory de product_serials',
    e.lineas[0].stock === e.lineas[0].seriales_disp && e.lineas[0].stock === 2 && e.recepciones.length === 1,
    `stock=${e.lineas[0].stock} disponibles=${e.lineas[0].seriales_disp} recepciones=${e.recepciones.length}`)
}

{
  // Reintento de una recepción serializada: ni un serial de más.
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 4, serial: true }])
  const ctid = uuid()
  const payload = [{
    orden_item_id: items[0].id, cantidad: 2,
    seriales: [{ serial_number: 'S-1' }, { serial_number: 'S-2' }],
  }]
  const r1 = await recibir(cli, ADMIN_UUID, { orden, ctid, items: payload })
  const r2 = await recibir(cli, ADMIN_UUID, { orden, ctid, items: payload })
  const e = await estado(orden)
  const { rows: [n] } = await admin.query(`select count(*)::int as n from ${ESQ}.product_serials`)
  comprobar('E5 · reintento serializado: ni un serial, ni un movimiento, ni una fila de más',
    n.n === 2 && e.lineas[0].stock === 2 && e.lineas[0].movs_n === 1 && e.recepciones.length === 1
      && r1.recepcion_id === r2.recepcion_id && sinReintento(r1) === sinReintento(r2),
    `seriales=${n.n} stock=${e.lineas[0].stock} movs=${e.lineas[0].movs_n} recepciones=${e.recepciones.length}`)
  comprobar('E5b · el resultado del reintento incluye los mismos IMEI',
    JSON.stringify(r1.lineas[0].seriales) === JSON.stringify(['S-1', 'S-2']),
    JSON.stringify(r1.lineas[0].seriales))
}

{
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 3 }])
  await debeFallar('E6 · mandar seriales a un producto sin IMEI se rechaza',
    () => recibir(cli, ADMIN_UUID, {
      orden, ctid: uuid(),
      items: [{ orden_item_id: items[0].id, cantidad: 1, seriales: [{ serial_number: 'X-1' }] }],
    }), 'no es de un producto con IMEI')
}

// ===========================================================================
// FASE F — concurrencia REAL
// ===========================================================================
async function esperarBloqueo(pid, intentos = 60) {
  const testigo = new pg.Client({ connectionString: URL_PG }); await testigo.connect()
  let visto = false
  for (let i = 0; i < intentos && !visto; i++) {
    await dormir(50)
    const { rows } = await testigo.query(
      "select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'", [pid])
    visto = rows.length > 0
  }
  await testigo.end()
  return visto
}

{
  // Dos conexiones reciben la MISMA orden con la MISMA clave a la vez.
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 10 }])
  const ctid = uuid()
  const payload = JSON.stringify([{ orden_item_id: items[0].id, cantidad: 4 }])

  const A = new pg.Client({ connectionString: URL_PG }); await A.connect()
  const B = new pg.Client({ connectionString: URL_PG }); await B.connect()
  const { rows: [{ pid }] } = await B.query('select pg_backend_pid() as pid')

  for (const c of [A, B]) {
    await c.query('begin')
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ADMIN_UUID })])
    await c.query('set local role authenticated')
  }
  // A ejecuta la recepción entera y NO hace commit: retiene el lock de la orden.
  const rA = (await A.query(recibirSQL(5), [orden, ctid, payload, null, null])).rows[0].res
  // B arranca en paralelo y se bloqueará de verdad.
  const enCurso = B.query(recibirSQL(5), [orden, ctid, payload, null, null])
  const bloqueo = await esperarBloqueo(pid)
  await A.query('commit')
  const rB = (await enCurso).rows[0].res
  await B.query('commit')
  await A.end(); await B.end()

  const e = await estado(orden)
  comprobar('F1 · hubo bloqueo REAL (si no, no se probó ninguna carrera)', bloqueo)
  comprobar('F1b · dos conexiones simultáneas con la misma clave → UNA sola recepción',
    e.recepciones.length === 1, `recepciones=${e.recepciones.length}`)
  comprobar('F1c · ambas reciben el MISMO recepcion_id', rA.recepcion_id === rB.recepcion_id,
    `${rA.recepcion_id} vs ${rB.recepcion_id}`)
  comprobar('F1d · el resultado es idéntico salvo la marca de reintento',
    sinReintento(rA) === sinReintento(rB))
  comprobar('F1e · el stock se sumó UNA vez y hay UN movimiento',
    e.lineas[0].stock === 4 && e.lineas[0].movs_n === 1 && e.lineas[0].cantidad_recibida === 4,
    `stock=${e.lineas[0].stock} movs=${e.lineas[0].movs_n} recibida=${e.lineas[0].cantidad_recibida}`)
}

{
  // El índice único es la garantía DURA, independiente de la lógica de la
  // función: dos inserts simultáneos con la misma clave, sin pasar por la RPC.
  await limpiar()
  const { orden } = await sembrarOrden([{ qty: 5 }])
  const ctid = uuid()
  const A = new pg.Client({ connectionString: URL_PG }); await A.connect()
  const B = new pg.Client({ connectionString: URL_PG }); await B.connect()
  const { rows: [{ pid }] } = await B.query('select pg_backend_pid() as pid')
  const ins = `insert into ${ESQ}.recepciones_compra(orden_id, recibido_por, client_transaction_id, payload_hash)
               values ($1,$2,$3,'h')`
  await A.query('begin'); await B.query('begin')
  await A.query(ins, [orden, ADMIN_UUID, ctid])
  const pendiente = B.query(ins, [orden, ADMIN_UUID, ctid]).then(() => null).catch((err) => err)
  const bloqueo = await esperarBloqueo(pid)
  await A.query('commit')
  const err = await pendiente
  await B.query('rollback')
  await A.end(); await B.end()
  comprobar('F2 · el índice único bloquea el segundo insert y lo rechaza con 23505',
    bloqueo && err && err.code === '23505',
    `bloqueo=${bloqueo} code=${err && err.code}`)
  const e = await estado(orden)
  comprobar('F2b · sólo sobrevivió una recepción', e.recepciones.length === 1)
}

{
  // Dos recepciones DISTINTAS y simultáneas de la misma orden: son legítimas,
  // pero entre las dos no pueden pasarse de lo pedido sin aceptar el sobrante.
  // Se reciben 4 + 4 sobre una orden de 6: la primera deja la orden en parcial,
  // así que la segunda NO puede apoyarse en la guarda de estado y TIENE que
  // releer lo ya recibido bajo el lock para ver que 4 + 4 supera lo pedido. Con
  // 6 + 6 la primera completaba la orden y saltaba antes la guarda de estado,
  // que también impide sobre-recibir pero no ejercitaba la relectura.
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 6 }])
  const payload = JSON.stringify([{ orden_item_id: items[0].id, cantidad: 4 }])
  const A = new pg.Client({ connectionString: URL_PG }); await A.connect()
  const B = new pg.Client({ connectionString: URL_PG }); await B.connect()
  const { rows: [{ pid }] } = await B.query('select pg_backend_pid() as pid')
  for (const c of [A, B]) {
    await c.query('begin')
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ADMIN_UUID })])
    await c.query('set local role authenticated')
  }
  await A.query(recibirSQL(5), [orden, uuid(), payload, null, null])
  const enCurso = B.query(recibirSQL(5), [orden, uuid(), payload, null, null]).then(() => null).catch((e2) => e2)
  const bloqueo = await esperarBloqueo(pid)
  await A.query('commit')
  const err = await enCurso
  await B.query('rollback').catch(() => {})
  await A.end(); await B.end()
  const e = await estado(orden)
  comprobar('F3 · dos recepciones distintas y simultáneas: la segunda ve lo ya recibido y no sobre-recibe',
    bloqueo && err !== null && /acepta_sobrante/i.test(String(err.message || err))
      && e.lineas[0].cantidad_recibida === 4 && e.lineas[0].stock === 4,
    `bloqueo=${bloqueo} err=${err && err.message} recibida=${e.lineas[0].cantidad_recibida} stock=${e.lineas[0].stock}`)
}

{
  // T1 · FALLO CERRADO SIN SUCURSAL (hallazgo del coordinador). Con `<>`, una
  // sucursal NULL daba NULL y el IF no saltaba: cualquiera sin sucursal recibía
  // órdenes de cualquier sucursal. Se usa un ADMINISTRADOR a propósito: pasa el
  // control de rol, así que el rechazo sólo puede venir del de sucursal.
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 5 }])
  const SIN_SUC = 'dddddddd-dddd-4ddd-8ddd-dddddddddd11'
  // En producción staff.location_id admite NULL; se refleja por si el esquema de
  // prueba lo hubiera declarado NOT NULL.
  await admin.query(`alter table ${ESQ}.staff alter column location_id drop not null`)
  await admin.query(
    `insert into ${ESQ}.staff(id,user_id,nombre,rol,location_id,activo,username,puesto)
     values ($1,$1,'Admin sin sucursal','administrador',null,true,'admin-sin-sucursal','jefa')`, [SIN_SUC])
  await debeFallar('T1 · un administrador SIN sucursal no recibe órdenes (fallo cerrado)',
    () => recibir(cli, SIN_SUC, { orden, ctid: uuid(), items: [{ orden_item_id: items[0].id, cantidad: 2 }] }),
    'otra sucursal')
  const e = await estado(orden)
  comprobar('T1b · el intento sin sucursal no dejó recepción, stock ni cantidad recibida',
    e.recepciones.length === 0 && e.lineas[0].stock === 0 && e.lineas[0].cantidad_recibida === 0,
    `recepciones=${e.recepciones.length} stock=${e.lineas[0].stock} recibida=${e.lineas[0].cantidad_recibida}`)
  await admin.query(`delete from ${ESQ}.staff where id=$1`, [SIN_SUC])
}

// ===========================================================================
// FASE G — historial append-only
// ===========================================================================
{
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 10 }])
  const r1 = await recibir(cli, ADMIN_UUID, { orden, ctid: uuid(), items: [{ orden_item_id: items[0].id, cantidad: 3 }] })

  // El dueño del esquema (equivalente a `postgres` en producción) bypasea RLS,
  // así que sin el trigger esto pasaría. Es exactamente el agujero que el
  // trigger tapa.
  await debeFallar('G1 · no se puede UPDATE una recepción, ni siquiera como dueño',
    () => admin.query(`update ${ESQ}.recepciones_compra set observacion='reescrito' where id=$1`, [r1.recepcion_id]),
    'append-only')
  await debeFallar('G2 · no se puede DELETE una recepción',
    () => admin.query(`delete from ${ESQ}.recepciones_compra where id=$1`, [r1.recepcion_id]),
    'append-only')
  await debeFallar('G3 · no se pueden modificar las líneas del documento',
    () => admin.query(`update ${ESQ}.recepcion_compra_items set cantidad=99 where recepcion_id=$1`, [r1.recepcion_id]),
    'append-only')
  await debeFallar('G4 · no se pueden borrar las líneas del documento',
    () => admin.query(`delete from ${ESQ}.recepcion_compra_items where recepcion_id=$1`, [r1.recepcion_id]),
    'append-only')

  // Adjuntar el documento escaneado una vez sí se permite; sustituirlo no.
  let ok = true, detalle = ''
  try {
    await admin.query(`update ${ESQ}.recepciones_compra set storage_path='ocr/1.pdf' where id=$1`, [r1.recepcion_id])
  } catch (err) { ok = false; detalle = String(err.message) }
  comprobar('G5 · adjuntar el documento una vez sí se permite', ok, detalle)
  await debeFallar('G5b · sustituir un documento ya adjunto se rechaza',
    () => admin.query(`update ${ESQ}.recepciones_compra set storage_path='ocr/2.pdf' where id=$1`, [r1.recepcion_id]),
    'ya estaba adjunto')

  // La corrección es una recepción NUEVA que apunta a la anterior.
  const r2 = await recibir(cli, ADMIN_UUID, {
    orden, ctid: uuid(), corrige: r1.recepcion_id,
    items: [{ orden_item_id: items[0].id, cantidad: 1, cantidad_danada: 1, observacion: 'Corrige: una venía rota' }],
  })
  const e = await estado(orden)
  comprobar('G6 · la corrección es una fila nueva y la anterior sigue intacta',
    e.recepciones.length === 2 && e.recepciones.some((r) => r.id === r1.recepcion_id)
      && r2.corrige_recepcion_id === r1.recepcion_id,
    `recepciones=${e.recepciones.length} corrige=${r2.corrige_recepcion_id}`)
  comprobar('G6b · las líneas de ambas recepciones conviven', e.items_recepcion.length === 2)
  comprobar('G6c · el stock refleja las dos recepciones con su delta real',
    e.lineas[0].stock === 4 && e.lineas[0].movs_n === 2 && e.lineas[0].movs_suma === 4,
    `stock=${e.lineas[0].stock} movs=${e.lineas[0].movs_n}/${e.lineas[0].movs_suma}`)

  await debeFallar('G7 · no se puede corregir una recepción de otra orden',
    async () => {
      const otra = await sembrarOrden([{ qty: 2 }])
      return recibir(cli, ADMIN_UUID, {
        orden: otra.orden, ctid: uuid(), corrige: r1.recepcion_id,
        items: [{ orden_item_id: otra.items[0].id, cantidad: 1 }],
      })
    }, 'no pertenece a esta orden')
}

// ===========================================================================
// FASE H — privilegios y RLS (lección de P0.4: NO validar sólo como postgres)
// ===========================================================================
{
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 5, serial: false }])
  await recibir(cli, ADMIN_UUID, {
    orden, ctid: uuid(),
    items: [{ orden_item_id: items[0].id, cantidad: 2, cantidad_danada: 1, cantidad_faltante: 1 }],
  })

  // LO QUE FALLÓ EN P0.4: una columna nueva invisible para `authenticated`.
  // recepciones_compra y recepcion_compra_items usan grant de TABLA, así que
  // las columnas nuevas heredan el SELECT. Esta comprobación es la que se
  // pondría roja si alguien las convirtiera a grants por columna.
  let ok = true, detalle = ''
  try {
    await comoAuth(cli, ADMIN_UUID, async () => {
      const a = await cli.query(`select client_transaction_id, payload_hash, corrige_recepcion_id from ${ESQ}.recepciones_compra`)
      const b = await cli.query(`select cantidad, cantidad_danada, cantidad_faltante, cantidad_sobrante,
                                        cantidad_producto_equivocado, variant_id_recibido, observacion
                                 from ${ESQ}.recepcion_compra_items`)
      if (a.rows.length !== 1 || b.rows.length !== 1) {
        ok = false; detalle = `filas visibles: cabecera=${a.rows.length} lineas=${b.rows.length}`
      }
    })
  } catch (err) { ok = false; detalle = String(err.message) }
  comprobar('H1 · `authenticated` VE las columnas nuevas (P0.4/R8: 42501 silencioso)', ok, detalle)

  // El control de privacidad de costo que ya existía sigue en pie.
  await debeFallar('H2 · `authenticated` sigue sin poder leer products.costo',
    () => comoAuth(cli, ADMIN_UUID, () => cli.query(`select costo from ${ESQ}.products`)),
    'permission denied')
  ok = true; detalle = ''
  try {
    await comoAuth(cli, ADMIN_UUID, () => cli.query(`select is_test, control_serial from ${ESQ}.products`))
  } catch (err) { ok = false; detalle = String(err.message) }
  comprobar('H2b · `authenticated` sí puede leer is_test y control_serial', ok, detalle)

  // RLS: la escritura directa a las tablas del documento sigue cerrada.
  await debeFallar('H3 · RLS impide insertar una recepción saltándose la RPC',
    () => comoAuth(cli, ADMIN_UUID, () => cli.query(
      `insert into ${ESQ}.recepciones_compra(orden_id, recibido_por, client_transaction_id, payload_hash)
       values ($1,$2,$3,'x')`, [orden, ADMIN_UUID, uuid()])),
    'row-level security')

  // `anon` no puede ejecutar la RPC (revocado en P0.4 / migración D).
  const anonCli = new pg.Client({ connectionString: URL_PG }); await anonCli.connect()
  await debeFallar('H4 · `anon` no puede ejecutar recibir_orden_compra', async () => {
    await anonCli.query('begin')
    await anonCli.query('set local role anon')
    try { await anonCli.query(recibirSQL(5), [orden, uuid(), '[]', null, null]) }
    finally { await anonCli.query('rollback').catch(() => {}) }
  }, 'permission denied')
  await anonCli.end()

  // Un cajero no puede recibir: se mantiene la regla de puestos de producción.
  await debeFallar('H5 · un cajero no puede recibir compras',
    () => recibir(cli, CAJERO_UUID, { orden, ctid: uuid(), items: [{ orden_item_id: items[0].id, cantidad: 1 }] }),
    'Sin permiso')

  // Sin JWT no hay staff y por tanto no hay recepción.
  await debeFallar('H6 · sin identidad no se puede recibir', async () => {
    await cli.query('begin')
    await cli.query('set local role authenticated')
    try { await cli.query(recibirSQL(5), [orden, uuid(), JSON.stringify([{ orden_item_id: items[0].id, cantidad: 1 }]), null, null]) }
    finally { await cli.query('rollback').catch(() => {}) }
  }, 'Sin permiso')
}

{
  // Sucursal ajena: la regla que ya existía en producción no se relaja.
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 5 }], { location: LOC2 })
  await debeFallar('H7 · no se puede recibir una orden de otra sucursal',
    () => recibir(cli, ADMIN_UUID, { orden, ctid: uuid(), items: [{ orden_item_id: items[0].id, cantidad: 1 }] }),
    'otra sucursal')
}

{
  // P0.4: el catálogo de prueba no entra en ningún consumidor operativo, y
  // recibir escribe inventario, movimientos e historial de costo.
  await limpiar()
  const { orden, items } = await sembrarOrden([{ qty: 5, is_test: true }])
  await debeFallar('H8 · no se puede recibir contra un producto is_test (invariante P0.4)',
    () => recibir(cli, ADMIN_UUID, { orden, ctid: uuid(), items: [{ orden_item_id: items[0].id, cantidad: 1 }] }),
    'is_test')
  const e = await estado(orden)
  comprobar('H8b · el rechazo no movió inventario ni creó recepción',
    e.recepciones.length === 0 && e.lineas[0].stock === 0)
}

// ===========================================================================
// FASE I — comprobaciones estáticas sobre el fichero de migración
// ===========================================================================
{
  const m = SQL_MIGRACION
  comprobar('I1 · la migración DROPEA las sobrecargas antes de crear (lección P0.2)',
    /drop function/i.test(m) && /proname\s*=\s*'recibir_orden_compra'/i.test(m))
  comprobar('I2 · p_client_transaction_id NO tiene DEFAULT',
    !/p_client_transaction_id\s+uuid\s+default/i.test(m))
  comprobar('I3 · el stock serializado se delega en sincronizar_stock_serializado',
    /private\.sincronizar_stock_serializado\s*\(/.test(m))
  comprobar('I4 · a `anon` no se le concede EXECUTE',
    !/grant\s+execute[^;]*\banon\b/i.test(m) && /revoke[^;]*\bfrom\s+anon\b/i.test(m))
  comprobar('I5 · existe el índice único de idempotencia',
    /create unique index[^;]*recepciones_compra\s*\(\s*client_transaction_id\s*\)/i.test(m))
  comprobar('I6 · no se conceden privilegios sobre products.costo',
    !/grant\s+select\s*\([^)]*\bcosto\b/i.test(m))
  // El movimiento del ramal serializado no puede escribirse a mano: eso era
  // justo el delta fijo que P0.2 prohibió.
  const ramaSerial = m.slice(m.indexOf('if coalesce(v_control, false) then'), m.indexOf('else\n      if v_buenas > 0 then'))
  comprobar('I7 · la rama serializada NO escribe inventory ni movimientos a mano',
    ramaSerial.length > 0
      && !/insert\s+into\s+public\.inventory\s*\(/i.test(ramaSerial)
      && !/insert\s+into\s+public\.inventory_movements/i.test(ramaSerial),
    `longitud de la rama analizada: ${ramaSerial.length}`)
}

// ---------------------------------------------------------------------------
await cli.end().catch(() => {})
await admin.query(`drop schema if exists ${ESQ} cascade`).catch(() => {})
await admin.end().catch(() => {})
if (servidorLocal) await servidorLocal.stop()

console.log('RECEPCIÓN DE COMPRAS — FASE 14')
console.log(`SQL real de ${MIGRACION_NUEVA}, PostgreSQL real, rol authenticated\n`)
for (const p of pasos) console.log(`  ${p.ok ? 'ok  ' : 'FAIL'}  ${p.nombre}`)
console.log(`\n  ${pasos.filter((p) => p.ok).length}/${pasos.length} comprobaciones`)

if (fallos.length) {
  console.log('\nFallos:')
  for (const f of fallos) console.log(`  [FAIL] ${f}`)
  process.exit(1)
}
console.log('\nFASE 14: la versión vieja duplica, la nueva es idempotente bajo reintento y concurrencia. PASS')
