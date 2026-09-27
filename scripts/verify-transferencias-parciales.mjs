#!/usr/bin/env node
// ============================================================================
// FASE 13 — TRANSFERENCIAS PARCIALES: verificación contra PostgreSQL REAL.
//
// QUÉ SE EJERCITA: el SQL REAL del fichero
//   supabase/migrations/_p1_a_transferencias_parciales.sql
// cargado tal cual, DDL incluido, sobre un esquema mínimo que reproduce el de
// producción ANTES de la migración. No hay reimplementación de nada: si
// alguien rompe la migración, esta prueba se pone roja. (En P0.4 una versión
// anterior de otro verificador reimplementaba las funciones a mano y por eso
// seguía en verde con el bug de vuelta.)
//
// SE PRUEBA COMO `authenticated`, NO COMO `postgres`. Ésa es la lección de
// P0.4: el rol `postgres` es dueño de todo y no pasa por privilegios de tabla
// ni por RLS, así que validar sólo con él dejó pasar un 42501 que rompía el
// dashboard para TODOS los usuarios. Aquí cada llamada operativa va con
// `set local role authenticated` y un request.jwt.claims realista.
//
// FALLA CERRADO. Sin entorno, exit 1. Nunca un SKIP con exit 0.
//
// Dos formas de ejecutarla, ambas reales:
//   P04_PG_URL=postgres://user:pass@localhost/db node scripts/verify-transferencias-parciales.mjs
//   cd .p04-pgtest && npm install   (una vez; luego el script arranca solo)
//
// Todo vive dentro del esquema desechable `t13`. El único DROP que hace este
// script es el de su propio esquema.
// ============================================================================

import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'
// Nombre lógico → archivo real (provisional `_p1_a_…` o versionado tras aplicarse en producción).
import { resolverMigracion } from './lib/migraciones.mjs'

const AISLADO = new URL('../.p04-pgtest/', import.meta.url)
const MIGRACIONES = new URL('../supabase/migrations/', import.meta.url).pathname

function abortar(motivo) {
  console.error('TRANSFERENCIAS PARCIALES (FASE 13): NO EJECUTADA\n')
  console.error(`  ${motivo}\n`)
  console.error('  Esta prueba comprueba recepción parcial, faltante, sobrante, dañado,')
  console.error('  idempotencia, concurrencia y que inventory nunca se desincronice de')
  console.error('  product_serials. Sin un PostgreSQL real no se puede ejercitar, y no')
  console.error('  ejecutarla NO es lo mismo que pasarla.\n')
  console.error('  Para ejecutarla de verdad, cualquiera de estas dos:')
  console.error('    P04_PG_URL=postgres://user:pass@localhost/db node scripts/verify-transferencias-parciales.mjs')
  console.error('    cd .p04-pgtest && npm install     (una vez)')
  process.exit(1)
}

let pg
try {
  pg = (await import('pg')).default
} catch {
  try { pg = createRequire(AISLADO)('pg') }
  catch { abortar('No hay cliente PostgreSQL (`pg`) ni en el repo ni en .p04-pgtest/.') }
}

const MIGRACION = MIGRACIONES + resolverMigracion('_p1_a_transferencias_parciales.sql')
if (!fs.existsSync(MIGRACION)) abortar(`No existe la migración bajo prueba: ${MIGRACION}`)

let URL_PG = process.env.P04_PG_URL
let servidorLocal = null

// Este script CREA y DESTRUYE objetos: sólo contra un PostgreSQL local.
if (URL_PG) {
  let anfitrion
  try { anfitrion = new URL(URL_PG.replace(/^postgres(ql)?:\/\//, 'http://')).hostname }
  catch { abortar(`P04_PG_URL no es una URL válida: ${URL_PG}`) }
  if (!['localhost', '127.0.0.1', '::1', ''].includes(anfitrion)) {
    abortar(`P04_PG_URL apunta a "${anfitrion}", que no es local. Esta prueba crea y borra objetos.`)
  }
}

if (!URL_PG) {
  let EmbeddedPostgres
  try {
    EmbeddedPostgres = (await import(new URL('node_modules/embedded-postgres/dist/index.js', AISLADO).href)).default
  } catch {
    abortar('Falta P04_PG_URL y el entorno local aislado (.p04-pgtest/) no está instalado.')
  }
  const puerto = 54333
  const dir = new URL('pgdata-transf', AISLADO).pathname
  fs.rmSync(dir, { recursive: true, force: true })
  servidorLocal = new EmbeddedPostgres({ databaseDir: dir, user: 'p04', password: 'p04', port: puerto, persistent: false })
  await servidorLocal.initialise()
  await servidorLocal.start()
  await servidorLocal.createDatabase('p04')
  URL_PG = `postgresql://p04:p04@localhost:${puerto}/p04`
}

// --- Extracción del SQL real de las migraciones -----------------------------
// Se toma la función tal cual está escrita en el fichero. Detecta la etiqueta
// dollar-quote real ($$ o $function$): el proyecto usa las dos.
function funcionDeMigracion(fichero, nombre) {
  const sql = fs.readFileSync(MIGRACIONES + resolverMigracion(fichero), 'utf8')
  const inicio = sql.search(new RegExp(`create or replace function\\s+(?:public\\.|private\\.)?${nombre}\\s*\\(`, 'i'))
  if (inicio === -1) throw new Error(`No se encontró ${nombre} en ${fichero}`)
  const resto = sql.slice(inicio)
  const m = /\bas\s*(\$[A-Za-z_]*\$)/i.exec(resto)
  if (!m) throw new Error(`No se encontró la apertura del cuerpo de ${nombre} en ${fichero}`)
  const cuerpo = m.index + m[0].length
  const fin = resto.indexOf(m[1], cuerpo)
  if (fin === -1) throw new Error(`No se encontró el fin del cuerpo de ${nombre} en ${fichero}`)
  return resto.slice(0, fin + m[1].length) + ';'
}

// Redirige TODO al esquema desechable. El orden de las sentencias —lo que se
// está probando— no se toca en ninguna sustitución.
const aEsquemaPrueba = (sql) => sql
  .replace(/\bpublic\./g, 't13.')
  .replace(/\bprivate\./g, 't13.')
  .replace(/\bauth\./g, 't13.')
  .replace(/set\s+search_path\s*(?:=|to)\s*'[^']*'(\s*,\s*'[^']*')*/gi, "set search_path to 't13'")

// --- Esquema base: producción ANTES de la migración -------------------------
const U = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`
const LOC_A = U(1), LOC_B = U(2), LOC_C = U(3)
const USER_A = U(4), USER_B = U(5), USER_C = U(6)
const STAFF_A = U(7), STAFF_B = U(8), STAFF_C = U(9)
const PROD_NS = U('a'), PROD_S = U('b'), PROD_S2 = U('e')
const VAR_NS = U('c'), VAR_S = U('d'), VAR_S2 = U('f')

const ESQUEMA_BASE = `
drop schema if exists t13 cascade;
create schema t13;

create table t13.locations(id uuid primary key, nombre text, activo boolean not null default true);
create table t13.staff(id uuid primary key, user_id uuid, activo boolean not null default true,
  rol text, puesto text, location_id uuid, active_location_id uuid);
create table t13.staff_locations(staff_id uuid, location_id uuid,
  puede_vender boolean, puede_inventario boolean, puede_taller boolean,
  primary key(staff_id, location_id));
create table t13.products(id uuid primary key, nombre text,
  control_serial boolean not null default false, is_test boolean not null default false);
create table t13.product_variants(id uuid primary key, product_id uuid not null references t13.products(id));
create table t13.inventory(variant_id uuid not null, location_id uuid not null,
  cantidad int not null default 0, updated_at timestamptz default now(),
  primary key(variant_id, location_id));
create table t13.inventory_movements(id bigserial primary key, variant_id uuid, location_id uuid,
  cantidad_delta int not null, motivo text not null, staff_id uuid, created_at timestamptz default now());
create table t13.product_serials(id uuid primary key default gen_random_uuid(),
  variant_id uuid, location_id uuid, serial_number text, imei2 text,
  estado text not null default 'disponible' check (estado in
    ('disponible','vendido','en_transito','servicio','baja','cuarentena','faltante','investigacion')),
  sale_id uuid, sold_at timestamptz, recepcion_item_id uuid,
  created_at timestamptz default now(), updated_at timestamptz default now());
create table t13.serial_reservations(serial_id uuid, client_transaction_id uuid, expires_at timestamptz);
create table t13.auditoria_eventos(id bigserial primary key, actor_user_id uuid, actor_staff_id uuid,
  accion text, tabla text, registro_id text, datos_anteriores jsonb, datos_nuevos jsonb,
  created_at timestamptz default now());

-- Transferencias TAL COMO ESTÁN EN PRODUCCIÓN HOY (pre-migración).
create table t13.transferencias_stock(
  id uuid primary key default gen_random_uuid(),
  numero bigint generated by default as identity unique,
  origen_id uuid not null references t13.locations(id),
  destino_id uuid not null references t13.locations(id),
  estado text not null default 'borrador'
    check(estado in('borrador','en_transito','recibida','cancelada')),
  creado_por uuid not null references t13.staff(id),
  despachado_por uuid references t13.staff(id),
  recibido_por uuid references t13.staff(id),
  fecha_creacion timestamptz not null default now(),
  fecha_despacho timestamptz, fecha_recepcion timestamptz, observacion text,
  check(origen_id <> destino_id));
create table t13.transferencia_stock_items(
  id uuid primary key default gen_random_uuid(),
  transferencia_id uuid not null references t13.transferencias_stock(id) on delete cascade,
  variant_id uuid not null references t13.product_variants(id),
  cantidad integer not null check(cantidad > 0),
  unique(transferencia_id, variant_id));
create table t13.transferencia_stock_serials(
  transferencia_id uuid not null references t13.transferencias_stock(id) on delete cascade,
  serial_id uuid not null references t13.product_serials(id),
  primary key(transferencia_id, serial_id),
  unique(serial_id));                    -- la unicidad DE POR VIDA que la migración sustituye

alter table t13.transferencias_stock enable row level security;
alter table t13.transferencia_stock_items enable row level security;
alter table t13.transferencia_stock_serials enable row level security;

-- auth.uid() real: lee request.jwt.claims, como en Supabase.
create function t13.uid() returns uuid language sql stable as $fn$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid
$fn$;

create function t13.auth_is_admin() returns boolean language sql stable security definer
set search_path to 't13' as $fn$
  select exists(select 1 from t13.staff where user_id = t13.uid() and rol = 'administrador' and activo = true)
$fn$;

create function t13.auth_location_id() returns uuid language sql stable security definer
set search_path to 't13' as $fn$
  select case when s.active_location_id is not null and exists(
           select 1 from t13.staff_locations sl where sl.staff_id = s.id and sl.location_id = s.active_location_id)
         then s.active_location_id else s.location_id end
  from t13.staff s where s.user_id = t13.uid() and s.activo = true limit 1
$fn$;

-- private.tiene_capacidad de _p2_h_capacidades.sql, con el mismo cuerpo: es el
-- control de permiso que usa la versión VIGENTE de recibir_transferencia_parcial
-- (_p2_i). Sin él se estaría probando la versión de _p1_a, que ya no es la que
-- corre en producción.
create function t13.tiene_capacidad(p_capacidad text) returns boolean language plpgsql stable
security definer set search_path to 't13' as $fn$
declare v_actor t13.staff; v_flag boolean;
begin
  if p_capacidad is null or p_capacidad not in ('supervisar','operar_inventario','operar_taller','vender') then
    raise exception 'Capacidad desconocida: %', p_capacidad;
  end if;
  select * into v_actor from t13.staff where user_id = t13.uid() and activo = true limit 1;
  if v_actor.id is null then return false; end if;
  if v_actor.rol = 'administrador' then return true; end if;
  if p_capacidad = 'supervisar' then return coalesce(v_actor.puesto,'') in ('encargado','jefa'); end if;
  if p_capacidad in ('operar_inventario','operar_taller')
     and coalesce(v_actor.puesto,'') not in ('tecnico','encargado','jefa') then return false; end if;
  select case p_capacidad when 'operar_inventario' then sl.puede_inventario
                          when 'operar_taller' then sl.puede_taller else sl.puede_vender end
    into v_flag from t13.staff_locations sl
   where sl.staff_id = v_actor.id and sl.location_id = t13.auth_location_id();
  return coalesce(v_flag, true);
end $fn$;

create function t13.registrar_auditoria() returns trigger language plpgsql security definer
set search_path to 't13' as $fn$
declare v_user_id uuid := t13.uid(); v_staff_id uuid; v_old jsonb; v_new jsonb; v_reg text;
begin
  if v_user_id is not null then select id into v_staff_id from t13.staff where user_id = v_user_id limit 1; end if;
  if tg_op = 'DELETE' then v_old := to_jsonb(old); v_new := null;
  elsif tg_op = 'INSERT' then v_old := null; v_new := to_jsonb(new);
  else v_old := to_jsonb(old); v_new := to_jsonb(new); if v_old = v_new then return new; end if; end if;
  v_reg := coalesce(v_new->>'id', v_old->>'id');
  insert into t13.auditoria_eventos(actor_user_id, actor_staff_id, accion, tabla, registro_id, datos_anteriores, datos_nuevos)
  values (v_user_id, v_staff_id, tg_op, tg_table_name, v_reg, v_old, v_new);
  return coalesce(new, old);
end $fn$;

create policy transferencias_read on t13.transferencias_stock for select to authenticated
  using(t13.auth_is_admin() or origen_id = t13.auth_location_id() or destino_id = t13.auth_location_id());
create policy transferencia_items_read on t13.transferencia_stock_items for select to authenticated
  using(exists(select 1 from t13.transferencias_stock t where t.id = transferencia_id
    and (t13.auth_is_admin() or t.origen_id = t13.auth_location_id() or t.destino_id = t13.auth_location_id())));
create policy transfer_serials_read on t13.transferencia_stock_serials for select to authenticated
  using(exists(select 1 from t13.transferencias_stock t where t.id = transferencia_id
    and (t13.auth_is_admin() or t.origen_id = t13.auth_location_id() or t.destino_id = t13.auth_location_id())));
`

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))
const fallos = []
const pasos = []
function check(ok, etiqueta, detalle) {
  pasos.push({ ok, etiqueta })
  if (!ok) fallos.push(`${etiqueta}${detalle ? ` — ${detalle}` : ''}`)
  return ok
}

// --- Ejecución como `authenticated` con claims realistas --------------------
async function comoUsuario(cli, userId, sql, params = []) {
  await cli.query('begin')
  await cli.query(`select set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: userId, role: 'authenticated' })])
  await cli.query('set local role authenticated')
  try {
    const r = await cli.query(sql, params)
    await cli.query('commit')
    return r
  } catch (e) {
    await cli.query('rollback').catch(() => {})
    throw e
  }
}
async function falla(cli, userId, sql, params = []) {
  try { await comoUsuario(cli, userId, sql, params); return null }
  catch (e) { return e }
}

const admin = new pg.Client({ connectionString: URL_PG })
await admin.connect()
// Algunas definiciones reales vienen en el formato de pg_get_functiondef, con
// el tipo de retorno SIN cualificar (`returns transferencias_stock`). Ese tipo
// se resuelve contra el search_path en el momento del CREATE, así que la sesión
// tiene que ver el esquema de prueba.
await admin.query('set search_path to t13, public')

// Rol authenticated real. Se crea ANTES del esquema porque las policies lo
// nombran. Las pruebas operativas corren con este rol, no con el superusuario.
await admin.query(`do $do$ begin
  if not exists(select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists(select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
end $do$;`)

await admin.query(ESQUEMA_BASE)
await admin.query('grant usage on schema t13 to authenticated')
await admin.query('grant select, insert, update, delete on all tables in schema t13 to authenticated')
await admin.query('grant usage, select on all sequences in schema t13 to authenticated')

// Prerrequisito real: la sincronización de stock serializado de P0.2/P0.4, que
// bloquea inventory ANTES de contar. Se carga del fichero, no se reescribe.
await admin.query(aEsquemaPrueba(
  funcionDeMigracion('20260909043129_p04_b_ledger_delta_real.sql', 'sincronizar_stock_serializado')))
// Creación de transferencias: la versión vigente, con manifiesto de seriales.
await admin.query(aEsquemaPrueba(
  funcionDeMigracion('20260824134229_serialized_inventory_units.sql', 'crear_transferencia_stock')))
await admin.query('grant execute on all functions in schema t13 to authenticated')

// El despacho ANTERIOR (el de producción) se guarda para demostrar que la
// prueba de regresión D1 detecta de verdad el bug.
const DESPACHO_VIEJO = aEsquemaPrueba(
  funcionDeMigracion('20260906203818_fix_null_puesto_bypass.sql', 'despachar_transferencia_stock'))
check(/en_transito/.test(DESPACHO_VIEJO), 'el despacho anterior extraído mueve seriales (si no, D1 no se estaría probando)')

// --- LA MIGRACIÓN BAJO PRUEBA, cargada del fichero, DDL incluido ------------
const SQL_MIGRACION = aEsquemaPrueba(fs.readFileSync(MIGRACION, 'utf8'))
await admin.query(SQL_MIGRACION)
const DESPACHO_NUEVO = aEsquemaPrueba(funcionDeMigracion('_p1_a_transferencias_parciales.sql', 'despachar_transferencia_stock'))

// --- P3.B (T3 · T4 · T7) --------------------------------------------------
// MUTACIÓN: con TRANSF_SIN_P3B=1 la migración NO se aplica. Sirve para
// demostrar cuántas comprobaciones dependen de verdad de ella. El resultado se
// marca y nunca cuenta como PASS.
const SIN_P3B = process.env.TRANSF_SIN_P3B === '1'
const MIGRACION_P3B = MIGRACIONES + resolverMigracion('_p3_b_transferencias_t3_t4.sql')
if (!fs.existsSync(MIGRACION_P3B)) abortar(`No existe la migración bajo prueba: ${MIGRACION_P3B}`)
if (!SIN_P3B) await admin.query(aEsquemaPrueba(fs.readFileSync(MIGRACION_P3B, 'utf8')))
// Las funciones nuevas de la migración nacen sin EXECUTE para `authenticated`
// en este esquema de prueba salvo por sus propios grants; se comprueba abajo.

// --- Siembra ----------------------------------------------------------------
async function sembrar({ nsA = 0, serialesA = 0, serialesA2 = 0 } = {}) {
  await admin.query(`truncate t13.transferencia_recepcion_serials, t13.transferencia_recepcion_items,
    t13.transferencia_recepciones, t13.transferencia_stock_serials, t13.transferencia_stock_items,
    t13.transferencias_stock, t13.inventory, t13.inventory_movements, t13.product_serials,
    t13.product_variants, t13.products, t13.staff_locations, t13.staff, t13.locations,
    t13.auditoria_eventos cascade`)
  await admin.query(`insert into t13.locations(id,nombre) values ($1,'Origen'),($2,'Destino'),($3,'Tercera')`,
    [LOC_A, LOC_B, LOC_C])
  // A es administrador (crear_transferencia_stock lo exige) y vive en el ORIGEN.
  // Que sea admin es deliberado: demuestra que el permiso por sucursal NO se
  // salta por ser administrador.
  // C es de una sucursal ajena y NO es administrador: un administrador ve
  // todas las sucursales por diseño (private.auth_is_admin() en las policies),
  // así que para probar el aislamiento hace falta un operador normal. Su puesto
  // sí le da el rol operativo, para que la prueba llegue hasta la comprobación
  // de sucursal y no se quede en la de rol.
  await admin.query(`insert into t13.staff(id,user_id,rol,puesto,location_id) values
    ($1,$2,'administrador','jefa',$3), ($4,$5,'vendedor','encargado',$6), ($7,$8,'vendedor','encargado',$9)`,
    [STAFF_A, USER_A, LOC_A, STAFF_B, USER_B, LOC_B, STAFF_C, USER_C, LOC_C])
  await admin.query(`insert into t13.products(id,nombre,control_serial) values
    ($1,'Cargador',false),($2,'iPhone 13',true),($3,'Galaxy S22',true)`, [PROD_NS, PROD_S, PROD_S2])
  await admin.query(`insert into t13.product_variants(id,product_id) values ($1,$2),($3,$4),($5,$6)`,
    [VAR_NS, PROD_NS, VAR_S, PROD_S, VAR_S2, PROD_S2])
  if (nsA > 0) await admin.query(`insert into t13.inventory(variant_id,location_id,cantidad) values ($1,$2,$3)`, [VAR_NS, LOC_A, nsA])
  if (serialesA > 0) {
    await admin.query(`insert into t13.product_serials(variant_id,location_id,serial_number,estado)
      select $1,$2,'IMEI-'||lpad(g::text,3,'0'),'disponible' from generate_series(1,$3) g`, [VAR_S, LOC_A, serialesA])
    await admin.query(`insert into t13.inventory(variant_id,location_id,cantidad) values ($1,$2,$3)`, [VAR_S, LOC_A, serialesA])
  }
  // Segunda variante CON IMEI: sólo la usan los casos que necesitan dos líneas
  // serializadas en la misma transferencia ("IMEI de otra variante").
  if (serialesA2 > 0) {
    await admin.query(`insert into t13.product_serials(variant_id,location_id,serial_number,estado)
      select $1,$2,'SN2-'||lpad(g::text,3,'0'),'disponible' from generate_series(1,$3) g`, [VAR_S2, LOC_A, serialesA2])
    await admin.query(`insert into t13.inventory(variant_id,location_id,cantidad) values ($1,$2,$3)`, [VAR_S2, LOC_A, serialesA2])
  }
}

const inv = async (v, l) => (await admin.query(
  'select coalesce((select cantidad from t13.inventory where variant_id=$1 and location_id=$2),0) as c', [v, l])).rows[0].c
const linea = async (tid) => (await admin.query(
  `select it.*, ts.estado as estado_cab, ts.tiene_diferencias from t13.transferencia_stock_items it
   join t13.transferencias_stock ts on ts.id=it.transferencia_id where it.transferencia_id=$1 order by it.id`, [tid])).rows
const cab = async (tid) => (await admin.query('select * from t13.transferencias_stock where id=$1', [tid])).rows[0]
const seriales = async () => (await admin.query(
  `select serial_number, estado, location_id from t13.product_serials order by serial_number`)).rows

// El invariante duro: para toda variante con IMEI, inventory = nº de seriales
// 'disponible' en esa ubicación. Se comprueba al final de cada escenario.
async function desincronizados() {
  const { rows } = await admin.query(`
    select i.variant_id, i.location_id, i.cantidad,
      (select count(*)::int from t13.product_serials ps
        where ps.variant_id=i.variant_id and ps.location_id=i.location_id and ps.estado='disponible') as disponibles
    from t13.inventory i
    join t13.product_variants pv on pv.id=i.variant_id
    join t13.products p on p.id=pv.product_id
    where p.control_serial`)
  return rows.filter((r) => r.cantidad !== r.disponibles)
}

// _p3_b cambia la firma: crear_transferencia_stock exige clave de idempotencia.
// El arnés la manda siempre; en modo mutación (sin la migración) se usa la firma
// vieja de 3 argumentos para que el resto de la suite siga ejerciéndose.
const SQL_CREAR = SIN_P3B
  ? 'select (t13.crear_transferencia_stock($1::uuid,$2::jsonb,null)).id as id'
  : 'select (t13.crear_transferencia_stock($1::uuid,$2::jsonb,null,$3::uuid)).id as id'
const argsCrear = (destino, items, clave) => SIN_P3B
  ? [destino, JSON.stringify(items)]
  : [destino, JSON.stringify(items), clave]
async function crear(cli, user, items, destino = LOC_B, clave = null) {
  const { rows } = await comoUsuario(cli, user, SQL_CREAR, argsCrear(destino, items, clave || crypto.randomUUID()))
  return rows[0].id
}
const recibirParcial = (cli, user, tid, key, items, cerrar = false) => comoUsuario(cli, user,
  'select t13.recibir_transferencia_parcial($1::uuid,$2::uuid,$3::jsonb,null,$4::boolean) as d',
  [tid, key, items === null ? null : JSON.stringify(items), cerrar])

const cli = new pg.Client({ connectionString: URL_PG }); await cli.connect()
const K = (n) => `${String(n).repeat(8)}-1111-4111-8111-${String(n).repeat(12)}`

// ===========================================================================
// T0 · FALLO CERRADO SIN SUCURSAL (hallazgo T1 del coordinador)
// ===========================================================================
// Con `t.origen_id <> v_loc`, un v_loc NULL daba NULL, el IF no saltaba y un
// operativo sin sucursal despachaba desde cualquier origen y recibía en cualquier
// destino. Se prueba con un puesto que SÍ pasa el control de rol, para que el
// rechazo sólo pueda venir de la comprobación de sucursal.
{
  await sembrar({ nsA: 5 })
  const tid = await crear(cli, USER_A, [{ variant_id: VAR_NS, cantidad: 5, serial_ids: [] }])
  const STAFF_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddd01'
  const USER_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddd02'
  // En producción staff.location_id admite NULL; se refleja aquí por si el
  // esquema de prueba lo hubiera declarado NOT NULL.
  await admin.query('alter table t13.staff alter column location_id drop not null')
  await admin.query(`insert into t13.staff(id,user_id,rol,puesto,location_id) values ($1,$2,'vendedor','encargado',null)`,
    [STAFF_D, USER_D])

  const eDesp = await falla(cli, USER_D, 'select t13.despachar_transferencia_stock($1::uuid)', [tid])
  check(eDesp !== null && /origen puede despachar/i.test(eDesp.message),
    'T0 un operativo SIN sucursal no despacha (fallo cerrado)', eDesp ? eDesp.message : 'despachó')
  check(await inv(VAR_NS, LOC_A) === 5, 'T0 el intento sin sucursal no descontó el origen')

  await comoUsuario(cli, USER_A, 'select t13.despachar_transferencia_stock($1::uuid)', [tid])
  const [itD] = await linea(tid)
  const eRec = await falla(cli, USER_D,
    'select t13.recibir_transferencia_parcial($1::uuid,$2::uuid,$3::jsonb,null,false) as d',
    [tid, K(9), JSON.stringify([{ item_id: itD.id, cantidad_ok: 5 }])])
  check(eRec !== null && /destino puede recibir/i.test(eRec.message),
    'T0 un operativo SIN sucursal no recibe (fallo cerrado)', eRec ? eRec.message : 'recibió')
  check(await inv(VAR_NS, LOC_B) === 0, 'T0 el intento sin sucursal no sumó stock al destino')
}

// ===========================================================================
// T0b · MISMA CLAVE, CONTENIDO DISTINTO (hallazgo T2 del coordinador)
// ===========================================================================
// Antes, la misma clave con otro contenido chocaba en el UNIQUE y la función
// devolvía el detalle como si la recepción hubiera entrado: la nueva no se
// aplicaba y el cliente no se enteraba.
{
  await sembrar({ nsA: 10 })
  const tid = await crear(cli, USER_A, [{ variant_id: VAR_NS, cantidad: 10, serial_ids: [] }])
  await comoUsuario(cli, USER_A, 'select t13.despachar_transferencia_stock($1::uuid)', [tid])
  const [it2] = await linea(tid)

  await recibirParcial(cli, USER_B, tid, K(7), [{ item_id: it2.id, cantidad_ok: 3 }])
  // Misma clave y mismo contenido: reintento legítimo, no aplica nada más.
  await recibirParcial(cli, USER_B, tid, K(7), [{ item_id: it2.id, cantidad_ok: 3 }])
  check((await linea(tid))[0].cantidad_recibida === 3 && await inv(VAR_NS, LOC_B) === 3,
    'T0b reintento con la misma clave y el mismo contenido no aplica dos veces')

  // Misma clave, OTRA cantidad.
  const eDist = await falla(cli, USER_B,
    'select t13.recibir_transferencia_parcial($1::uuid,$2::uuid,$3::jsonb,null,false) as d',
    [tid, K(7), JSON.stringify([{ item_id: it2.id, cantidad_ok: 5 }])])
  check(eDist !== null && /contenido distinto/i.test(eDist.message),
    'T0b la misma clave con otro contenido se RECHAZA, no se da por aplicada', eDist ? eDist.message : 'se aceptó en silencio')
  check((await linea(tid))[0].cantidad_recibida === 3 && await inv(VAR_NS, LOC_B) === 3,
    'T0b el rechazo no aplicó la recepción distinta')

  // "Recibir todo" (p_items NULL) y su reintento. Es el caso que obliga a hashear
  // la PETICIÓN y no lo pendiente derivado: tras aplicarse ya no queda nada
  // pendiente, y un hash de lo derivado haría fallar el reintento legítimo.
  await recibirParcial(cli, USER_B, tid, K(8), null)
  const eTodo = await falla(cli, USER_B,
    'select t13.recibir_transferencia_parcial($1::uuid,$2::uuid,$3::jsonb,null,false) as d', [tid, K(8), null])
  check(eTodo === null, 'T0b el reintento de "recibir todo" con la misma clave no se rechaza', eTodo ? eTodo.message : '')
  check(await inv(VAR_NS, LOC_B) === 10, 'T0b "recibir todo" completó el stock sin duplicarlo en el reintento')
}

// ===========================================================================
// T1 · RECEPCIÓN PARCIAL EN DOS TANDAS (sin IMEI)
// ===========================================================================
{
  await sembrar({ nsA: 10 })
  const tid = await crear(cli, USER_A, [{ variant_id: VAR_NS, cantidad: 10, serial_ids: [] }])
  await comoUsuario(cli, USER_A, 'select t13.despachar_transferencia_stock($1::uuid)', [tid])
  check(await inv(VAR_NS, LOC_A) === 0, 'T1 despacho descuenta el origen')

  const [it] = await linea(tid)
  await recibirParcial(cli, USER_B, tid, K(1), [{ item_id: it.id, cantidad_ok: 4 }])
  let l = (await linea(tid))[0]
  check(l.cantidad_recibida === 4 && l.estado_linea === 'parcial', 'T1 primera tanda deja la línea en parcial',
    `recibida=${l.cantidad_recibida} estado=${l.estado_linea}`)
  check((await cab(tid)).estado === 'recibida_parcial', 'T1 la cabecera queda recibida_parcial',
    `estado=${(await cab(tid)).estado}`)
  check(await inv(VAR_NS, LOC_B) === 4, 'T1 el destino recibe sólo lo que llegó', `inv=${await inv(VAR_NS, LOC_B)}`)

  await recibirParcial(cli, USER_B, tid, K(2), [{ item_id: it.id, cantidad_ok: 6 }])
  l = (await linea(tid))[0]
  const c = await cab(tid)
  check(l.cantidad_recibida === 10 && l.estado_linea === 'completa' && l.cantidad_faltante === 0,
    'T1 la segunda tanda completa la línea', `recibida=${l.cantidad_recibida} estado=${l.estado_linea}`)
  check(c.estado === 'recibida' && c.tiene_diferencias === false, 'T1 cierre limpio sin diferencias',
    `estado=${c.estado} dif=${c.tiene_diferencias}`)
  check(await inv(VAR_NS, LOC_B) === 10, 'T1 el destino acaba con las 10 unidades')
  const { rows: movs } = await admin.query(
    'select cantidad_delta from t13.inventory_movements where location_id=$1 order by id', [LOC_B])
  check(JSON.stringify(movs.map((m) => m.cantidad_delta)) === '[4,6]',
    'T1 el ledger registra los deltas REALES de cada tanda, no la cantidad enviada',
    JSON.stringify(movs.map((m) => m.cantidad_delta)))
}

// ===========================================================================
// T2 · FALTANTE Y CIERRE EXPLÍCITO
// ===========================================================================
{
  await sembrar({ nsA: 10 })
  const tid = await crear(cli, USER_A, [{ variant_id: VAR_NS, cantidad: 10, serial_ids: [] }])
  await comoUsuario(cli, USER_A, 'select t13.despachar_transferencia_stock($1::uuid)', [tid])
  const [it] = await linea(tid)
  await recibirParcial(cli, USER_B, tid, K(3), [{ item_id: it.id, cantidad_ok: 7 }])
  await comoUsuario(cli, USER_B, 'select t13.cerrar_transferencia_stock($1::uuid,$2::uuid,$3)',
    [tid, K(4), 'faltan 3 unidades'])
  const l = (await linea(tid))[0]
  const c = await cab(tid)
  check(l.cantidad_faltante === 3 && l.cantidad_recibida === 7, 'T2 el cierre fija el faltante real',
    `faltante=${l.cantidad_faltante} recibida=${l.cantidad_recibida}`)
  check(l.estado_linea === 'con_diferencia' && c.estado === 'recibida' && c.tiene_diferencias === true,
    'T2 la cabecera cierra marcada con diferencias', `linea=${l.estado_linea} cab=${c.estado} dif=${c.tiene_diferencias}`)
  check(await inv(VAR_NS, LOC_B) === 7 && await inv(VAR_NS, LOC_A) === 0,
    'T2 el faltante NO se inventa stock en ninguna sucursal',
    `A=${await inv(VAR_NS, LOC_A)} B=${await inv(VAR_NS, LOC_B)}`)
}

// ===========================================================================
// T3 · SOBRANTE
// ===========================================================================
{
  await sembrar({ nsA: 5 })
  const tid = await crear(cli, USER_A, [{ variant_id: VAR_NS, cantidad: 5, serial_ids: [] }])
  await comoUsuario(cli, USER_A, 'select t13.despachar_transferencia_stock($1::uuid)', [tid])
  const [it] = await linea(tid)
  await recibirParcial(cli, USER_B, tid, K(5), [{ item_id: it.id, cantidad_ok: 7 }])
  const l = (await linea(tid))[0]
  const c = await cab(tid)
  check(l.cantidad_sobrante === 2 && l.cantidad_recibida === 7, 'T3 el sobrante se deriva y se registra',
    `sobrante=${l.cantidad_sobrante} recibida=${l.cantidad_recibida}`)
  check(l.estado_linea === 'con_diferencia' && c.tiene_diferencias === true,
    'T3 el sobrante marca la transferencia con diferencias', `linea=${l.estado_linea}`)
  check(await inv(VAR_NS, LOC_B) === 7, 'T3 el destino refleja lo realmente recibido')
  // El derivado está atornillado en la base, no sólo en el código: ni siquiera
  // el dueño de la tabla puede escribir un sobrante que no cuadre.
  let eChk = null
  try { await admin.query('update t13.transferencia_stock_items set cantidad_sobrante = 99 where id=$1', [it.id]) }
  catch (err) { eChk = err }
  check(eChk !== null && /tsi_sobrante_derivado/.test(eChk.message + (eChk.constraint || '')),
    'T3 la base rechaza un sobrante que no sea el exceso real sobre lo enviado',
    eChk ? `${eChk.constraint || ''} ${eChk.message.slice(0, 70)}` : 'la escritura pasó')
}

// ===========================================================================
// T4 · DAÑADO (sin IMEI): no entra al inventario disponible
// ===========================================================================
{
  await sembrar({ nsA: 5 })
  const tid = await crear(cli, USER_A, [{ variant_id: VAR_NS, cantidad: 5, serial_ids: [] }])
  await comoUsuario(cli, USER_A, 'select t13.despachar_transferencia_stock($1::uuid)', [tid])
  const [it] = await linea(tid)
  await recibirParcial(cli, USER_B, tid, K(6), [{ item_id: it.id, cantidad_ok: 3, cantidad_danada: 2 }])
  const l = (await linea(tid))[0]
  check(l.cantidad_danada === 2 && l.cantidad_recibida === 3, 'T4 el dañado se contabiliza aparte',
    `dan=${l.cantidad_danada} ok=${l.cantidad_recibida}`)
  check(await inv(VAR_NS, LOC_B) === 3, 'T4 las unidades dañadas NO entran al stock vendible',
    `inv=${await inv(VAR_NS, LOC_B)}`)
  check((await cab(tid)).estado === 'recibida' && l.estado_linea === 'con_diferencia',
    'T4 la transferencia cierra: no queda nada pendiente', `cab=${(await cab(tid)).estado}`)
}

// ===========================================================================
// T5 · IDEMPOTENCIA: la misma client_transaction_id dos veces
// ===========================================================================
{
  await sembrar({ nsA: 10 })
  const tid = await crear(cli, USER_A, [{ variant_id: VAR_NS, cantidad: 10, serial_ids: [] }])
  await comoUsuario(cli, USER_A, 'select t13.despachar_transferencia_stock($1::uuid)', [tid])
  const [it] = await linea(tid)
  await recibirParcial(cli, USER_B, tid, K(7), [{ item_id: it.id, cantidad_ok: 4 }])
  await recibirParcial(cli, USER_B, tid, K(7), [{ item_id: it.id, cantidad_ok: 4 }])
  const l = (await linea(tid))[0]
  const { rows: [{ n }] } = await admin.query(
    'select count(*)::int as n from t13.transferencia_recepciones where transferencia_id=$1', [tid])
  check(l.cantidad_recibida === 4 && await inv(VAR_NS, LOC_B) === 4 && n === 1,
    'T5 el reenvío con la misma clave no duplica stock ni movimientos',
    `recibida=${l.cantidad_recibida} inv=${await inv(VAR_NS, LOC_B)} recepciones=${n}`)
  const { rows: [{ m }] } = await admin.query(
    'select count(*)::int as m from t13.inventory_movements where location_id=$1', [LOC_B])
  check(m === 1, 'T5 tampoco duplica el movimiento de inventario', `movimientos=${m}`)

  // Y la clave es obligatoria: sin ella no hay recepción.
  const e = await falla(cli, USER_B,
    'select t13.recibir_transferencia_parcial($1::uuid,null,null,null,false)', [tid])
  check(e !== null && /client_transaction_id/i.test(e.message),
    'T5 la recepción exige client_transaction_id', e ? e.message.slice(0, 80) : 'no falló')
}

// ===========================================================================
// T6 · CONCURRENCIA REAL: dos conexiones simultáneas
// ===========================================================================
async function carrera(tid, itemId, keyA, keyB, cant) {
  const c1 = new pg.Client({ connectionString: URL_PG })
  const c2 = new pg.Client({ connectionString: URL_PG })
  await c1.connect(); await c2.connect()
  const testigo = new pg.Client({ connectionString: URL_PG }); await testigo.connect()
  try {
    const { rows: [{ pid }] } = await c2.query('select pg_backend_pid() as pid')
    const abrir = async (c) => {
      await c.query('begin')
      await c.query(`select set_config('request.jwt.claims',$1,true)`,
        [JSON.stringify({ sub: USER_B, role: 'authenticated' })])
      await c.query('set local role authenticated')
    }
    await abrir(c1); await abrir(c2)

    // c1 entra primero y RETIENE el lock de la cabecera sin hacer commit.
    await c1.query('select t13.recibir_transferencia_parcial($1::uuid,$2::uuid,$3::jsonb,null,false)',
      [tid, keyA, JSON.stringify([{ item_id: itemId, cantidad_ok: cant }])])

    // c2 arranca en paralelo y se bloqueará DE VERDAD en ese lock.
    const enCurso = c2.query('select t13.recibir_transferencia_parcial($1::uuid,$2::uuid,$3::jsonb,null,false)',
      [tid, keyB, JSON.stringify([{ item_id: itemId, cantidad_ok: cant }])])

    let bloqueoObservado = false
    for (let i = 0; i < 60 && !bloqueoObservado; i++) {
      await dormir(50)
      const { rows } = await testigo.query(
        "select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'", [pid])
      bloqueoObservado = rows.length > 0
    }
    await c1.query('commit')
    let error = null
    try { await enCurso; await c2.query('commit') }
    catch (e) { error = e; await c2.query('rollback').catch(() => {}) }
    return { bloqueoObservado, error }
  } finally {
    await c1.end().catch(() => {}); await c2.end().catch(() => {}); await testigo.end().catch(() => {})
  }
}

{
  // 6a · MISMA clave en las dos conexiones: un doble clic que sale por dos
  // conexiones distintas. Sólo puede aplicarse una vez.
  await sembrar({ nsA: 10 })
  let tid = await crear(cli, USER_A, [{ variant_id: VAR_NS, cantidad: 10, serial_ids: [] }])
  await comoUsuario(cli, USER_A, 'select t13.despachar_transferencia_stock($1::uuid)', [tid])
  let [it] = await linea(tid)
  let r = await carrera(tid, it.id, K(8), K(8), 4)
  check(r.bloqueoObservado, 'T6a se observó bloqueo real de lock (sin bloqueo no hubo carrera que probar)')
  let l = (await linea(tid))[0]
  check(l.cantidad_recibida === 4 && await inv(VAR_NS, LOC_B) === 4,
    'T6a dos recepciones simultáneas con la misma clave ingresan UNA sola vez',
    `recibida=${l.cantidad_recibida} inv=${await inv(VAR_NS, LOC_B)}`)

  // 6b · Claves DISTINTAS: son dos recepciones legítimas y deben sumarse
  // exactamente, sin lost update.
  await sembrar({ nsA: 10 })
  tid = await crear(cli, USER_A, [{ variant_id: VAR_NS, cantidad: 10, serial_ids: [] }])
  await comoUsuario(cli, USER_A, 'select t13.despachar_transferencia_stock($1::uuid)', [tid])
  ;[it] = await linea(tid)
  r = await carrera(tid, it.id, K(9), K(2), 3)
  check(r.bloqueoObservado, 'T6b se observó bloqueo real de lock')
  l = (await linea(tid))[0]
  check(l.cantidad_recibida === 6 && await inv(VAR_NS, LOC_B) === 6,
    'T6b dos recepciones distintas simultáneas se acumulan sin lost update',
    `recibida=${l.cantidad_recibida} inv=${await inv(VAR_NS, LOC_B)}`)
}

// ===========================================================================
// T7 · SERIALIZADO: parcial, dañado y faltante por IMEI
// ===========================================================================
{
  await sembrar({ serialesA: 5 })
  const { rows: sids } = await admin.query(
    'select id, serial_number from t13.product_serials order by serial_number')
  const tid = await crear(cli, USER_A,
    [{ variant_id: VAR_S, cantidad: 5, serial_ids: sids.map((s) => s.id) }])
  await comoUsuario(cli, USER_A, 'select t13.despachar_transferencia_stock($1::uuid)', [tid])
  check(await inv(VAR_S, LOC_A) === 0, 'T7 el despacho serializado deja el origen en 0',
    `invA=${await inv(VAR_S, LOC_A)}`)
  const { rows: [{ n: enVuelo }] } = await admin.query(
    "select count(*)::int as n from t13.product_serials where estado='en_transito'")
  check(enVuelo === 5, 'T7 las 5 unidades EXACTAS quedan en tránsito', `en_transito=${enVuelo}`)

  const [it] = await linea(tid)
  // Llegan 2 correctas.
  await recibirParcial(cli, USER_B, tid, K(3), [{ item_id: it.id,
    serials: [{ serial_id: sids[0].id, resultado: 'ok' }, { serial_id: sids[1].id, resultado: 'ok' }] }])
  check(await inv(VAR_S, LOC_B) === 2, 'T7 el destino sube a 2, derivado de product_serials',
    `invB=${await inv(VAR_S, LOC_B)}`)

  // Llega 1 correcta y 1 dañada -> cuarentena, que NO es stock vendible.
  await recibirParcial(cli, USER_B, tid, K(4), [{ item_id: it.id,
    serials: [{ serial_id: sids[2].id, resultado: 'ok' }, { serial_id: sids[3].id, resultado: 'danado' }] }])
  check(await inv(VAR_S, LOC_B) === 3, 'T7 la unidad dañada NO infla el inventario del destino',
    `invB=${await inv(VAR_S, LOC_B)}`)
  const est = Object.fromEntries((await seriales()).map((s) => [s.serial_number, s.estado]))
  check(est['IMEI-004'] === 'cuarentena', 'T7 el IMEI dañado va a cuarentena (matriz P0.3), no a un estado inventado',
    `estado=${est['IMEI-004']}`)

  // Se cierra: la quinta nunca llegó.
  await comoUsuario(cli, USER_B, 'select t13.cerrar_transferencia_stock($1::uuid,$2::uuid,null)', [tid, K(5)])
  const l = (await linea(tid))[0]
  const est2 = Object.fromEntries((await seriales()).map((s) => [s.serial_number, s.estado]))
  check(est2['IMEI-005'] === 'faltante', 'T7 el IMEI que no llegó queda FALTANTE, no resucita como disponible',
    `estado=${est2['IMEI-005']}`)
  check(l.cantidad_recibida === 3 && l.cantidad_danada === 1 && l.cantidad_faltante === 1,
    'T7 la línea cuadra: 3 ok + 1 dañada + 1 faltante = 5 enviadas',
    `ok=${l.cantidad_recibida} dan=${l.cantidad_danada} falt=${l.cantidad_faltante}`)
  check(await inv(VAR_S, LOC_A) === 0 && await inv(VAR_S, LOC_B) === 3,
    'T7 el stock final cuadra en ambas sucursales')
  const d = await desincronizados()
  check(d.length === 0, 'T7 inventory == product_serials disponibles en TODA ubicación', JSON.stringify(d))
}

// ===========================================================================
// T8 · UN IMEI NO PUEDE ESTAR EN DOS UBICACIONES
// ===========================================================================
{
  await sembrar({ serialesA: 4 })
  const { rows: sids } = await admin.query('select id, serial_number from t13.product_serials order by serial_number')

  // 8a · El mismo IMEI no puede entrar en dos transferencias abiertas.
  const t1 = await crear(cli, USER_A, [{ variant_id: VAR_S, cantidad: 2, serial_ids: [sids[0].id, sids[1].id] }])
  const e1 = await falla(cli, USER_A, SQL_CREAR,
    argsCrear(LOC_C, [{ variant_id: VAR_S, cantidad: 1, serial_ids: [sids[0].id] }], crypto.randomUUID()))
  check(e1 !== null, 'T8a un IMEI ya reservado no puede entrar en una segunda transferencia',
    e1 ? e1.message.slice(0, 90) : 'la segunda transferencia se creó')

  // 8b · Recibir en una transferencia un IMEI que pertenece a otra: rechazado.
  const t2 = await crear(cli, USER_A, [{ variant_id: VAR_S, cantidad: 2, serial_ids: [sids[2].id, sids[3].id] }])
  await comoUsuario(cli, USER_A, 'select t13.despachar_transferencia_stock($1::uuid)', [t1])
  await comoUsuario(cli, USER_A, 'select t13.despachar_transferencia_stock($1::uuid)', [t2])
  const [i1] = await linea(t1)
  const e2 = await falla(cli, USER_B,
    'select t13.recibir_transferencia_parcial($1::uuid,$2::uuid,$3::jsonb,null,false)',
    [t1, K(6), JSON.stringify([{ item_id: i1.id, serials: [{ serial_id: sids[2].id, resultado: 'ok' }] }])])
  check(e2 !== null && /no está en vuelo/i.test(e2.message),
    'T8b no se puede recibir en una transferencia un IMEI que viaja en otra',
    e2 ? e2.message.slice(0, 100) : 'se aceptó el IMEI ajeno')

  // 8c · Y el mismo IMEI no puede conciliarse dos veces dentro de la suya.
  await recibirParcial(cli, USER_B, t1, K(7), [{ item_id: i1.id, serials: [{ serial_id: sids[0].id, resultado: 'ok' }] }])
  const e3 = await falla(cli, USER_B,
    'select t13.recibir_transferencia_parcial($1::uuid,$2::uuid,$3::jsonb,null,false)',
    [t1, K(8), JSON.stringify([{ item_id: i1.id, serials: [{ serial_id: sids[0].id, resultado: 'ok' }] }])])
  check(e3 !== null && /no está en vuelo/i.test(e3.message),
    'T8c un IMEI ya conciliado no puede recibirse otra vez', e3 ? e3.message.slice(0, 100) : 'se aceptó dos veces')

  // 8d · Ningún IMEI figura como disponible en más de una ubicación.
  const { rows: dobles } = await admin.query(`
    select serial_number from t13.product_serials where estado='disponible'
    group by serial_number having count(distinct location_id) > 1`)
  check(dobles.length === 0, 'T8d ningún IMEI aparece disponible en dos ubicaciones', JSON.stringify(dobles))
  const d = await desincronizados()
  check(d.length === 0, 'T8 inventory sigue cuadrando con product_serials', JSON.stringify(d))
}

// ===========================================================================
// T9 · REGRESIÓN D1: IMEI vendido entre la creación y el despacho
// El despacho ANTERIOR desincroniza; el nuevo aborta.
// ===========================================================================
// El origen tiene 5 unidades y la transferencia pide 3 IMEI concretos. Entre
// la creación y el despacho se VENDE uno de esos 3: el stock baja a 4, que
// sigue siendo suficiente para 3, así que la comprobación `cantidad>=i.cantidad`
// del despacho anterior no salta. Pero ya sólo quedan 2 de los 3 IMEI del
// manifiesto en estado 'disponible'. Ahí es donde vivía D1: inventory baja 3 y
// sólo viajan 2 unidades. Con el origen justo (3 de 3) el fallo se enmascara
// tras un "stock insuficiente" y la regresión no se estaría probando.
async function escenarioD1() {
  await sembrar({ serialesA: 5 })
  const { rows: sids } = await admin.query('select id from t13.product_serials order by serial_number')
  const manifiesto = [sids[0].id, sids[1].id, sids[2].id]
  const tid = await crear(cli, USER_A, [{ variant_id: VAR_S, cantidad: 3, serial_ids: manifiesto }])
  await admin.query("update t13.product_serials set estado='vendido', sold_at=now() where id=$1", [sids[2].id])
  await admin.query('update t13.inventory set cantidad=4 where variant_id=$1 and location_id=$2', [VAR_S, LOC_A])
  return tid
}
{
  // Versión ANTERIOR (la de producción): tiene que reproducir el bug.
  await admin.query(DESPACHO_VIEJO)
  await admin.query('grant execute on function t13.despachar_transferencia_stock(uuid) to authenticated')
  let tid = await escenarioD1()
  const eViejo = await falla(cli, USER_A, 'select t13.despachar_transferencia_stock($1::uuid)', [tid])
  const dViejo = await desincronizados()
  check(eViejo === null && dViejo.length > 0,
    'T9 el despacho ANTERIOR reproduce D1: acepta el despacho y desincroniza inventory de product_serials',
    `error=${eViejo ? eViejo.message.slice(0, 60) : 'ninguno'} desincronizados=${JSON.stringify(dViejo)}`)

  // Versión NUEVA: tiene que abortar y no dejar rastro.
  await admin.query(DESPACHO_NUEVO)
  await admin.query('grant execute on function t13.despachar_transferencia_stock(uuid) to authenticated')
  tid = await escenarioD1()
  const eNuevo = await falla(cli, USER_A, 'select t13.despachar_transferencia_stock($1::uuid)', [tid])
  check(eNuevo !== null && /no desincronizar|siguen disponibles/i.test(eNuevo.message),
    'T9 el despacho NUEVO aborta con un error que explica por qué',
    eNuevo ? eNuevo.message.slice(0, 120) : 'despachó igualmente')
  check((await cab(tid)).estado === 'borrador', 'T9 tras el aborto la transferencia sigue en borrador',
    `estado=${(await cab(tid)).estado}`)
  const dNuevo = await desincronizados()
  check(dNuevo.length === 0, 'T9 el despacho NUEVO no deja inventory desincronizado', JSON.stringify(dNuevo))
}

// ===========================================================================
// T10 · PERMISOS POR SUCURSAL, VALIDADOS EN SERVIDOR (como `authenticated`)
// ===========================================================================
{
  await sembrar({ nsA: 5 })
  const tid = await crear(cli, USER_A, [{ variant_id: VAR_NS, cantidad: 5, serial_ids: [] }])

  // El DESTINO no puede despachar.
  const e1 = await falla(cli, USER_B, 'select t13.despachar_transferencia_stock($1::uuid)', [tid])
  check(e1 !== null && /sucursal de origen/i.test(e1.message) && e1.code === '42501',
    'T10 el destino no puede despachar (42501 en servidor)', e1 ? `${e1.code} ${e1.message.slice(0, 70)}` : 'despachó')

  await comoUsuario(cli, USER_A, 'select t13.despachar_transferencia_stock($1::uuid)', [tid])
  const [it] = await linea(tid)

  // El ORIGEN no puede recibir, aunque sea administrador.
  const e2 = await falla(cli, USER_A,
    'select t13.recibir_transferencia_parcial($1::uuid,$2::uuid,$3::jsonb,null,false)',
    [tid, K(9), JSON.stringify([{ item_id: it.id, cantidad_ok: 5 }])])
  check(e2 !== null && /sucursal de destino/i.test(e2.message) && e2.code === '42501',
    'T10 el origen no puede recibir, ni siendo administrador',
    e2 ? `${e2.code} ${e2.message.slice(0, 70)}` : 'recibió')

  // Una tercera sucursal no puede recibir ni ver nada.
  const e3 = await falla(cli, USER_C,
    'select t13.recibir_transferencia_parcial($1::uuid,$2::uuid,$3::jsonb,null,false)',
    [tid, K(1), JSON.stringify([{ item_id: it.id, cantidad_ok: 5 }])])
  check(e3 !== null && e3.code === '42501', 'T10 una sucursal ajena no puede recibir',
    e3 ? `${e3.code} ${e3.message.slice(0, 70)}` : 'recibió')

  const { rows: vistas } = await comoUsuario(cli, USER_C,
    'select count(*)::int as n from t13.transferencias_stock where id=$1', [tid])
  check(vistas[0].n === 0, 'T10 RLS oculta la transferencia a la sucursal ajena', `filas=${vistas[0].n}`)
  const { rows: det } = await comoUsuario(cli, USER_C, 'select t13.transferencia_detalle($1::uuid) as d', [tid])
  check(det[0].d === null, 'T10 transferencia_detalle no filtra datos a una sucursal ajena', JSON.stringify(det[0].d))

  // El destino sí puede, y ve su propio detalle.
  const { rows: ok } = await comoUsuario(cli, USER_B, 'select t13.transferencia_detalle($1::uuid) as d', [tid])
  check(ok[0].d !== null && ok[0].d.lineas.length === 1 && ok[0].d.lineas[0].cantidad_enviada === 5,
    'T10 el destino lee su detalle con las cantidades por línea', JSON.stringify(ok[0].d))

  // Y no se puede escribir la tabla a mano saltándose las RPC. Ojo: RLS sin
  // policy de UPDATE no lanza error, simplemente no afecta a ninguna fila. Si
  // esta comprobación buscara una excepción, pasaría también con la tabla
  // abierta de par en par. Se comprueba el EFECTO, no el error.
  const { rows: [{ afectadas }] } = await comoUsuario(cli, USER_B,
    'with u as (update t13.transferencia_stock_items set cantidad_recibida=99 where id=$1 returning 1) select count(*)::int as afectadas from u', [it.id])
  const tras = (await linea(tid))[0]
  check(afectadas === 0 && tras.cantidad_recibida === 0,
    'T10 authenticated no puede escribir los acumuladores por fuera de las RPC',
    `filas afectadas=${afectadas} cantidad_recibida=${tras.cantidad_recibida}`)
}

// ===========================================================================
// T11 · AUDITORÍA
// ===========================================================================
{
  await sembrar({ nsA: 5 })
  const tid = await crear(cli, USER_A, [{ variant_id: VAR_NS, cantidad: 5, serial_ids: [] }])
  await comoUsuario(cli, USER_A, 'select t13.despachar_transferencia_stock($1::uuid)', [tid])
  const [it] = await linea(tid)
  await admin.query('truncate t13.auditoria_eventos')
  await recibirParcial(cli, USER_B, tid, K(2), [{ item_id: it.id, cantidad_ok: 2 }])
  const { rows: aud } = await admin.query(
    'select tabla, accion, actor_staff_id from t13.auditoria_eventos order by id')
  check(aud.some((a) => a.tabla === 'transferencia_recepciones' && a.accion === 'INSERT'),
    'T11 cada recepción deja un evento de auditoría', JSON.stringify(aud.map((a) => `${a.tabla}:${a.accion}`)))
  check(aud.some((a) => a.tabla === 'transferencia_stock_items' && a.accion === 'UPDATE'),
    'T11 el cambio de acumuladores de la línea queda auditado')
  check(aud.every((a) => a.actor_staff_id === STAFF_B),
    'T11 la auditoría atribuye la recepción al operador del destino, no al rol de servicio',
    JSON.stringify([...new Set(aud.map((a) => a.actor_staff_id))]))
}

// ===========================================================================
// T12 · T3 — TODAS LAS UNIDADES IDENTIFICADAS: LA TRANSFERENCIA CIERRA SOLA
// ===========================================================================
// Deuda T3: un IMEI marcado "no llegó" no tocaba ningún acumulador, así que la
// fórmula de pendientes (recibida + danada < cantidad) lo seguía contando y la
// cabecera se quedaba en 'recibida_parcial' para siempre, aunque no quedara
// NADA que identificar. El operador ya había hecho todo su trabajo.
{
  await sembrar({ serialesA: 5 })
  const { rows: sids } = await admin.query('select id, serial_number from t13.product_serials order by serial_number')
  const tid = await crear(cli, USER_A, [{ variant_id: VAR_S, cantidad: 5, serial_ids: sids.map((x) => x.id) }])
  await comoUsuario(cli, USER_A, 'select t13.despachar_transferencia_stock($1::uuid)', [tid])
  const [it] = await linea(tid)

  // Una sola recepción que identifica LAS CINCO: 3 bien, 1 dañada, 1 no llegó.
  // No se pide cerrar: la transferencia tiene que cerrarse por sí misma.
  const e = await falla(cli, USER_B,
    'select t13.recibir_transferencia_parcial($1::uuid,$2::uuid,$3::jsonb,null,false) as d',
    [tid, K(1), JSON.stringify([{ item_id: it.id, serials: [
      { serial_id: sids[0].id, resultado: 'ok' }, { serial_id: sids[1].id, resultado: 'ok' },
      { serial_id: sids[2].id, resultado: 'ok' }, { serial_id: sids[3].id, resultado: 'danado' },
      { serial_id: sids[4].id, resultado: 'faltante' }] }])])
  check(e === null, 'T12 la recepción que identifica todas las unidades se aplica', e ? e.message.slice(0, 110) : '')

  const l = (await linea(tid))[0]
  const c = await cab(tid)
  check(c.estado === 'recibida', 'T12 la cabecera CIERRA SOLA: no queda nada que identificar (deuda T3)',
    `estado=${c.estado}`)
  check(l.cantidad_recibida === 3 && l.cantidad_danada === 1 && l.cantidad_faltante === 1,
    'T12 la línea cuadra 3 ok + 1 dañada + 1 faltante = 5 enviadas',
    `ok=${l.cantidad_recibida} dan=${l.cantidad_danada} falt=${l.cantidad_faltante}`)
  check(l.estado_linea === 'con_diferencia' && c.tiene_diferencias === true,
    'T12 el cierre automático queda marcado con diferencias', `linea=${l.estado_linea} dif=${c.tiene_diferencias}`)
  const est = Object.fromEntries((await seriales()).map((x) => [x.serial_number, x.estado]))
  check(est['IMEI-005'] === 'faltante' && est['IMEI-004'] === 'cuarentena',
    'T12 el faltante no resucita y el dañado va a cuarentena', JSON.stringify(est))
  check(await inv(VAR_S, LOC_B) === 3 && await inv(VAR_S, LOC_A) === 0,
    'T12 el stock final cuadra: sólo entran las 3 buenas',
    `A=${await inv(VAR_S, LOC_A)} B=${await inv(VAR_S, LOC_B)}`)
  const { rows: det } = await comoUsuario(cli, USER_B, 'select t13.transferencia_detalle($1::uuid) as d', [tid])
  check(det[0].d?.lineas?.[0]?.pendiente === 0,
    'T12 el detalle deja de anunciar un pendiente que nadie puede recibir',
    JSON.stringify(det[0].d?.lineas?.[0]))
  check((await desincronizados()).length === 0, 'T12 inventory sigue cuadrando con product_serials')
}

// ===========================================================================
// T12b · T3 en DOS TANDAS: el faltante de la primera no bloquea el cierre
// ===========================================================================
{
  await sembrar({ serialesA: 4 })
  const { rows: sids } = await admin.query('select id, serial_number from t13.product_serials order by serial_number')
  const tid = await crear(cli, USER_A, [{ variant_id: VAR_S, cantidad: 4, serial_ids: sids.map((x) => x.id) }])
  await comoUsuario(cli, USER_A, 'select t13.despachar_transferencia_stock($1::uuid)', [tid])
  const [it] = await linea(tid)

  await recibirParcial(cli, USER_B, tid, K(2), [{ item_id: it.id, serials: [
    { serial_id: sids[0].id, resultado: 'ok' }, { serial_id: sids[1].id, resultado: 'faltante' }] }])
  let l = (await linea(tid))[0]
  check((await cab(tid)).estado === 'recibida_parcial' && l.cantidad_faltante === 1 && l.estado_linea === 'parcial',
    'T12b con unidades aún sin identificar la transferencia sigue parcial y el faltante ya está contado',
    `estado=${(await cab(tid)).estado} falt=${l.cantidad_faltante} linea=${l.estado_linea}`)

  await recibirParcial(cli, USER_B, tid, K(3), [{ item_id: it.id, serials: [
    { serial_id: sids[2].id, resultado: 'ok' }, { serial_id: sids[3].id, resultado: 'faltante' }] }])
  l = (await linea(tid))[0]
  check((await cab(tid)).estado === 'recibida' && l.cantidad_recibida === 2 && l.cantidad_faltante === 2,
    'T12b la segunda tanda completa la identificación y cierra',
    `estado=${(await cab(tid)).estado} ok=${l.cantidad_recibida} falt=${l.cantidad_faltante}`)
  check(await inv(VAR_S, LOC_B) === 2, 'T12b sólo entran las unidades que llegaron')
  check((await desincronizados()).length === 0, 'T12b inventory cuadra con product_serials')
}

// ===========================================================================
// T12c · "RECIBIR TODO LO PENDIENTE" NO RESUCITA UN FALTANTE
// ===========================================================================
// Con el faltante fuera de la fórmula, p_items NULL volvía a pedir la unidad ya
// dada por perdida. Con IMEI el filtro `resultado is null` la salvaba; la
// cantidad derivada de la línea, no.
{
  await sembrar({ serialesA: 4 })
  const { rows: sids } = await admin.query('select id, serial_number from t13.product_serials order by serial_number')
  const tid = await crear(cli, USER_A, [{ variant_id: VAR_S, cantidad: 4, serial_ids: sids.map((x) => x.id) }])
  await comoUsuario(cli, USER_A, 'select t13.despachar_transferencia_stock($1::uuid)', [tid])
  const [it] = await linea(tid)
  await recibirParcial(cli, USER_B, tid, K(4), [{ item_id: it.id,
    serials: [{ serial_id: sids[0].id, resultado: 'faltante' }] }])
  const e = await falla(cli, USER_B,
    'select t13.recibir_transferencia_parcial($1::uuid,$2::uuid,null,null,false) as d', [tid, K(5)])
  check(e === null, 'T12c "recibir todo lo pendiente" tras un faltante no revienta', e ? e.message.slice(0, 110) : '')
  const l = (await linea(tid))[0]
  check(l.cantidad_recibida === 3 && l.cantidad_faltante === 1 && (await cab(tid)).estado === 'recibida',
    'T12c recibe SÓLO las 3 que seguían en vuelo y cierra',
    `ok=${l.cantidad_recibida} falt=${l.cantidad_faltante} estado=${(await cab(tid)).estado}`)
  check(await inv(VAR_S, LOC_B) === 3, 'T12c el faltante no entra al stock del destino')
  check((await desincronizados()).length === 0, 'T12c inventory cuadra con product_serials')
}

// ===========================================================================
// T13 · IMEI SOBRANTE: una unidad que nunca se envió no se puede recibir
// ===========================================================================
{
  await sembrar({ serialesA: 5 })
  const { rows: sids } = await admin.query('select id, serial_number from t13.product_serials order by serial_number')
  const tid = await crear(cli, USER_A,
    [{ variant_id: VAR_S, cantidad: 3, serial_ids: [sids[0].id, sids[1].id, sids[2].id] }])
  await comoUsuario(cli, USER_A, 'select t13.despachar_transferencia_stock($1::uuid)', [tid])
  const [it] = await linea(tid)
  const e = await falla(cli, USER_B,
    'select t13.recibir_transferencia_parcial($1::uuid,$2::uuid,$3::jsonb,null,false)',
    [tid, K(6), JSON.stringify([{ item_id: it.id, serials: [{ serial_id: sids[4].id, resultado: 'ok' }] }])])
  check(e !== null && /no está en vuelo/i.test(e.message),
    'T13 un IMEI que nunca se envió (sobrante) se RECHAZA: no entra por la puerta de atrás',
    e ? e.message.slice(0, 110) : 'se aceptó')
  const est = Object.fromEntries((await seriales()).map((x) => [x.serial_number, [x.estado, x.location_id]]))
  check(est['IMEI-005'][0] === 'disponible' && est['IMEI-005'][1] === LOC_A,
    'T13 el IMEI sobrante sigue disponible en el ORIGEN, intacto', JSON.stringify(est['IMEI-005']))
  check(await inv(VAR_S, LOC_B) === 0, 'T13 el rechazo no movió stock al destino')
  check((await desincronizados()).length === 0, 'T13 inventory cuadra con product_serials')
}

// ===========================================================================
// T14 · IMEI DE OTRA VARIANTE (hallazgo T7 de esta auditoría)
// ===========================================================================
// El filtro de conciliación era (transferencia_id, serial_id, resultado is
// null): NO comprobaba la variante. Con dos líneas serializadas en la misma
// transferencia, escanear el IMEI de la línea B dentro de la línea A se
// aceptaba, movía el serial al destino y sincronizaba el stock de A. El
// inventario de B nunca subía: inventory < product_serials disponibles.
{
  await sembrar({ serialesA: 2, serialesA2: 2 })
  const { rows: s1 } = await admin.query(
    'select id, serial_number from t13.product_serials where variant_id=$1 order by serial_number', [VAR_S])
  const { rows: s2 } = await admin.query(
    'select id, serial_number from t13.product_serials where variant_id=$1 order by serial_number', [VAR_S2])
  const tid = await crear(cli, USER_A, [
    { variant_id: VAR_S, cantidad: 2, serial_ids: s1.map((x) => x.id) },
    { variant_id: VAR_S2, cantidad: 2, serial_ids: s2.map((x) => x.id) }])
  await comoUsuario(cli, USER_A, 'select t13.despachar_transferencia_stock($1::uuid)', [tid])
  const items = await linea(tid)
  const itS = items.find((x) => x.variant_id === VAR_S)
  const itS2 = items.find((x) => x.variant_id === VAR_S2)

  const e = await falla(cli, USER_B,
    'select t13.recibir_transferencia_parcial($1::uuid,$2::uuid,$3::jsonb,null,false)',
    [tid, K(7), JSON.stringify([{ item_id: itS.id, serials: [{ serial_id: s2[0].id, resultado: 'ok' }] }])])
  check(e !== null && /no está en vuelo/i.test(e.message),
    'T14 un IMEI de OTRA variante no se concilia en esta línea (T7)',
    e ? e.message.slice(0, 130) : 'se aceptó el IMEI de otra variante')
  check((await desincronizados()).length === 0,
    'T14 el intento no desincronizó inventory de product_serials', JSON.stringify(await desincronizados()))
  check(await inv(VAR_S2, LOC_B) === 0 && await inv(VAR_S, LOC_B) === 0, 'T14 el rechazo no movió nada')

  // Y la vía correcta sí funciona, cada IMEI en su línea. (Se usa `falla` y no
  // `recibirParcial` porque sin la corrección el intento anterior SÍ se aplica
  // y deja el IMEI ya conciliado: la suite debe reportarlo, no reventar.)
  const eOk = await falla(cli, USER_B,
    'select t13.recibir_transferencia_parcial($1::uuid,$2::uuid,$3::jsonb,null,false)',
    [tid, K(8), JSON.stringify([
      { item_id: itS.id, serials: s1.map((x) => ({ serial_id: x.id, resultado: 'ok' })) },
      { item_id: itS2.id, serials: s2.map((x) => ({ serial_id: x.id, resultado: 'ok' })) }])])
  check(eOk === null, 'T14 la recepción con cada IMEI en su línea se aplica', eOk ? eOk.message.slice(0, 110) : '')
  check(await inv(VAR_S, LOC_B) === 2 && await inv(VAR_S2, LOC_B) === 2,
    'T14 con cada IMEI en su línea, AMBOS inventarios del destino suben',
    `S=${await inv(VAR_S, LOC_B)} S2=${await inv(VAR_S2, LOC_B)}`)
  check((await cab(tid)).estado === 'recibida', 'T14 la transferencia de dos líneas cierra')
  check((await desincronizados()).length === 0, 'T14 inventory cuadra con product_serials en ambas variantes')
}

// ===========================================================================
// T15 · T4 — CREACIÓN IDEMPOTENTE
// ===========================================================================
const nTransf = async () => (await admin.query('select count(*)::int as n from t13.transferencias_stock')).rows[0].n
{
  await sembrar({ nsA: 10 })
  const clave = crypto.randomUUID()
  const contenido = [{ variant_id: VAR_NS, cantidad: 3, serial_ids: [] }]

  // Sin clave no se crea nada. Fallo CERRADO: ningún cliente puede optar por
  // no tener idempotencia.
  const eSin = await falla(cli, USER_A,
    'select t13.crear_transferencia_stock($1::uuid,$2::jsonb,null,null)',
    [LOC_B, JSON.stringify(contenido)])
  check(eSin !== null && /client_transaction_id/i.test(eSin.message),
    'T15 la creación exige client_transaction_id', eSin ? eSin.message.slice(0, 110) : 'creó sin clave')
  check(await nTransf() === 0, 'T15 el intento sin clave no dejó ningún borrador')

  // Doble envío con la MISMA clave y el mismo contenido: un solo borrador.
  const t1 = await crear(cli, USER_A, contenido, LOC_B, clave)
  const t2 = await crear(cli, USER_A, contenido, LOC_B, clave)
  check(t1 === t2 && await nTransf() === 1,
    'T15 el doble envío con la misma clave devuelve el MISMO borrador, no crea dos (deuda T4)',
    `t1=${t1} t2=${t2} total=${await nTransf()}`)
  const { rows: lineasT1 } = await admin.query(
    'select count(*)::int as n from t13.transferencia_stock_items where transferencia_id=$1', [t1])
  check(lineasT1[0].n === 1, 'T15 tampoco duplica las líneas del borrador', `lineas=${lineasT1[0].n}`)

  // Misma clave, OTRO contenido: se RECHAZA. Nunca un éxito silencioso que
  // devuelva el borrador viejo como si fuera el nuevo (lección de T2).
  const eDist = await falla(cli, USER_A, SQL_CREAR,
    argsCrear(LOC_B, [{ variant_id: VAR_NS, cantidad: 7, serial_ids: [] }], clave))
  check(eDist !== null && /contenido distinto/i.test(eDist.message),
    'T15 la misma clave con otro contenido se RECHAZA, no devuelve el borrador anterior',
    eDist ? eDist.message.slice(0, 130) : 'lo dio por creado en silencio')
  check(await nTransf() === 1, 'T15 el rechazo no creó un segundo borrador')

  // Y una clave nueva sí crea otra transferencia: la idempotencia no bloquea.
  const t3 = await crear(cli, USER_A, contenido, LOC_B, crypto.randomUUID())
  check(t3 !== t1 && await nTransf() === 2, 'T15 una clave nueva sí crea una transferencia nueva')
}

// ===========================================================================
// T16 · T4 CONCURRENTE: dos conexiones REALES con la misma clave
// ===========================================================================
{
  await sembrar({ nsA: 10 })
  const clave = crypto.randomUUID()
  const contenido = JSON.stringify([{ variant_id: VAR_NS, cantidad: 4, serial_ids: [] }])
  const c1 = new pg.Client({ connectionString: URL_PG })
  const c2 = new pg.Client({ connectionString: URL_PG })
  const testigo = new pg.Client({ connectionString: URL_PG })
  await c1.connect(); await c2.connect(); await testigo.connect()
  let r1 = null, r2 = null, e2 = null, bloqueoObservado = false
  try {
    const { rows: [{ pid }] } = await c2.query('select pg_backend_pid() as pid')
    const abrir = async (c) => {
      await c.query('begin')
      await c.query(`select set_config('request.jwt.claims',$1,true)`,
        [JSON.stringify({ sub: USER_A, role: 'authenticated' })])
      await c.query('set local role authenticated')
    }
    await abrir(c1); await abrir(c2)
    r1 = (await c1.query(SQL_CREAR, argsCrear(LOC_B, JSON.parse(contenido), clave))).rows[0].id
    const enCurso = c2.query(SQL_CREAR, argsCrear(LOC_B, JSON.parse(contenido), clave))
    for (let i = 0; i < 60 && !bloqueoObservado; i++) {
      await dormir(50)
      const { rows } = await testigo.query(
        "select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'", [pid])
      bloqueoObservado = rows.length > 0
    }
    await c1.query('commit')
    try { r2 = (await enCurso).rows[0].id; await c2.query('commit') }
    catch (err) { e2 = err; await c2.query('rollback').catch(() => {}) }
  } finally {
    await c1.end().catch(() => {}); await c2.end().catch(() => {}); await testigo.end().catch(() => {})
  }
  check(bloqueoObservado, 'T16 se observó bloqueo real entre las dos conexiones (sin bloqueo no hubo carrera)')
  check(e2 === null && r1 === r2 && await nTransf() === 1,
    'T16 dos creaciones simultáneas con la misma clave dan UNA transferencia, y la segunda devuelve la misma',
    `r1=${r1} r2=${r2} error=${e2 ? e2.message.slice(0, 80) : 'ninguno'} total=${await nTransf()}`)
}

// ===========================================================================
// T17 · SUPERFICIE: una sola firma y nada para `anon`
// ===========================================================================
{
  const { rows: [{ n: firmas }] } = await admin.query(
    `select count(*)::int as n from pg_proc p join pg_namespace s on s.oid=p.pronamespace
      where s.nspname='t13' and p.proname='crear_transferencia_stock'`)
  check(firmas === 1, 'T17 crear_transferencia_stock deja UNA sola firma (sin sobrecarga ambigua)', `firmas=${firmas}`)

  const { rows: acl } = await admin.query(
    `select p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' as f,
            has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
       from pg_proc p join pg_namespace s on s.oid=p.pronamespace
      where s.nspname='t13' and p.proname in
        ('crear_transferencia_stock','recibir_transferencia_parcial','transferencia_detalle',
         'cerrar_transferencia_stock','despachar_transferencia_stock')`)
  const conAnon = acl.filter((r) => r.anon).map((r) => r.f)
  check(conAnon.length === 0, 'T17 ninguna RPC de transferencias es ejecutable por anon', conAnon.join(', '))
  const sinAuth = acl.filter((r) => !r.auth).map((r) => r.f)
  check(sinAuth.length === 0, 'T17 authenticated puede ejecutar todas las RPC de transferencias', sinAuth.join(', '))

  const { rows: [{ n: hashPriv }] } = await admin.query(
    `select count(*)::int as n from pg_proc p join pg_namespace s on s.oid=p.pronamespace
      where s.nspname='t13' and p.proname='hash_transferencia_creacion'
        and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))`)
  check(hashPriv === 0, 'T17 el helper de huella no es invocable por nadie de fuera', `expuesto en ${hashPriv}`)
}

// ===========================================================================
// FIN
// ===========================================================================
await admin.query('drop schema if exists t13 cascade')
await cli.end().catch(() => {})
await admin.end()
if (servidorLocal) await servidorLocal.stop()

console.log('FASE 13 — TRANSFERENCIAS PARCIALES')
console.log('SQL real de _p1_a_transferencias_parciales.sql + _p3_b_transferencias_t3_t4.sql, PostgreSQL real, rol authenticated')
if (SIN_P3B) console.log('*** MUTACIÓN TRANSF_SIN_P3B=1: _p3_b NO aplicada — se esperan FAIL ***')
console.log('')
for (const p of pasos) console.log(`  ${p.ok ? 'ok  ' : 'FAIL'} ${p.etiqueta}`)
console.log(`\n  ${pasos.filter((p) => p.ok).length}/${pasos.length} comprobaciones`)

if (SIN_P3B) {
  console.log(`\nMUTACIÓN: ${fallos.length} comprobaciones dependen de _p3_b_transferencias_t3_t4.sql`)
  for (const f of fallos) console.log(`  [FAIL] ${f}`)
  console.log('\nUna ejecución con mutación NUNCA cuenta como PASS.')
  process.exit(1)
}
if (fallos.length) {
  console.log('\nFallos:')
  for (const f of fallos) console.log(`  [FAIL] ${f}`)
  process.exit(1)
}
console.log('\nTransferencias parciales: PASS')
