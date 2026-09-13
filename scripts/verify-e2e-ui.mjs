#!/usr/bin/env node
// E2E DE NAVEGADOR — backend Supabase SIMULADO (red interceptada).
//
// Prueba la lógica de la UI (Caja, Transferencias) contra el bundle REAL de la app,
// con Supabase simulado por intercepción de red. NO prueba la integración con Supabase:
// eso lo cubren las suites de PostgreSQL real.
//
// Seguridad (el .env del repo apunta a PRODUCCIÓN):
//   1. Build aislado (.p1-e2e/vite.e2e.config.mjs) con envDir vacío: .env no se lee.
//      Se eliminan del entorno todas las VITE_* y se fuerzan URL y clave FALSAS.
//   2. Se escanea el bundle: si contiene el ref de producción o un JWT, exit 1.
//   3. Toda petición del navegador pasa por context.route: sólo se permiten el preview
//      local y el origen falso (respondido aquí). El resto se aborta y cuenta como FUGA.
//      Una sola fuga hace fallar la ejecución.
//   4. Defensa en profundidad: Chrome arranca con --host-resolver-rules que no resuelve
//      ningún nombre DNS, y con service workers bloqueados.
//
// Uso: node scripts/verify-e2e-ui.mjs [--verbose]
// Requisito: cd .p1-e2e && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci

import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const E2E = path.join(REPO, '.p1-e2e')
// --dist <dir>: usa un bundle ya generado (p. ej. un mutante para demostrar que las pruebas fallan).
// Omite el build pero NO el escaneo de seguridad.
const iDist = process.argv.indexOf('--dist')
const DIST = iDist > 0 && process.argv[iDist + 1] ? path.resolve(process.argv[iDist + 1]) : path.join(E2E, 'dist')
const FAKE_URL = 'http://supabase.e2e.invalid'
const FAKE_ORIGIN = new URL(FAKE_URL).origin
const FAKE_KEY = 'e2e-anon-key-FALSA-no-es-un-jwt'
const PROD_REF = 'fbwkclpgnsxuqycazumj'
const STORAGE_KEY = `sb-${new URL(FAKE_URL).hostname.split('.')[0]}-auth-token`
const VERBOSE = process.argv.includes('--verbose') || process.env.E2E_VERBOSE === '1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const abortar = (msg) => { console.error(`E2E ABORTADO (fallo cerrado): ${msg}`); process.exit(1) }
const log = (...a) => { if (VERBOSE) console.log(...a) }

// ---------------------------------------------------------------------------
// 1. Dependencia
// ---------------------------------------------------------------------------
let chromium
try {
  ;({ chromium } = createRequire(path.join(E2E, 'package.json'))('playwright-core'))
} catch {
  abortar('falta playwright-core en .p1-e2e/ (cd .p1-e2e && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci)')
}

// ---------------------------------------------------------------------------
// 2. Build aislado con variables falsas
// ---------------------------------------------------------------------------
if (iDist < 0) {
  const viteBin = path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!fs.existsSync(viteBin)) abortar('no está vite en node_modules del repo (npm ci en la raíz)')
  fs.mkdirSync(path.join(E2E, 'env-vacio'), { recursive: true })
  if (fs.readdirSync(path.join(E2E, 'env-vacio')).length) abortar('.p1-e2e/env-vacio/ debe estar vacío')
  const envBuild = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITE_')))
  envBuild.VITE_SUPABASE_URL = FAKE_URL
  envBuild.VITE_SUPABASE_ANON_KEY = FAKE_KEY
  const build = spawnSync(process.execPath, [viteBin, 'build', '--config', path.join(E2E, 'vite.e2e.config.mjs')], { cwd: REPO, env: envBuild, encoding: 'utf8' })
  if (build.status !== 0) {
    console.error(`${build.stdout || ''}${build.stderr || ''}`.split('\n').slice(-25).join('\n'))
    abortar('falló el build aislado')
  }
}

// ---------------------------------------------------------------------------
// 3. Escaneo del bundle
// ---------------------------------------------------------------------------
const listar = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? listar(path.join(dir, d.name)) : [path.join(dir, d.name)])
if (!fs.existsSync(path.join(DIST, 'index.html'))) abortar('el build no generó .p1-e2e/dist/index.html')
let contieneOrigenFalso = false
const archivosBundle = listar(DIST)
for (const f of archivosBundle) {
  const s = fs.readFileSync(f).toString('latin1')
  if (s.includes(PROD_REF)) abortar(`el bundle contiene el host de PRODUCCIÓN en ${path.relative(REPO, f)}`)
  if (s.includes('eyJhbGciOi')) abortar(`el bundle contiene un JWT (posible clave real) en ${path.relative(REPO, f)}`)
  if (s.includes('supabase.e2e.invalid')) contieneOrigenFalso = true
}
if (!contieneOrigenFalso) abortar('el bundle no contiene el origen falso: las variables forzadas no se aplicaron')

// ---------------------------------------------------------------------------
// 4. Servidor local del bundle (SPA)
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' }
const servidor = http.createServer((req, res) => {
  let archivo
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    archivo = path.join(DIST, path.normalize(p))
    if (!archivo.startsWith(DIST) || !fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) archivo = path.join(DIST, 'index.html')
  } catch { archivo = path.join(DIST, 'index.html') }
  res.writeHead(200, { 'content-type': MIME[path.extname(archivo)] || 'application/octet-stream', 'cache-control': 'no-store' })
  fs.createReadStream(archivo).pipe(res)
})
await new Promise((r) => servidor.listen(0, '127.0.0.1', r))
const PREVIEW = `http://127.0.0.1:${servidor.address().port}`

// ---------------------------------------------------------------------------
// 5. Navegador del sistema (sin descargas)
// ---------------------------------------------------------------------------
const ARGS = [
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  '--disable-background-networking', '--disable-component-update', '--disable-sync',
  '--disable-domain-reliability', '--no-pings', '--no-first-run', '--safebrowsing-disable-auto-update',
]
async function lanzarNavegador() {
  const errores = []
  try { return { browser: await chromium.launch({ channel: 'chrome', headless: true, args: ARGS }), nombre: 'Google Chrome del sistema' } } catch (e) { errores.push(`chrome: ${String(e.message).split('\n')[0]}`) }
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
  const candidatos = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse().flatMap((d) => [
    path.join(cache, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    path.join(cache, d, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    path.join(cache, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  ]).filter((p) => fs.existsSync(p)) : []
  for (const executablePath of candidatos) {
    try { return { browser: await chromium.launch({ executablePath, headless: true, args: ARGS }), nombre: `Chromium en caché (${path.relative(cache, executablePath).split(path.sep)[0]})` } } catch (e) { errores.push(`${executablePath}: ${String(e.message).split('\n')[0]}`) }
  }
  servidor.close()
  abortar(`no hay navegador utilizable (no se descargan navegadores). ${errores.join(' | ') || 'sin candidatos'}`)
}
const { browser, nombre: nombreNavegador } = await lanzarNavegador()

// ---------------------------------------------------------------------------
// 6. Datos simulados
// ---------------------------------------------------------------------------
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const USER_ID = id(1), STAFF_ID = id(2), LOC_A = id(10), LOC_B = id(11), SESION_ID = id(20)
const TR_ID = id(30), ITEM_ID = id(31), VAR_ID = id(40), AUTH_ID = id(50)
const ahora = new Date()
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 365 * 24 * 3600
const USER = { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'e2e@lukatcell.invalid', app_metadata: { provider: 'email' }, user_metadata: {}, factors: [], created_at: ahora.toISOString() }
const SESSION = {
  access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: USER_ID, aud: 'authenticated', role: 'authenticated', exp, aal: 'aal1', amr: [] })}.${Buffer.from('firma-falsa-e2e').toString('base64url')}`,
  token_type: 'bearer', expires_in: 365 * 24 * 3600, expires_at: exp, refresh_token: 'e2e-refresh-falso', user: USER,
}
const STAFF = { id: STAFF_ID, user_id: USER_ID, nombre: 'Encargada E2E', rol: 'cajero', puesto: 'encargado', location_id: LOC_B, active_location_id: null, activo: true, username: 'e2e' }
const JORNADA = { asistencia_id: id(3), fecha: ahora.toISOString().slice(0, 10), entrada: ahora.toISOString(), salida: null, estado: 'puntual', minutos_tarde: 0, turno_id: null, turno_nombre: null, hora_inicio: null, hora_fin: null, tolerancia_minutos: null }
const SESION = { id: SESION_ID, cajero_id: STAFF_ID, location_id: LOC_B, apertura: ahora.toISOString(), cierre: null, monto_inicial: 100, monto_final_esperado: null, monto_final_contado: null, diferencia: null }
const CONFIG = { id: 1, igv_activo: true, igv_porcentaje: 18, negocio_nombre: 'LUKATCELL E2E', negocio_ruc: null, negocio_direccion: null, stock_minimo_default: 5, permitir_stock_negativo: false, auto_imprimir_ticket: false, tamano_papel: '80mm', nubefact_activo: false, nubefact_serie_boleta: 'BBB1', nubefact_serie_factura: 'FFF1', culqi_activo: false, updated_at: ahora.toISOString() }
const LOCS = [{ id: LOC_A, nombre: 'Tienda Centro' }, { id: LOC_B, nombre: 'Tienda Norte' }]
const TRANSFERENCIA = { id: TR_ID, numero: 42, origen_id: LOC_A, destino_id: LOC_B, estado: 'en_transito', fecha_creacion: ahora.toISOString(), tiene_diferencias: false, origen: { nombre: 'Tienda Centro' }, destino: { nombre: 'Tienda Norte' } }
const VARIANTE = { id: VAR_ID, color: 'Negro', product: { nombre: 'Cargador USB-C E2E', control_serial: false } }
const DETALLE = { id: TR_ID, numero: 42, estado: 'en_transito', tiene_diferencias: false, origen_id: LOC_A, destino_id: LOC_B, lineas: [{ item_id: ITEM_ID, variant_id: VAR_ID, cantidad_enviada: 5, cantidad_recibida: 0, cantidad_danada: 0, cantidad_faltante: 0, cantidad_sobrante: 0, pendiente: 5, estado_linea: 'pendiente', seriales: [] }] }

// ---------------------------------------------------------------------------
// 7. Backend simulado
// ---------------------------------------------------------------------------
const fugas = []
const trafico = new Map()
const erroresPagina = []
const noSimulados = new Set()

class Backend {
  constructor({ umbral = 200, autorizacion = null } = {}) {
    this.umbral = umbral
    this.autorizacion = autorizacion
    this.movimientos = []
    this.planes = new Map()
    this.eventos = [] // {n, clase: 'rpc'|'lectura'|'escritura', nombre, cuerpo}
    this.retenidas = []
    this.seq = 0
  }
  plan(nombre, ...pasos) { this.planes.set(nombre, pasos) }
  rpcs(nombre) { return this.eventos.filter((e) => e.clase === 'rpc' && e.nombre === nombre) }
  lecturas(tabla, desde = 0) { return this.eventos.filter((e) => e.clase === 'lectura' && e.nombre === tabla && e.n > desde) }
  soltar() { for (const r of this.retenidas.splice(0)) r() }
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS', 'access-control-expose-headers': 'content-range, x-supabase-api-version' }
const responder = (route, status, cuerpo, extra = {}) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json', ...extra }, body: cuerpo === undefined ? '' : JSON.stringify(cuerpo) })

const RPC_DEFECTO = {
  mi_estado_jornada: () => [JORNADA],
  mis_sucursales: () => [],
  registrar_heartbeat_pos: () => null,
  variantes_actualizadas_desde: () => [],
  solicitar_autorizacion: () => ({ id: AUTH_ID }),
  transferencia_detalle: () => DETALLE,
  // Idempotente como el real: devuelve la venta con el mismo client_transaction_id.
  registrar_venta: (c) => ({ id: id(900), numero: 1, estado: 'completada', client_transaction_id: c?.p_client_transaction_id ?? null, total: c?.p_total ?? 0 }),
  recibir_transferencia_parcial: () => DETALLE,
  registrar_movimiento_caja: (c, be) => {
    const firmado = ['retiro', 'gasto', 'deposito_banco'].includes(c?.p_tipo) ? -Math.abs(c.p_monto) : Math.abs(c?.p_monto ?? 0)
    const mov = { id: id(1000 + be.seq), cash_session_id: c?.p_cash_session_id, tipo: c?.p_tipo, monto: firmado, motivo: c?.p_motivo, created_at: new Date().toISOString() }
    be.movimientos.unshift(mov)
    return mov
  },
}

function filasTabla(tabla, u, be) {
  switch (tabla) {
    case 'staff': return [STAFF]
    case 'cash_sessions': return u.searchParams.get('cierre') === 'is.null' ? [SESION] : []
    case 'cash_movements': return be.movimientos
    case 'autorizaciones_operativas': return be.autorizacion ? [be.autorizacion] : []
    case 'configuracion': return [{ ...CONFIG, caja_egreso_max_sin_autorizacion: be.umbral }]
    case 'transferencias_stock': return [TRANSFERENCIA]
    case 'locations': return LOCS
    case 'product_variants': return [VARIANTE]
    default: return null
  }
}

async function atenderSupabase(route, req, be) {
  const u = new URL(req.url())
  const metodo = req.method()
  const p = u.pathname
  if (metodo === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-headers': req.headers()['access-control-request-headers'] || '*' } })

  if (p.startsWith('/auth/v1/')) {
    if (p === '/auth/v1/user') return responder(route, 200, USER)
    if (p === '/auth/v1/logout') return route.fulfill({ status: 204, headers: CORS })
    if (p === '/auth/v1/token') return responder(route, 200, SESSION)
    noSimulados.add(`${metodo} ${p}`)
    return responder(route, 200, {})
  }

  if (p.startsWith('/rest/v1/rpc/')) {
    const nombre = p.slice('/rest/v1/rpc/'.length)
    let cuerpo = null
    try { cuerpo = req.postDataJSON() } catch { cuerpo = null }
    be.eventos.push({ n: ++be.seq, clase: 'rpc', nombre, cuerpo })
    const plan = be.planes.get(nombre)
    let paso = plan && plan.length ? plan.shift() : null
    if (paso?.retener) { await new Promise((r) => be.retenidas.push(r)); paso = paso.luego ?? null }
    if (paso?.abortar) return route.abort('failed')
    if (paso?.error) return responder(route, paso.status ?? 400, { code: 'P0001', details: null, hint: null, ...paso.error })
    if (!(nombre in RPC_DEFECTO)) { noSimulados.add(`RPC ${nombre}`); return responder(route, 200, null) }
    return responder(route, 200, RPC_DEFECTO[nombre](cuerpo, be))
  }

  if (p.startsWith('/rest/v1/')) {
    const tabla = p.slice('/rest/v1/'.length)
    if (metodo !== 'GET' && metodo !== 'HEAD') {
      be.eventos.push({ n: ++be.seq, clase: 'escritura', nombre: tabla, cuerpo: req.postData() })
      noSimulados.add(`${metodo} /rest/v1/${tabla}`)
      return responder(route, 201, [])
    }
    be.eventos.push({ n: ++be.seq, clase: 'lectura', nombre: tabla })
    let filas = filasTabla(tabla, u, be)
    if (filas === null) { noSimulados.add(`GET /rest/v1/${tabla}`); filas = [] }
    if ((req.headers().accept || '').includes('vnd.pgrst.object')) {
      return filas.length ? responder(route, 200, filas[0]) : responder(route, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: null, hint: null })
    }
    return responder(route, 200, filas, { 'content-range': `0-${Math.max(filas.length - 1, 0)}/*` })
  }

  noSimulados.add(`${metodo} ${p}`)
  return responder(route, 404, { message: 'no simulado' })
}

function contarTrafico(url) {
  let o
  try { const x = new URL(url); if (['data:', 'blob:', 'about:'].includes(x.protocol)) return; o = x.origin } catch { o = url }
  trafico.set(o, (trafico.get(o) || 0) + 1)
}

async function conPagina(escenario, ruta, listo, fn) {
  const be = new Backend(escenario)
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1366, height: 900 }, locale: 'es-PE' })
  context.setDefaultTimeout(8000)
  context.on('request', (r) => contarTrafico(r.url()))
  await context.route('**/*', async (route) => {
    const req = route.request()
    let origen
    try { origen = new URL(req.url()).origin } catch { origen = req.url() }
    try {
      if (origen === PREVIEW) return await route.continue()
      if (origen === FAKE_ORIGIN) return await atenderSupabase(route, req, be)
      fugas.push(`${req.method()} ${req.url()}`)
      await route.abort('blockedbyclient')
    } catch { /* contexto cerrado durante una respuesta retenida */ }
  })
  await context.addInitScript(({ key, session }) => {
    try {
      if (location.hostname === '127.0.0.1') {
        localStorage.setItem(key, JSON.stringify(session))
        localStorage.setItem('lukatcell_sidebar_collapsed', '0')
      }
    } catch { /* sin storage */ }
  }, { key: STORAGE_KEY, session: SESSION })
  const page = await context.newPage()
  page.on('websocket', (ws) => fugas.push(`WS ${ws.url()}`))
  page.on('pageerror', (e) => erroresPagina.push(String(e.message).split('\n')[0]))
  try {
    await page.goto(PREVIEW + ruta)
    await listo(page)
    await fn(page, be)
  } finally {
    be.soltar()
    await context.close()
  }
  return be
}

// ---------------------------------------------------------------------------
// 8. Utilidades de prueba
// ---------------------------------------------------------------------------
const pausa = (ms) => new Promise((r) => setTimeout(r, ms))
const afirmar = (c, msg) => { if (!c) throw new Error(msg) }
async function esperar(cond, ms, que) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await cond()) return; await pausa(40) }
  throw new Error(`timeout esperando ${que}`)
}
const toasts = (page) => page.getByRole('status').allTextContents().then((xs) => xs.map((x) => x.trim()))
const esperarToast = (page, pred, que) => esperar(async () => (await toasts(page)).some(pred), 4000, `aviso: ${que}`)
const botonLibre = (loc, texto) => esperar(async () => (await loc.textContent())?.trim() === texto && await loc.isEnabled(), 5000, `botón "${texto}" habilitado`)

// Canario: demuestra EN CADA EJECUCIÓN que el detector de fugas funciona. Dos peticiones deliberadas a
// orígenes no permitidos deben quedar registradas como fuga Y rechazadas en el navegador. Si no, la
// cuenta "Fugas de red: 0" no demostraría nada → fallo cerrado. Luego se retiran sólo esas entradas.
const CANARIOS = ['https://example.com/canario-e2e', 'http://canario.e2e-fuga.invalid/canario-e2e']
const canario = { detectadas: 0, bloqueadas: 0 }
await conPagina({}, '/login', (page) => page.waitForLoadState('domcontentloaded'), async (page) => {
  for (const url of CANARIOS) {
    const r = await page.evaluate(async (u) => { try { await fetch(u, { mode: 'no-cors', cache: 'no-store' }); return 'respondió' } catch { return 'bloqueada' } }, url)
    if (r === 'bloqueada') canario.bloqueadas++
  }
})
for (let i = fugas.length - 1; i >= 0; i--) if (CANARIOS.some((c) => fugas[i].includes(c))) { fugas.splice(i, 1); canario.detectadas++ }
for (const u of CANARIOS) trafico.delete(new URL(u).origin)
if (canario.detectadas !== CANARIOS.length || canario.bloqueadas !== CANARIOS.length) {
  await browser.close(); servidor.close()
  abortar(`el canario de fugas no se comportó como debe (detectadas ${canario.detectadas}/${CANARIOS.length}, bloqueadas ${canario.bloqueadas}/${CANARIOS.length}): la intercepción no es fiable`)
}

const resultados = { Caja: [], Transferencias: [], Offline: [] }
const hallazgos = []
async function prueba(suite, nombre, fn) {
  try { await fn(); resultados[suite].push({ nombre, ok: true }); log(`  ok   ${suite} · ${nombre}`) } catch (e) {
    resultados[suite].push({ nombre, ok: false, motivo: String(e.message).split('\n')[0] })
    log(`  FAIL ${suite} · ${nombre}: ${String(e.message).split('\n')[0]}`)
  }
}

// ---------------------------------------------------------------------------
// 9. CAJA
// ---------------------------------------------------------------------------
const RPC_MOV = 'registrar_movimiento_caja'
const caja = (page) => ({
  monto: page.getByPlaceholder('Monto (S/)'),
  motivo: page.getByPlaceholder('Motivo (obligatorio)'),
  registrar: page.locator('button').filter({ hasText: /^(Registrar|Registrando\.\.\.)$/ }),
  tipo: (n) => page.getByRole('button', { name: n, exact: true }),
})
const listoCaja = (page) => page.getByPlaceholder('Monto (S/)').waitFor()

await prueba('Caja', '1 · fallo de red y reintento con el mismo contenido → misma clave', () => conPagina({}, '/caja', listoCaja, async (page, be) => {
  be.plan(RPC_MOV, { abortar: true })
  const c = caja(page)
  await c.monto.fill('50'); await c.motivo.fill('Sencillo para cambio')
  await c.registrar.click()
  await esperar(() => be.rpcs(RPC_MOV).length === 1, 5000, '1ª llamada')
  // La ventana se ancla al número de la PROPIA llamada fallida, no a un
  // contador tomado tras el toast: la recarga sale en paralelo con el toast, y
  // medir después podía dejar fuera la lectura real y dar un falso hallazgo.
  const nFallo = be.rpcs(RPC_MOV)[0].n
  await botonLibre(c.registrar, 'Registrar')
  await esperarToast(page, (t) => /fetch/i.test(t), 'error de red visible')
  await pausa(400)
  if (be.lecturas('cash_movements', nFallo).length === 0 && !hallazgos.some((h) => h.id === 'CAJA-RECARGA')) {
    hallazgos.push({ id: 'CAJA-RECARGA', texto: 'Caja.tsx:207-212 — tras un error, registrarMovimiento sólo recarga la autorización (cargarAutorizacion), NO los movimientos. CURRENT_EXECUTION.md afirma "al fallar se recargan los movimientos para que un registro que sí entró quede visible". Evidencia: 0 lecturas GET /rest/v1/cash_movements tras la respuesta fallida.' })
  }
  await c.registrar.click()
  await esperar(() => be.rpcs(RPC_MOV).length === 2, 5000, '2ª llamada')
  const [a, b] = be.rpcs(RPC_MOV).map((x) => x.cuerpo)
  afirmar(UUID.test(a.p_client_transaction_id || ''), `la clave no es un UUID: ${a.p_client_transaction_id}`)
  afirmar(a.p_client_transaction_id === b.p_client_transaction_id, `clave distinta en el reintento: ${a.p_client_transaction_id} vs ${b.p_client_transaction_id}`)
  afirmar(a.p_monto === 50 && b.p_monto === 50 && a.p_tipo === b.p_tipo && a.p_motivo === b.p_motivo, 'el contenido cambió entre intentos')
  await esperarToast(page, (t) => t === 'Movimiento registrado', 'éxito del reintento')
}))

await prueba('Caja', '2 · tras un error, cambiar el monto y reenviar → clave distinta', () => conPagina({}, '/caja', listoCaja, async (page, be) => {
  be.plan(RPC_MOV, { status: 500, error: { message: 'Fallo temporal E2E' } })
  const c = caja(page)
  await c.monto.fill('50'); await c.motivo.fill('Compra de útiles')
  await c.registrar.click()
  await esperar(() => be.rpcs(RPC_MOV).length === 1, 5000, '1ª llamada')
  await botonLibre(c.registrar, 'Registrar')
  await c.monto.fill('60')
  await c.registrar.click()
  await esperar(() => be.rpcs(RPC_MOV).length === 2, 5000, '2ª llamada')
  const [a, b] = be.rpcs(RPC_MOV).map((x) => x.cuerpo)
  afirmar(b.p_monto === 60, `el reenvío no lleva el monto nuevo (${b.p_monto})`)
  afirmar(UUID.test(b.p_client_transaction_id || ''), 'la clave nueva no es UUID')
  afirmar(a.p_client_transaction_id !== b.p_client_transaction_id, `misma clave con contenido distinto: ${a.p_client_transaction_id}`)
}))

await prueba('Caja', '3 · tras un éxito, el siguiente movimiento (incluso idéntico) usa clave nueva', () => conPagina({}, '/caja', listoCaja, async (page, be) => {
  const c = caja(page)
  await c.monto.fill('50'); await c.motivo.fill('Fondo de cambio')
  await c.registrar.click()
  await esperarToast(page, (t) => t === 'Movimiento registrado', 'éxito 1')
  await esperar(async () => (await c.monto.inputValue()) === '', 3000, 'formulario limpio')
  await c.monto.fill('50'); await c.motivo.fill('Fondo de cambio')
  await c.registrar.click()
  await esperar(() => be.rpcs(RPC_MOV).length === 2, 5000, '2ª llamada')
  const [a, b] = be.rpcs(RPC_MOV).map((x) => x.cuerpo)
  afirmar(UUID.test(a.p_client_transaction_id || '') && UUID.test(b.p_client_transaction_id || ''), 'claves no UUID')
  afirmar(a.p_client_transaction_id !== b.p_client_transaction_id, `se reutilizó una clave ya consumida: ${a.p_client_transaction_id}`)
}))

await prueba('Caja', '4 · doble clic con respuesta retenida → una sola petición en curso', () => conPagina({}, '/caja', listoCaja, async (page, be) => {
  be.plan(RPC_MOV, { retener: true })
  const c = caja(page)
  await c.monto.fill('25'); await c.motivo.fill('Doble clic')
  await c.registrar.dblclick()
  await pausa(800)
  afirmar(be.rpcs(RPC_MOV).length === 1, `salieron ${be.rpcs(RPC_MOV).length} peticiones durante el doble clic`)
  afirmar((await c.registrar.textContent())?.trim() === 'Registrando...' && await c.registrar.isDisabled(), 'el botón no queda bloqueado mientras la petición está en curso')
  await c.registrar.click({ force: true, timeout: 1500 }).catch(() => {})
  await pausa(300)
  afirmar(be.rpcs(RPC_MOV).length === 1, 'un clic extra sobre el botón bloqueado lanzó otra petición')
  be.soltar()
  await esperarToast(page, (t) => t === 'Movimiento registrado', 'éxito tras soltar')
  await pausa(300)
  afirmar(be.rpcs(RPC_MOV).length === 1, 'apareció una segunda petición al soltar la primera')

  // Sonda estricta (no bloqueante): dos clics sintéticos en la MISMA tarea JS, sin ciclo de render entre ellos.
  // Ninguna entrada humana produce esto; se mide para documentar si hay guarda síncrona.
  const antes = be.rpcs(RPC_MOV).length
  be.plan(RPC_MOV, { retener: true })
  await c.monto.fill('30'); await c.motivo.fill('Sonda estricta')
  await c.registrar.evaluate((el) => { el.click(); el.click() })
  await pausa(800)
  const sonda = be.rpcs(RPC_MOV).slice(antes).map((x) => x.cuerpo)
  be.soltar()
  if (sonda.length > 1) {
    afirmar(sonda.every((x) => x.p_client_transaction_id === sonda[0].p_client_transaction_id), 'dos envíos simultáneos con CLAVES DISTINTAS (duplicaría el movimiento)')
    hallazgos.push({ id: 'CAJA-GUARDA', texto: `Caja.tsx:192-197 — sin guarda síncrona (useRef) antes del await: dos clics en la misma tarea JS emiten ${sonda.length} peticiones. Llevan la MISMA clave, así que el servidor idempotente no duplica; no alcanzable con doble clic humano (probado arriba). Transferencias sí usa enCurso.current.` })
  }
}))

await prueba('Caja', '5 · umbral 100, retiro 150 → aviso y Registrar desactivado sin autorización que cubra', async () => {
  const preparar = async (page, monto, tipo = 'Retiro') => {
    const c = caja(page)
    await c.tipo(tipo).click()
    await c.monto.fill(String(monto)); await c.motivo.fill('Retiro para depósito')
    return c
  }
  // a) sin autorización
  await conPagina({ umbral: 100 }, '/caja', listoCaja, async (page, be) => {
    const c = await preparar(page, 150)
    await page.getByText('supera el umbral y necesita autorización aprobada').waitFor({ timeout: 3000 })
    await page.getByText('Por encima de S/ 100.00, un egreso necesita autorización').waitFor({ timeout: 3000 })
    afirmar(await page.getByRole('button', { name: 'Solicitar autorización' }).isVisible(), 'no se ofrece "Solicitar autorización"')
    afirmar(await c.registrar.isDisabled(), 'Registrar habilitado con retiro 150 > umbral 100 sin autorización')
    await c.registrar.click({ force: true, timeout: 1500 }).catch(() => {})
    await pausa(300)
    afirmar(be.rpcs(RPC_MOV).length === 0, 'se envió el movimiento pese a estar bloqueado')
    // frontera: 100 no supera el umbral
    await c.monto.fill('100')
    await esperar(async () => await c.registrar.isEnabled(), 2000, 'Registrar habilitado en 100 (= umbral)')
    afirmar(!(await page.getByText('supera el umbral').isVisible()), 'aviso mostrado con monto igual al umbral')
    await c.monto.fill('100.01')
    await esperar(async () => await c.registrar.isDisabled(), 2000, 'Registrar bloqueado en 100.01')
    // un ingreso no es egreso
    await c.tipo('Ingreso').click(); await c.monto.fill('150')
    await esperar(async () => await c.registrar.isEnabled(), 2000, 'Registrar habilitado para ingreso 150')
  })
  // b) solicitud pendiente
  await conPagina({ umbral: 100, autorizacion: { id: AUTH_ID, estado: 'pendiente', motivo: 'x', payload: { tipo: 'retiro', monto: 150 } } }, '/caja', listoCaja, async (page) => {
    const c = await preparar(page, 150)
    await page.getByText('Ya hay una solicitud pendiente para esta caja').waitFor({ timeout: 3000 })
    afirmar(await c.registrar.isDisabled(), 'Registrar habilitado con autorización sólo pendiente')
  })
  // c) aprobada por menos
  await conPagina({ umbral: 100, autorizacion: { id: AUTH_ID, estado: 'aprobada', motivo: 'x', payload: { tipo: 'retiro', monto: 120 } } }, '/caja', listoCaja, async (page) => {
    const c = await preparar(page, 150)
    await page.getByText('no cubre este movimiento').waitFor({ timeout: 3000 })
    afirmar(await c.registrar.isDisabled(), 'Registrar habilitado con autorización de 120 para un retiro de 150')
  })
  // d) aprobada para otro tipo
  await conPagina({ umbral: 100, autorizacion: { id: AUTH_ID, estado: 'aprobada', motivo: 'x', payload: { tipo: 'gasto', monto: 500 } } }, '/caja', listoCaja, async (page) => {
    const c = await preparar(page, 150)
    await page.getByText('no cubre este movimiento').waitFor({ timeout: 3000 })
    afirmar(await c.registrar.isDisabled(), 'Registrar habilitado con autorización de otro tipo (gasto)')
  })
  // e) aprobada que cubre → habilitado y la envía
  await conPagina({ umbral: 100, autorizacion: { id: AUTH_ID, estado: 'aprobada', motivo: 'x', payload: { tipo: 'retiro', monto: 200 } } }, '/caja', listoCaja, async (page, be) => {
    const c = await preparar(page, 150)
    await page.getByText('Autorización aprobada por hasta S/ 200.00').waitFor({ timeout: 3000 })
    await esperar(async () => await c.registrar.isEnabled(), 2000, 'Registrar habilitado con autorización que cubre')
    await c.registrar.click()
    await esperar(() => be.rpcs(RPC_MOV).length === 1, 5000, 'llamada autorizada')
    const x = be.rpcs(RPC_MOV)[0].cuerpo
    afirmar(x.p_autorizacion_id === AUTH_ID && x.p_tipo === 'retiro' && x.p_monto === 150, `payload autorizado incorrecto: ${JSON.stringify(x)}`)
  })
})

await prueba('Caja', '6 · el error del servidor se muestra con su texto literal', () => conPagina({}, '/caja', listoCaja, async (page, be) => {
  const LITERAL = 'La caja 7731 está cerrada: no admite movimientos (E2E «literal» ñ)'
  be.plan(RPC_MOV, { status: 400, error: { message: LITERAL } })
  const c = caja(page)
  await c.monto.fill('20'); await c.motivo.fill('Prueba de error')
  await c.registrar.click()
  await esperarToast(page, (t) => t === LITERAL, 'texto literal del servidor')
  afirmar(!(await toasts(page)).some((t) => t === 'No se pudo registrar el movimiento'), 'se sustituyó el mensaje del servidor por uno genérico')
}))

// ---------------------------------------------------------------------------
// 10. TRANSFERENCIAS
// ---------------------------------------------------------------------------
const RPC_REC = 'recibir_transferencia_parcial'
const listoTransf = async (page) => {
  await page.getByText('Transferencia #42').first().waitFor()
  await page.getByRole('button', { name: 'Recibir', exact: true }).click()
  await page.getByLabel('Llegó bien', { exact: true }).waitFor()
}
const transf = (page) => ({
  ok: page.getByLabel('Llegó bien', { exact: true }),
  registrar: page.locator('button').filter({ hasText: /^(Registrar recepción|Enviando\.\.\.)$/ }),
  recibirTodo: page.getByRole('button', { name: 'Recibir todo lo pendiente', exact: true }),
})

await prueba('Transferencias', '1 · recepción parcial que falla y se reintenta igual → misma clave', () => conPagina({}, '/transferencias', listoTransf, async (page, be) => {
  be.plan(RPC_REC, { abortar: true })
  const t = transf(page)
  await t.ok.fill('2')
  await t.registrar.click()
  await esperar(() => be.rpcs(RPC_REC).length === 1, 5000, '1ª llamada')
  await botonLibre(t.registrar, 'Registrar recepción')
  await page.getByText('Reintentar el mismo envío no duplica la recepción.').waitFor({ timeout: 3000 })
  afirmar((await t.ok.inputValue()) === '2', 'la captura se perdió tras el error')
  await t.registrar.click()
  await esperar(() => be.rpcs(RPC_REC).length === 2, 5000, '2ª llamada')
  const [a, b] = be.rpcs(RPC_REC).map((x) => x.cuerpo)
  afirmar(UUID.test(a.p_client_transaction_id || ''), 'la clave no es UUID')
  afirmar(a.p_client_transaction_id === b.p_client_transaction_id, `clave distinta en el reintento: ${a.p_client_transaction_id} vs ${b.p_client_transaction_id}`)
  afirmar(JSON.stringify(a.p_items) === JSON.stringify([{ item_id: ITEM_ID, cantidad_ok: 2, cantidad_danada: 0 }]) && JSON.stringify(a.p_items) === JSON.stringify(b.p_items), `p_items inesperado: ${JSON.stringify(a.p_items)} / ${JSON.stringify(b.p_items)}`)
  afirmar(a.p_transferencia_id === TR_ID && a.p_cerrar === false, 'transferencia o p_cerrar incorrectos')
  await esperarToast(page, (x) => x === 'Recepción registrada', 'éxito del reintento')
}))

await prueba('Transferencias', '2 · cambiar la cantidad antes de reenviar → clave distinta', () => conPagina({}, '/transferencias', listoTransf, async (page, be) => {
  be.plan(RPC_REC, { status: 500, error: { message: 'Error temporal E2E' } })
  const t = transf(page)
  await t.ok.fill('2')
  await t.registrar.click()
  await esperar(() => be.rpcs(RPC_REC).length === 1, 5000, '1ª llamada')
  await botonLibre(t.registrar, 'Registrar recepción')
  await t.ok.fill('3')
  await t.registrar.click()
  await esperar(() => be.rpcs(RPC_REC).length === 2, 5000, '2ª llamada')
  const [a, b] = be.rpcs(RPC_REC).map((x) => x.cuerpo)
  afirmar(b.p_items?.[0]?.cantidad_ok === 3, `el reenvío no lleva la cantidad nueva: ${JSON.stringify(b.p_items)}`)
  afirmar(UUID.test(b.p_client_transaction_id || ''), 'la clave nueva no es UUID')
  afirmar(a.p_client_transaction_id !== b.p_client_transaction_id, `misma clave con cantidad distinta: ${a.p_client_transaction_id}`)
}))

await prueba('Transferencias', '3 · error "contenido distinto" del servidor se muestra literal', () => conPagina({}, '/transferencias', listoTransf, async (page, be) => {
  const LITERAL = 'La clave 5512 ya se usó con contenido distinto: genera una nueva recepción (E2E ñ)'
  be.plan(RPC_REC, { status: 400, error: { message: LITERAL } })
  const t = transf(page)
  await t.ok.fill('2')
  await t.registrar.click()
  await esperarToast(page, (x) => x === LITERAL, 'aviso literal')
  const panel = page.locator('p').filter({ hasText: 'Reintentar el mismo envío no duplica la recepción.' })
  await panel.waitFor({ timeout: 3000 })
  const texto = (await panel.evaluate((el) => el.firstChild?.textContent || '')).trim()
  afirmar(texto === LITERAL, `el panel de error no muestra el texto literal: "${texto}"`)
}))

await prueba('Transferencias', '4 · envío bloqueado mientras hay uno en curso', () => conPagina({}, '/transferencias', listoTransf, async (page, be) => {
  be.plan(RPC_REC, { retener: true })
  const t = transf(page)
  await t.ok.fill('2')
  await t.registrar.dblclick()
  await pausa(800)
  afirmar(be.rpcs(RPC_REC).length === 1, `salieron ${be.rpcs(RPC_REC).length} peticiones durante el doble clic`)
  afirmar((await t.registrar.textContent())?.trim() === 'Enviando...' && await t.registrar.isDisabled(), 'Registrar recepción no queda bloqueado en curso')
  afirmar(await t.recibirTodo.isDisabled(), '"Recibir todo lo pendiente" sigue habilitado con un envío en curso')
  be.soltar()
  await esperarToast(page, (x) => x === 'Recepción registrada', 'éxito tras soltar')
  await pausa(300)
  afirmar(be.rpcs(RPC_REC).length === 1, 'apareció una segunda petición al soltar la primera')
  // Sonda estricta: dos clics en la misma tarea JS. Aquí hay guarda síncrona (enCurso.current): debe salir UNA.
  const antes = be.rpcs(RPC_REC).length
  be.plan(RPC_REC, { retener: true })
  await t.ok.fill('1')
  await esperar(async () => await t.registrar.isEnabled(), 2000, 'botón habilitado con nueva captura')
  await t.registrar.evaluate((el) => { el.click(); el.click() })
  await pausa(800)
  const n = be.rpcs(RPC_REC).length - antes
  be.soltar()
  afirmar(n === 1, `con dos clics en la misma tarea salieron ${n} peticiones pese a la guarda enCurso`)
}))

// ---------------------------------------------------------------------------
// 10b. OFFLINE — cola de ventas pendientes (IndexedDB real del navegador)
// ---------------------------------------------------------------------------
// Se abre /caja (el Layout abre la base y sincroniza al montar), se siembra la
// cola directamente en IndexedDB y se recarga: la sincronización del arranque
// procesa lo sembrado con el código real del bundle.
const RPC_VENTA = 'registrar_venta'
const colaVentas = (page, op, arg = null) => page.evaluate(async ({ op, arg }) => {
  const pedir = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error) })
  const db = await pedir(indexedDB.open('lukatcell-pos'))
  try {
    if (!db.objectStoreNames.contains('ventas_pendientes')) return null
    const store = (modo) => db.transaction('ventas_pendientes', modo).objectStore('ventas_pendientes')
    if (op === 'agregar') { for (const v of arg) await pedir(store('readwrite').add(v)); return true }
    return await pedir(store('readonly').getAll())
  } finally { db.close() }
}, { op, arg })
const ventaEncolada = (tx, estado) => ({
  clientTransactionId: tx,
  cart: [{ variant: { id: VAR_ID, product: { nombre: 'Cargador USB-C E2E' } }, cantidad: 1, precio_unitario: 10, descuento: 0 }],
  subtotal: 10, impuesto: 1.8, total: 11.8, pagos: [{ metodo: 'efectivo', monto: 11.8 }],
  clienteId: null, clienteDoc: null, locationId: LOC_B, cajeroId: STAFF_ID, cashSessionId: SESION_ID,
  createdAt: new Date().toISOString(), estado, intentos: 0, ultimoError: null,
})
const listoCola = async (page) => { await listoCaja(page); await esperar(async () => Array.isArray(await colaVentas(page, 'todas')), 5000, 'IndexedDB de la app lista') }
const txOffline = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

await prueba('Offline', '1 · una venta huérfana en SYNCING (envío interrumpido) se reenvía y sale de la cola', () => conPagina({}, '/caja', listoCola, async (page, be) => {
  const tx = txOffline(1)
  await colaVentas(page, 'agregar', [ventaEncolada(tx, 'SYNCING')])
  await page.reload()
  await listoCola(page)
  await esperar(async () => be.rpcs(RPC_VENTA).some((e) => e.cuerpo?.p_client_transaction_id === tx), 5000, 'reenvío de la venta huérfana')
  await esperar(async () => ((await colaVentas(page, 'todas')) || []).length === 0, 4000, 'cola vacía tras el reenvío')
}))

await prueba('Offline', '2 · un corte de red no gasta intentos, deja la venta PENDING y detiene la ronda', () => conPagina({}, '/caja', listoCola, async (page, be) => {
  const tx1 = txOffline(2), tx2 = txOffline(3)
  be.plan(RPC_VENTA, { abortar: true }, { abortar: true })
  await colaVentas(page, 'agregar', [ventaEncolada(tx1, 'PENDING'), ventaEncolada(tx2, 'PENDING')])
  const antes = be.rpcs(RPC_VENTA).length
  await page.reload()
  await listoCola(page)
  await esperar(async () => be.rpcs(RPC_VENTA).length > antes, 5000, 'primer intento de envío')
  await esperar(async () => ((await colaVentas(page, 'todas')) || []).some((v) => v.ultimoError), 4000, 'error registrado en la cola')
  await pausa(700)
  const cola = await colaVentas(page, 'todas')
  const intentada = cola.find((v) => v.ultimoError)
  afirmar(intentada?.estado === 'PENDING', `estado tras corte de red: ${intentada?.estado} (esperado PENDING)`)
  afirmar(intentada?.intentos === 0, `intentos tras corte de red: ${intentada?.intentos} (esperado 0)`)
  afirmar(be.rpcs(RPC_VENTA).length - antes === 1, `envíos en la ronda: ${be.rpcs(RPC_VENTA).length - antes} (esperado 1: sin red se detiene)`)
}))

await prueba('Offline', '3 · un rechazo del servidor sí cuenta como intento', () => conPagina({}, '/caja', listoCola, async (page, be) => {
  const tx = txOffline(4)
  be.plan(RPC_VENTA, { error: { message: 'Stock insuficiente' } })
  await colaVentas(page, 'agregar', [ventaEncolada(tx, 'PENDING')])
  await page.reload()
  await listoCola(page)
  await esperar(async () => ((await colaVentas(page, 'todas')) || []).some((v) => v.clientTransactionId === tx && v.estado === 'FAILED'), 5000, 'venta rechazada marcada FAILED')
  const v = (await colaVentas(page, 'todas')).find((x) => x.clientTransactionId === tx)
  afirmar(v.intentos === 1 && /Stock insuficiente/.test(v.ultimoError || ''), `rechazo: intentos=${v.intentos} error=${v.ultimoError}`)
}))

// ---------------------------------------------------------------------------
// 11. Resumen
// ---------------------------------------------------------------------------
await browser.close()
servidor.close()

for (const [origen] of trafico) {
  if (origen !== PREVIEW && origen !== FAKE_ORIGIN && !fugas.some((f) => f.includes(origen))) fugas.push(`(visto en request) ${origen}`)
}
const cuenta = (s) => `${resultados[s].filter((r) => r.ok).length}/${resultados[s].length}`
const fallidas = Object.entries(resultados).flatMap(([s, rs]) => rs.filter((r) => !r.ok).map((r) => `${s} · ${r.nombre}: ${r.motivo}`))
const otros = [...trafico].filter(([o]) => o !== PREVIEW && o !== FAKE_ORIGIN).reduce((n, [, c]) => n + c, 0)

console.log('E2E DE NAVEGADOR — backend Supabase SIMULADO (red interceptada)')
console.log(`${nombreNavegador} headless · bundle aislado .p1-e2e/dist (${archivosBundle.length} archivos, sin host de producción)`)
console.log(`Caja: ${cuenta('Caja')} · Transferencias: ${cuenta('Transferencias')} · Offline: ${cuenta('Offline')} · Fugas de red: ${fugas.length}`)
console.log(`Tráfico: ${trafico.get(PREVIEW) || 0} al preview local · ${trafico.get(FAKE_ORIGIN) || 0} al Supabase simulado · ${otros} a otros orígenes · canario de fugas ${canario.detectadas}/${CANARIOS.length} detectado y bloqueado`)
for (const f of fallidas) console.log(`  FALLO ${f}`)
for (const f of fugas.slice(0, 10)) console.log(`  FUGA ${f}`)
if (hallazgos.length) {
  console.log(`Hallazgos de UI (no bloqueantes): ${hallazgos.length}`)
  for (const h of hallazgos) console.log(`  [${h.id}] ${h.texto}`)
}
if (VERBOSE) {
  if (noSimulados.size) console.log(`Endpoints sin simulación específica (respuesta vacía): ${[...noSimulados].join(', ')}`)
  if (erroresPagina.length) console.log(`Errores de página: ${[...new Set(erroresPagina)].join(' | ')}`)
}
const ok = fallidas.length === 0 && fugas.length === 0
console.log(`Resultado: ${ok ? 'PASS' : 'FAIL'} (backend simulado: lógica de UI contra el bundle real, no integración con Supabase)`)
process.exit(ok ? 0 : 1)
