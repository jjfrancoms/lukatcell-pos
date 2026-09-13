#!/usr/bin/env node
// ============================================================================
// P1-C · CAJA: umbral, autorización, actor real, sucursal e idempotencia.
//
// QUÉ SE EJERCITA: el SQL REAL de supabase/migrations/_p1_c_caja_umbral_
// autorizacion.sql, cargado del fichero tal cual, sobre un PostgreSQL REAL.
// El motor de autorizaciones (solicitar/resolver/consumir) también se carga
// literal de su migración (20260824131847), igual que la versión PREVIA de
// registrar_movimiento_caja e insertar_movimiento_caja: así la prueba ve el
// mismo salto de estado que verá producción, incluido el DROP de las firmas
// viejas. Si alguien reescribe la migración y reintroduce un agujero, esto se
// pone rojo. Nada se reimplementa a mano.
//
// CÓMO SE EJECUTA, y por qué importa (lección de P0.4): TODAS las llamadas
// bajo prueba corren con `set local role authenticated` y un
// `request.jwt.claims` realista. Validar como `postgres` no prueba nada: es
// dueño de todo, no pasa por privilegios de tabla ni por RLS, y así fue como
// un 42501 para todos los usuarios reales pasó desapercibido en P0.4.
//
// FALLA CERRADO. Sin PostgreSQL real termina con código 1 y explica cómo
// conseguirlo. No hay SKIP ni variable de escape: un script que imprime SKIP y
// sale con 0 hace creer que se probó algo que no se probó.
//
// Dos formas de ejecutarla, ambas reales:
//   1. Contra un PostgreSQL LOCAL existente (crea y destruye el esquema
//      desechable `p1c` y nada más):
//        P04_PG_URL=postgres://user:pass@localhost/db node scripts/verify-caja-autorizacion.mjs
//      Se rechaza cualquier destino que no sea localhost.
//   2. Con el entorno aislado del repo (binarios oficiales, sin Docker):
//        cd .p04-pgtest && npm install     (una sola vez)
//        node scripts/verify-caja-autorizacion.mjs
// ============================================================================

import { createRequire } from 'node:module'
import fs from 'node:fs'
// Nombre lógico → archivo real (provisional `_p1_c_…` o versionado tras aplicarse en producción).
import { resolverMigracion } from './lib/migraciones.mjs'

const AISLADO = new URL('../.p04-pgtest/', import.meta.url)
const MIGRACIONES = new URL('../supabase/migrations/', import.meta.url).pathname

function abortar(motivo) {
  console.error('VERIFICACIÓN DE CAJA (P1-C): NO EJECUTADA\n')
  console.error(`  ${motivo}\n`)
  console.error('  Esta prueba comprueba el umbral de egresos, la autorización obligatoria,')
  console.error('  el actor desde auth.uid(), la validación de sucursal y la idempotencia de')
  console.error('  los movimientos de caja. Sin un PostgreSQL real no se puede ejercitar, y')
  console.error('  NO ejecutarla no es lo mismo que pasarla.\n')
  console.error('  Para ejecutarla de verdad, cualquiera de estas dos:')
  console.error('    P04_PG_URL=postgres://user:pass@localhost/db node scripts/verify-caja-autorizacion.mjs')
  console.error('    cd .p04-pgtest && npm install   (una vez; luego se arranca solo)')
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

// Este script CREA y DESTRUYE objetos. Un dedazo en P04_PG_URL con la cadena
// de una Supabase real no puede llegar a ejecutarse.
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
  const puerto = 54341
  const dir = new URL('pgdata-caja', AISLADO).pathname
  fs.rmSync(dir, { recursive: true, force: true })
  servidorLocal = new EmbeddedPostgres({ databaseDir: dir, user: 'p04', password: 'p04', port: puerto, persistent: false })
  await servidorLocal.initialise()
  await servidorLocal.start()
  await servidorLocal.createDatabase('p04')
  URL_PG = `postgresql://p04:p04@localhost:${puerto}/p04`
}

// --- Extracción del SQL real de las migraciones -----------------------------
// Se toma la función tal cual está escrita en el fichero, sin reescribirla.
function funcionDeMigracion(fichero, nombre) {
  const sql = fs.readFileSync(MIGRACIONES + resolverMigracion(fichero), 'utf8')
  const inicio = sql.search(new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+${nombre}\\s*\\(`, 'i'))
  if (inicio === -1) throw new Error(`No se encontró ${nombre} en ${fichero}`)
  const resto = sql.slice(inicio)
  const apertura = /\$[A-Za-z_]*\$/.exec(resto)
  if (!apertura) throw new Error(`No se encontró el cuerpo de ${nombre} en ${fichero}`)
  const etiqueta = apertura[0]
  const cierre = resto.indexOf(etiqueta, apertura.index + etiqueta.length)
  if (cierre === -1) throw new Error(`No se encontró el fin del cuerpo de ${nombre} en ${fichero}`)
  return resto.slice(0, cierre + etiqueta.length) + ';'
}

// --- Esqueleto ---------------------------------------------------------------
// Las TABLAS se reproducen con la forma VERIFICADA en producción
// (information_schema.columns + pg_constraint del proyecto fbwkclpgnsxuqycazumj,
// consultado en sólo lectura). Las FUNCIONES no se reproducen: se cargan del
// fichero de migración, que es lo que está bajo prueba.
const ESQUELETO = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end $$;
create schema if not exists private;
create schema if not exists auth;

-- auth.uid() como en Supabase: sale del JWT, nunca de un parámetro.
create or replace function auth.uid() returns uuid language plpgsql stable as $fn$
declare c text := nullif(current_setting('request.jwt.claims', true), '');
begin
  if c is null then return null; end if;
  return nullif(c::json->>'sub', '')::uuid;
end $fn$;

create table public.locations (id uuid primary key, nombre text);
create table public.staff (id uuid primary key, user_id uuid, activo boolean not null default true,
  rol text, puesto text, location_id uuid references public.locations(id), nombre text);
create table public.sale_items (id uuid primary key);

create table public.configuracion (
  id smallint primary key,
  diferencia_caja_critica numeric(14,2) not null default 20,
  descuento_vendedor_max_pct numeric(5,2) not null default 0,
  puntos_por_sol numeric(10,4) not null default 0
);
insert into public.configuracion(id) values (1);

create table public.cash_sessions (
  id uuid primary key default gen_random_uuid(),
  cajero_id uuid references public.staff(id),
  location_id uuid references public.locations(id),
  apertura timestamptz default now(),
  cierre timestamptz,
  monto_inicial numeric not null default 0,
  monto_final_esperado numeric,
  monto_final_contado numeric,
  diferencia numeric,
  recalculado_tras_cierre boolean not null default false,
  is_test boolean not null default false,
  test_motivo text
);

create table public.cash_movements (
  id uuid primary key default gen_random_uuid(),
  cash_session_id uuid not null references public.cash_sessions(id),
  tipo text not null check (tipo in (
    'venta_efectivo', 'devolucion_efectivo', 'ingreso', 'retiro',
    'deposito_banco', 'retiro_banco', 'gasto', 'pago_proveedor', 'ajuste'
  )),
  monto numeric not null check (monto <> 0),
  motivo text,
  referencia_tipo text,
  referencia_id uuid,
  staff_id uuid not null references public.staff(id),
  reversa_de uuid references public.cash_movements(id),
  created_at timestamptz not null default now()
);

create table public.autorizaciones_operativas (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('descuento','anulacion','devolucion','ajuste_stock','otro')),
  solicitado_por uuid not null references public.staff(id),
  location_id uuid not null references public.locations(id),
  recurso_tipo text,
  recurso_id text,
  motivo text not null,
  payload jsonb not null default '{}'::jsonb,
  estado text not null default 'pendiente' check (estado in ('pendiente','aprobada','rechazada','consumida','cancelada')),
  resuelto_por uuid references public.staff(id),
  resolucion_motivo text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  consumed_at timestamptz,
  sale_item_id uuid references public.sale_items(id)
);

-- Helpers de identidad, copia literal de su definición en producción
-- (pg_get_functiondef sobre private.auth_staff_id / private.auth_is_admin).
create or replace function private.auth_staff_id() returns uuid
  language sql stable security definer set search_path to 'public' as $fn$
  select id from public.staff where user_id = auth.uid() and activo = true limit 1;
$fn$;
create or replace function private.auth_is_admin() returns boolean
  language sql stable security definer set search_path to 'public' as $fn$
  select exists (select 1 from public.staff where user_id = auth.uid() and rol = 'administrador' and activo = true);
$fn$;

-- RLS y grants como los deja el proyecto antes de esta migración.
alter table public.cash_movements enable row level security;
create policy cash_movements_lectura on public.cash_movements for select
  using (private.auth_is_admin() or exists (
    select 1 from public.cash_sessions cs
    where cs.id = cash_movements.cash_session_id and cs.cajero_id = private.auth_staff_id()));
create policy cash_movements_insercion_admin on public.cash_movements for insert
  with check (private.auth_is_admin());

alter table public.autorizaciones_operativas enable row level security;
create policy autorizaciones_lectura on public.autorizaciones_operativas for select to authenticated
  using (solicitado_por = private.auth_staff_id() or private.auth_is_admin());

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
revoke insert, update, delete on public.autorizaciones_operativas from authenticated;
revoke all on public.autorizaciones_operativas from anon;
grant select on public.autorizaciones_operativas to authenticated;
revoke update, delete on public.cash_movements from authenticated, anon;
`

const admin = new pg.Client({ connectionString: URL_PG })
await admin.connect()
await admin.query(ESQUELETO)

// Motor de autorizaciones REAL (no se duplica: se reutiliza tal cual).
const ENGINE = '20260824131847_operational_authorization_engine.sql'
for (const fn of ['public\\.solicitar_autorizacion', 'public\\.resolver_autorizacion', 'private\\.consumir_autorizacion']) {
  await admin.query(funcionDeMigracion(ENGINE, fn))
}
await admin.query(`
  revoke all on function public.solicitar_autorizacion(text,text,text,text,jsonb) from public, anon;
  revoke all on function public.resolver_autorizacion(uuid,boolean,text) from public, anon;
  revoke all on function private.consumir_autorizacion(uuid,text,uuid,text,text) from public, anon, authenticated;
  grant execute on function public.solicitar_autorizacion(text,text,text,text,jsonb) to authenticated;
  grant execute on function public.resolver_autorizacion(uuid,boolean,text) to authenticated;
`)

// Estado PREVIO de caja, literal de sus migraciones: así el DROP de firmas de
// la migración bajo prueba se ejerce de verdad y "no quedan sobrecargas" mide algo.
await admin.query(funcionDeMigracion('20260906210423_cierre_caja_con_ventas_offline_pendientes.sql', 'private\\.insertar_movimiento_caja'))
await admin.query(funcionDeMigracion('20260906205005_cash_movements_ledger.sql', 'public\\.registrar_movimiento_caja'))
await admin.query(funcionDeMigracion('20260906205005_cash_movements_ledger.sql', 'public\\.calcular_diferencia_caja'))
await admin.query(funcionDeMigracion('20260906210423_cierre_caja_con_ventas_offline_pendientes.sql', 'private\\.recalcular_caja_tras_movimiento'))
await admin.query(`
  revoke all on function private.insertar_movimiento_caja(uuid,text,numeric,text,uuid,text,uuid,uuid) from public, anon, authenticated;
  revoke all on function public.registrar_movimiento_caja(uuid,text,numeric,text) from public, anon;
  grant execute on function public.registrar_movimiento_caja(uuid,text,numeric,text) to authenticated;
  create trigger trg_recalcular_caja_tras_movimiento after insert on public.cash_movements
    for each row execute function private.recalcular_caja_tras_movimiento();
  create trigger trg_calcular_diferencia_caja before update on public.cash_sessions
    for each row execute function public.calcular_diferencia_caja();
`)

const firmasPrevias = await admin.query(
  `select p.proname, count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where p.proname in ('registrar_movimiento_caja','insertar_movimiento_caja') group by 1`)

// --- LA MIGRACIÓN BAJO PRUEBA, ÍNTEGRA Y SIN RETOCAR ------------------------
const MIGRACION = '_p1_c_caja_umbral_autorizacion.sql'
const sqlMigracion = fs.readFileSync(MIGRACIONES + resolverMigracion(MIGRACION), 'utf8')
await admin.query(sqlMigracion)

// --- Datos ------------------------------------------------------------------
const LOC_A = '11111111-0000-0000-0000-000000000001'
const LOC_B = '11111111-0000-0000-0000-000000000002'
const U_CAJERO_A = '22222222-0000-0000-0000-00000000000a'
const S_CAJERO_A = '33333333-0000-0000-0000-00000000000a'
const U_CAJERO_B = '22222222-0000-0000-0000-00000000000b'
const S_CAJERO_B = '33333333-0000-0000-0000-00000000000b'
const U_ADMIN = '22222222-0000-0000-0000-0000000000ad'
const S_ADMIN = '33333333-0000-0000-0000-0000000000ad'
const UMBRAL = 100

await admin.query(`insert into public.locations(id,nombre) values ($1,'Sucursal A'), ($2,'Sucursal B')`, [LOC_A, LOC_B])
await admin.query(
  `insert into public.staff(id,user_id,rol,puesto,location_id,nombre) values
     ($1,$2,'cajero',null,$5,'Cajera A'),
     ($3,$4,'cajero',null,$6,'Cajero B'),
     ($7,$8,'administrador','jefa',$5,'Admin')`,
  [S_CAJERO_A, U_CAJERO_A, S_CAJERO_B, U_CAJERO_B, LOC_A, LOC_B, S_ADMIN, U_ADMIN])
await admin.query(`update public.configuracion set caja_egreso_max_sin_autorizacion = $1 where id = 1`, [UMBRAL])

const { rows: [{ id: CAJA_A }] } = await admin.query(
  `insert into public.cash_sessions(cajero_id,location_id,monto_inicial) values ($1,$2,100000) returning id`,
  [S_CAJERO_A, LOC_A])

// --- Ejecución como usuario real -------------------------------------------
// Nunca como `postgres`: `set local role authenticated` + claims de verdad.
async function comoUsuario(cliente, userId, sql, params = []) {
  await cliente.query('begin')
  try {
    await cliente.query(`select set_config('request.jwt.claims', $1, true)`,
      [userId === null ? '' : JSON.stringify({ sub: userId, role: 'authenticated' })])
    await cliente.query('set local role authenticated')
    const r = await cliente.query(sql, params)
    await cliente.query('commit')
    return r
  } catch (e) {
    await cliente.query('rollback').catch(() => {})
    throw e
  }
}

const usuario = new pg.Client({ connectionString: URL_PG })
await usuario.connect()

const RPC_MOV = `select * from public.registrar_movimiento_caja($1,$2,$3,$4,$5,$6)`

const mov = (userId, { caja = CAJA_A, tipo, monto, motivo = 'motivo de prueba', tx, auth = null }) =>
  comoUsuario(usuario, userId, RPC_MOV, [caja, tipo, monto, motivo, tx, auth])

const solicitar = (userId, { caja = CAJA_A, tipo, monto, motivo }) =>
  comoUsuario(usuario, userId,
    `select * from public.solicitar_autorizacion('otro',$1,'movimiento_caja',$2,$3::jsonb)`,
    [motivo, caja, JSON.stringify({ tipo, monto })])

const solicitarPayload = (userId, { caja = CAJA_A, payload, motivo }) =>
  comoUsuario(usuario, userId,
    `select * from public.solicitar_autorizacion('otro',$1,'movimiento_caja',$2,$3::jsonb)`,
    [motivo, caja, JSON.stringify(payload)])

const resolver = (id, aprobar) =>
  comoUsuario(usuario, U_ADMIN, `select * from public.resolver_autorizacion($1,$2,'resuelto por la prueba')`, [id, aprobar])

async function autorizacionAprobada(userId, { caja = CAJA_A, tipo, monto, motivo, payload }) {
  const { rows: [a] } = payload
    ? await solicitarPayload(userId, { caja, payload, motivo })
    : await solicitar(userId, { caja, tipo, monto, motivo })
  await resolver(a.id, true)
  return a.id
}

const uuid = () => crypto.randomUUID()
const estadoAuth = async (id) => (await admin.query('select estado, consumed_at from public.autorizaciones_operativas where id=$1', [id])).rows[0]
const cuentaMov = async (filtro, params) => Number((await admin.query(`select count(*)::int n from public.cash_movements where ${filtro}`, params)).rows[0].n)

// --- Casos ------------------------------------------------------------------
const resultados = []
async function caso(nombre, requisito, fn) {
  try {
    const detalle = await fn()
    resultados.push({ nombre, requisito, ok: true, detalle: detalle ?? '' })
  } catch (e) {
    resultados.push({ nombre, requisito, ok: false, detalle: e.message })
  }
}
function exigir(cond, mensaje) { if (!cond) throw new Error(mensaje) }
async function debeFallar(promesa, patron, queEsperaba) {
  try {
    await promesa
  } catch (e) {
    if (!patron.test(e.message)) throw new Error(`falló, pero con otro error: ${e.message}`)
    return e.message
  }
  throw new Error(`NO falló: ${queEsperaba}`)
}

await caso('sin sobrecargas tras la migración', 'P0.2 · una firma por función', async () => {
  const { rows } = await admin.query(
    `select p.proname, count(*)::int as n, string_agg(pg_get_function_identity_arguments(p.oid), ' | ') as firmas
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where p.proname in ('registrar_movimiento_caja','insertar_movimiento_caja') group by 1 order by 1`)
  const previas = Object.fromEntries(firmasPrevias.rows.map((r) => [r.proname, r.n]))
  exigir(previas.registrar_movimiento_caja === 1 && previas.insertar_movimiento_caja === 1,
    'el esqueleto no partía de una sola firma: la prueba no mide el reemplazo')
  for (const r of rows) exigir(r.n === 1, `${r.proname} quedó con ${r.n} firmas (sobrecarga): ${r.firmas}`)
  return rows.map((r) => `${r.proname}(${r.firmas})`).join(' ; ')
})

await caso('egreso bajo el umbral pasa sin autorización', 'umbral configurable', async () => {
  const tx = uuid()
  const { rows: [m] } = await mov(U_CAJERO_A, { tipo: 'retiro', monto: 50, tx })
  exigir(Number(m.monto) === -50, `monto firmado ${m.monto}, se esperaba -50`)
  exigir(m.autorizacion_id === null, 'se vinculó una autorización que no hacía falta')
  exigir(m.client_transaction_id === tx, 'no se guardó el client_transaction_id')
  return `movimiento ${m.id} monto ${m.monto}`
})

await caso('egreso sobre el umbral se RECHAZA sin autorización', 'autorización obligatoria', async () => {
  const msg = await debeFallar(mov(U_CAJERO_A, { tipo: 'retiro', monto: 500, tx: uuid() }),
    /supera el umbral/i, 'un retiro de 500 con umbral 100 pasó sin autorización')
  exigir(await cuentaMov('monto = -500') === 0, 'se registró el movimiento pese al rechazo')
  return msg
})

await caso('autorización PENDIENTE no habilita el egreso', 'autorización obligatoria', async () => {
  const { rows: [a] } = await solicitar(U_CAJERO_A, { tipo: 'retiro', monto: 500, motivo: 'retiro grande pendiente' })
  exigir(a.estado === 'pendiente', `la solicitud nació en estado ${a.estado}`)
  const msg = await debeFallar(mov(U_CAJERO_A, { tipo: 'retiro', monto: 500, tx: uuid(), auth: a.id }),
    /no está aprobada|no es tuya|ya fue usada/i, 'una autorización pendiente habilitó el egreso')
  await resolver(a.id, false)
  return msg
})

await caso('autorización RECHAZADA no habilita el egreso', 'autorización obligatoria', async () => {
  const { rows: [a] } = await solicitar(U_CAJERO_A, { tipo: 'retiro', monto: 500, motivo: 'retiro que se rechaza' })
  await resolver(a.id, false)
  exigir((await estadoAuth(a.id)).estado === 'rechazada', 'la autorización no quedó rechazada')
  return await debeFallar(mov(U_CAJERO_A, { tipo: 'retiro', monto: 500, tx: uuid(), auth: a.id }),
    /no está aprobada|no es tuya|ya fue usada/i, 'una autorización rechazada habilitó el egreso')
})

let AUTH_CONSUMIDA = null
await caso('con autorización aprobada pasa y queda CONSUMIDA', 'autorización obligatoria', async () => {
  const id = await autorizacionAprobada(U_CAJERO_A, { tipo: 'retiro', monto: 500, motivo: 'retiro grande aprobado' })
  const { rows: [m] } = await mov(U_CAJERO_A, { tipo: 'retiro', monto: 500, tx: uuid(), auth: id })
  exigir(Number(m.monto) === -500, `monto ${m.monto}`)
  exigir(m.autorizacion_id === id, 'el movimiento no quedó vinculado a la autorización')
  const a = await estadoAuth(id)
  exigir(a.estado === 'consumida', `la autorización quedó en ${a.estado}, no 'consumida'`)
  exigir(a.consumed_at !== null, 'consumed_at quedó en null')
  AUTH_CONSUMIDA = id
  return `movimiento ${m.id} ← autorización ${id} consumida`
})

await caso('la autorización consumida NO se reutiliza', 'autorización no reutilizable', async () => {
  const msg = await debeFallar(mov(U_CAJERO_A, { tipo: 'retiro', monto: 500, tx: uuid(), auth: AUTH_CONSUMIDA }),
    /no está aprobada|ya fue usada|no es tuya/i, 'una autorización ya consumida se volvió a usar')
  exigir(await cuentaMov('autorizacion_id = $1', [AUTH_CONSUMIDA]) === 1,
    'la autorización respalda más de un movimiento')
  return msg
})

await caso('doble clic / doble POST no duplica el movimiento', 'idempotencia', async () => {
  const tx = uuid()
  const { rows: [a] } = await mov(U_CAJERO_A, { tipo: 'retiro', monto: 40, motivo: 'doble clic', tx })
  const { rows: [b] } = await mov(U_CAJERO_A, { tipo: 'retiro', monto: 40, motivo: 'doble clic', tx })
  exigir(a.id === b.id, 'el reintento creó un movimiento distinto')
  exigir(await cuentaMov('client_transaction_id = $1', [tx]) === 1, 'quedaron dos movimientos con el mismo id de transacción')
  return `un solo movimiento ${a.id} para dos envíos`
})

await caso('el reintento no quema una segunda autorización', 'idempotencia + autorización', async () => {
  const id = await autorizacionAprobada(U_CAJERO_A, { tipo: 'retiro', monto: 700, motivo: 'retiro con reintento' })
  const tx = uuid()
  const { rows: [a] } = await mov(U_CAJERO_A, { tipo: 'retiro', monto: 700, tx, auth: id })
  const { rows: [b] } = await mov(U_CAJERO_A, { tipo: 'retiro', monto: 700, tx, auth: id })
  exigir(a.id === b.id, 'el reintento creó un segundo movimiento')
  exigir(await cuentaMov('client_transaction_id = $1', [tx]) === 1, 'se duplicó el movimiento autorizado')
  exigir(await cuentaMov('autorizacion_id = $1', [id]) === 1, 'la autorización respalda dos movimientos')
  return `movimiento ${a.id}, autorización ${id} consumida una sola vez`
})

await caso('un cajero de OTRA sucursal no opera esta caja', 'sucursal validada en servidor', async () => {
  const msg = await debeFallar(mov(U_CAJERO_B, { tipo: 'retiro', monto: 10, tx: uuid() }),
    /no pertenece a tu sucursal/i, 'un cajero de otra sucursal registró un movimiento')
  exigir(await cuentaMov('staff_id = $1', [S_CAJERO_B]) === 0, 'el cajero de otra sucursal dejó movimientos')
  return msg
})

await caso('ni con autorización aprobada de su propia sucursal', 'sucursal validada en servidor', async () => {
  const { rows: [a] } = await comoUsuario(usuario, U_CAJERO_B,
    `select * from public.solicitar_autorizacion('otro',$1,'movimiento_caja',$2,$3::jsonb)`,
    ['retiro grande del cajero B', CAJA_A, JSON.stringify({ tipo: 'retiro', monto: 500 })])
  await resolver(a.id, true)
  const msg = await debeFallar(mov(U_CAJERO_B, { tipo: 'retiro', monto: 500, tx: uuid(), auth: a.id }),
    /no pertenece a tu sucursal/i, 'la autorización sorteó la validación de sucursal')
  exigir((await estadoAuth(a.id)).estado === 'aprobada', 'se consumió la autorización pese al rechazo por sucursal')
  return msg
})

await caso('el actor sale de auth.uid(), no de un parámetro', 'actor real', async () => {
  const { rows: [firma] } = await admin.query(
    `select pg_get_function_identity_arguments(p.oid) as args from pg_proc p
     join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='registrar_movimiento_caja'`)
  exigir(!/staff|actor|cajero|usuario|user_id/i.test(firma.args),
    `la firma expone un parámetro de identidad falsificable: ${firma.args}`)

  const tx = uuid()
  const { rows: [m] } = await mov(U_CAJERO_A, { tipo: 'ingreso', monto: 10, tx })
  exigir(m.staff_id === S_CAJERO_A, `staff_id ${m.staff_id}, se esperaba la cajera A`)

  const { rows: [m2] } = await mov(U_ADMIN, { tipo: 'ingreso', monto: 11, tx: uuid() })
  exigir(m2.staff_id === S_ADMIN, 'el actor no cambió al cambiar el JWT')

  await debeFallar(mov(null, { tipo: 'ingreso', monto: 12, tx: uuid() }),
    /usuario autenticado|Personal no válido/i, 'se registró un movimiento sin sesión autenticada')
  return `firma sin parámetro de identidad: (${firma.args})`
})

await caso('dos conexiones no consumen la misma autorización dos veces', 'concurrencia real', async () => {
  const id = await autorizacionAprobada(U_CAJERO_A, { tipo: 'retiro', monto: 300, motivo: 'carrera por la misma autorizacion' })
  const c1 = new pg.Client({ connectionString: URL_PG })
  const c2 = new pg.Client({ connectionString: URL_PG })
  await c1.connect(); await c2.connect()
  const testigo = new pg.Client({ connectionString: URL_PG })
  await testigo.connect()
  try {
    const { rows: [{ pid }] } = await c2.query('select pg_backend_pid() as pid')
    const abrir = async (c, u) => {
      await c.query('begin')
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: u, role: 'authenticated' })])
      await c.query('set local role authenticated')
    }
    await abrir(c1, U_CAJERO_A)
    await abrir(c2, U_CAJERO_A)

    // c1 consume la autorización y NO confirma: retiene el lock de la caja.
    const r1 = await c1.query(RPC_MOV, [CAJA_A, 'retiro', 300, 'carrera 1', uuid(), id])

    // c2 entra a la vez con la MISMA autorización y se bloqueará de verdad.
    const enCurso = c2.query(RPC_MOV, [CAJA_A, 'retiro', 300, 'carrera 2', uuid(), id])
      .then(() => ({ ok: true })).catch((e) => ({ ok: false, error: e.message }))

    let bloqueo = false
    for (let i = 0; i < 40 && !bloqueo; i++) {
      await new Promise((r) => setTimeout(r, 50))
      const { rows } = await testigo.query(
        `select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`, [pid])
      bloqueo = rows.length > 0
    }
    exigir(bloqueo, 'no se observó bloqueo real: esa carrera no ejerció concurrencia')

    await c1.query('commit')
    const res2 = await enCurso
    await c2.query('rollback').catch(() => {})

    exigir(res2.ok === false, 'las DOS conexiones consumieron la misma autorización')
    exigir(/no está aprobada|ya fue usada|no es tuya/i.test(res2.error), `la segunda falló con otro error: ${res2.error}`)
    exigir(await cuentaMov('autorizacion_id = $1', [id]) === 1, 'quedaron dos movimientos con la misma autorización')
    exigir(r1.rows[0].autorizacion_id === id, 'el movimiento ganador no quedó vinculado')
    return `bloqueo observado en pg_stat_activity; ganó una sola conexión (${res2.error.split('\n')[0]})`
  } finally {
    await c1.end().catch(() => {}); await c2.end().catch(() => {}); await testigo.end().catch(() => {})
  }
})

await caso('un ajuste positivo grande también exige autorización', 'ajustes grandes', async () => {
  const msg = await debeFallar(mov(U_ADMIN, { tipo: 'ajuste', monto: 500, tx: uuid() }),
    /supera el umbral/i, 'un ajuste positivo de 500 pasó sin autorización')
  exigir(await cuentaMov(`tipo = 'ajuste'`) === 0, 'se registró el ajuste pese al rechazo')
  return msg
})

// --- Misma clave, contenido distinto -------------------------------------------
// Un reintento legítimo repite el contenido. Si la misma clave llega con otro
// importe, tipo o motivo es otra operación, y devolver el movimiento anterior
// como si fuera un reintento dejaría la nueva sin registrar mientras el cliente
// ve "registrado". Estos casos van DESPUÉS de 'un ajuste positivo grande...',
// que exige que no exista ningún ajuste todavía.
await caso('misma clave con OTRO monto se RECHAZA, no devuelve el viejo en silencio', 'idempotencia sin pérdida silenciosa', async () => {
  const tx = uuid()
  const { rows: [a] } = await mov(U_CAJERO_A, { tipo: 'retiro', monto: 41, motivo: 'clave reutilizada', tx })
  const msg = await debeFallar(mov(U_CAJERO_A, { tipo: 'retiro', monto: 42, motivo: 'clave reutilizada', tx }),
    /contenido distinto/i, 'la misma clave con otro monto devolvió el movimiento anterior en silencio')
  exigir(await cuentaMov('client_transaction_id = $1', [tx]) === 1, 'se registró un segundo movimiento con la misma clave')
  exigir(await cuentaMov('monto = -42') === 0, 'se registró el retiro de 42')
  return `${a.id} conservado; ${msg}`
})

await caso('misma clave con OTRO tipo o motivo se RECHAZA', 'idempotencia sin pérdida silenciosa', async () => {
  const tx = uuid()
  await mov(U_CAJERO_A, { tipo: 'retiro', monto: 43, motivo: 'motivo original', tx })
  await debeFallar(mov(U_CAJERO_A, { tipo: 'ingreso', monto: 43, motivo: 'motivo original', tx }),
    /contenido distinto/i, 'la misma clave con otro tipo devolvió el movimiento anterior')
  return await debeFallar(mov(U_CAJERO_A, { tipo: 'retiro', monto: 43, motivo: 'otro motivo', tx }),
    /contenido distinto/i, 'la misma clave con otro motivo devolvió el movimiento anterior')
})

await caso('un ajuste con la misma clave y el signo invertido se RECHAZA', 'idempotencia con signo', async () => {
  // +20 y -20 tienen el mismo valor absoluto: comparar sólo el absoluto
  // confundiría un ajuste que suma con uno que resta.
  const tx = uuid()
  await mov(U_ADMIN, { tipo: 'ajuste', monto: 20, motivo: 'ajuste firmado', tx })
  return await debeFallar(mov(U_ADMIN, { tipo: 'ajuste', monto: -20, motivo: 'ajuste firmado', tx }),
    /contenido distinto/i, 'un ajuste de -20 con la clave de uno de +20 se tomó por reintento')
})

await caso('un ingreso grande NO exige autorización', 'el umbral es de egresos', async () => {
  const { rows: [m] } = await mov(U_CAJERO_A, { tipo: 'ingreso', monto: 5000, tx: uuid() })
  exigir(Number(m.monto) === 5000 && m.autorizacion_id === null, 'el ingreso no se registró limpio')
  return `ingreso ${m.monto} sin autorización`
})

await caso('no se puede exceder el monto autorizado', 'la autorización acota el importe', async () => {
  const id = await autorizacionAprobada(U_CAJERO_A, { tipo: 'retiro', monto: 500, motivo: 'autorizacion de 500' })
  const msg = await debeFallar(mov(U_CAJERO_A, { tipo: 'retiro', monto: 900, tx: uuid(), auth: id }),
    /supera el monto autorizado/i, 'se retiró más de lo autorizado')
  exigir((await estadoAuth(id)).estado === 'aprobada', 'se consumió la autorización en un intento rechazado')
  return msg
})

await caso('la autorización de otro tipo de movimiento no sirve', 'la autorización acota el tipo', async () => {
  const id = await autorizacionAprobada(U_ADMIN, { tipo: 'gasto', monto: 500, motivo: 'autorizacion de gasto' })
  const msg = await debeFallar(mov(U_ADMIN, { tipo: 'retiro', monto: 500, tx: uuid(), auth: id }),
    /otro tipo de movimiento/i, 'una autorización de gasto habilitó un retiro')
  exigir((await estadoAuth(id)).estado === 'aprobada', 'se consumió una autorización de otro tipo')
  return msg
})

await caso('una autorización sin monto aprobado no sirve', 'payload validado en servidor', async () => {
  const id = await autorizacionAprobada(U_CAJERO_A, { payload: { tipo: 'retiro' }, motivo: 'autorizacion sin monto' })
  const msg = await debeFallar(mov(U_CAJERO_A, { tipo: 'retiro', monto: 500, tx: uuid(), auth: id }),
    /no indica el monto aprobado/i, 'una autorización sin monto habilitó un egreso')
  exigir((await estadoAuth(id)).estado === 'aprobada', 'se consumió una autorización inválida')
  return msg
})

await caso('un monto de payload no numérico no sirve', 'payload validado en servidor', async () => {
  const id = await autorizacionAprobada(U_CAJERO_A, { payload: { tipo: 'retiro', monto: '99999' }, motivo: 'monto como texto' })
  return await debeFallar(mov(U_CAJERO_A, { tipo: 'retiro', monto: 500, tx: uuid(), auth: id }),
    /no indica el monto aprobado/i, 'un monto en texto se aceptó como aprobación')
})

await caso('no se usa la autorización de otra persona', 'la autorización es del solicitante', async () => {
  const id = await autorizacionAprobada(U_ADMIN, { tipo: 'retiro', monto: 500, motivo: 'autorizacion del admin' })
  const msg = await debeFallar(mov(U_CAJERO_A, { tipo: 'retiro', monto: 500, tx: uuid(), auth: id }),
    /no es tuya|no está aprobada|ya fue usada/i, 'un cajero usó la autorización de otra persona')
  exigir((await estadoAuth(id)).estado === 'aprobada', 'se consumió la autorización ajena')
  return msg
})

await caso('un id de transacción no se reutiliza en otra caja', 'idempotencia acotada', async () => {
  const { rows: [{ id: otraCaja }] } = await admin.query(
    `insert into public.cash_sessions(cajero_id,location_id,monto_inicial) values ($1,$2,500) returning id`,
    [S_CAJERO_A, LOC_A])
  const tx = uuid()
  await mov(U_CAJERO_A, { tipo: 'retiro', monto: 20, tx })
  return await debeFallar(mov(U_CAJERO_A, { caja: otraCaja, tipo: 'retiro', monto: 20, tx }),
    /ya se usó en otro movimiento/i, 'el mismo id de transacción sirvió para dos cajas distintas')
})

await caso('privilegios reales: authenticated ejecuta, anon no', 'P0.4 · no validar sólo como postgres', async () => {
  const { rows: [p] } = await admin.query(`
    select has_function_privilege('authenticated', p.oid, 'execute') as auth_ok,
           has_function_privilege('anon', p.oid, 'execute') as anon_ok
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='registrar_movimiento_caja'`)
  exigir(p.auth_ok, 'authenticated NO puede ejecutar registrar_movimiento_caja (42501 para todos los usuarios reales)')
  exigir(!p.anon_ok, 'anon puede ejecutar registrar_movimiento_caja')
  const { rows: [t] } = await admin.query(`
    select has_table_privilege('authenticated','public.cash_movements','update') as upd,
           has_table_privilege('authenticated','public.cash_movements','delete') as del`)
  exigir(!t.upd && !t.del, 'cash_movements dejó de ser append-only para authenticated')
  return 'authenticated: execute sí, update/delete no; anon: nada'
})

// --- C1 · compatibilidad hacia atrás --------------------------------------------
// El frontend desplegado antes de P1 —y cualquier bundle viejo en caché de una
// terminal offline— llama con 4 argumentos NOMBRADOS, como hace PostgREST, sin
// clave. Estas pruebas usan exactamente esa forma de llamada. Lo que importa no
// es sólo que funcione, sino que omitir la clave NO salte ningún control.
const RPC_MOV_VIEJA = `select * from public.registrar_movimiento_caja(p_cash_session_id => $1, p_tipo => $2, p_monto => $3, p_motivo => $4)`
const movVieja = (userId, { caja = CAJA_A, tipo, monto, motivo = 'bundle viejo offline' }) =>
  comoUsuario(usuario, userId, RPC_MOV_VIEJA, [caja, tipo, monto, motivo])

await caso('C1 · la firma vieja de 4 args nombrados sigue funcionando', 'compatibilidad offline', async () => {
  const { rows: [m] } = await movVieja(U_CAJERO_A, { tipo: 'retiro', monto: 30 })
  exigir(Number(m.monto) === -30, `monto ${m.monto}, se esperaba -30`)
  exigir(m.client_transaction_id !== null, 'sin clave no se generó una en el servidor')
  exigir(m.staff_id === S_CAJERO_A, 'el actor no salió de auth.uid()')
  return `movimiento ${m.id} con clave generada ${m.client_transaction_id}`
})

await caso('C1 · sin clave, un egreso sobre el umbral SIGUE exigiendo autorización', 'compatibilidad sin saltar controles', async () => {
  const msg = await debeFallar(movVieja(U_CAJERO_A, { tipo: 'retiro', monto: 650 }),
    /supera el umbral/i, 'omitir la clave permitió un retiro de 650 sin autorización')
  exigir(await cuentaMov('monto = -650') === 0, 'se registró el retiro pese al rechazo')
  return msg
})

await caso('C1 · sin clave, otra sucursal SIGUE rechazada', 'compatibilidad sin saltar controles', async () => {
  const msg = await debeFallar(movVieja(U_CAJERO_B, { tipo: 'retiro', monto: 15 }),
    /no pertenece a tu sucursal/i, 'omitir la clave permitió operar la caja de otra sucursal')
  exigir(await cuentaMov('staff_id = $1', [S_CAJERO_B]) === 0, 'el cajero de otra sucursal dejó movimientos')
  return msg
})

await caso('C1 · sin clave no hay idempotencia: dos envíos son dos movimientos', 'coste documentado de la compatibilidad', async () => {
  // Es el comportamiento previo a P1, y se fija aquí a propósito: si alguien
  // cambiara el camino sin clave para deduplicar por contenido, dos retiros
  // legítimos e idénticos se fundirían en uno y la caja quedaría descuadrada.
  await movVieja(U_CAJERO_A, { tipo: 'retiro', monto: 33 })
  await movVieja(U_CAJERO_A, { tipo: 'retiro', monto: 33 })
  const n = await cuentaMov('monto = -33')
  exigir(n === 2, `quedaron ${n} movimientos de -33, se esperaban 2`)
  return 'dos envíos sin clave → dos movimientos, como antes de P1'
})

// --- C3 · las llamadoras reales de insertar_movimiento_caja ---------------------
// La migración hace DROP de la firma de 8 args y CREATE de una de 10. Cinco
// funciones de producción la invocan con argumentos POSICIONALES y plpgsql
// resuelve la llamada al ejecutarse, no al crearse: si la firma nueva no
// aceptara esas formas, venta, anulación, reembolso, pago a proveedor y reversa
// de caja fallarían en tiempo de ejecución. Se ejercitan las dos formas reales,
// con los tipos exactos que usan (según pg_get_functiondef en producción):
//   7 args — registrar_venta, ejecutar_anulacion_venta,
//            confirmar_reembolso_devolucion, registrar_pago_proveedor
//   8 args — reversar_movimiento_caja (añade reversa_de)
// Como `postgres`, que es el contexto en que corren esas SECURITY DEFINER.
await caso('C3 · llamadas posicionales de 7 y 8 args resuelven tras el DROP+CREATE', 'P0 · consumidores reales de la firma', async () => {
  const { rows: [m7] } = await admin.query(
    `select * from private.insertar_movimiento_caja($1::uuid, 'venta_efectivo'::text, $2::numeric, 'Venta en efectivo'::text, $3::uuid, 'sale'::text, $4::uuid)`,
    [CAJA_A, 25, S_CAJERO_A, uuid()])
  exigir(Number(m7.monto) === 25 && m7.referencia_tipo === 'sale', `la llamada de 7 args insertó mal: monto ${m7.monto}`)
  const { rows: [m8] } = await admin.query(
    `select * from private.insertar_movimiento_caja($1::uuid, 'venta_efectivo'::text, $2::numeric, 'Reversión: prueba'::text, $3::uuid, 'sale'::text, $4::uuid, $5::uuid)`,
    [CAJA_A, -25, S_CAJERO_A, m7.referencia_id, m7.id])
  exigir(m8.reversa_de === m7.id, 'la llamada de 8 args no guardó reversa_de')
  const { rows: [{ n }] } = await admin.query(
    `select count(*)::int as n from pg_proc p join pg_namespace s on s.oid=p.pronamespace
     where s.nspname='private' and p.proname='insertar_movimiento_caja'`)
  exigir(n === 1, `insertar_movimiento_caja quedó con ${n} firmas`)
  return `7 args → ${m7.id}; 8 args → ${m8.id} (reversa de ${m7.id}); una sola firma`
})

await caso('invariante P0: el esperado sigue siendo el libro', 'P0 · esperado reconstruible', async () => {
  const { rows: [s] } = await admin.query(`
    update public.cash_sessions set cierre = now(), monto_final_contado = 1
    where id = $1 returning monto_inicial, monto_final_esperado`, [CAJA_A])
  const { rows: [l] } = await admin.query(
    `select coalesce(sum(monto),0) as suma from public.cash_movements where cash_session_id = $1`, [CAJA_A])
  const esperado = Number(s.monto_inicial) + Number(l.suma)
  exigir(Math.abs(Number(s.monto_final_esperado) - esperado) < 0.005,
    `monto_final_esperado ${s.monto_final_esperado} ≠ monto_inicial + libro (${esperado})`)
  return `esperado ${s.monto_final_esperado} = inicial ${s.monto_inicial} + libro ${l.suma}`
})

await caso('caja cerrada sigue rechazando movimientos manuales', 'P0 · caja cerrada inmutable', async () =>
  await debeFallar(mov(U_CAJERO_A, { tipo: 'retiro', monto: 10, tx: uuid() }),
    /no está abierta/i, 'se registró un movimiento manual en una caja cerrada'))

// --- Cierre -----------------------------------------------------------------
await usuario.end().catch(() => {})
await admin.end()
if (servidorLocal) await servidorLocal.stop()

console.log('VERIFICACIÓN DE CAJA (P1-C) — umbral, autorización, actor, sucursal, idempotencia')
console.log(`SQL real de ${MIGRACION} sobre PostgreSQL real, ejecutado como rol authenticated con JWT\n`)
let fallos = 0
for (const r of resultados) {
  if (!r.ok) fallos++
  console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.nombre}`)
  console.log(`         requisito: ${r.requisito}`)
  if (r.detalle) console.log(`         ${String(r.detalle).split('\n')[0]}`)
}
console.log(`\n${resultados.length - fallos}/${resultados.length} casos en verde`)
if (fallos) {
  console.log(`${fallos} FALLO(S). La migración no está lista para producción.`)
  process.exit(1)
}
console.log('P1-C: umbral, autorización obligatoria y no reutilizable, actor desde auth.uid(),')
console.log('sucursal validada e idempotencia verificados contra PostgreSQL real. PASS')
