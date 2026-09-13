#!/usr/bin/env node
// FASE 18 — PAGOS Y CONCILIACIÓN. Regresión contra PostgreSQL REAL.
//
// QUÉ SE EJERCITA: el SQL REAL de `supabase/migrations/_p1_d_pagos_conciliacion.sql`,
// cargado tal cual del fichero, sobre las DDL REALES de las migraciones que ya
// están en producción (20260824145525, 20260824151006) y con el trigger REAL de
// business_date de P0.2 (20260906200849). No se reimplementa ninguna función:
// si alguien afloja la migración, esto se pone rojo.
//
// POR QUÉ COMO `authenticated` Y NO COMO `postgres`: en P0.4 un 42501 que
// afectaba a TODOS los usuarios pasó desapercibido porque la validación corría
// como el rol dueño, que no pasa por privilegios de tabla ni por RLS. Aquí
// cada llamada de negocio va dentro de `begin; set local role authenticated;
// set local request.jwt.claims '...'` con un sub realista, y hay assertions
// negativas explícitas (cajero, anon, UPDATE directo) para probarlo.
//
// FALLA CERRADO. Sin PostgreSQL real esto termina con código 1 y explica cómo
// conseguirlo. No hay SKIP, no hay variable de escape, no hay exit 0 sin haber
// ejercitado nada.
//
// Dos formas de ejecutarla, ambas reales:
//   1. P04_PG_URL=postgres://user:pass@localhost/db node scripts/verify-pagos-conciliacion.mjs
//      (sólo localhost: el script CREA y DESTRUYE una base desechable)
//   2. cd .p04-pgtest && npm install    (una vez; luego arranca el server solo)

import { createRequire } from 'node:module'
import fs from 'node:fs'
// Nombre lógico → archivo real (provisional `_p1_d_…` o versionado tras aplicarse en producción).
import { resolverMigracion } from './lib/migraciones.mjs'

const AISLADO = new URL('../.p04-pgtest/', import.meta.url)
const MIGRACIONES = new URL('../supabase/migrations/', import.meta.url).pathname
const BD_PRUEBA = 'p1d_conciliacion'

function abortar(motivo) {
  console.error('FASE 18 · PAGOS Y CONCILIACIÓN: NO EJECUTADA\n')
  console.error(`  ${motivo}\n`)
  console.error('  Esta prueba comprueba que un pago no se concilia dos veces, que una')
  console.error('  referencia de proveedor no se acepta dos veces, y que la conciliación')
  console.error('  agrupa por business_date en America/Lima. Sin un PostgreSQL real no se')
  console.error('  puede ejercitar, y no ejecutarla NO es lo mismo que pasarla.\n')
  console.error('  Para ejecutarla de verdad, cualquiera de estas dos:')
  console.error('    P04_PG_URL=postgres://user:pass@localhost/db node scripts/verify-pagos-conciliacion.mjs')
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

// Este script CREA y DESTRUYE una base de datos. Un dedazo en P04_PG_URL con la
// cadena de una Supabase real no puede llegar a ejecutarse.
let URL_ADMIN = process.env.P04_PG_URL
let servidorLocal = null

if (URL_ADMIN) {
  let anfitrion
  try {
    anfitrion = new URL(URL_ADMIN.replace(/^postgres(ql)?:\/\//, 'http://')).hostname
  } catch {
    abortar(`P04_PG_URL no es una URL válida: ${URL_ADMIN}`)
  }
  if (!['localhost', '127.0.0.1', '::1', ''].includes(anfitrion)) {
    abortar(`P04_PG_URL apunta a "${anfitrion}", que no es local. Esta prueba crea y borra una base de datos entera: sólo contra un PostgreSQL local desechable.`)
  }
}

if (!URL_ADMIN) {
  let EmbeddedPostgres
  try {
    EmbeddedPostgres = (await import(new URL('node_modules/embedded-postgres/dist/index.js', AISLADO).href)).default
  } catch {
    abortar('Falta P04_PG_URL y el entorno local aislado (.p04-pgtest/) no está instalado.')
  }
  const puerto = 54336
  const dir = new URL('pgdata-p1d', AISLADO).pathname
  fs.rmSync(dir, { recursive: true, force: true })
  servidorLocal = new EmbeddedPostgres({ databaseDir: dir, user: 'p1d', password: 'p1d', port: puerto, persistent: false })
  await servidorLocal.initialise()
  await servidorLocal.start()
  await servidorLocal.createDatabase('p1d')
  URL_ADMIN = `postgresql://p1d:p1d@localhost:${puerto}/p1d`
}

const URL_PRUEBA = URL_ADMIN.replace(/\/[^/?]*(\?.*)?$/, `/${BD_PRUEBA}$1`)

// --- Extracción del SQL real de los ficheros de migración -------------------
// Soporta tanto `as $$ ... $$;` (migraciones viejas) como `as $function$ ... $function$;`.
function funcionDeMigracion(fichero, nombre) {
  const sql = fs.readFileSync(MIGRACIONES + resolverMigracion(fichero), 'utf8')
  const re = new RegExp(`create or replace function\\s+(?:public\\.|private\\.)?${nombre}\\s*\\(`, 'i')
  const inicio = sql.search(re)
  if (inicio === -1) throw new Error(`No se encontró ${nombre} en ${fichero}`)
  const resto = sql.slice(inicio)
  const etiqueta = /\bas\s+(\$[A-Za-z_]*\$)/i.exec(resto)
  if (!etiqueta) throw new Error(`No se encontró el cuerpo dollar-quoted de ${nombre} en ${fichero}`)
  const desde = etiqueta.index + etiqueta[0].length
  const fin = resto.indexOf(etiqueta[1], desde)
  if (fin === -1) throw new Error(`No se encontró el cierre de ${nombre} en ${fichero}`)
  return resto.slice(0, fin + etiqueta[1].length) + ';'
}

function ficheroDeMigracion(fichero) {
  return fs.readFileSync(MIGRACIONES + resolverMigracion(fichero), 'utf8')
}

// De 20260824151006 sólo interesa la parte de conciliación. El fichero termina
// reemplazando `aprobar_cierre_diario`, que arrastra cierres_diarios /
// autorizaciones_operativas / configuracion y no es objeto de esta prueba.
function baseFechaVenta() {
  const sql = ficheroDeMigracion('20260824151006_payment_reconciliation_uses_sale_date.sql')
  const corte = sql.indexOf('create or replace function public.aprobar_cierre_diario')
  if (corte === -1) throw new Error('20260824151006 cambió de forma: no se encontró aprobar_cierre_diario')
  return sql.slice(0, corte)
}

// --- Andamiaje mínimo: lo que las migraciones de conciliación dan por hecho --
// Las DDL de `sales`/`payments`/`staff` replican las columnas reales leídas de
// producción con information_schema. El trigger de business_date NO se replica:
// se carga la función REAL de P0.2, que es justo lo que la prueba de medianoche
// tiene que ejercitar.
const ANDAMIO = `
create extension if not exists pgcrypto;

do $do$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end $do$;

create schema if not exists private;
create schema if not exists auth;
grant usage on schema public to anon, authenticated;

create or replace function auth.uid() returns uuid language sql stable as $f$
  select nullif(current_setting('request.jwt.claims', true)::jsonb->>'sub','')::uuid
$f$;

create table public.locations(id uuid primary key, nombre text);
create table public.staff(
  id uuid primary key, user_id uuid, nombre text, rol text not null default 'cajero',
  location_id uuid references public.locations(id), activo boolean default true,
  puesto text, active_location_id uuid);
create table public.staff_locations(
  staff_id uuid references public.staff(id), location_id uuid references public.locations(id),
  primary key(staff_id, location_id));
create table public.cash_sessions(id uuid primary key, location_id uuid references public.locations(id));
create table public.sales(
  id uuid primary key default gen_random_uuid(),
  location_id uuid references public.locations(id),
  cash_session_id uuid references public.cash_sessions(id),
  fecha timestamptz default now(),
  total numeric not null default 0,
  estado varchar not null default 'completada',
  numero serial,
  business_date date,
  is_test boolean not null default false);
create table public.payments(
  id uuid primary key default gen_random_uuid(),
  sale_id uuid references public.sales(id),
  metodo varchar not null,
  monto numeric not null,
  referencia varchar);
create table public.pagos_digitales(
  id uuid primary key default gen_random_uuid(),
  culqi_order_id text, monto numeric not null, metodo text not null,
  estado text not null default 'pendiente',
  sale_id uuid references public.sales(id), location_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());

create or replace function private.auth_is_admin() returns boolean language sql stable security definer set search_path='public' as $f$
  select exists (select 1 from public.staff where user_id = auth.uid() and rol = 'administrador' and activo = true);
$f$;

create or replace function private.auth_location_id() returns uuid language sql stable security definer set search_path='public','private' as $f$
  select case
    when s.active_location_id is not null and exists(
      select 1 from public.staff_locations sl where sl.staff_id=s.id and sl.location_id=s.active_location_id
    ) then s.active_location_id
    else s.location_id
  end
  from public.staff s where s.user_id=auth.uid() and s.activo=true limit 1;
$f$;

-- Auditoría: en producción escribe en public.auditoria. Aquí sólo tiene que
-- existir y no estorbar; lo que se prueba no es la auditoría.
create or replace function private.registrar_auditoria() returns trigger language plpgsql as $f$
begin return coalesce(new, old); end $f$;
`

const LOC = '22222222-2222-2222-2222-222222222222'
const LOC_B = '22222222-2222-2222-2222-2222222222bb'
const ADMIN_STAFF = '11111111-1111-1111-1111-111111111111'
const ADMIN_USER = 'aaaaaaaa-1111-1111-1111-111111111111'
const CAJERO_STAFF = '11111111-1111-1111-1111-111111111122'
const CAJERO_USER = 'aaaaaaaa-1111-1111-1111-111111111122'

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

const fallos = []
const pasos = []
function comprobar(nombre, ok, detalle = '') {
  pasos.push({ nombre, ok })
  if (!ok) fallos.push(`${nombre}${detalle ? ` — ${detalle}` : ''}`)
}

// --- Ejecución con rol e identidad reales -----------------------------------
// Todo lo de negocio pasa por aquí: rol `authenticated` (no el dueño) y un
// request.jwt.claims con `sub` realista, igual que PostgREST.
async function como(cliente, userId, sql, params = [], rol = 'authenticated') {
  await cliente.query('begin')
  try {
    await cliente.query(`set local role ${rol}`)
    await cliente.query('select set_config($1,$2,true)', ['request.jwt.claims', JSON.stringify({ sub: userId, role: rol })])
    const r = await cliente.query(sql, params)
    await cliente.query('commit')
    return r
  } catch (e) {
    await cliente.query('rollback').catch(() => {})
    throw e
  }
}

async function esperarError(fn) {
  try {
    await fn()
    return null
  } catch (e) {
    return e
  }
}

// --- Arranque ---------------------------------------------------------------
const bootstrap = new pg.Client({ connectionString: URL_ADMIN })
await bootstrap.connect()
await bootstrap.query(`drop database if exists ${BD_PRUEBA} with (force)`)
await bootstrap.query(`create database ${BD_PRUEBA}`)
await bootstrap.end()

const db = new pg.Client({ connectionString: URL_PRUEBA })
await db.connect()

let salidaCodigo = 0
try {
  await db.query(ANDAMIO)

  // Trigger REAL de business_date (P0.2). La prueba de medianoche no vale nada
  // si la fecha comercial la calcula una reimplementación de este script.
  await db.query(funcionDeMigracion('20260906200849_business_date_and_registrar_venta_hardening.sql', 'private\\.calcular_business_date_lima'))
  await db.query(`
    create trigger trg_business_date_sales before insert or update of fecha on public.sales
      for each row execute function private.calcular_business_date_lima();
    alter table public.sales alter column business_date set not null;
  `)

  // DDL y funciones REALES ya aplicadas en producción.
  await db.query(ficheroDeMigracion('20260824145525_payment_reconciliation_and_provider_refunds.sql'))
  await db.query(baseFechaVenta())
  await db.query(funcionDeMigracion('20260824151437_auto_reconcile_confirmed_digital_payments.sql', 'auto_conciliar_pagos_digitales_admin'))

  const antes = await db.query(
    `select proname, count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
     where ns.nspname='public' and proname in ('conciliar_pago_admin','sincronizar_conciliaciones_pago_admin','resumen_conciliacion_pagos_admin','auto_conciliar_pagos_digitales_admin')
     group by 1 order by 1`)

  // ---- LA MIGRACIÓN BAJO PRUEBA, VERBATIM --------------------------------
  await db.query(ficheroDeMigracion('_p1_d_pagos_conciliacion.sql'))

  // T1 — firmas. Lección de P0.2: un CREATE OR REPLACE con distinta lista de
  // parámetros NO reemplaza, crea una SOBRECARGA y deja la vieja viva.
  const despues = await db.query(
    `select proname, count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
     where ns.nspname='public' and proname in ('conciliar_pago_admin','sincronizar_conciliaciones_pago_admin','resumen_conciliacion_pagos_admin','auto_conciliar_pagos_digitales_admin')
     group by 1 order by 1`)
  const sobrecargas = despues.rows.filter((r) => r.n !== 1)
  comprobar('T1 · sin sobrecargas: cada RPC de conciliación sigue teniendo UNA sola firma',
    sobrecargas.length === 0 && despues.rows.length === antes.rows.length,
    `antes=${JSON.stringify(antes.rows)} despues=${JSON.stringify(despues.rows)}`)

  // ---- Semilla ------------------------------------------------------------
  await db.query(`insert into public.locations(id,nombre) values ($1,'Central'),($2,'Anexo')`, [LOC, LOC_B])
  await db.query(`insert into public.staff(id,user_id,nombre,rol,location_id,activo) values
      ($1,$2,'Admin','administrador',$5,true),
      ($3,$4,'Cajero','cajero',$5,true)`, [ADMIN_STAFF, ADMIN_USER, CAJERO_STAFF, CAJERO_USER, LOC])
  await db.query(`insert into public.cash_sessions(id,location_id) values ('33333333-0000-0000-0000-000000000001',$1)`, [LOC])

  // Ventas. `fecha` en UTC; el trigger real deriva business_date en Lima.
  //   v1  2026-05-10 18:00Z -> Lima 13:00 del 10  -> tarjeta 200
  //   v2  2026-05-10 20:00Z -> Lima 15:00 del 10  -> MIXTA efectivo 50 + yape 150
  //   v3  2026-05-11 03:30Z -> Lima 22:30 del 10  <- MEDIANOCHE: día UTC = 11
  //   v4  2026-05-10 19:00Z -> is_test = true     -> yape 999
  //   v5  2026-05-10 21:00Z -> MIXTA DESCUADRADA  -> efectivo 10 + tarjeta 10 sobre total 100
  const ventas = {}
  for (const [clave, fecha, total, test] of [
    ['v1', '2026-05-10T18:00:00Z', 200, false],
    ['v2', '2026-05-10T20:00:00Z', 200, false],
    ['v3', '2026-05-11T03:30:00Z', 300, false],
    ['v4', '2026-05-10T19:00:00Z', 999, true],
    ['v5', '2026-05-10T21:00:00Z', 100, false],
  ]) {
    const { rows: [v] } = await db.query(
      `insert into public.sales(location_id,cash_session_id,fecha,total,is_test)
       values ($1,'33333333-0000-0000-0000-000000000001',$2::timestamptz,$3,$4)
       returning id, business_date, numero`, [LOC, fecha, total, test])
    ventas[clave] = v
  }
  const pagos = {}
  for (const [clave, venta, metodo, monto, ref] of [
    ['p1', 'v1', 'tarjeta', 200, 'VTA-001'],
    ['p2e', 'v2', 'efectivo', 50, null],
    ['p2y', 'v2', 'yape', 150, 'VTA-002'],
    ['p3', 'v3', 'tarjeta', 300, 'VTA-003'],
    ['p4', 'v4', 'yape', 999, 'QA-004'],
    ['p5e', 'v5', 'efectivo', 10, null],
    ['p5t', 'v5', 'tarjeta', 10, 'VTA-005'],
  ]) {
    const { rows: [p] } = await db.query(
      `insert into public.payments(sale_id,metodo,monto,referencia) values ($1,$2,$3,$4) returning id`,
      [ventas[venta].id, metodo, monto, ref])
    pagos[clave] = p.id
  }

  // T6a — el trigger REAL de P0.2 ya separa el día comercial del día UTC.
  comprobar('T6a · venta 03:30Z cae en el business_date de Lima (2026-05-10), no en el día UTC (2026-05-11)',
    ventas.v3.business_date.toISOString().slice(0, 10) === '2026-05-10',
    `business_date=${ventas.v3.business_date}`)

  // ---- Sincronización como authenticated ----------------------------------
  const sync = await como(db, ADMIN_USER,
    `select public.sincronizar_conciliaciones_pago_admin($1::timestamptz,$2::timestamptz) as n`,
    ['2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'])
  comprobar('T0 · sincronizar_conciliaciones_pago_admin ejecuta como `authenticated` (no 42501) y da de alta los pagos no efectivo',
    Number(sync.rows[0].n) === 5, `n=${sync.rows[0].n} (esperado 5: p1,p2y,p3,p4,p5t)`)

  const { rows: [c3] } = await db.query('select fecha_venta, venta_at, is_test, monto_venta, cash_session_id from public.conciliaciones_pago where payment_id=$1', [pagos.p3])
  comprobar('T6b · la conciliación de la venta de medianoche hereda fecha_venta = business_date de Lima',
    c3.fecha_venta.toISOString().slice(0, 10) === '2026-05-10', `fecha_venta=${c3.fecha_venta}`)
  comprobar('T6c · la conciliación conserva la HORA real de la venta y el turno de caja',
    c3.venta_at instanceof Date && c3.cash_session_id !== null, `venta_at=${c3.venta_at} caja=${c3.cash_session_id}`)

  // T6d — el trigger IGNORA una fecha_venta impuesta desde fuera (p.ej. un
  // cliente con el reloj en UTC). Se fuerza como dueño, que es el único que
  // puede escribir directo; lo que se prueba aquí es el trigger, no el permiso.
  await db.query(`update public.conciliaciones_pago set fecha_venta='2026-05-11' where payment_id=$1`, [pagos.p3])
  const { rows: [c3b] } = await db.query('select fecha_venta from public.conciliaciones_pago where payment_id=$1', [pagos.p3])
  comprobar('T6d · un UPDATE que intenta imponer otra fecha_venta es corregido por el trigger desde sales.business_date',
    c3b.fecha_venta.toISOString().slice(0, 10) === '2026-05-10', `fecha_venta quedó en ${c3b.fecha_venta}`)

  // ---- T2 · referencia de proveedor duplicada -----------------------------
  await como(db, ADMIN_USER,
    `select public.conciliar_pago_admin($1,'conciliado',200,'CULQI-REF-AAA','ok')`, [pagos.p1])
  const errRef = await esperarError(() => como(db, ADMIN_USER,
    `select public.conciliar_pago_admin($1,'conciliado',150,'CULQI-REF-AAA','misma ref')`, [pagos.p2y]))
  comprobar('T2a · la MISMA referencia de proveedor se rechaza la segunda vez',
    errRef !== null && /ya fue aceptada/i.test(errRef.message), `error=${errRef && errRef.message}`)

  // Y con otra caja/normalización: mayúsculas y espacios no son una referencia distinta.
  const errRef2 = await esperarError(() => como(db, ADMIN_USER,
    `select public.conciliar_pago_admin($1,'conciliado',150,'  culqi-ref-aaa  ','misma ref, otro formato')`, [pagos.p2y]))
  comprobar('T2b · la referencia duplicada no se cuela cambiando mayúsculas o espacios',
    errRef2 !== null && /ya fue aceptada/i.test(errRef2.message), `error=${errRef2 && errRef2.message}`)

  // Respaldo duro: el índice único parcial, saltándose la función.
  const errIdx = await esperarError(() => db.query(
    `update public.conciliaciones_pago set estado='conciliado', monto_confirmado=150, referencia_proveedor='CULQI-REF-AAA', proveedor='culqi' where payment_id=$1`,
    [pagos.p2y]))
  comprobar('T2c · el índice único parcial bloquea la referencia duplicada aunque se esquive la función',
    errIdx !== null && errIdx.code === '23505', `code=${errIdx && errIdx.code}`)

  // ---- T3 · doble conciliación del mismo pago -----------------------------
  const { rows: [antesDoble] } = await db.query('select estado, monto_confirmado, conciliado_at from public.conciliaciones_pago where payment_id=$1', [pagos.p1])
  const errDoble = await esperarError(() => como(db, ADMIN_USER,
    `select public.conciliar_pago_admin($1,'conciliado',180,'CULQI-REF-BBB','segundo intento distinto')`, [pagos.p1]))
  const { rows: [trasDoble] } = await db.query('select estado, monto_confirmado, referencia_proveedor, conciliado_at from public.conciliaciones_pago where payment_id=$1', [pagos.p1])
  comprobar('T3a · un segundo intento DISTINTO sobre un pago ya conciliado se rechaza',
    errDoble !== null && /ya fue conciliado/i.test(errDoble.message), `error=${errDoble && errDoble.message}`)
  comprobar('T3b · y no deja rastro: estado, monto y referencia quedan como estaban',
    trasDoble.estado === 'conciliado' && Number(trasDoble.monto_confirmado) === 200 && trasDoble.referencia_proveedor === 'CULQI-REF-AAA',
    JSON.stringify(trasDoble))

  const rep = await como(db, ADMIN_USER,
    `select (public.conciliar_pago_admin($1,'conciliado',200,'CULQI-REF-AAA','reintento idéntico')).conciliado_at as at`, [pagos.p1])
  comprobar('T3c · el reintento IDÉNTICO es idempotente: devuelve la fila sin reescribir conciliado_at',
    new Date(rep.rows[0].at).getTime() === new Date(antesDoble.conciliado_at).getTime(),
    `antes=${antesDoble.conciliado_at} despues=${rep.rows[0].at}`)

  // T3d — la versión ANTERIOR tiene que reproducir el bug. Si no, esta prueba
  // habría dejado de detectar la regresión.
  // Mismo importe y misma referencia: para la versión nueva es el reintento
  // idempotente de T3c y no toca nada. La vieja lo re-concilia y reescribe
  // conciliado_por/conciliado_at, que es exactamente el agujero.
  await db.query(funcionDeMigracion('20260824145525_payment_reconciliation_and_provider_refunds.sql', 'conciliar_pago_admin'))
  await como(db, ADMIN_USER, `select public.conciliar_pago_admin($1,'conciliado',200,'CULQI-REF-AAA','sobrescritura')`, [pagos.p1])
  const { rows: [conVieja] } = await db.query('select estado, monto_confirmado, observacion, conciliado_at from public.conciliaciones_pago where payment_id=$1', [pagos.p1])
  comprobar('T3d · la versión ANTERIOR sí re-conciliaba un pago ya conciliado (la prueba detecta la regresión)',
    conVieja.observacion === 'sobrescritura'
      && new Date(conVieja.conciliado_at).getTime() !== new Date(antesDoble.conciliado_at).getTime(),
    `observacion=${conVieja.observacion} conciliado_at=${conVieja.conciliado_at} (antes ${antesDoble.conciliado_at})`)

  // Restaurar la versión bajo prueba y dejar la fila exactamente como estaba.
  await db.query(funcionDeMigracion('_p1_d_pagos_conciliacion.sql', 'conciliar_pago_admin'))
  await db.query(
    `update public.conciliaciones_pago set estado='conciliado', monto_confirmado=200, observacion='ok', conciliado_at=$2 where payment_id=$1`,
    [pagos.p1, antesDoble.conciliado_at])

  // ---- T4 · concurrencia real ---------------------------------------------
  // Dos conexiones conciliando el MISMO pago a la vez. Se comprueba contra
  // pg_stat_activity, filtrando por el PID del segundo backend, que está
  // EFECTIVAMENTE bloqueado esperando el lock de fila. Sin bloqueo observado no
  // hubo carrera que probar y la prueba falla.
  const a = new pg.Client({ connectionString: URL_PRUEBA })
  const b = new pg.Client({ connectionString: URL_PRUEBA })
  const testigo = new pg.Client({ connectionString: URL_PRUEBA })
  await a.connect(); await b.connect(); await testigo.connect()
  let bloqueoObservado = false
  let errB = null
  try {
    const { rows: [{ pid }] } = await b.query('select pg_backend_pid() as pid')
    const claims = JSON.stringify({ sub: ADMIN_USER, role: 'authenticated' })

    await a.query('begin')
    await a.query('set local role authenticated')
    await a.query('select set_config($1,$2,true)', ['request.jwt.claims', claims])
    await a.query(`select public.conciliar_pago_admin($1,'conciliado',300,'CULQI-CARRERA','conexión A')`, [pagos.p3])
    // A no hace commit todavía: retiene el lock de la fila.

    await b.query('begin')
    await b.query('set local role authenticated')
    await b.query('select set_config($1,$2,true)', ['request.jwt.claims', claims])
    const enCurso = b.query(`select public.conciliar_pago_admin($1,'conciliado',250,'CULQI-CARRERA-B','conexión B')`, [pagos.p3])
      .catch((e) => { errB = e })

    for (let i = 0; i < 60 && !bloqueoObservado; i++) {
      await dormir(50)
      const { rows } = await testigo.query(
        "select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'", [pid])
      bloqueoObservado = rows.length > 0
    }

    await a.query('commit')
    await enCurso
    await b.query('rollback').catch(() => {})
  } finally {
    await a.end().catch(() => {}); await b.end().catch(() => {}); await testigo.end().catch(() => {})
  }
  const { rows: [carrera] } = await db.query('select estado, monto_confirmado, referencia_proveedor, observacion from public.conciliaciones_pago where payment_id=$1', [pagos.p3])
  comprobar('T4a · la segunda conexión se bloquea DE VERDAD esperando el lock de la fila', bloqueoObservado)
  comprobar('T4b · de dos conciliaciones concurrentes del mismo pago gana UNA sola',
    errB !== null && /ya fue conciliado/i.test(errB.message), `errorB=${errB && errB.message}`)
  comprobar('T4c · y la fila conserva exactamente la conciliación ganadora',
    carrera.estado === 'conciliado' && Number(carrera.monto_confirmado) === 300 && carrera.referencia_proveedor === 'CULQI-CARRERA',
    JSON.stringify(carrera))

  // ---- T5 · pago mixto -----------------------------------------------------
  // v2 = efectivo 50 + yape 150 sobre total 200. Sólo el tramo no efectivo se
  // concilia, por su propio importe; la suma de pagos cuadra con el total.
  await como(db, ADMIN_USER, `select public.conciliar_pago_admin($1,'conciliado',150,'CULQI-MIXTO','tramo digital')`, [pagos.p2y])
  const cuadre = await como(db, ADMIN_USER, `select public.cuadre_pagos_venta_admin($1::date) as j`, ['2026-05-10'])
  const filas = cuadre.rows[0].j
  const fv2 = filas.find((f) => f.sale_id === ventas.v2.id)
  const fv5 = filas.find((f) => f.sale_id === ventas.v5.id)
  comprobar('T5a · el pago mixto (efectivo 50 + yape 150) cuadra con el total de la venta (200)',
    fv2 && fv2.mixto === true && fv2.cuadra === true && Number(fv2.pagado) === 200, JSON.stringify(fv2))
  const { rows: [cMix] } = await db.query('select monto_esperado, monto_confirmado, monto_venta from public.conciliaciones_pago where payment_id=$1', [pagos.p2y])
  comprobar('T5b · la conciliación cubre sólo el tramo no efectivo (150) y conserva el total de la venta (200)',
    Number(cMix.monto_esperado) === 150 && Number(cMix.monto_confirmado) === 150 && Number(cMix.monto_venta) === 200,
    JSON.stringify(cMix))
  comprobar('T5c · un pago mixto que NO cuadra (10+10 sobre 100) se detecta, no se da por bueno',
    fv5 && fv5.cuadra === false && Number(fv5.diferencia) === -80, JSON.stringify(fv5))

  // ---- T8 · rechazo y diferencia ------------------------------------------
  // p5t: tarjeta 10. Se rechaza -> el proveedor no confirmó nada.
  await como(db, ADMIN_USER, `select public.conciliar_pago_admin($1,'rechazado',10,'CULQI-RECHAZO','el POS no reconoce la operación')`, [pagos.p5t])
  const { rows: [rech] } = await db.query('select estado, monto_esperado, monto_confirmado from public.conciliaciones_pago where payment_id=$1', [pagos.p5t])
  comprobar('T8a · un rechazo conserva el importe ESPERADO y no finge un confirmado',
    rech.estado === 'rechazado' && Number(rech.monto_esperado) === 10 && Number(rech.monto_confirmado) === 0,
    JSON.stringify(rech))

  // Diferencia: se pide 'conciliado' con un monto que no cuadra -> diferencia.
  const { rows: [vd] } = await db.query(
    `insert into public.sales(location_id,fecha,total) values ($1,'2026-05-10T22:00:00Z',400) returning id`, [LOC])
  const { rows: [pd] } = await db.query(
    `insert into public.payments(sale_id,metodo,monto,referencia) values ($1,'tarjeta',400,'VTA-006') returning id`, [vd.id])
  await como(db, ADMIN_USER, `select public.conciliar_pago_admin($1,'conciliado',380,'CULQI-DIF','el POS liquidó 380')`, [pd.id])
  const { rows: [dif] } = await db.query('select estado, monto_esperado, monto_confirmado from public.conciliaciones_pago where payment_id=$1', [pd.id])
  comprobar('T8b · un "conciliado" cuyo importe no cuadra se degrada a diferencia y conserva el esperado',
    dif.estado === 'diferencia' && Number(dif.monto_esperado) === 400 && Number(dif.monto_confirmado) === 380,
    JSON.stringify(dif))

  const errDifSinMonto = await esperarError(() => como(db, ADMIN_USER,
    `select public.conciliar_pago_admin($1,'diferencia',null,'X','sin monto')`, [pagos.p5t]))
  comprobar('T8c · no se puede registrar una diferencia sin decir cuánto confirmó el proveedor',
    errDifSinMonto !== null && /exige el monto/i.test(errDifSinMonto.message), `error=${errDifSinMonto && errDifSinMonto.message}`)

  // ---- T7 · is_test fuera de las cifras -----------------------------------
  const resumen = (await como(db, ADMIN_USER, `select public.resumen_conciliacion_pagos_admin($1::date) as j`, ['2026-05-10'])).rows[0].j
  const { rows: [qa] } = await db.query('select estado, is_test from public.conciliaciones_pago where payment_id=$1', [pagos.p4])
  comprobar('T7a · la conciliación de una venta is_test existe pero queda marcada como QA',
    qa && qa.is_test === true, JSON.stringify(qa))
  // Sin la exclusión, los 999 de la venta QA aparecerían en monto_pendiente.
  comprobar('T7b · las ventas is_test NO entran en las cifras del resumen',
    Number(resumen.monto_pendiente) === 0 && Number(resumen.pendientes) === 0,
    `pendientes=${resumen.pendientes} monto_pendiente=${resumen.monto_pendiente} (la venta QA aporta 999)`)
  comprobar('T7c · el resumen agrupa por business_date de Lima: la venta de las 03:30Z cuenta en el día 10',
    Number(resumen.conciliados) === 3 && Number(resumen.diferencias) === 1 && Number(resumen.rechazados) === 1,
    JSON.stringify(resumen))
  comprobar('T8d · el resumen contabiliza el rechazo por su importe esperado y la diferencia por su delta',
    Math.abs(Number(resumen.monto_rechazado) - 10) < 0.005 && Math.abs(Number(resumen.monto_diferencia) + 20) < 0.005,
    JSON.stringify(resumen))
  comprobar('T5d · el resumen reporta las ventas con pago mixto descuadrado',
    Number(resumen.ventas_descuadradas) === 1 && Math.abs(Number(resumen.monto_descuadre) - 80) < 0.005,
    JSON.stringify(resumen))

  const resumen11 = (await como(db, ADMIN_USER, `select public.resumen_conciliacion_pagos_admin($1::date) as j`, ['2026-05-11'])).rows[0].j
  comprobar('T6e · el día UTC (2026-05-11) NO se lleva la venta de las 03:30Z',
    Number(resumen11.conciliados) === 0 && Number(resumen11.pendientes) === 0, JSON.stringify(resumen11))

  // ---- T10 · adaptador de proveedor externo -------------------------------
  const { rows: [vx] } = await db.query(
    `insert into public.sales(location_id,fecha,total) values ($1,'2026-05-10T23:00:00Z',500) returning id`, [LOC])
  const { rows: [px] } = await db.query(
    `insert into public.payments(sale_id,metodo,monto,referencia) values ($1,'tarjeta',500,'VTA-007') returning id`, [vx.id])
  await como(db, ADMIN_USER, `select public.sincronizar_conciliaciones_pago_admin($1::timestamptz,$2::timestamptz)`, ['2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'])

  const ad1 = await como(db, ADMIN_USER,
    `select (public.registrar_confirmacion_proveedor_admin($1,'pos_externo','POS-9001',500,null)).conciliado_at as at`, [px.id])
  const ad2 = await como(db, ADMIN_USER,
    `select (public.registrar_confirmacion_proveedor_admin($1,'pos_externo','POS-9001',500,null)).conciliado_at as at`, [px.id])
  comprobar('T10a · el adaptador de proveedor externo es idempotente: reenviar el mismo evento no reaplica nada',
    new Date(ad1.rows[0].at).getTime() === new Date(ad2.rows[0].at).getTime(),
    `${ad1.rows[0].at} vs ${ad2.rows[0].at}`)

  const { rows: [vy] } = await db.query(
    `insert into public.sales(location_id,fecha,total) values ($1,'2026-05-10T23:30:00Z',500) returning id`, [LOC])
  const { rows: [py] } = await db.query(
    `insert into public.payments(sale_id,metodo,monto,referencia) values ($1,'tarjeta',500,'VTA-008') returning id`, [vy.id])
  await como(db, ADMIN_USER, `select public.sincronizar_conciliaciones_pago_admin($1::timestamptz,$2::timestamptz)`, ['2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'])
  const errAd = await esperarError(() => como(db, ADMIN_USER,
    `select public.registrar_confirmacion_proveedor_admin($1,'pos_externo','POS-9001',500,null)`, [py.id]))
  comprobar('T10b · la misma referencia del POS externo aplicada a OTRO pago se rechaza (doble cobro)',
    errAd !== null && /ya fue aceptada/i.test(errAd.message), `error=${errAd && errAd.message}`)

  const errAdSinRef = await esperarError(() => como(db, ADMIN_USER,
    `select public.registrar_confirmacion_proveedor_admin($1,'pos_externo','   ',500,null)`, [py.id]))
  comprobar('T10c · una "confirmación" de proveedor sin referencia se rechaza, no se da por buena',
    errAdSinRef !== null && /sin referencia no es una confirmación/i.test(errAdSinRef.message),
    `error=${errAdSinRef && errAdSinRef.message}`)

  // ---- T11 · auto-conciliación Culqi sin reutilizar referencias -----------
  const { rows: [vz] } = await db.query(
    `insert into public.sales(location_id,fecha,total) values ($1,'2026-05-12T18:00:00Z',120) returning id`, [LOC])
  const { rows: [vz2] } = await db.query(
    `insert into public.sales(location_id,fecha,total) values ($1,'2026-05-12T18:30:00Z',120) returning id`, [LOC])
  await db.query(`insert into public.payments(sale_id,metodo,monto,referencia) values ($1,'yape',120,'VTA-009'),($2,'yape',120,'VTA-010')`, [vz.id, vz2.id])
  // El mismo culqi_order_id colgando de dos ventas: eso es un doble cobro, no
  // dos pagos. El auto-conciliador sólo puede aplicarlo a una.
  await db.query(`insert into public.pagos_digitales(culqi_order_id,monto,metodo,estado,sale_id,location_id) values
      ('CULQI-ORD-1',120,'yape','pagado',$1,$3),('CULQI-ORD-1',120,'yape','pagado',$2,$3)`, [vz.id, vz2.id, LOC])
  const auto = await como(db, ADMIN_USER,
    `select public.auto_conciliar_pagos_digitales_admin($1::timestamptz,$2::timestamptz) as n`,
    ['2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'])
  comprobar('T11 · el auto-conciliador no aplica el mismo culqi_order_id a dos conciliaciones',
    Number(auto.rows[0].n) === 1, `conciliados=${auto.rows[0].n} (esperado 1)`)

  // ---- T9 · privilegios y RLS reales (lección de P0.4) --------------------
  const errCajero = await esperarError(() => como(db, CAJERO_USER,
    `select public.conciliar_pago_admin($1,'conciliado',200,'X',null)`, [pagos.p1]))
  comprobar('T9a · un cajero no puede conciliar',
    errCajero !== null && /Solo administradores/i.test(errCajero.message), `error=${errCajero && errCajero.message}`)

  const errAnon = await esperarError(() => como(db, ADMIN_USER,
    `select public.conciliar_pago_admin($1,'conciliado',200,'X',null)`, [pagos.p1], 'anon'))
  comprobar('T9b · el rol `anon` no tiene EXECUTE sobre conciliar_pago_admin (42501)',
    errAnon !== null && errAnon.code === '42501', `code=${errAnon && errAnon.code} msg=${errAnon && errAnon.message}`)

  const errWrite = await esperarError(() => como(db, ADMIN_USER,
    `update public.conciliaciones_pago set estado='conciliado' where payment_id=$1`, [pagos.p5e ?? pagos.p1]))
  comprobar('T9c · `authenticated` no puede escribir la tabla directamente: toda escritura pasa por las RPC',
    errWrite !== null && errWrite.code === '42501', `code=${errWrite && errWrite.code}`)

  const lectura = await como(db, ADMIN_USER, `select count(*)::int n from public.conciliaciones_pago`)
  comprobar('T9d · el admin SÍ puede leer sus conciliaciones bajo RLS (no es un 42501 encubierto)',
    Number(lectura.rows[0].n) > 0, `n=${lectura.rows[0].n}`)

  // RLS por sucursal: un admin de otra sucursal no ve estas filas.
  await db.query(`insert into public.staff(id,user_id,nombre,rol,location_id,activo) values ($1,$2,'Admin B','administrador',$3,true)`,
    ['11111111-1111-1111-1111-1111111111bb', 'aaaaaaaa-1111-1111-1111-1111111111bb', LOC_B])
  const otra = await como(db, 'aaaaaaaa-1111-1111-1111-1111111111bb', `select count(*)::int n from public.conciliaciones_pago`)
  comprobar('T9e · un admin de otra sucursal no ve las conciliaciones ajenas (RLS por location_id)',
    Number(otra.rows[0].n) === 0, `n=${otra.rows[0].n}`)

  // G6 — coherencia entre lo que la función ESCRIBE y lo que la policy DEJA LEER.
  // Admin con active_location_id en la sucursal B: la versión anterior escribía
  // filas de la sucursal A (staff.location_id) que después RLS le ocultaba.
  await db.query(`insert into public.staff_locations(staff_id,location_id) values ($1,$2),($1,$3)`, [ADMIN_STAFF, LOC, LOC_B])
  await db.query(`update public.staff set active_location_id=$2 where id=$1`, [ADMIN_STAFF, LOC_B])
  const visto = await como(db, ADMIN_USER, `select count(*)::int n from public.conciliaciones_pago`)
  const errOtraSuc = await esperarError(() => como(db, ADMIN_USER,
    `select public.conciliar_pago_admin($1,'conciliado',150,'REF-CRUZADA',null)`, [pagos.p2e ?? pagos.p1]))
  comprobar('T9f · con la sucursal activa cambiada, la función usa la MISMA fuente de sucursal que RLS',
    Number(visto.rows[0].n) === 0 && errOtraSuc !== null && /Pago no conciliable/i.test(errOtraSuc.message),
    `visibles=${visto.rows[0].n} error=${errOtraSuc && errOtraSuc.message}`)
  await db.query(`update public.staff set active_location_id=null where id=$1`, [ADMIN_STAFF])

  // T9g — FALLO CERRADO SIN SUCURSAL (hallazgo T1 del coordinador). Con `<>`, una
  // sucursal NULL daba NULL y el IF no saltaba: un admin sin sucursal conciliaba
  // pagos de cualquier sucursal. La guarda de sucursal va ANTES de las de estado,
  // así que el rechazo tiene que llegar aunque el pago ya estuviera conciliado.
  await db.query('alter table public.staff alter column location_id drop not null')
  await db.query(`insert into public.staff(id,user_id,nombre,rol,location_id,activo) values ($1,$2,'Admin sin sucursal','administrador',null,true)`,
    ['11111111-1111-1111-1111-1111111111dd', 'aaaaaaaa-1111-1111-1111-1111111111dd'])
  const antesSinSuc = (await db.query('select estado, referencia_proveedor from public.conciliaciones_pago where payment_id=$1', [pagos.p3])).rows[0]
  const errSinSuc = await esperarError(() => como(db, 'aaaaaaaa-1111-1111-1111-1111111111dd',
    `select public.conciliar_pago_admin($1,'conciliado',300,'REF-SIN-SUCURSAL',null)`, [pagos.p3]))
  const despuesSinSuc = (await db.query('select estado, referencia_proveedor from public.conciliaciones_pago where payment_id=$1', [pagos.p3])).rows[0]
  comprobar('T9g · un admin SIN sucursal no concilia pagos de ninguna sucursal (fallo cerrado)',
    errSinSuc !== null && /Pago no conciliable|sucursal/i.test(errSinSuc.message)
      && despuesSinSuc.estado === antesSinSuc.estado && despuesSinSuc.referencia_proveedor === antesSinSuc.referencia_proveedor,
    `error=${errSinSuc && errSinSuc.message} estado ${antesSinSuc && antesSinSuc.estado}→${despuesSinSuc && despuesSinSuc.estado}`)

  // T9h — CONFIRMACIÓN DE PROVEEDOR: misma referencia y mismo pago con OTRO
  // importe (hallazgo T2 del coordinador). La función devolvía la conciliación
  // existente como si fuera un reenvío del mismo evento: el importe distinto se
  // perdía en silencio mientras el llamador recibía éxito.
  const { rows: [confirmada] } = await db.query(
    `select payment_id, proveedor, referencia_proveedor,
            coalesce(monto_confirmado, monto_esperado)::numeric as m, estado
       from public.conciliaciones_pago
      where location_id = $1 and estado in ('conciliado','diferencia') and referencia_proveedor is not null
      order by conciliado_at nulls last limit 1`, [LOC])
  if (!confirmada) {
    // Fallo CERRADO: sin la fila de partida la prueba no ejercita nada, y eso no
    // es un PASS.
    comprobar('T9h · confirmación de proveedor con misma referencia y otro importe', false,
      'no hay ninguna conciliación con referencia en la semilla: la prueba no se pudo ejercitar')
  } else {
    const sqlConf = `select (public.registrar_confirmacion_proveedor_admin($1,$2,$3,$4,null)).id as id`
    const errIgual = await esperarError(() => como(db, ADMIN_USER, sqlConf,
      [confirmada.payment_id, confirmada.proveedor, confirmada.referencia_proveedor, Number(confirmada.m)]))
    const errDist = await esperarError(() => como(db, ADMIN_USER, sqlConf,
      [confirmada.payment_id, confirmada.proveedor, confirmada.referencia_proveedor, Number(confirmada.m) + 1]))
    const { rows: [tras] } = await db.query(
      `select coalesce(monto_confirmado, monto_esperado)::numeric as m, estado
         from public.conciliaciones_pago where payment_id=$1`, [confirmada.payment_id])
    comprobar('T9h · el reenvío IDÉNTICO de una confirmación de proveedor es idempotente',
      errIgual === null, `error=${errIgual && errIgual.message}`)
    comprobar('T9h · misma referencia y mismo pago con OTRO importe se RECHAZA, no se da por aplicada',
      errDist !== null && /contenido distinto/i.test(errDist.message)
        && Number(tras.m) === Number(confirmada.m) && tras.estado === confirmada.estado,
      `error=${errDist && errDist.message} importe ${confirmada.m}→${tras.m} estado ${confirmada.estado}→${tras.estado}`)
  }
} catch (e) {
  fallos.push(`EXCEPCIÓN NO ESPERADA: ${e.message}${e.where ? `\n        ${e.where}` : ''}`)
  salidaCodigo = 1
} finally {
  await db.end().catch(() => {})
  if (servidorLocal) {
    await servidorLocal.stop().catch(() => {})
  } else {
    const limpieza = new pg.Client({ connectionString: URL_ADMIN })
    await limpieza.connect().catch(() => {})
    await limpieza.query(`drop database if exists ${BD_PRUEBA} with (force)`).catch(() => {})
    await limpieza.end().catch(() => {})
  }
}

console.log('FASE 18 · PAGOS Y CONCILIACIÓN')
console.log('SQL real de supabase/migrations/_p1_d_pagos_conciliacion.sql, PostgreSQL real, rol `authenticated`\n')
for (const p of pasos) console.log(`  [${p.ok ? 'PASS' : 'FAIL'}] ${p.nombre}`)

if (fallos.length || salidaCodigo) {
  console.log('\nFallos:')
  for (const f of fallos) console.log(`  [FAIL] ${f}`)
  process.exit(1)
}
console.log(`\n${pasos.length}/${pasos.length} comprobaciones en verde. PASS`)
