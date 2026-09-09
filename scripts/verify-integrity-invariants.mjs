#!/usr/bin/env node
// Suite de integración P0.1: reproduce contra una base Supabase REAL los
// escenarios críticos verificados manualmente durante el hardening (curl +
// JWT real, no solo introspección SQL). No forma parte de `npm test` porque
// necesita credenciales vivas y crea/borra datos reales — se ejecuta aparte
// con `npm run test:integration`.
//
// Requiere estas variables de entorno:
//   SUPABASE_URL            URL del proyecto (https://xxx.supabase.co)
//   SUPABASE_ANON_KEY       anon/publishable key del proyecto
//   QA_STAFF_EMAIL          email de una cuenta de staff de PRUEBA
//   QA_STAFF_PASSWORD       password de esa cuenta
//   QA_STAFF_ID             staff.id de esa cuenta (uuid)
//   QA_LOCATION_ID          location_id (sucursal) de esa cuenta
//
// Y estas dos, que gobiernan el bloqueo de destino (ver bloque de guards):
//   QA_ALLOW_MUTATING_INTEGRATION_TESTS  debe valer 'true' SIEMPRE, sea cual
//                                        sea el proyecto destino
//   QA_EXPECTED_PROJECT_REF (opcional)   si se define, el project ref del
//                                        destino debe coincidir exactamente
//
// La cuenta de prueba debe tener rol='administrador' — la mayoría de
// tablas de catálogo/inventario (products, product_variants, inventory)
// solo aceptan escritura directa de un admin vía RLS (`private.auth_is_
// admin()`); todo lo demás pasa por RPC. Esto significa que el escenario
// "ajustar_stock rechaza sucursal ajena para un NO-admin" (verificado
// manualmente con curl durante el hardening, ver docs/POS_INTEGRITY_
// HARDENING.md) no se automatiza aquí: requeriría una SEGUNDA identidad
// no-admin, que un admin bypassea por diseño. En su lugar este script
// cubre la invariante de "nunca stock negativo", que sí aplica a
// cualquier rol.
//
// El script llama a registrar_mi_entrada al iniciar (best-effort) para
// asegurar una jornada activa, requisito para abrir caja — se ignora si
// ya había una entrada registrada hoy.
//
// Si faltan variables de entorno, el script termina con código 0 y un
// aviso — para que un `npm run test:integration` accidental en un entorno
// sin credenciales no se reporte como una regresión real. La excepción es
// SUPABASE_URL: sin ella no se puede saber CONTRA QUÉ se iba a escribir, y
// eso no puede degradar a un SKIP silencioso (ver guards más abajo).
//
// Limpieza de datos de prueba: products/product_variants/inventory/
// cash_sessions SIN historial se borran solos al terminar. Pero sales,
// sale_items, payments, cash_movements, inventory_movements,
// product_serials, serial_reservations e inventario_fisico_items/
// inventarios_fisicos NO tienen policy de DELETE para ningún rol — son
// historiales inmutables por diseño (el mismo principio que "cash_movements
// append-only" documentado en el hardening). El script NO intenta borrarlos
// (siempre sería un no-op o un 403) y en vez de eso imprime al final un
// listado de "residuos esperados" con los IDs exactos de esta corrida, para
// purgarlos aparte con una conexión de administrador de base de datos si el
// proyecto usado es efectivamente uno de prueba/QA.

// P0.2 bloque 7: esta suite CREA datos reales (ventas, cajas, movimientos,
// seriales, conteos) y varias de esas tablas son append-only por diseño —
// no hay forma de dejar producción exactamente como estaba. Correrla contra
// el proyecto de producción real, aunque sea "solo para probar", deja
// residuos permanentes (ver docs/POS_INTEGRITY_HARDENING.md). El único
// proyecto Supabase de LUKATCELL hoy es el de producción — no existe un
// branch/staging separado — así que el bloqueo de abajo es la única
// protección real contra correr esto sin querer contra el negocio en vivo.
//
// El project ref de producción está hardcodeado a propósito (no en una env
// var): si se pudiera "configurar" el bloqueo con una variable de entorno,
// un simple typo o un .env mal copiado lo desactivaría en silencio.
const PROD_SUPABASE_PROJECT_REF = 'fbwkclpgnsxuqycazumj'

// Se extrae con regex a propósito, sin `new URL(...)`: más abajo este módulo
// declara `const URL = process.env.SUPABASE_URL`, que sombrea al constructor
// global; usarlo aquí lanzaría un ReferenceError por TDZ y — si eso quedara
// dentro de un try/catch — el bloqueo fallaría en SILENCIO, que es
// exactamente lo que este bloqueo existe para evitar.
function projectRefDe(url) {
  const m = /^https?:\/\/([^./]+)\./.exec(String(url || ''))
  return m ? m[1] : null
}

const refDestino = projectRefDe(process.env.SUPABASE_URL)
const permitidoExplicitamente = process.env.QA_ALLOW_MUTATING_INTEGRATION_TESTS === 'true'
// Se normaliza con trim porque el valor típico viene de un .env o de un
// `export` a mano: un espacio final invisible convertiría el guard opcional
// en un rechazo incomprensible ("abc" !== "abc ") justo cuando el operador
// hizo lo correcto.
const refEsperado = String(process.env.QA_EXPECTED_PROJECT_REF || '').trim()

// Todos los rechazos salen por acá para que el operador reciba siempre las
// tres mismas piezas: qué se bloqueó, por qué, y qué hacer a continuación.
// Un REFUSED sin la última línea termina en alguien "probando cosas" con
// variables de entorno hasta que algo corre, que es el escenario peligroso.
function rechazar(motivo, comoDesbloquear) {
  console.error('REFUSED: mutating integration tests cannot run against this target')
  console.error(motivo)
  console.error(comoDesbloquear)
  console.error('Para verificar producción sin escribir nada, usa: npm run test:production:readonly')
  process.exit(1)
}

// P0.3 bloque 10: contra PRODUCCIÓN el rechazo es ABSOLUTO — no hay override.
// Antes, QA_ALLOW_MUTATING_INTEGRATION_TESTS=true alcanzaba para saltarse el
// bloqueo incluso apuntando a producción, o sea que la única barrera real era
// que nadie exportara esa variable "para probar una cosita". Ahora esa
// variable SÓLO sirve para habilitar escritura en un proyecto que NO es
// producción; sobre producción no la mira nadie. Tampoco NODE_ENV, ni CI, ni
// el usuario: no existe combinación de entorno que lo permita.
if (refDestino === PROD_SUPABASE_PROJECT_REF) {
  console.error('REFUSED: mutating integration tests cannot run against production')
  console.error(`SUPABASE_URL apunta al proyecto de producción (${PROD_SUPABASE_PROJECT_REF}). Esta suite crea ventas, cajas, seriales y conteos reales, y varias de esas tablas son append-only: no hay forma de dejar producción como estaba.`)
  console.error('No hay override: QA_ALLOW_MUTATING_INTEGRATION_TESTS NO habilita este caso. Usa un proyecto de staging.')
  console.error('Para verificar producción sin escribir nada, usa: npm run test:production:readonly')
  process.exit(1)
}

// Falla CERRADO: si no se pudo leer el ref, no se sabe contra qué se iba a
// escribir. La tentación es degradarlo al SKIP de "faltan credenciales", pero
// una SUPABASE_URL malformada (un proxy, una IP, un typo que borró el
// subdominio) puede seguir resolviendo a producción — desconocido se trata
// como producción, nunca como "seguro". Este chequeo va ANTES del flag a
// propósito: el flag no es una respuesta válida a "no sé dónde estoy".
if (refDestino === null) {
  rechazar(
    `No se pudo determinar el proyecto destino desde SUPABASE_URL (${process.env.SUPABASE_URL || 'vacío'}); por seguridad se asume producción.`,
    'Corrige SUPABASE_URL a la forma https://<project-ref>.supabase.co del proyecto de staging/QA. Ningún flag habilita un destino ilegible.',
  )
}

// El flag es obligatorio SIEMPRE, no solo cuando el destino es dudoso. Antes
// un ref legible y distinto de producción corría solo: bastaba un .env de
// otro proyecto (o el staging de otro cliente) para que una suite que CREA
// ventas, cajas y seriales arrancara sin que nadie hubiera dicho "sí". Que la
// escritura sea siempre un acto deliberado es el punto entero del flag.
if (!permitidoExplicitamente) {
  rechazar(
    `SUPABASE_URL apunta al proyecto '${refDestino}'. Esta suite CREA datos reales (ventas, cajas, movimientos, seriales, conteos) y varias de esas tablas son append-only: lo que escriba ahí no se puede deshacer.`,
    "Si ese proyecto es efectivamente de staging/QA y aceptas el residuo permanente, exporta QA_ALLOW_MUTATING_INTEGRATION_TESTS=true explícitamente.",
  )
}

// Guard opcional de "destino esperado": el flag de arriba autoriza escribir,
// pero no dice DÓNDE. Con un .env viejo o un export olvidado se puede tener
// permiso legítimo y aun así apuntar al proyecto equivocado (el staging de
// otro cliente sigue siendo datos de alguien). Fijar QA_EXPECTED_PROJECT_REF
// en el runner de CI convierte ese error silencioso en un rechazo.
if (refEsperado && refEsperado !== refDestino) {
  rechazar(
    `QA_EXPECTED_PROJECT_REF exige el proyecto '${refEsperado}', pero SUPABASE_URL apunta a '${refDestino}'.`,
    'Apunta SUPABASE_URL al proyecto esperado, o corrige QA_EXPECTED_PROJECT_REF si el destino nuevo es el correcto.',
  )
}

if (!refEsperado) {
  // Aviso, no bloqueo: exigirlo rompería a quien ya corre esto a mano contra
  // su staging. Pero sin él el único filtro de destino es "no es producción",
  // y eso deja pasar cualquier otro proyecto Supabase del mundo.
  console.warn(`WARN: QA_EXPECTED_PROJECT_REF no está definida — no se está verificando que '${refDestino}' sea el proyecto que esperabas. Defínela para blindar el destino.`)
}

console.log(`Destino autorizado: proyecto '${refDestino}' (no es producción, QA_ALLOW_MUTATING_INTEGRATION_TESTS=true${refEsperado ? `, coincide con QA_EXPECTED_PROJECT_REF` : ''}).`)

const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'QA_STAFF_EMAIL', 'QA_STAFF_PASSWORD', 'QA_STAFF_ID', 'QA_LOCATION_ID']
const missing = required.filter((k) => !process.env[k])
if (missing.length) {
  console.log(`SKIP: faltan variables de entorno para la suite de integración (${missing.join(', ')}). Ver cabecera de este archivo.`)
  process.exit(0)
}

const URL = process.env.SUPABASE_URL
const ANON_KEY = process.env.SUPABASE_ANON_KEY
const STAFF_ID = process.env.QA_STAFF_ID
const LOCATION_ID = process.env.QA_LOCATION_ID

let failures = 0
function assert(condition, message) {
  if (!condition) { console.error(`FAIL: ${message}`); failures++ }
  else console.log(`PASS: ${message}`)
}

async function api(path, { method = 'GET', body, jwt, prefer } = {}) {
  const headers = { apikey: ANON_KEY, 'Content-Type': 'application/json' }
  if (jwt) headers.Authorization = `Bearer ${jwt}`
  if (prefer) headers.Prefer = prefer
  const res = await fetch(`${URL}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
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
  if (!data?.access_token) throw new Error(`No se pudo autenticar la cuenta QA: ${JSON.stringify(data)}`)
  return data.access_token
}

const cleanup = []
function trackCleanup(fn) { cleanup.push(fn) }

// Tablas de auditoría/trazabilidad (sales, sale_items, payments,
// cash_movements, inventory_movements, product_serials, serial_reservations,
// inventarios_fisicos/items) NO tienen policy RLS de DELETE para ningún rol
// de app — ni siquiera administrador — por diseño: son historiales que el
// hardening P0.1 dejó deliberadamente inmutables vía REST/RPC (mismo
// principio que "cash_movements append-only"). Un DELETE contra ellas desde
// este script SIEMPRE queda en no-op o 403, y eso a su vez bloquea por FK el
// DELETE de product_variants/products/cash_sessions que sí son borrables.
// Estos residuos son ESPERADOS, no un bug de la suite: se listan al final
// para purgarlos aparte con una conexión con privilegios de administrador de
// base de datos (no con el rol `authenticated` de la app).
const residuosEsperados = []
function registrarResiduo(tabla, descripcion) { residuosEsperados.push({ tabla, descripcion }) }

async function runCleanup() {
  for (const fn of cleanup.reverse()) {
    try {
      const r = await fn()
      // api() nunca lanza por un status HTTP no-2xx (solo por errores de red):
      // un DELETE bloqueado por FK o RLS "tiene éxito" como fetch aunque no
      // borre nada, así que hay que revisar el status explícitamente o la
      // limpieza queda incompleta en silencio.
      if (r && r.ok === false) console.error(`WARN (inesperado): limpieza devolvió status ${r.status}:`, JSON.stringify(r.data))
    } catch (e) { console.error('WARN (inesperado): fallo en limpieza de datos de prueba:', e.message) }
  }
  if (residuosEsperados.length) {
    console.log('\nResiduos ESPERADOS (tablas de auditoría inmutables vía REST, requieren purga manual con rol admin de BD):')
    for (const r of residuosEsperados) console.log(`  - ${r.tabla}: ${r.descripcion}`)
  }
}

async function crearProducto(jwt, { nombre, precio = 100, controlSerial = false, costo = 50, dejaRastroAuditoria = false, motivoAuditoria = '' }) {
  // return=minimal (no return=representation): la columna `costo` está
  // deliberadamente sin GRANT SELECT para `authenticated` (oculta a no-admin
  // por diseño previo, enforce_product_cost_column_privacy) — pedir de
  // vuelta la fila completa tras el INSERT dispara un SELECT * que choca
  // con esa columna. Se generan los IDs en el cliente para no necesitarlo.
  //
  // `dejaRastroAuditoria`: true cuando el escenario que llama a esta función
  // va a generar filas en tablas de historial sin policy de DELETE para
  // ningún rol (inventory_movements, product_serials, sale_items,
  // inventario_fisico_items — inmutables por diseño). En ese caso, intentar
  // borrar product_variants/products más abajo en la cola SIEMPRE fallaría
  // por FK contra ese historial, así que directamente se documentan como
  // residuo esperado en vez de generar un WARN engañoso.
  const productId = crypto.randomUUID()
  const { status, data } = await api('/rest/v1/products', {
    method: 'POST', jwt, prefer: 'return=minimal',
    body: { id: productId, nombre, precio_base: precio, activo: true, control_serial: controlSerial, costo },
  })
  if (status >= 400) throw new Error(`No se pudo crear producto de prueba (¿la cuenta QA es admin?): ${JSON.stringify(data)}`)
  const variantId = crypto.randomUUID()
  const { status: vStatus, data: vData } = await api('/rest/v1/product_variants', {
    method: 'POST', jwt, prefer: 'return=minimal',
    body: { id: variantId, product_id: productId },
  })
  if (vStatus >= 400) throw new Error(`No se pudo crear variante de prueba: ${JSON.stringify(vData)}`)
  if (dejaRastroAuditoria) {
    registrarResiduo('products + product_variants', `id=${productId}/${variantId} (${nombre}) — bloqueados por FK desde ${motivoAuditoria || 'historial inmutable'}`)
    // No se puede borrar la fila, pero SÍ desactivarla (UPDATE, no DELETE:
    // products tiene policy ALL para admin) — necesario para que este
    // producto de prueba deje de aparecer en conteos físicos futuros
    // (iniciar_inventario_fisico incluye todo producto activo con stock en
    // la sucursal) y en catálogo/reportes. Sin esto, cada corrida deja un
    // producto activo más que las siguientes corridas arrastran para
    // siempre, y el conteo físico nunca vuelve a poder cerrarse solo.
    trackCleanup(() => api(`/rest/v1/products?id=eq.${productId}`, { method: 'PATCH', jwt, body: { activo: false } }))
  } else {
    trackCleanup(() => api(`/rest/v1/product_variants?id=eq.${variantId}`, { method: 'DELETE', jwt }))
    trackCleanup(() => api(`/rest/v1/products?id=eq.${productId}`, { method: 'DELETE', jwt }))
  }
  return { productId, variantId, dejaRastroAuditoria }
}

async function setInventory(jwt, variantId, cantidad, { limpiar = true } = {}) {
  await api('/rest/v1/inventory', { method: 'POST', jwt, prefer: 'resolution=merge-duplicates', body: { variant_id: variantId, location_id: LOCATION_ID, cantidad } })
  // Si la variante va a quedar como residuo (dejaRastroAuditoria), borrar
  // solo `inventory` dejaría la variante sin su fila de stock — inconsistente
  // con que la variante en sí sobreviva. Se deja también como parte del mismo
  // residuo documentado por crearProducto.
  if (limpiar) trackCleanup(() => api(`/rest/v1/inventory?variant_id=eq.${variantId}`, { method: 'DELETE', jwt }))
}

async function abrirCaja(jwt) {
  // cash_sessions_one_open_per_staff impide abrir una segunda caja mientras
  // haya una abierta. Una corrida anterior de esta suite puede haber dejado
  // la suya abierta a propósito (no se borra: es un residuo esperado, ver
  // abajo) — se cierra (UPDATE, no DELETE) antes de abrir la nueva, lo cual
  // no requiere tocar cash_movements ni viola el append-only.
  const { data: previa } = await api(`/rest/v1/cash_sessions?cajero_id=eq.${STAFF_ID}&cierre=is.null&select=id`, { jwt })
  if (previa?.[0]?.id) {
    await api(`/rest/v1/cash_sessions?id=eq.${previa[0].id}`, { method: 'PATCH', jwt, body: { cierre: new Date().toISOString(), monto_final_contado: 0 } })
  }
  const { data, status } = await api('/rest/v1/cash_sessions', {
    method: 'POST', jwt, prefer: 'return=representation',
    body: { cajero_id: STAFF_ID, location_id: LOCATION_ID, monto_inicial: 0 },
  })
  if (status >= 400) throw new Error(`No se pudo abrir caja: ${JSON.stringify(data)}`)
  const sessionId = data[0].id
  // cash_movements no tiene GRANT de DELETE para ningún rol de app (append-
  // only por diseño, ver 20260906... hardening de caja) y la venta de
  // Escenario 1 deja al menos un cash_movement real referenciando esta
  // sesión — el cash_session tampoco puede borrarse mientras exista ese
  // movimiento. Se documenta como residuo esperado en vez de intentarlo.
  registrarResiduo('cash_sessions + cash_movements', `session id=${sessionId}`)
  return sessionId
}

async function main() {
  const jwt = await login()
  console.log('Autenticado como cuenta QA. Iniciando escenarios...')
  await api('/rest/v1/rpc/registrar_mi_entrada', { method: 'POST', jwt, body: {} }).catch(() => {})

  // Una sola caja compartida por los escenarios que la necesitan: la BD
  // exige un único cash_session abierto por cajero (cash_sessions_one_open_
  // per_staff), así que no se puede abrir una nueva por escenario sin
  // cerrar/borrar la anterior primero.
  const sessionId = await abrirCaja(jwt)

  // ------------------------------------------------------------------
  // Escenario 1 — Venta: idempotencia por client_transaction_id
  // ------------------------------------------------------------------
  {
    const { variantId } = await crearProducto(jwt, { nombre: 'QA-INTEGRITY-idempotencia', precio: 50, dejaRastroAuditoria: true, motivoAuditoria: 'sale_items/inventory_movements de la venta de prueba' })
    await setInventory(jwt, variantId, 10, { limpiar: false })
    const clientTxId = crypto.randomUUID()
    const payload = {
      p_items: [{ variant_id: variantId, cantidad: 1, precio_unitario: 50, subtotal: 50, descuento: 0 }],
      p_pagos: [{ metodo: 'efectivo', monto: 50 }],
      p_subtotal: 50, p_impuesto: 0, p_total: 50,
      p_location_id: LOCATION_ID, p_cajero_id: STAFF_ID, p_cash_session_id: sessionId,
      p_client_transaction_id: clientTxId,
    }
    const first = await api('/rest/v1/rpc/registrar_venta', { method: 'POST', jwt, body: payload })
    const second = await api('/rest/v1/rpc/registrar_venta', { method: 'POST', jwt, body: payload })
    assert(first.ok && second.ok, 'Venta: ambos envíos con el mismo client_transaction_id responden OK')
    assert(!!first.data?.id && first.data?.id === second.data?.id, 'Venta: el reenvío con el mismo client_transaction_id devuelve la MISMA venta (idempotencia real)')
    // sales/sale_items/payments/cash_movements no tienen policy de DELETE
    // para ningún rol (historial de ventas y caja inmutable por diseño) —
    // no se intenta borrarlos vía REST, se documentan como residuo esperado.
    if (first.data?.id) registrarResiduo('sales + sale_items + payments + cash_movements', `sale id=${first.data.id}`)
  }

  // ------------------------------------------------------------------
  // Escenario 2 — Caja: retiro que excede el saldo se rechaza (no negativo)
  // ------------------------------------------------------------------
  {
    const { status, data } = await api('/rest/v1/rpc/registrar_movimiento_caja', {
      method: 'POST', jwt,
      body: { p_cash_session_id: sessionId, p_tipo: 'retiro', p_monto: 999999, p_motivo: 'prueba integridad: retiro imposible' },
    })
    assert(status >= 400 && /insuficiente/i.test(JSON.stringify(data)), 'Caja: un retiro que excede el saldo disponible se rechaza (nunca queda negativa)')
  }

  // ------------------------------------------------------------------
  // Escenario 3 — Stock: ajustar_stock nunca deja cantidad negativa
  // (el escenario "sucursal ajena para un NO-admin" está verificado
  // manualmente en docs/POS_INTEGRITY_HARDENING.md — requiere una
  // segunda identidad no-admin, que un admin bypassea por diseño)
  // ------------------------------------------------------------------
  {
    // Si el Escenario 5 (conteo físico) también corre en esta ejecución, su
    // iniciar_inventario_fisico barre TODA la sucursal y va a crear una fila
    // en inventario_fisico_items para CUALQUIER producto activo con
    // inventory ahí — incluida esta variante — antes de que este bloque
    // llegue a borrarla. Esa fila es inmutable (ver crearProducto), así que
    // el DELETE de más abajo quedaría bloqueado por FK. Se anticipa aquí en
    // vez de descubrirlo como un WARN inesperado en la limpieza.
    const conteoFisicoVaACorrer = !!process.env.QA_RUN_CONTEO_FISICO
    const { variantId } = await crearProducto(jwt, {
      nombre: 'QA-INTEGRITY-stock-negativo', precio: 10,
      dejaRastroAuditoria: conteoFisicoVaACorrer,
      motivoAuditoria: 'inventario_fisico_items (barrido de sucursal del Escenario 5, QA_RUN_CONTEO_FISICO=1)',
    })
    await setInventory(jwt, variantId, 3, { limpiar: !conteoFisicoVaACorrer })
    const { status, data } = await api('/rest/v1/rpc/ajustar_stock', {
      method: 'POST', jwt,
      body: { p_variant_id: variantId, p_location_id: LOCATION_ID, p_cantidad_delta: -10, p_motivo: 'prueba integridad: retiro mayor al disponible' },
    })
    assert(status >= 400 && /insuficiente/i.test(JSON.stringify(data)), 'Stock: ajustar_stock rechaza un retiro mayor al disponible (nunca queda negativo)')
  }

  // ------------------------------------------------------------------
  // Escenario 4 — IMEI: dos carritos no se pisan la misma reserva
  // ------------------------------------------------------------------
  {
    const { variantId } = await crearProducto(jwt, { nombre: 'QA-INTEGRITY-imei', precio: 100, controlSerial: true, dejaRastroAuditoria: true, motivoAuditoria: 'product_serials/serial_reservations de prueba' })
    const sufijo = Date.now()
    const { data: n1 } = await api('/rest/v1/rpc/registrar_seriales', { method: 'POST', jwt, body: { p_variant_id: variantId, p_seriales: [{ serial_number: `QA-INTEGRITY-SN-${sufijo}-1` }] } })
    await api('/rest/v1/rpc/registrar_seriales', { method: 'POST', jwt, body: { p_variant_id: variantId, p_seriales: [{ serial_number: `QA-INTEGRITY-SN-${sufijo}-2` }] } })
    // product_serials/serial_reservations no tienen policy de DELETE para
    // ningún rol (trazabilidad de IMEI inmutable por diseño) — ya quedaron
    // documentados como residuo junto con el producto/variante arriba.
    assert(n1 === 1, 'IMEI: registrar_seriales da de alta la unidad de prueba')
    const { data: seriales } = await api(`/rest/v1/product_serials?variant_id=eq.${variantId}&select=id,serial_number`, { jwt })
    const sn1 = seriales?.[0]?.id
    const cartA = crypto.randomUUID(); const cartB = crypto.randomUUID()
    const reservaA = await api('/rest/v1/rpc/reservar_seriales_carrito', { method: 'POST', jwt, body: { p_variant_id: variantId, p_serial_ids: [sn1], p_client_transaction_id: cartA } })
    const reservaB = await api('/rest/v1/rpc/reservar_seriales_carrito', { method: 'POST', jwt, body: { p_variant_id: variantId, p_serial_ids: [sn1], p_client_transaction_id: cartB } })
    assert(reservaA.ok, 'IMEI: el Carrito A reserva el primer serial sin problema')
    assert(!reservaB.ok, 'IMEI: el Carrito B NO puede reservar el mismo serial que ya tiene el Carrito A')
    const disponiblesParaB = await api('/rest/v1/rpc/seriales_disponibles', { method: 'POST', jwt, body: { p_variant_id: variantId, p_client_transaction_id: cartB } })
    assert(Array.isArray(disponiblesParaB.data) && !disponiblesParaB.data.some((s) => s.id === sn1), 'IMEI: seriales_disponibles no muestra al Carrito B un serial ya reservado por el Carrito A')
  }

  // ------------------------------------------------------------------
  // Escenario 5 — Conteo físico: venta concurrente entre apertura y conteo
  // (Caso B del hardening: snapshot 10, venta -2 antes de contar, conteo 9 → final 9)
  //
  // A diferencia de los demás escenarios (aislados a filas con nombre
  // QA-INTEGRITY-*), iniciar_inventario_fisico abre un conteo para TODA la
  // sucursal — incluye el catálogo real completo de QA_LOCATION_ID, no solo
  // la variante de prueba, y dos ejecuciones de esta suite no pueden
  // solaparse (un único conteo abierto por sucursal). Correrlo de forma
  // rutinaria: (a) deja una entrada de "conteo físico completo" real y
  // sintética en el historial de esa sucursal en cada corrida, y (b) puede
  // chocar con un conteo físico real que el personal esté haciendo a la vez.
  // Por eso queda detrás de un flag explícito — no se ejecuta en un
  // `npm run test:integration` normal salvo que se pida a propósito.
  // ------------------------------------------------------------------
  if (!process.env.QA_RUN_CONTEO_FISICO) {
    console.log('SKIP: Escenario 5 (conteo físico) — abre un conteo real para TODA la sucursal, se omite salvo QA_RUN_CONTEO_FISICO=1 (ver comentario en el script).')
  } else {
    const { variantId } = await crearProducto(jwt, { nombre: 'QA-INTEGRITY-conteo', precio: 10, dejaRastroAuditoria: true, motivoAuditoria: 'inventory_movements/inventario_fisico_items del conteo de prueba' })
    await setInventory(jwt, variantId, 10, { limpiar: false })
    const { data: inv } = await api('/rest/v1/rpc/iniciar_inventario_fisico', { method: 'POST', jwt, body: {} })
    const inventarioId = inv.id
    // inventario_fisico_items/inventarios_fisicos no tienen policy de DELETE
    // para ningún rol (historial de conteos físicos inmutable por diseño) —
    // ya quedaron documentados como residuo junto con el producto arriba.
    // venta concurrente: -2 vía ajustar_stock (simula una venta real reduciendo inventory)
    await api('/rest/v1/rpc/ajustar_stock', { method: 'POST', jwt, body: { p_variant_id: variantId, p_location_id: LOCATION_ID, p_cantidad_delta: -2, p_motivo: 'QA-INTEGRITY venta concurrente' } })
    await api('/rest/v1/rpc/registrar_conteo_fisico', { method: 'POST', jwt, body: { p_inventario_id: inventarioId, p_variant_id: variantId, p_cantidad: 9 } })
    // iniciar_inventario_fisico abarca TODA la sucursal (catálogo real
    // incluido, no solo la variante QA) — mientras el conteo sigue abierto,
    // actividad real concurrente en esa sucursal (una venta real, otro
    // ajuste) puede seguir agregando líneas pendientes nuevas. Un solo pase
    // de "completar pendientes" no es suficiente (se comprobó en producción:
    // una línea de un servicio real apareció como pendiente después del
    // primer pase) — se reintenta hasta que no quede ninguna, con un tope
    // para no quedar en loop infinito si algo más está genuinamente roto.
    for (let intento = 0; intento < 5; intento++) {
      const { data: pendientes } = await api(`/rest/v1/inventario_fisico_items?inventario_id=eq.${inventarioId}&cantidad_contada=is.null&select=variant_id,cantidad_sistema`, { jwt })
      if (!pendientes?.length) break
      for (const p of pendientes) {
        await api('/rest/v1/rpc/registrar_conteo_fisico', { method: 'POST', jwt, body: { p_inventario_id: inventarioId, p_variant_id: p.variant_id, p_cantidad: p.cantidad_sistema } })
      }
    }
    const cierre = await api('/rest/v1/rpc/cerrar_inventario_fisico', { method: 'POST', jwt, body: { p_inventario_id: inventarioId } })
    const { data: invFinal } = await api(`/rest/v1/inventory?variant_id=eq.${variantId}&select=cantidad`, { jwt })
    assert(cierre.ok, `Conteo: el cierre se ejecuta sin error (${cierre.ok ? '' : JSON.stringify(cierre.data)})`)
    assert(invFinal?.[0]?.cantidad === 9, `Conteo: resultado final = 9 (esperado al contar 8, contado 9 → +1 real), obtenido ${invFinal?.[0]?.cantidad}`)
  }

  console.log(failures ? `\n${failures} escenario(s) fallaron.` : '\nTodos los escenarios de integridad pasaron.')
  process.exitCode = failures ? 1 : 0
}

main()
  .catch((e) => { console.error('ERROR en la suite de integración:', e); process.exitCode = 1 })
  .finally(runCleanup)
