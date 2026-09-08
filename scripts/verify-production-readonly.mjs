#!/usr/bin/env node
// Verificación de integridad de SOLO LECTURA contra un proyecto Supabase
// real (típicamente producción). A diferencia de
// scripts/verify-integrity-invariants.mjs, esta suite NO crea ventas, cajas,
// productos, seriales ni conteos: solo lee. Es segura de correr contra el
// negocio en vivo tantas veces como haga falta.
//
//   npm run test:production:readonly
//
// Requiere:
//   SUPABASE_URL          URL del proyecto (https://xxx.supabase.co)
//   SUPABASE_ANON_KEY     anon/publishable key
//   QA_STAFF_EMAIL        email de una cuenta con rol administrador
//   QA_STAFF_PASSWORD     password de esa cuenta
//
// La cuenta debe ser administrador: la introspección (grants, definición de
// RPC, RLS) vive en diagnostico_integridad_admin(), una RPC SECURITY DEFINER
// STABLE — un script con solo la anon key no puede consultar
// information_schema/pg_catalog directamente porque PostgREST solo expone el
// esquema `public`.
//
// Si faltan variables de entorno termina con código 0 y un SKIP, para que un
// `npm run` accidental sin credenciales no se reporte como regresión.

const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'QA_STAFF_EMAIL', 'QA_STAFF_PASSWORD']
const missing = required.filter((k) => !process.env[k])
if (missing.length) {
  console.log(`SKIP: faltan variables de entorno para la verificación de solo lectura (${missing.join(', ')}). Ver cabecera de este archivo.`)
  process.exit(0)
}

const URL_BASE = process.env.SUPABASE_URL
const ANON_KEY = process.env.SUPABASE_ANON_KEY

let failures = 0
function assert(condition, message) {
  if (!condition) { console.error(`FAIL: ${message}`); failures++ }
  else console.log(`PASS: ${message}`)
}
function info(message) { console.log(`INFO: ${message}`) }

async function api(path, { method = 'GET', body, jwt } = {}) {
  const headers = { apikey: ANON_KEY, 'Content-Type': 'application/json' }
  if (jwt) headers.Authorization = `Bearer ${jwt}`
  const res = await fetch(`${URL_BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { ok: res.ok, status: res.status, data }
}

async function login() {
  const { data } = await api('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email: process.env.QA_STAFF_EMAIL, password: process.env.QA_STAFF_PASSWORD },
  })
  if (!data?.access_token) throw new Error(`No se pudo autenticar: ${JSON.stringify(data)}`)
  return data.access_token
}

async function main() {
  const jwt = await login()
  console.log('Autenticado. Verificación de SOLO LECTURA (no se escribe nada)...\n')

  const diag = await api('/rest/v1/rpc/diagnostico_integridad_admin', { method: 'POST', jwt, body: {} })
  if (!diag.ok) {
    console.error(`FAIL: no se pudo obtener el diagnóstico (¿la cuenta es administrador?): ${JSON.stringify(diag.data)}`)
    process.exitCode = 1
    return
  }
  const d = diag.data

  // --- Superficie de RPC: el ciclo transaccional nuevo no debe poder evadirse
  assert(d.consumir_autorizacion_descuento_revocada,
    'consumir_autorizacion_descuento (consumía la autorización fuera de la venta) ya no es invocable')
  assert(d.registrar_uso_cupon_revocada,
    'registrar_uso_cupon (contabilizaba el cupón fuera de la venta) ya no es invocable')
  assert(d.consultar_autorizacion_descuento_otorgada,
    'consultar_autorizacion_descuento (solo lectura) está disponible para el POS')
  assert(d.registrar_venta_acepta_codigo_cupon,
    'registrar_venta valida y consume el cupón dentro de su propia transacción')
  assert(d.inventario_fisico_seriales_existe,
    'La reconciliación de conteo físico por IMEI/serie está desplegada')

  // --- Estado operativo: cosas que quedaron trabadas y nadie notó
  const conteos = d.conteos_fisicos_abiertos_hace_mas_de_2_dias || []
  assert(conteos.length === 0,
    `No hay conteos físicos abiertos hace más de 2 días (encontrados: ${conteos.length})`)
  if (conteos.length) info(`Conteos trabados: ${JSON.stringify(conteos)}`)

  const cajas = d.cash_sessions_abiertas_hace_mas_de_2_dias || []
  // Una caja abierta más de 2 días es sospechosa pero no siempre es un bug
  // (una sucursal puede dejarla abierta un feriado largo) — se reporta, no
  // se falla la suite por eso.
  if (cajas.length) info(`Cajas abiertas hace más de 2 días (revisar): ${JSON.stringify(cajas)}`)
  else console.log('PASS: No hay cajas abiertas hace más de 2 días')

  // --- Residuos de pruebas: no debería quedar NADA de QA activo en producción
  const qa = d.productos_qa_activos_en_produccion || []
  assert(qa.length === 0,
    `No hay productos de prueba QA-INTEGRITY activos en producción (encontrados: ${qa.length})`)
  if (qa.length) info(`Productos QA activos: ${JSON.stringify(qa)}`)

  console.log(failures ? `\n${failures} verificación(es) fallaron.` : '\nTodas las verificaciones de solo lectura pasaron.')
  process.exitCode = failures ? 1 : 0
}

main().catch((e) => { console.error('ERROR en la verificación de solo lectura:', e); process.exitCode = 1 })
