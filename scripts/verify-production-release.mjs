#!/usr/bin/env node
// PRUEBA DE ACEPTACIÓN FINAL DE PRODUCCIÓN — SOLO LECTURA.
//
// Es la única validación que se corre contra el proyecto de producción real
// DESPUÉS del deploy. A diferencia de scripts/verify-integrity-invariants.mjs
// (que CREA ventas, cajas, seriales y conteos y por eso tiene prohibido
// apuntar a producción), este script NO escribe absolutamente nada: solo hace
// GET sobre PostgREST y llama RPC declaradas `stable`/`security definer` de
// solo lectura. No crea productos, ventas, cajas, seriales ni conteos
// sintéticos, y por lo tanto es seguro correrlo tantas veces como haga falta.
//
//   npm run verify:production-release
//
// Requiere:
//   SUPABASE_URL          URL del proyecto (https://xxx.supabase.co)
//   SUPABASE_ANON_KEY     anon/publishable key
//   QA_STAFF_EMAIL        email de una cuenta con rol administrador
//   QA_STAFF_PASSWORD     password de esa cuenta
//
// La cuenta debe ser administrador: la introspección de grants/RLS/definición
// de RPC vive detrás de diagnostico_integridad_admin() y release_health_admin(),
// ambas SECURITY DEFINER y ambas con un chequeo de admin adentro. Con la anon
// key sola no hay forma de ver esto (PostgREST solo expone el esquema public).
//
// FALLA CERRADO (R7). Una prueba de aceptación que puede terminar en verde sin
// haber comprobado nada es peor que no tenerla: da la firma de "listo para
// producción" a un release que nadie miró. Por eso:
//   * si falta cualquier credencial -> BLOCKED y exit 1, nunca SKIP silencioso;
//   * si una sección CRÍTICA no consigue datos -> FAIL, no "SKIP sin fuente";
//   * si una clave de diagnóstico no viene en la respuesta -> FAIL, en vez de
//     degradar a lista vacía y declarar "0 problemas encontrados".
// Solo las secciones marcadas como no críticas (aquellas cuya fuente de datos
// sencillamente no existe hoy en el esquema) pueden quedar en SKIP sin romper.
//
// Salida: UN resumen agregado por secciones. El detalle solo se imprime para
// lo que NO pasó — un muro de cientos de líneas verdes es exactamente igual de
// ilegible que ninguna salida, y esconde la línea que importa.
//
// Honestidad de las secciones: NUNCA se reporta PASS por algo que no se
// comprobó, y no se inventan llamadas a RPC inexistentes. Lo que antes era
// inverificable desde fuera (la lista de triggers desplegados y el cuadre
// agregado de las ventas) ahora lo expone p04_invariantes_admin(), así que ya
// no quedan SKIP estructurales: si algo no se puede verificar, es un FAIL.

const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'QA_STAFF_EMAIL', 'QA_STAFF_PASSWORD']
const missing = required.filter((k) => !process.env[k])
if (missing.length) {
  console.log('PRODUCTION FINAL ACCEPTANCE TEST\n')
  console.log(`STATUS: BLOCKED — faltan credenciales: ${missing.join(', ')}`)
  console.log('\nSin estas variables no se comprueba nada, y "no se comprobó nada" no es un PASS.')
  console.log('Ver la cabecera de este archivo para qué representa cada una.')
  console.log('\nCritical errors: 1')
  process.exit(1)
}

const URL_BASE = process.env.SUPABASE_URL
const ANON_KEY = process.env.SUPABASE_ANON_KEY

// ---------------------------------------------------------------------------
// Transporte: GET/POST contra PostgREST. Ningún helper de este archivo emite
// PATCH, PUT ni DELETE, y el único POST permitido es /rpc/ de funciones de
// lectura — está centralizado aquí a propósito para que sea auditable de un
// vistazo que este script no puede escribir.
// ---------------------------------------------------------------------------
async function api(path, { method = 'GET', body, jwt, count } = {}) {
  if (method !== 'GET' && method !== 'POST') throw new Error(`Método no permitido en un script de solo lectura: ${method}`)
  const headers = { apikey: ANON_KEY, 'Content-Type': 'application/json' }
  if (jwt) headers.Authorization = `Bearer ${jwt}`
  if (count) headers.Prefer = 'count=exact'
  const res = await fetch(`${URL_BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { ok: res.ok, status: res.status, data, contentRange: res.headers.get('content-range') }
}

let JWT = null

async function login() {
  const { data } = await api('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email: process.env.QA_STAFF_EMAIL, password: process.env.QA_STAFF_PASSWORD },
  })
  if (!data?.access_token) throw new Error(`No se pudo autenticar: ${JSON.stringify(data)}`)
  return data.access_token
}

function motivo(r) {
  const d = typeof r.data === 'string' ? r.data : JSON.stringify(r.data)
  return `HTTP ${r.status} ${String(d || '').slice(0, 160)}`
}

// Cuenta filas sin traérselas: `limit=1` + `Prefer: count=exact` devuelve el
// total en el header content-range. Traer las filas para hacer `.length` sería
// leer producción entera para contar.
async function contar(tabla, filtro = '', columna = 'id') {
  const r = await api(`/rest/v1/${tabla}?select=${columna}&limit=1${filtro ? `&${filtro}` : ''}`, { jwt: JWT, count: true })
  if (!r.ok) return { error: motivo(r) }
  const total = Number(String(r.contentRange || '').split('/')[1])
  if (!Number.isFinite(total)) return { error: `sin content-range (${r.contentRange})` }
  return { total }
}

// Prueba de existencia de una columna/tabla: si la migración no se aplicó,
// PostgREST responde 400/404 con el código de Postgres (42703 columna
// inexistente, 42P01/PGRST205 tabla inexistente).
async function existeColumna(tabla, columna) {
  const r = await api(`/rest/v1/${tabla}?select=${columna}&limit=1`, { jwt: JWT })
  if (r.ok) return { existe: true }
  const cuerpo = JSON.stringify(r.data || '')
  if (/42703|42P01|PGRST205|PGRST20[12]/.test(cuerpo) || r.status === 404) return { existe: false, detalle: motivo(r) }
  return { indeterminado: true, detalle: motivo(r) }
}

// ---------------------------------------------------------------------------
// Acumulador de secciones. Cada sección junta resultados y al final se colapsa
// a un solo estado; el detalle se guarda para imprimir solo lo no-PASS.
// ---------------------------------------------------------------------------
const secciones = []
// `critica: false` solo para secciones cuya fuente de datos no existe en el
// esquema actual (y que por tanto no pueden comprobarse leyendo). Todo lo demás
// es crítico por defecto: si no se pudo verificar, el release no está validado.
function seccion(nombre, { critica = true } = {}) {
  const s = { nombre, critica, ok: 0, fallos: [], avisos: [], omitidos: [] }
  secciones.push(s)
  return {
    pass() { s.ok++ },
    check(condicion, mensaje) { if (condicion) s.ok++; else s.fallos.push(mensaje) },
    fail(mensaje) { s.fallos.push(mensaje) },
    warn(mensaje) { s.avisos.push(mensaje) },
    skip(mensaje) { s.omitidos.push(mensaje) },
  }
}

// Lee una clave de la respuesta de diagnóstico exigiendo que EXISTA y sea un
// array. Un `d.loQueSea || []` convertiría "la RPC ya no devuelve esa clave" en
// "no hay problemas": el fallo se volvería invisible justo cuando el
// diagnóstico dejó de funcionar. Aquí eso es un FAIL explícito.
function listaDe(s, d, clave) {
  const v = d?.[clave]
  if (Array.isArray(v)) return v
  s.fail(`el diagnóstico no devolvió la clave "${clave}" (recibido: ${v === undefined ? 'ausente' : JSON.stringify(v).slice(0, 80)}); no se puede afirmar que no haya problemas`)
  return null
}

function estadoDe(s) {
  if (s.fallos.length) return 'FAIL'
  if (!s.ok) return s.critica ? 'FAIL (sin fuente de datos)' : 'SKIP (sin fuente de datos)'
  // Los omitidos se evalúan ANTES que los avisos. Al revés, un warn rutinario
  // (por ejemplo "hay reservas vencidas") cortocircuitaba el estado a WARN y
  // enmascaraba un check crítico que no se llegó a ejecutar: el skip salía en
  // el detalle pero no bloqueaba el release.
  if (s.omitidos.length) return s.critica ? 'FAIL (verificación incompleta)' : 'PASS (parcial)'
  if (s.avisos.length) return 'WARN'
  return 'PASS'
}

function imprimirResumen() {
  const ancho = Math.max(...secciones.map((s) => s.nombre.length)) + 5
  console.log('PRODUCTION FINAL ACCEPTANCE TEST\n')
  for (const s of secciones) {
    const puntos = '.'.repeat(Math.max(3, ancho - s.nombre.length))
    console.log(`${s.nombre} ${puntos} ${estadoDe(s)}`)
  }

  const conDetalle = secciones.filter((s) => s.fallos.length || s.avisos.length || s.omitidos.length)
  if (conDetalle.length) {
    console.log('\nDetalle:')
    for (const s of conDetalle) {
      for (const m of s.fallos) console.log(`  [FAIL] ${s.nombre}: ${m}`)
      for (const m of s.avisos) console.log(`  [WARN] ${s.nombre}: ${m}`)
      for (const m of s.omitidos) console.log(`  [SKIP] ${s.nombre}: ${m}`)
    }
  }

  // Cuenta como crítico cualquier sección cuyo estado empiece por FAIL, no solo
  // las que acumularon mensajes: una sección crítica que no consiguió datos o
  // que quedó a medias no verificó el release, y eso no puede salir en verde.
  const seccionesEnFallo = secciones.filter((s) => estadoDe(s).startsWith('FAIL'))
  const criticos = seccionesEnFallo.reduce((n, s) => n + Math.max(1, s.fallos.length), 0)
  const avisos = secciones.reduce((n, s) => n + s.avisos.length, 0)
  console.log(`\nCritical errors: ${criticos}`)
  console.log(`Warnings: ${avisos}`)
  console.log(`STATUS: ${criticos ? 'FAIL — no desplegar' : 'PASS'}`)
  return criticos
}

// ---------------------------------------------------------------------------
async function main() {
  JWT = await login()

  // Las dos RPC de introspección existentes. Se piden una sola vez y todas las
  // secciones leen de acá: son las únicas fuentes que ven grants, RLS y
  // definición de funciones, cosas invisibles desde PostgREST.
  const diagRes = await api('/rest/v1/rpc/diagnostico_integridad_admin', { method: 'POST', jwt: JWT, body: {} })
  const healthRes = await api('/rest/v1/rpc/release_health_admin', { method: 'POST', jwt: JWT, body: {} })
  const p04Res = await api('/rest/v1/rpc/p04_invariantes_admin', { method: 'POST', jwt: JWT, body: {} })
  const d = diagRes.ok && diagRes.data && typeof diagRes.data === 'object' ? diagRes.data : null
  const hRaw = healthRes.ok ? healthRes.data : null
  const h = Array.isArray(hRaw) ? hRaw[0] || null : hRaw
  const p04 = p04Res.ok && p04Res.data && typeof p04Res.data === 'object' ? p04Res.data : null

  // --- P0.4 invariants -----------------------------------------------------
  // Lo que este release arregla, comprobado explícitamente. Si la RPC no
  // responde, la sección es FAIL: sin ella no hay forma de ver desde fuera si
  // las migraciones del release hicieron lo que dicen.
  {
    const s = seccion('P0.4 invariants')
    if (!p04) {
      s.fail(`p04_invariantes_admin() no respondió: ${motivo(p04Res)}. Sin esta RPC los invariantes de P0.4 NO están verificados.`)
    } else {
      // R8 — el bug que habría vaciado 4 pantallas al desplegar el frontend.
      s.check(p04.products_is_test_existe === true, 'products.is_test no existe: la migración A no está aplicada')
      s.check(p04.products_is_test_not_null === true, 'products.is_test admite NULL')
      s.check(p04.products_is_test_visible_authenticated === true,
        'authenticated NO puede SELECCIONAR products.is_test: los filtros del frontend fallarán con 42501 y dejarán Inventario/Compras/Transferencias/Comparador vacíos (falta el grant por columna)')
      s.check(p04.products_costo_oculto_authenticated === true,
        'products.costo quedó visible para authenticated: el grant por columna se relajó de más')

      // R1
      s.check(p04.product_variants_product_id_not_null === true,
        'product_variants.product_id volvió a admitir NULL: una variante sin producto desaparece de los filtros y oculta stock real')

      // R6 — la carrera que resucitaba stock vendido.
      s.check(p04.cierre_conteo_orden_seguro === true,
        'cerrar_inventario_fisico NO deriva el stock serializado por sincronizar_stock_serializado: volvió a contar los seriales antes de bloquear inventory (R6, resucita stock vendido)')
      s.check(p04.sincronizar_bloquea_antes_de_contar === true,
        'sincronizar_stock_serializado ya no bloquea inventory antes de contar los seriales (R6)')
      s.check(Number(p04.sincronizar_expuesta_en_api) === 0,
        `${p04.sincronizar_expuesta_en_api} funciones private.sincronizar_* expuestas a la API`)

      // Matriz de transiciones
      s.check(p04.movimiento_posterior_permitido === true,
        'la CHECK de tipo_resolucion no admite movimiento_posterior: un conteo con una unidad movida no se puede cerrar')
      s.check(p04.matriz_valida_estado_previo === true,
        'resolver_reconciliacion_serial no valida el estado previo del IMEI en servidor')

      // F3 — ventas en el libro mayor. Solo es exigible si hubo ventas después
      // de la migración; si no las hubo, no hay evidencia que pedir.
      s.check(p04.venta_escribe_ledger === true,
        'descontar_inventario no escribe en inventory_movements: las ventas vuelven a ser invisibles en el libro mayor')
      // Si no se sabe DESDE CUÁNDO mirar, no se puede afirmar nada: sin este
      // check, un corte sin resolver colapsaba los contadores a 0 y se leía
      // como "todavía no hubo ventas", apagando justo el detector que importa.
      s.check(p04.corte_resuelto === true,
        'no se pudo determinar desde cuándo exigir movimientos de venta (la migración del ledger no consta aplicada): el ledger NO está verificado')
      if (p04.corte_resuelto === true) {
        // Se compara contra TODAS las líneas, no sólo las reales: el trigger
        // escribe un movimiento por sale_item sin mirar is_test, así que los
        // movimientos de ventas de prueba ya están dentro del total esperado y
        // no pueden tapar líneas reales que no escribieron.
        // Se usa >= y no igualdad porque una venta offline sincronizada tarde
        // tiene `fecha` anterior al corte y su movimiento posterior: eso suma
        // movimientos sin sumar líneas, y no es un fallo.
        const lineasTodas = Number(p04.lineas_todas_desde_migracion)
        const movs = Number(p04.movimientos_venta_desde_migracion)
        if (lineasTodas > 0) {
          s.check(movs >= lineasTodas,
            `${lineasTodas} líneas de venta desde la migración pero solo ${movs} movimientos 'Venta': alguna venta no está escribiendo en el libro mayor`)
        } else {
          s.warn(`aún no hay líneas de venta posteriores a la migración (${p04.ventas_desde_migracion} ventas): el ledger está verificado por definición, no por datos`)
        }
      }

      // Aislamiento QA
      s.check(Number(p04.qa_unidades_operativas) === 0, `${p04.qa_unidades_operativas} unidades QA siguen contando como stock`)
      s.check(Number(p04.qa_valorizacion) === 0, `la valorización incluye S/ ${p04.qa_valorizacion} de catálogo QA`)
      s.check(Number(p04.qa_sin_marcar) === 0, `${p04.qa_sin_marcar} productos con pinta de QA sin marcar is_test`)
      // R4 — el saneamiento deja las filas QA en cantidad 0, y `0 <=
      // stock_minimo` es cierto siempre: sin filtro se vuelven "stock crítico"
      // permanente e irresoluble. Aquí se mide cuántas alertas falsas está
      // suprimiendo el filtro; que sean > 0 es exactamente lo que se espera.
      const falsosCriticos = Number(p04.stock_critico_sin_filtrar_qa) - Number(p04.stock_critico_real)
      s.check(Number.isFinite(falsosCriticos) && falsosCriticos >= 0,
        `stock_critico_real (${p04.stock_critico_real}) supera al total sin filtrar (${p04.stock_critico_sin_filtrar_qa}): el filtro de QA no puede añadir críticos`)
      if (falsosCriticos > 0) {
        s.warn(`el filtro de is_test está suprimiendo ${falsosCriticos} alertas de stock crítico que serían falsas e irresolubles (R4)`)
      }

      // Invariantes que no deberían poder existir nunca.
      s.check(Number(p04.inventario_negativo) === 0, `${p04.inventario_negativo} filas de inventory con cantidad negativa`)
      s.check(Number(p04.imei_vendido_sin_venta) === 0, `${p04.imei_vendido_sin_venta} IMEI vendidos sin venta asociada`)
      s.check(Number(p04.imei_disponible_con_venta) === 0, `${p04.imei_disponible_con_venta} IMEI disponibles con sale_id`)

      // Paridad de migraciones: se comprueba QUÉ migraciones están aplicadas,
      // no cuántas. Un contador cuadra igual si falta la del ledger y sobra
      // otra distinta, que es justo el caso que hay que detectar.
      const p04Migs = Array.isArray(p04.migraciones_p04) ? p04.migraciones_p04 : null
      if (!p04Migs) {
        s.fail('p04_invariantes_admin() no devolvió la lista de migraciones p04_*')
      } else {
        const esperadas = [
          ['p04_a', 'catálogo de prueba y saneamiento QA'],
          ['p04_b', 'ledger de ventas y stock serializado con delta real'],
          ['p04_c', 'matriz de transiciones de IMEI'],
          ['p04_d', 'revocación de funciones de trigger a anon'],
          ['p04_e', 'cierre de conteo con lock antes de contar (R6)'],
          ['p04_f', 'grant de products.is_test a authenticated (R8)'],
          ['p04_g', 'invariantes de verificación (R7)'],
        ]
        const faltan = esperadas.filter(([pref]) => !p04Migs.some((m) => String(m).includes(pref)))
        s.check(faltan.length === 0,
          `faltan migraciones del release: ${faltan.map(([p, d]) => `${p} (${d})`).join(', ')}`)
      }
    }
  }

  // --- Release -------------------------------------------------------------
  {
    const s = seccion('Release')
    if (!h) {
      s.fail(`release_health_admin() no respondió o la cuenta no es administradora: ${motivo(healthRes)}`)
    } else {
      s.check(h.healthy === true, `release_health_admin().healthy = ${h.healthy} (se esperaba true)`)
      s.check(Number(h.public_tables) > 0, `public_tables = ${h.public_tables} (el esquema no parece desplegado)`)
      if (Number(h.whatsapp_fallidos) > 0) s.warn(`${h.whatsapp_fallidos} envíos de WhatsApp fallidos pendientes de revisión`)
      if (Number(h.conciliaciones_pendientes) > 0) s.warn(`${h.conciliaciones_pendientes} conciliaciones de pago pendientes`)
      if (Number(h.solicitudes_personal_pendientes) > 0) s.warn(`${h.solicitudes_personal_pendientes} solicitudes de personal pendientes`)
    }
  }

  // --- Database migrations -------------------------------------------------
  // Se prueba la superficie que introdujeron las migraciones del release: si
  // una no se aplicó, la columna/tabla simplemente no existe y PostgREST lo
  // dice. Es la comprobación más directa que se puede hacer sin acceso al
  // catálogo de migraciones (schema_migrations no está expuesto por PostgREST).
  {
    const s = seccion('Database migrations')
    const sondas = [
      ['products', 'is_test'],
      ['sales', 'is_test'],
      ['cash_sessions', 'is_test'],
      ['pos_devices', 'device_id'],
      ['inventario_fisico_seriales', 'serial_id'],
      ['cierres_diarios', 'fecha'],
      ['cash_movements', 'id'],
      ['serial_reservations', 'expires_at'],
      ['cupones', 'codigo'],
      ['promociones', 'acumulable'],
    ]
    for (const [tabla, columna] of sondas) {
      const r = await existeColumna(tabla, columna)
      if (r.existe) s.pass()
      else if (r.existe === false) s.fail(`falta ${tabla}.${columna} — la migración correspondiente NO está aplicada (${r.detalle})`)
      else s.skip(`no se pudo comprobar ${tabla}.${columna}: ${r.detalle}`)
    }
  }

  // --- RPC / triggers ------------------------------------------------------
  {
    const s = seccion('RPC/triggers')
    if (!d) {
      s.fail(`diagnostico_integridad_admin() no respondió: ${motivo(diagRes)}`)
    } else {
      s.check(d.consumir_autorizacion_descuento_revocada === true,
        'consumir_autorizacion_descuento sigue siendo invocable (consumía la autorización fuera de la venta)')
      s.check(d.registrar_uso_cupon_revocada === true,
        'registrar_uso_cupon sigue siendo invocable (contabilizaba el cupón fuera de la venta)')
      s.check(d.consultar_autorizacion_descuento_otorgada === true,
        'consultar_autorizacion_descuento (solo lectura) no está disponible para el POS')
      s.check(d.registrar_venta_acepta_codigo_cupon === true,
        'registrar_venta no valida/consume el cupón dentro de su propia transacción')
      s.check(d.inventario_fisico_seriales_existe === true,
        'la reconciliación de conteo físico por IMEI/serie no está desplegada')
      const sobrecargas = listaDe(s, d, 'rpc_con_sobrecargas_ambiguas')
      if (sobrecargas) {
        s.check(sobrecargas.length === 0,
          `${sobrecargas.length} RPC con sobrecargas ambiguas (PostgREST puede resolver a la versión vieja): ${JSON.stringify(sobrecargas).slice(0, 300)}`)
      }
    }
    // Los triggers ya no son una caja negra: p04_invariantes_admin los lista.
    if (!p04) {
      s.fail('sin p04_invariantes_admin() no se puede comprobar qué triggers siguen desplegados')
    } else {
      const trg = Array.isArray(p04.triggers_criticos) ? p04.triggers_criticos : null
      if (!trg) s.fail('p04_invariantes_admin() no devolvió triggers_criticos')
      else {
        const nombres = trg.join(' ')
        s.check(/descontar_inventario/.test(nombres),
          `el trigger que descuenta stock en cada venta no está desplegado: ${JSON.stringify(trg).slice(0, 200)}`)
        s.check(trg.length > 0, 'no hay ningún trigger en sales/sale_items/cash_movements/product_serials')
      }
    }
  }

  // --- Security ------------------------------------------------------------
  {
    const s = seccion('Security')
    if (h) {
      s.check(Number(h.tables_without_rls) === 0, `${h.tables_without_rls} tablas de public sin RLS`)
      s.check(Number(h.anon_tables) === 0, `${h.anon_tables} tablas de public con grants para anon`)
      s.check(Number(h.anon_secdef) === 0, `${h.anon_secdef} funciones SECURITY DEFINER ejecutables por anon`)
    } else {
      s.skip('release_health_admin() no respondió: sin datos de RLS/grants')
    }
    if (d) {
      const expuestas = listaDe(s, d, 'security_definer_ejecutables_por_anon')
      if (expuestas) {
        s.check(expuestas.length === 0,
          `${expuestas.length} funciones SECURITY DEFINER ejecutables por anon: ${JSON.stringify(expuestas).slice(0, 300)}`)
      }
    } else {
      s.skip('diagnostico_integridad_admin() no respondió: sin el detalle de funciones expuestas a anon')
    }
  }

  // --- QA isolation --------------------------------------------------------
  // Producción no debe tener residuos de las suites mutantes, y lo que quede
  // marcado como prueba debe estar efectivamente marcado (is_test) para que las
  // cifras financieras lo excluyan.
  {
    const s = seccion('QA isolation')
    if (d) {
      const qa = listaDe(s, d, 'productos_qa_activos_en_produccion')
      if (qa) {
        s.check(qa.length === 0, `${qa.length} productos QA-INTEGRITY activos en producción: ${JSON.stringify(qa).slice(0, 300)}`)
      }
      if (typeof d.ventas_marcadas_como_prueba === 'number' && d.ventas_marcadas_como_prueba > 0) {
        s.warn(`${d.ventas_marcadas_como_prueba} ventas marcadas is_test en producción (excluidas de finanzas, pero revisar su origen)`)
      }
    } else {
      s.skip('diagnostico_integridad_admin() no respondió: sin inventario de residuos QA')
    }
    const prodTest = await contar('products', 'is_test=is.true')
    if (prodTest.error) s.skip(`no se pudo contar products.is_test: ${prodTest.error}`)
    else { s.pass(); if (prodTest.total > 0) s.warn(`${prodTest.total} productos marcados is_test en producción`) }
    const cajasTest = await contar('cash_sessions', 'is_test=is.true')
    if (cajasTest.error) s.skip(`no se pudo contar cash_sessions.is_test: ${cajasTest.error}`)
    else { s.pass(); if (cajasTest.total > 0) s.warn(`${cajasTest.total} cajas marcadas is_test en producción`) }
  }

  // --- Sales integrity -----------------------------------------------------
  {
    const s = seccion('Sales integrity')
    const negativas = await contar('sales', 'total=lt.0')
    if (negativas.error) s.skip(`no se pudo contar ventas con total negativo: ${negativas.error}`)
    else s.check(negativas.total === 0, `${negativas.total} ventas con total negativo`)

    const revision = await contar('sales', 'estado=eq.revision_requerida')
    if (revision.error) s.skip(`no se pudo contar ventas en revisión: ${revision.error}`)
    else { s.pass(); if (revision.total > 0) s.warn(`${revision.total} ventas en estado revision_requerida`) }

    const huerfanas = await contar('sales', 'cajero_id=is.null')
    if (huerfanas.error) s.skip(`no se pudo contar ventas sin cajero: ${huerfanas.error}`)
    else s.check(huerfanas.total === 0, `${huerfanas.total} ventas sin cajero asociado`)

    // El cuadre agregado tampoco es ya inverificable.
    if (!p04) {
      s.fail('sin p04_invariantes_admin() no se puede comprobar el cuadre de las ventas')
    } else {
      s.check(Number(p04.ventas_descuadradas) === 0,
        `${p04.ventas_descuadradas} ventas completadas donde subtotal + impuesto no cuadra con total`)
      s.check(Number(p04.ventas_sin_lineas) === 0,
        `${p04.ventas_sin_lineas} ventas completadas sin ninguna línea de venta`)
    }
  }

  // --- Cash integrity ------------------------------------------------------
  {
    const s = seccion('Cash integrity')
    if (d) {
      const cajas = listaDe(s, d, 'cash_sessions_abiertas_hace_mas_de_2_dias')
      if (cajas) {
        s.pass()
        // Una caja abierta más de 2 días es sospechosa pero no siempre es un bug
        // (un feriado largo la deja abierta): se reporta, no tumba el release.
        if (cajas.length) s.warn(`${cajas.length} cajas abiertas hace más de 2 días: ${JSON.stringify(cajas).slice(0, 300)}`)
      }
    } else {
      s.skip('diagnostico_integridad_admin() no respondió: sin cajas trabadas')
    }
    const inicialNegativo = await contar('cash_sessions', 'monto_inicial=lt.0')
    if (inicialNegativo.error) s.skip(`no se pudo contar cajas con monto inicial negativo: ${inicialNegativo.error}`)
    else s.check(inicialNegativo.total === 0, `${inicialNegativo.total} cajas con monto_inicial negativo`)

    const cerradasSinConteo = await contar('cash_sessions', 'cierre=not.is.null&monto_final_contado=is.null')
    if (cerradasSinConteo.error) s.skip(`no se pudo contar cajas cerradas sin conteo: ${cerradasSinConteo.error}`)
    else s.check(cerradasSinConteo.total === 0, `${cerradasSinConteo.total} cajas cerradas sin monto_final_contado`)

    const movimientos = await contar('cash_movements')
    if (movimientos.error) s.skip(`no se pudo leer el libro de cash_movements: ${movimientos.error}`)
    else s.pass()
  }

  // --- Inventory -----------------------------------------------------------
  {
    const s = seccion('Inventory')
    const negativo = await contar('inventory', 'cantidad=lt.0', 'variant_id')
    if (negativo.error) s.skip(`no se pudo contar stock negativo: ${negativo.error}`)
    else s.check(negativo.total === 0, `${negativo.total} filas de inventory con cantidad negativa (invariante "nunca stock negativo" rota)`)

    if (d) {
      const conteos = listaDe(s, d, 'conteos_fisicos_abiertos_hace_mas_de_2_dias')
      if (conteos) {
        s.check(conteos.length === 0, `${conteos.length} conteos físicos abiertos hace más de 2 días: ${JSON.stringify(conteos).slice(0, 300)}`)
      }
    } else {
      s.skip('diagnostico_integridad_admin() no respondió: sin conteos trabados')
    }
  }

  // --- IMEI ----------------------------------------------------------------
  {
    const s = seccion('IMEI')
    const vendidoSinVenta = await contar('product_serials', 'estado=eq.vendido&sale_id=is.null')
    if (vendidoSinVenta.error) s.skip(`no se pudo contar seriales vendidos sin venta: ${vendidoSinVenta.error}`)
    else s.check(vendidoSinVenta.total === 0, `${vendidoSinVenta.total} seriales en estado 'vendido' sin sale_id`)

    const disponibleConVenta = await contar('product_serials', 'estado=eq.disponible&sale_id=not.is.null')
    if (disponibleConVenta.error) s.skip(`no se pudo contar seriales disponibles con venta: ${disponibleConVenta.error}`)
    else s.check(disponibleConVenta.total === 0, `${disponibleConVenta.total} seriales 'disponible' con sale_id (unidad vendida y otra vez a la venta)`)

    const ahora = new Date().toISOString()
    const reservasVencidas = await contar('serial_reservations', `expires_at=lt.${ahora}`)
    if (reservasVencidas.error) s.skip(`no se pudo contar reservas de IMEI vencidas: ${reservasVencidas.error}`)
    else { s.pass(); if (reservasVencidas.total > 0) s.warn(`${reservasVencidas.total} reservas de IMEI vencidas sin liberar (se purgan al vender, pero bloquean el selector mientras tanto)`) }
  }

  // --- Promotions / coupons ------------------------------------------------
  {
    const s = seccion('Promotions/coupons')
    // La comparación columna-contra-columna (usos > max_usos) no existe en
    // PostgREST: se traen solo los cupones con tope (pocos por definición) y se
    // compara acá. Sigue siendo una lectura.
    const r = await api('/rest/v1/cupones?select=codigo,usos,max_usos,activo&max_usos=not.is.null&limit=1000', { jwt: JWT })
    if (!r.ok || !Array.isArray(r.data)) {
      s.skip(`no se pudieron leer los cupones con tope de usos: ${motivo(r)}`)
    } else {
      const excedidos = r.data.filter((c) => Number(c.usos) > Number(c.max_usos))
      s.check(excedidos.length === 0, `${excedidos.length} cupones usados por encima de max_usos: ${JSON.stringify(excedidos.map((c) => c.codigo)).slice(0, 200)}`)
    }
    const vencidasActivas = await contar('promociones', `activo=is.true&fecha_fin=lt.${new Date().toISOString()}`)
    if (vencidasActivas.error) s.skip(`no se pudieron contar promociones vencidas activas: ${vencidasActivas.error}`)
    else { s.pass(); if (vencidasActivas.total > 0) s.warn(`${vencidasActivas.total} promociones marcadas activas con fecha_fin ya pasada (no aplican, pero ensucian el catálogo)`) }
  }

  // --- Authorizations ------------------------------------------------------
  {
    const s = seccion('Authorizations')
    const consumidaSinFecha = await contar('autorizaciones_operativas', 'estado=eq.consumida&consumed_at=is.null')
    if (consumidaSinFecha.error) s.skip(`no se pudieron contar autorizaciones consumidas: ${consumidaSinFecha.error}`)
    else s.check(consumidaSinFecha.total === 0, `${consumidaSinFecha.total} autorizaciones 'consumida' sin consumed_at (consumo fuera de la transacción de venta)`)

    const resueltaSinFecha = await contar('autorizaciones_operativas', 'estado=in.(aprobada,rechazada)&resolved_at=is.null')
    if (resueltaSinFecha.error) s.skip(`no se pudieron contar autorizaciones resueltas: ${resueltaSinFecha.error}`)
    else s.check(resueltaSinFecha.total === 0, `${resueltaSinFecha.total} autorizaciones resueltas sin resolved_at`)

    const hace48h = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
    const pendientesViejas = await contar('autorizaciones_operativas', `estado=eq.pendiente&created_at=lt.${hace48h}`)
    if (pendientesViejas.error) s.skip(`no se pudieron contar autorizaciones pendientes: ${pendientesViejas.error}`)
    else { s.pass(); if (pendientesViejas.total > 0) s.warn(`${pendientesViejas.total} autorizaciones pendientes hace más de 48 h`) }
  }

  // --- Daily close ---------------------------------------------------------
  // Ojo: cierres_diarios tiene RLS por sucursal del admin autenticado, así que
  // estos números son los de SU sucursal, no los de toda la empresa.
  {
    const s = seccion('Daily close')
    const total = await contar('cierres_diarios')
    if (total.error) {
      s.skip(`no se pudieron leer los cierres diarios: ${total.error}`)
    } else {
      s.pass()
      const ultimo = await api('/rest/v1/cierres_diarios?select=fecha&order=fecha.desc&limit=1', { jwt: JWT })
      if (!ultimo.ok || !Array.isArray(ultimo.data)) {
        s.skip(`no se pudo leer el último cierre diario: ${motivo(ultimo)}`)
      } else if (!ultimo.data.length) {
        s.warn('no hay ningún cierre diario registrado para la sucursal de esta cuenta')
      } else {
        const dias = Math.floor((Date.now() - Date.parse(`${ultimo.data[0].fecha}T00:00:00Z`)) / 86400000)
        s.pass()
        if (dias > 3) s.warn(`el último cierre diario visible es del ${ultimo.data[0].fecha} (hace ${dias} días)`)
      }
      const descuadrados = await contar('cierres_diarios', 'diferencia_cajas=neq.0')
      if (descuadrados.error) s.skip(`no se pudieron contar cierres descuadrados: ${descuadrados.error}`)
      else { s.pass(); if (descuadrados.total > 0) s.warn(`${descuadrados.total} cierres diarios con diferencia de cajas distinta de cero`) }
    }
  }

  // --- POS devices ---------------------------------------------------------
  {
    const s = seccion('POS devices')
    const activos = await contar('pos_devices', 'activo=is.true')
    if (activos.error) {
      s.skip(`no se pudo leer pos_devices: ${activos.error}`)
    } else {
      // Haber podido leer pos_devices ya es una comprobación: la tabla existe y
      // es legible con las políticas vigentes.
      s.pass()
      // 0 terminales NO es un fallo de software: el mecanismo está validado y
      // registrar una terminal física es una acción operativa externa. Se
      // reporta el número real y se clasifica, no se inventan dispositivos.
      if (activos.total === 0) {
        s.warn('0 terminales POS registradas — ACTIVACIÓN OPERATIVA EXTERNA pendiente (el mecanismo está verificado; falta dar de alta la terminal física)')
      }
      const fueraServicio = await contar('pos_devices', 'fuera_de_servicio=is.true')
      if (!fueraServicio.error && fueraServicio.total > 0) s.warn(`${fueraServicio.total} terminales marcadas fuera de servicio`)
      const conFallos = await contar('pos_devices', 'failed_sales_count=gt.0')
      if (!conFallos.error && conFallos.total > 0) s.warn(`${conFallos.total} terminales con ventas offline fallidas sin sincronizar`)
      const conPendientes = await contar('pos_devices', 'pending_sales_count=gt.0')
      if (!conPendientes.error && conPendientes.total > 0) s.warn(`${conPendientes.total} terminales con ventas offline pendientes de sincronizar`)
    }
  }

  // --- Reports -------------------------------------------------------------
  // reportes_avanzados_admin es `stable` + security definer: ejecutarla no
  // escribe nada. Se pide el día de hoy en hora de Lima; lo que se verifica es
  // que el reporte responde y trae la forma esperada, no sus cifras.
  {
    const s = seccion('Reports')
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
    const r = await api('/rest/v1/rpc/reportes_avanzados_admin', {
      method: 'POST', jwt: JWT, body: { p_desde: hoy, p_hasta: hoy },
    })
    if (!r.ok) s.fail(`reportes_avanzados_admin(${hoy}, ${hoy}) falló: ${motivo(r)}`)
    else s.check(r.data !== null && typeof r.data === 'object', 'reportes_avanzados_admin devolvió una respuesta que no es un objeto JSON')

    const g = await api(`/rest/v1/rpc/resumen_ganancias`, {
      method: 'POST', jwt: JWT, body: { fecha_desde: `${hoy}T00:00:00-05:00`, fecha_hasta: `${hoy}T23:59:59-05:00` },
    })
    if (!g.ok) s.warn(`resumen_ganancias falló para hoy: ${motivo(g)}`)
    else s.pass()
  }

  const criticos = imprimirResumen()
  process.exitCode = criticos ? 1 : 0
}

main().catch((e) => {
  console.log('PRODUCTION FINAL ACCEPTANCE TEST\n')
  console.error(`ERROR: la aceptación final no pudo ejecutarse: ${e && e.message ? e.message : e}`)
  console.log('\nCritical errors: 1')
  console.log('Warnings: 0')
  process.exitCode = 1
})
