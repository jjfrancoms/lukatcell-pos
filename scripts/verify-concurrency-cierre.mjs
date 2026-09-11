#!/usr/bin/env node
// REGRESIÓN DE CONCURRENCIA — R6.
//
// El cierre de conteo físico, en su rama serializada, alineaba el stock al
// número de IMEI disponibles. Lo hacía en este orden:
//
//     select count(*) ... product_serials ... estado='disponible'   -- (1)
//     select cantidad ... inventory ... for update                  -- (2)
//     update inventory set cantidad = <lo contado en (1)>           -- (3)
//
// Bajo READ COMMITTED (el nivel por defecto) cada sentencia toma su propio
// snapshot. (1) lee sin bloquear nada; (2) se queda esperando el lock que tiene
// una venta en curso y, al concedérselo, ve la fila YA actualizada. El valor de
// (1) es de antes de la venta y el de (2) de después, así que (3) escribe un
// stock que resucita la unidad vendida y deja un movimiento +1 falso.
//
// QUÉ SE EJERCITA: el SQL REAL de las migraciones, no una reimplementación.
// Se carga `public.cerrar_inventario_fisico` tal cual está en el fichero de
// migración —la versión vieja desde 20260909015208 y la nueva desde la
// migración E— sobre un esquema mínimo. Si alguien reintroduce el orden
// inseguro en la migración, esta prueba se pone roja. Una versión anterior de
// este archivo reimplementaba las funciones a mano y por eso habría seguido en
// verde con el bug de vuelta.
//
// La concurrencia es real: la venta mantiene su transacción abierta reteniendo
// el lock, y se comprueba contra pg_stat_activity —filtrando por el PID del
// backend del cierre— que el cierre está EFECTIVAMENTE bloqueado esperando ese
// lock antes de soltar la venta. Si no se observa bloqueo, la prueba falla: sin
// bloqueo no hubo carrera que probar.
//
// FALLA CERRADO. Un comando llamado `test:concurrency` que imprime SKIP y sale
// con 0 es un falso éxito: quien lo ejecuta cree haber probado la concurrencia
// y no probó nada. Si no hay entorno, esto termina con código 1 y explica cómo
// conseguirlo. No hay variable de escape para saltárselo.
//
// Dos formas de ejecutarla, ambas reales:
//
//   1. Contra un PostgreSQL LOCAL que ya tengas. El script crea un esquema
//      `r6` desechable, trabaja sólo dentro de él y lo borra al terminar; no
//      toca ningún otro esquema de esa base.
//        P04_PG_URL=postgres://user:pass@localhost/db npm run test:concurrency
//      Se rechazan los destinos que no sean localhost: esto crea y destruye
//      objetos, y no tiene por qué apuntar nunca a una base compartida.
//
//   2. Con el entorno local aislado del repo (binarios oficiales de
//      PostgreSQL, sin Docker). Se instala una sola vez:
//        cd .p04-pgtest && npm install
//      y a partir de ahí `npm run test:concurrency` arranca el servidor solo.
//
// `.p04-pgtest/` está en .gitignore y tiene su propio package.json, así que no
// entra en el repo publicado ni en `npm ci`. Por eso CI no ejecuta esta prueba:
// allí la puerta son las assertions estáticas de scripts/verify-security.mjs,
// que exigen que cerrar_inventario_fisico delegue en
// private.sincronizar_stock_serializado y que esa función bloquee antes de contar.

import { createRequire } from 'node:module'
import fs from 'node:fs'

const AISLADO = new URL('../.p04-pgtest/', import.meta.url)
const MIGRACIONES = new URL('../supabase/migrations/', import.meta.url).pathname

function abortar(motivo) {
  console.error('REGRESIÓN DE CONCURRENCIA (R6): NO EJECUTADA\n')
  console.error(`  ${motivo}\n`)
  console.error('  Esta prueba comprueba que el cierre de conteo no resucita stock vendido')
  console.error('  cuando una venta ocurre a la vez. Sin un PostgreSQL real no se puede')
  console.error('  ejercitar, y no ejecutarla NO es lo mismo que pasarla.\n')
  console.error('  Para ejecutarla de verdad, cualquiera de estas dos:')
  console.error('    P04_PG_URL=postgres://user:pass@host/db npm run test:concurrency')
  console.error('    cd .p04-pgtest && npm install     (una vez; luego npm run test:concurrency)')
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

// Este script CREA y DESTRUYE objetos. No hay ningún motivo legítimo para
// apuntarlo a una base que no sea local, y sí un motivo muy claro para
// impedirlo: un dedazo en P04_PG_URL con la cadena de una Supabase real.
if (URL_PG) {
  let anfitrion
  try {
    anfitrion = new URL(URL_PG.replace(/^postgres(ql)?:\/\//, 'http://')).hostname
  } catch {
    abortar(`P04_PG_URL no es una URL válida: ${URL_PG}`)
  }
  if (!['localhost', '127.0.0.1', '::1', ''].includes(anfitrion)) {
    abortar(`P04_PG_URL apunta a "${anfitrion}", que no es local. Esta prueba crea y borra objetos: solo se ejecuta contra un PostgreSQL local desechable.`)
  }
}

if (!URL_PG) {
  let EmbeddedPostgres
  try {
    EmbeddedPostgres = (await import(new URL('node_modules/embedded-postgres/dist/index.js', AISLADO).href)).default
  } catch {
    abortar('Falta P04_PG_URL y el entorno local aislado (.p04-pgtest/) no está instalado.')
  }
  const puerto = 54332
  const dir = new URL('pgdata-cierre', AISLADO).pathname
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
  const sql = fs.readFileSync(MIGRACIONES + fichero, 'utf8')
  const inicio = sql.search(new RegExp(`create or replace function\\s+(public\\.)?${nombre}\\s*\\(`, 'i'))
  if (inicio === -1) throw new Error(`No se encontró ${nombre} en ${fichero}`)
  const resto = sql.slice(inicio)
  // Hasta el final del cuerpo `$function$;`, que es como los cierra el proyecto.
  const fin = resto.search(/\$function\$\s*;/)
  if (fin === -1) throw new Error(`No se encontró el fin del cuerpo de ${nombre} en ${fichero}`)
  return resto.slice(0, fin) + '$function$;'
}

const STAFF_UUID = '11111111-1111-1111-1111-111111111111'

// TODO vive dentro del esquema `r6` y NADA fuera de él se toca. Una versión
// anterior hacía `drop schema private cascade` y `drop schema auth cascade`
// sobre la base apuntada por P04_PG_URL: contra una Supabase eso habría
// borrado todos los usuarios. El único DROP que hace este script es el de su
// propio esquema desechable.
const ESQUEMA = `
drop schema if exists r6 cascade;
create schema r6;
set search_path to r6;

create table r6.staff (id uuid primary key, user_id uuid, activo boolean default true, rol text, puesto text, location_id uuid);
create table r6.products (id uuid primary key, nombre text, control_serial boolean not null default false, is_test boolean not null default false);
create table r6.product_variants (id uuid primary key, product_id uuid not null references r6.products(id));
create table r6.inventory (variant_id uuid not null, location_id uuid not null, cantidad int not null default 0, stock_minimo int not null default 0, updated_at timestamptz default now(), primary key (variant_id, location_id));
create table r6.inventory_movements (id bigserial primary key, variant_id uuid, location_id uuid, cantidad_delta int not null, motivo text not null, staff_id uuid, created_at timestamptz default now());
create table r6.product_serials (id uuid primary key default gen_random_uuid(), variant_id uuid, location_id uuid, serial_number text, estado text default 'disponible');
create table r6.inventarios_fisicos (id uuid primary key, location_id uuid, estado text, creado_por uuid, cerrado_por uuid, fecha_inicio timestamptz default now(), fecha_cierre timestamptz);
create table r6.inventario_fisico_items (inventario_id uuid, variant_id uuid, cantidad_sistema int, cantidad_contada int, counted_at timestamptz);
create table r6.inventario_fisico_seriales (id uuid primary key default gen_random_uuid(), inventario_id uuid, variant_id uuid, serial_id uuid, esperado boolean, encontrado boolean, estado_reconciliacion text, tipo_resolucion text);

create function r6.uid() returns uuid language sql stable as $$ select '${STAFF_UUID}'::uuid $$;
`

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

const LOC = '22222222-2222-2222-2222-222222222222'
const PROD = '33333333-3333-3333-3333-333333333333'
const VAR = '44444444-4444-4444-4444-444444444444'
const CONTEO = '55555555-5555-5555-5555-555555555555'

async function sembrar(c) {
  await c.query('set search_path to r6, public')
  await c.query('truncate r6.staff, r6.products, r6.product_variants, r6.inventory, r6.inventory_movements, r6.product_serials, r6.inventarios_fisicos, r6.inventario_fisico_items, r6.inventario_fisico_seriales cascade')
  await c.query('insert into r6.staff(id,user_id,rol,location_id) values ($1,$1,$2,$3)', [STAFF_UUID, 'administrador', LOC])
  await c.query('insert into r6.products(id,nombre,control_serial) values ($1,$2,true)', [PROD, 'iPhone 13'])
  await c.query('insert into r6.product_variants(id,product_id) values ($1,$2)', [VAR, PROD])
  await c.query('insert into r6.inventory(variant_id,location_id,cantidad) values ($1,$2,10)', [VAR, LOC])
  await c.query("insert into r6.product_serials(variant_id,location_id,serial_number,estado) select $1,$2,'IMEI-'||g,'disponible' from generate_series(1,10) g", [VAR, LOC])
  // Conteo abierto y ya reconciliado: todo cuadra al momento de contar.
  await c.query("insert into r6.inventarios_fisicos(id,location_id,estado,creado_por,fecha_inicio) values ($1,$2,'abierto',$3, now() - interval '10 minutes')", [CONTEO, LOC, STAFF_UUID])
  await c.query('insert into r6.inventario_fisico_items(inventario_id,variant_id,cantidad_sistema,cantidad_contada,counted_at) values ($1,$2,10,10, now())', [CONTEO, VAR])
  await c.query("insert into r6.inventario_fisico_seriales(inventario_id,variant_id,serial_id,esperado,encontrado,estado_reconciliacion) select $1,$2,id,true,true,'coincide' from r6.product_serials", [CONTEO, VAR])
}

async function carrera(c) {
  const venta = new pg.Client({ connectionString: URL_PG })
  const cierre = new pg.Client({ connectionString: URL_PG })
  await venta.connect()
  await cierre.connect()
  try {
    await venta.query('set search_path to r6, public')
    await cierre.query('set search_path to r6, public')
    const { rows: [{ pid }] } = await cierre.query('select pg_backend_pid() as pid')

    // La venta abre transacción, vende una unidad y NO hace commit: retiene el
    // lock de la fila de inventory.
    await venta.query('begin')
    await venta.query("update r6.product_serials set estado='vendido' where id = (select id from r6.product_serials where estado='disponible' order by serial_number limit 1)")
    await venta.query('update r6.inventory set cantidad = cantidad - 1 where variant_id=$1 and location_id=$2', [VAR, LOC])

    // El cierre arranca en paralelo y se bloqueará de verdad en el lock.
    await cierre.query('begin')
    // La función se instala en el esquema de prueba (r6), no en public.
    const enCurso = cierre.query('select r6.cerrar_inventario_fisico($1::uuid)', [CONTEO])

    // Se espera a observar el bloqueo REAL de ese backend concreto, no de
    // cualquier sesión de la instancia.
    let bloqueoObservado = false
    const testigo = new pg.Client({ connectionString: URL_PG })
    await testigo.connect()
    for (let intento = 0; intento < 40 && !bloqueoObservado; intento++) {
      await dormir(50)
      const { rows } = await testigo.query(
        "select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'", [pid])
      bloqueoObservado = rows.length > 0
    }
    await testigo.end()

    await venta.query('commit')
    await enCurso
    await cierre.query('commit')
    return { bloqueoObservado }
  } finally {
    await venta.end().catch(() => {})
    await cierre.end().catch(() => {})
  }
}

// El motivo distingue qué rama del cierre se ejecutó:
//   rama SERIALIZADA   -> 'Conteo físico: stock alineado a los IMEI/serie...'
//   rama no serializada -> 'Ajuste conteo físico'
// R6 sólo existe en la serializada, así que si la prueba estuviera ejercitando
// la otra estaría pasando por el motivo equivocado.
const MOTIVO_SERIALIZADA = 'Conteo físico: stock alineado'

async function medir(c) {
  const { rows: [inv] } = await c.query('select cantidad from r6.inventory where variant_id=$1', [VAR])
  const { rows: [ser] } = await c.query("select count(*)::int as n from r6.product_serials where estado='disponible'")
  const { rows: movs } = await c.query('select cantidad_delta, motivo from r6.inventory_movements order by id')
  return {
    inventory: inv.cantidad,
    seriales: ser.n,
    movimientos: movs.map((m) => m.cantidad_delta),
    motivos: movs.map((m) => m.motivo),
    ramaNoSerializada: movs.some((m) => m.motivo === 'Ajuste conteo físico'),
  }
}

const admin = new pg.Client({ connectionString: URL_PG })
await admin.connect()
await admin.query(ESQUEMA)

// La función de sincronización real (migración B) es prerrequisito de la nueva.
// Se reescribe el esquema `public.` a `r6.` para que opere sobre el esquema de
// prueba; el ORDEN de las sentencias, que es lo que se está probando, no se toca.
// Todo se redirige al esquema desechable: `public.`, `private.` y `auth.`.
// Además se neutraliza el `set search_path` del propio CREATE FUNCTION, que
// apuntaría a public/private y dejaría sin resolver cualquier referencia sin
// cualificar. El ORDEN de las sentencias —lo único que se está probando— no se
// toca en ninguna de las sustituciones.
const aEsquemaPrueba = (sql) => sql
  .replace(/\bpublic\./g, 'r6.')
  .replace(/\bprivate\./g, 'r6.')
  .replace(/\bauth\./g, 'r6.')
  .replace(/set search_path to '[^']*'(\s*,\s*'[^']*')*/gi, "set search_path to 'r6'")
await admin.query(aEsquemaPrueba(funcionDeMigracion('20260909043129_p04_b_ledger_delta_real.sql', 'private\\.sincronizar_stock_serializado')))

const VERSIONES = [
  ['orden viejo (count -> lock)', '20260909015208_conteo_serializado_cantidad_derivada_de_escaneos.sql'],
  ['orden nuevo (lock -> count)', '20260911023654_p04_g_cierre_conteo_lock_antes_de_contar.sql'],
]

const resultados = []
for (const [etiqueta, fichero] of VERSIONES) {
  // Se instala la definición REAL de esa migración y se corre la carrera.
  const def = funcionDeMigracion(fichero, 'cerrar_inventario_fisico')
  await admin.query(aEsquemaPrueba(def))
  await sembrar(admin)
  const { bloqueoObservado } = await carrera(admin)
  resultados.push({ etiqueta, fichero, bloqueoObservado, ...(await medir(admin)) })
}

await admin.query('drop schema if exists r6 cascade')
await admin.end()
if (servidorLocal) await servidorLocal.stop()

const [viejo, nuevo] = resultados

const fallos = []
// Cada carrera por separado tiene que haber bloqueado: acumular con OR dejaría
// pasar una carrera que nunca compitió.
for (const r of resultados) {
  if (!r.bloqueoObservado) fallos.push(`${r.etiqueta}: no se observó bloqueo de lock; esa carrera no ejerció concurrencia real`)
}
// Ninguna carrera puede haberse resuelto por la rama NO serializada: R6 no
// existe ahí, y pasar por esa rama sería pasar por el motivo equivocado.
for (const r of resultados) {
  if (r.ramaNoSerializada) fallos.push(`${r.etiqueta}: se ejecutó la rama NO serializada (motivos: ${JSON.stringify(r.motivos)}); la prueba no está ejercitando el código donde vive R6`)
}
// El orden viejo TIENE que reproducir el bug; si no, la prueba ya no lo detecta.
if (!(viejo.inventory === 10 && viejo.seriales === 9 && viejo.movimientos.includes(1))) {
  fallos.push(`el orden viejo no reprodujo R6 (inventory=${viejo.inventory}, seriales=${viejo.seriales}, movs=[${viejo.movimientos}]): la prueba dejó de detectar la regresión`)
}
// Y ese movimiento falso tiene que venir de la rama serializada.
if (!viejo.motivos.some((m) => m.startsWith(MOTIVO_SERIALIZADA))) {
  fallos.push(`el movimiento del orden viejo no proviene de la rama serializada (motivos: ${JSON.stringify(viejo.motivos)})`)
}
if (nuevo.inventory !== 9) fallos.push(`el orden nuevo dejó inventory=${nuevo.inventory}, se esperaba 9`)
if (nuevo.seriales !== nuevo.inventory) fallos.push(`el orden nuevo dejó inventory=${nuevo.inventory} con ${nuevo.seriales} seriales disponibles`)
if (nuevo.movimientos.some((d) => d > 0)) fallos.push(`el orden nuevo escribió un movimiento positivo falso: [${nuevo.movimientos}]`)

console.log('REGRESIÓN DE CONCURRENCIA (R6)')
console.log('SQL real de las migraciones, dos conexiones simultáneas\n')
for (const r of resultados) {
  console.log(`  ${r.etiqueta.padEnd(28)} inventory=${r.inventory} seriales=${r.seriales} movs=[${r.movimientos}] bloqueo=${r.bloqueoObservado ? 'sí' : 'NO'}`)
  console.log(`  ${''.padEnd(28)} ${r.fichero}`)
}

if (fallos.length) {
  console.log('\nFallos:')
  for (const f of fallos) console.log(`  [FAIL] ${f}`)
  process.exit(1)
}
console.log('\nR6: el orden viejo reproduce el bug y el nuevo lo corrige. PASS')
