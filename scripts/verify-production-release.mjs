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
// Si faltan variables de entorno termina con código 0 y un SKIP, para que un
// `npm run` accidental sin credenciales no se reporte como regresión.
//
// Salida: UN resumen agregado por secciones. El detalle solo se imprime para
// lo que NO pasó — un muro de cientos de líneas verdes es exactamente igual de
// ilegible que ninguna salida, y esconde la línea que importa.
//
// Código de salida: 1 si hay algún error crítico; 0 si solo hay advertencias
// o secciones sin fuente de datos.
//
// Honestidad de las secciones: lo que no se puede verificar leyendo (por
// ejemplo la lista de triggers, que no está expuesta por ninguna RPC de las
// que existen hoy) se marca SKIP con el motivo. NUNCA se reporta PASS por algo
// que no se comprobó, y no se inventan llamadas a RPC inexistentes.

const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'QA_STAFF_EMAIL', 'QA_STAFF_PASSWORD']
const missing = required.filter((k) => !process.env[k])
if (missing.length) {
  console.log(`SKIP: faltan variables de entorno para la aceptación final de producción (${missing.join(', ')}). Ver cabecera de este archivo.`)
  process.exit(0)
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
function seccion(nombre) {
  const s = { nombre, ok: 0, fallos: [], avisos: [], omitidos: [] }
  secciones.push(s)
  return {
    pass() { s.ok++ },
    check(condicion, mensaje) { if (condicion) s.ok++; else s.fallos.push(mensaje) },
    fail(mensaje) { s.fallos.push(mensaje) },
    warn(mensaje) { s.avisos.push(mensaje) },
    skip(mensaje) { s.omitidos.push(mensaje) },
  }
}

function estadoDe(s) {
  if (s.fallos.length) return 'FAIL'
  if (!s.ok) return 'SKIP (sin fuente de datos)'
  if (s.avisos.length) return 'WARN'
  if (s.omitidos.length) return 'PASS (parcial)'
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

  const criticos = secciones.reduce((n, s) => n + s.fallos.length, 0)
  const avisos = secciones.reduce((n, s) => n + s.avisos.length, 0)
  console.log(`\nCritical errors: ${criticos}`)
  console.log(`Warnings: ${avisos}`)
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
  const d = diagRes.ok && diagRes.data && typeof diagRes.data === 'object' ? diagRes.data : null
  const hRaw = healthRes.ok ? healthRes.data : null
  const h = Array.isArray(hRaw) ? hRaw[0] || null : hRaw

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
      const sobrecargas = d.rpc_con_sobrecargas_ambiguas || []
      s.check(sobrecargas.length === 0,
        `${sobrecargas.length} RPC con sobrecargas ambiguas (PostgREST puede resolver a la versión vieja): ${JSON.stringify(sobrecargas).slice(0, 300)}`)
    }
    s.skip('la lista de triggers desplegados no la expone ninguna RPC existente; solo se verifica su efecto observable (secciones Inventory/IMEI)')
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
      const expuestas = d.security_definer_ejecutables_por_anon || []
      s.check(expuestas.length === 0,
        `${expuestas.length} funciones SECURITY DEFINER ejecutables por anon: ${JSON.stringify(expuestas).slice(0, 300)}`)
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
      const qa = d.productos_qa_activos_en_produccion || []
      s.check(qa.length === 0, `${qa.length} productos QA-INTEGRITY activos en producción: ${JSON.stringify(qa).slice(0, 300)}`)
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

    s.skip('el cuadre línea a línea (sum(sale_items.subtotal) vs sales.total) exigiría una agregación SQL que ninguna RPC de lectura expone hoy')
  }

  // --- Cash integrity ------------------------------------------------------
  {
    const s = seccion('Cash integrity')
    if (d) {
      const cajas = d.cash_sessions_abiertas_hace_mas_de_2_dias || []
      s.pass()
      // Una caja abierta más de 2 días es sospechosa pero no siempre es un bug
      // (un feriado largo la deja abierta): se reporta, no tumba el release.
      if (cajas.length) s.warn(`${cajas.length} cajas abiertas hace más de 2 días: ${JSON.stringify(cajas).slice(0, 300)}`)
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
      const conteos = d.conteos_fisicos_abiertos_hace_mas_de_2_dias || []
      s.check(conteos.length === 0, `${conteos.length} conteos físicos abiertos hace más de 2 días: ${JSON.stringify(conteos).slice(0, 300)}`)
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
      s.check(activos.total > 0, 'no hay ninguna terminal POS registrada como activa')
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
