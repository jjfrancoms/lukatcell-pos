import fs from 'node:fs'

function read(path) { return fs.readFileSync(path, 'utf8') }
function assert(condition, message) {
  if (!condition) { console.error(`FAIL: ${message}`); process.exitCode = 1 }
  else console.log(`PASS: ${message}`)
}

const login = read('src/pages/Login.tsx')
const personal = read('src/pages/Personal.tsx')
const jornada = read('src/pages/MiJornada.tsx')
const permisos = read('src/pages/PermisosPersonal.tsx')
const cambiosTurno = read('src/pages/CambiosTurno.tsx')
const anulaciones = read('src/pages/Anulaciones.tsx')
const devoluciones = read('src/pages/Devoluciones.tsx')
const notas = read('src/pages/NotasCredito.tsx')
const autorizaciones = read('src/pages/Autorizaciones.tsx')
const cierre = read('src/pages/CierreDiario.tsx')
const proveedores = read('src/pages/Proveedores.tsx')
const compras = read('src/pages/Compras.tsx')
const transferencias = read('src/pages/Transferencias.tsx')
const conteo = read('src/pages/ConteoInventario.tsx')
const seriales = read('src/pages/Seriales.tsx')
const selectorSeriales = read('src/components/SelectorSeriales.tsx')
const taller = read('src/pages/Taller.tsx')
const app = read('src/App.tsx')
const layout = read('src/components/Layout.tsx')
const dashboard = read('src/pages/DashboardAdmin.tsx')
const audit = read('src/pages/Auditoria.tsx')
const notify = read('supabase/functions/notificar-estado/index.ts')
const receipt = read('supabase/functions/emitir-comprobante/index.ts')
const creditNote = read('supabase/functions/emitir-nota-credito/index.ts')
const userLogin = read('supabase/functions/login-por-usuario/index.ts')
const bootstrap = read('supabase/functions/estado-bootstrap/index.ts')
const linkLogin = read('supabase/functions/vincular-login-personal/index.ts')

assert(!login.includes("rpc('email_por_username'"), 'Login no expone email_por_username al navegador')
assert(login.includes("functions.invoke('login-por-usuario'"), 'Login usa Edge Function login-por-usuario')
assert(login.includes("functions.invoke('estado-bootstrap'"), 'Bootstrap usa Edge Function')
assert(userLogin.includes('SUPABASE_SERVICE_ROLE_KEY'), 'login-por-usuario resuelve correo en servidor')
assert(bootstrap.includes('SUPABASE_SERVICE_ROLE_KEY'), 'estado-bootstrap usa servidor')
assert(linkLogin.includes("rol !== 'administrador'"), 'vincular-login-personal exige administrador')
assert(personal.includes("rpc('reprogramar_staff_turnos'"), 'Personal reprograma turnos transaccionalmente')
assert(!personal.includes("from('staff_turnos').delete()"), 'Personal no borra turnos directamente')

for (const [path, component] of [
  ['dashboard','DashboardAdmin'],['permisos','PermisosPersonal'],['cambios-turno','CambiosTurno'],['anulaciones','Anulaciones'],['devoluciones','Devoluciones'],['notas-credito','NotasCredito'],['cierre-diario','CierreDiario'],['proveedores','Proveedores'],['auditoria','Auditoria']
]) assert(app.includes(`path="${path}" element={<AdminRoute><${component} /></AdminRoute>}`), `${path} protegido por AdminRoute`)
assert(app.includes('path="autorizaciones" element={<Autorizaciones />}'), 'Autorizaciones disponible a personal autenticado')
for (const [path, component] of [['compras','Compras'],['transferencias','Transferencias'],['conteo-inventario','ConteoInventario'],['taller','Taller']]) {
  assert(app.includes(`path="${path}" element={<InventoryOpsRoute><${component} /></InventoryOpsRoute>}`), `${path} protegido por InventoryOpsRoute`)
}
assert(app.includes('path="seriales" element={<OperationalRoute><Seriales /></OperationalRoute>}'), 'Seriales disponible a personal operativo para reserva de venta')

assert(layout.includes("to:'/compras'"), 'Compras en navegación de inventario avanzado')
assert(layout.includes("to:'/transferencias'"), 'Transferencias en navegación de inventario avanzado')
assert(layout.includes("to:'/conteo-inventario'"), 'Conteo físico en navegación de inventario avanzado')
assert(layout.includes("to: '/seriales'"), 'Seriales en navegación operativa')
assert(layout.includes("to:'/taller'"), 'Taller en navegación técnica')
assert(layout.includes("to:'/proveedores'"), 'Proveedores solo en navegación administrativa')

assert(permisos.includes("rpc('registrar_permiso_personal'"), 'Permisos usan RPC')
assert(cambiosTurno.includes("rpc('registrar_excepcion_turno'"), 'Cambios de turno usan RPC')
assert(anulaciones.includes("rpc('anular_venta'"), 'Anulaciones usa RPC del servidor')
assert(!anulaciones.includes("from('sales').update("), 'Anulaciones no modifica sales directamente')
assert(!anulaciones.includes("from('inventory').update("), 'Anulaciones no repone stock en cliente')
assert(devoluciones.includes("rpc('registrar_devolucion'"), 'Devoluciones usa RPC transaccional')
assert(devoluciones.includes("rpc('confirmar_reembolso_devolucion'"), 'Reembolsos usan RPC')
assert(!devoluciones.includes("from('inventory').update("), 'Devoluciones no repone stock directamente')
assert(!devoluciones.includes("from('devoluciones').insert("), 'UI no inserta devoluciones directamente')
assert(notas.includes("rpc('crear_nota_credito_devolucion'"), 'Notas de crédito se crean por RPC')
assert(notas.includes("functions.invoke('emitir-nota-credito'"), 'Notas se emiten/reintentan con Edge Function')
assert(!notas.includes("from('notas_credito').insert("), 'UI no inserta notas directamente')
assert(creditNote.includes('SUPABASE_SERVICE_ROLE_KEY'), 'Edge NC usa credenciales servidor')
assert(creditNote.includes('staff.rol === "administrador"'), 'Edge NC limita reintentos a admin')
assert(creditNote.includes('documento_que_se_modifica_serie'), 'NC referencia comprobante original')

assert(autorizaciones.includes("rpc('solicitar_autorizacion'"), 'Personal solicita autorización por RPC')
assert(autorizaciones.includes("rpc('resolver_autorizacion'"), 'Admin resuelve autorización por RPC')
assert(!autorizaciones.includes("from('autorizaciones_operativas').update("), 'UI no resuelve autorizaciones directamente')
assert(cierre.includes("rpc('previsualizar_cierre_diario'"), 'Cierre diario usa preview servidor')
assert(cierre.includes("rpc('cerrar_dia'"), 'Cierre diario se ejecuta por RPC')
assert(!cierre.includes("from('cierres_diarios').insert("), 'UI no crea cierre directamente')

// P2 — abastecimiento e inventario avanzado
assert(proveedores.includes("rpc('crear_proveedor'"), 'Proveedores se guardan por RPC administrativa')
assert(!proveedores.includes("from('proveedores').insert("), 'Proveedores no se insertan directamente desde UI')
assert(compras.includes("rpc('crear_orden_compra'"), 'Órdenes de compra usan RPC')
assert(compras.includes("rpc('recibir_orden_compra'"), 'Recepción de compras usa RPC transaccional')
assert(!compras.includes("from('inventory').update("), 'Compras no modifican inventario desde UI')
assert(compras.includes('seriales'), 'Recepción contempla seriales/IMEI')
assert(transferencias.includes("rpc('crear_transferencia_stock'"), 'Transferencias se crean por RPC')
assert(transferencias.includes("rpc('despachar_transferencia_stock'"), 'Despacho usa RPC')
assert(transferencias.includes("rpc('recibir_transferencia_stock'"), 'Recepción de transferencia usa RPC')
assert(!transferencias.includes("from('inventory').update("), 'Transferencias no modifican inventario directamente')
assert(transferencias.includes("rpc('seriales_disponibles'"), 'Transferencias seleccionan seriales disponibles')
assert(conteo.includes("rpc('iniciar_inventario_fisico'"), 'Conteo físico se inicia por RPC')
assert(conteo.includes("rpc('registrar_conteo_fisico'"), 'Conteo físico registra cantidades por RPC')
assert(conteo.includes("rpc('cerrar_inventario_fisico'"), 'Conteo físico aplica diferencias solo al cierre')
assert(!conteo.includes("from('inventory').update("), 'Conteo físico no altera inventario desde UI')
assert(seriales.includes("rpc('configurar_control_serial'"), 'Control serial se configura por RPC')
assert(seriales.includes("rpc('registrar_seriales'"), 'Alta de seriales usa RPC')
assert(!seriales.includes("rpc('reservar_seriales_carrito'"), 'Seriales.tsx ya no reserva IMEI directamente (P0.1: solo el carrito reserva)')
assert(selectorSeriales.includes("rpc('reservar_seriales_carrito'"), 'La reserva de IMEI ocurre en el selector del carrito, atada al client_transaction_id')
assert(selectorSeriales.includes('cartTransactionId'), 'La reserva de IMEI está atada a un carrito específico, no solo a staff+variante')
assert(!seriales.includes("from('product_serials').insert("), 'UI no inserta IMEI/seriales directamente')

// P3 — taller avanzado
assert(taller.includes("rpc('actualizar_orden_servicio_tecnica'"), 'Taller actualiza orden mediante RPC técnica')
assert(taller.includes("rpc('agregar_repuesto_orden'"), 'Taller descuenta repuestos mediante RPC')
assert(taller.includes("rpc('retirar_repuesto_orden'"), 'Taller devuelve repuestos mediante RPC')
assert(taller.includes("rpc('registrar_foto_orden'"), 'Taller registra evidencia mediante RPC')
assert(taller.includes("storage.from('ordenes-servicio').upload"), 'Fotos se suben al bucket privado de órdenes')
assert(!taller.includes("from('inventory').update("), 'Taller no toca stock directamente')
assert(!taller.includes("from('orden_servicio_repuestos').insert("), 'Taller no inserta repuestos directamente')

assert(jornada.includes("['permiso', 'vacaciones', 'licencia']"), 'Mi Jornada reconoce permisos')
assert(dashboard.includes('personal_permisos'), 'Dashboard cuenta permisos')
assert(audit.includes("rpc('auditoria_reciente_admin'"), 'Auditoría usa RPC admin')
assert(notify.includes('token === SUPABASE_SERVICE_ROLE_KEY'), 'notificar-estado exige service role')
assert(receipt.includes("staff.rol === \"administrador\""), 'Reintentos Nubefact exigen admin')

// P0.1 — descuentos/promociones/autorizaciones end-to-end
const ventaP01 = read('src/pages/Venta.tsx')
const offlineP01 = read('src/lib/offline.ts')
const cuentasPorPagarP01 = read('src/pages/CuentasPorPagar.tsx')
const businessDateLib = read('src/lib/businessDate.ts')
const conciliacionP01 = read('src/pages/ConciliacionPagos.tsx')
const dashboardP01 = read('src/pages/DashboardAdmin.tsx')
const cambiosTurnoP01 = read('src/pages/CambiosTurno.tsx')
const permisosP01 = read('src/pages/PermisosPersonal.tsx')
const misSolicitudesP01 = read('src/pages/MisSolicitudes.tsx')
const reportesP01 = read('src/pages/Reportes.tsx')
const reportesAvanzadosP01 = read('src/pages/ReportesAvanzados.tsx')

assert(ventaP01.includes('promocionId') && ventaP01.includes('autorizacionId'), 'Venta.tsx conserva promocionId/autorizacionId por línea del carrito')
assert(offlineP01.includes('promocion_id: i.promocionId') && offlineP01.includes('autorizacion_id: i.autorizacionId'), 'registrar_venta recibe promocion_id/autorizacion_id del carrito, no solo el monto')

assert(cuentasPorPagarP01.includes("p_cash_session_id:metodo==='efectivo'?cajaId:null"), 'Pago a proveedor en efectivo envía la caja seleccionada')
assert(cuentasPorPagarP01.includes("eq('location_id',factura.location_id)"), 'El selector de caja del pago a proveedor se limita a la sucursal de la factura')

assert(fs.existsSync('src/lib/businessDate.ts'), 'Existe un helper central de fecha comercial en America/Lima')
assert(businessDateLib.includes("America/Lima"), 'El helper de fecha comercial usa la zona horaria de Lima')
for (const [nombre, contenido] of [
  ['CierreDiario.tsx', cierre],
  ['ConciliacionPagos.tsx', conciliacionP01],
  ['DashboardAdmin.tsx', dashboardP01],
  ['CambiosTurno.tsx', cambiosTurnoP01],
  ['PermisosPersonal.tsx', permisosP01],
  ['MisSolicitudes.tsx', misSolicitudesP01],
  ['Reportes.tsx', reportesP01],
  ['ReportesAvanzados.tsx', reportesAvanzadosP01],
]) {
  assert(!contenido.includes('toISOString().slice(0, 10)') && !contenido.includes('toISOString().slice(0,10)'), `${nombre} no usa UTC crudo para fecha comercial (usa businessDate)`)
}

// P0.4 — el guard de la suite mutante es código de seguridad y hasta ahora
// ninguna assertion lo protegía: se podía relajar (quitar el hardcode del
// project ref, permitir un override sobre producción, o volver a `new URL(...)`
// y romperlo en silencio) sin que `npm test` se enterara. Estas assertions
// leen scripts/verify-integrity-invariants.mjs como TEXTO — no lo ejecutan —
// para que cualquier aflojada del bloqueo rompa la suite estática.
const guardMutante = read('scripts/verify-integrity-invariants.mjs')

assert(guardMutante.includes("const PROD_SUPABASE_PROJECT_REF = 'fbwkclpgnsxuqycazumj'"),
  'El guard mutante tiene el project ref de producción hardcodeado (fbwkclpgnsxuqycazumj)')
assert(!/PROD_SUPABASE_PROJECT_REF\s*=\s*[^\n]*process\.env/.test(guardMutante),
  'El project ref de producción NO se puede configurar por variable de entorno')

const inicioBloqueProd = guardMutante.indexOf('if (refDestino === PROD_SUPABASE_PROJECT_REF) {')
assert(inicioBloqueProd !== -1,
  'El guard mutante rechaza cuando el destino es exactamente el ref de producción')
const finBloqueProd = inicioBloqueProd === -1 ? -1 : guardMutante.indexOf('\n}', inicioBloqueProd)
const bloqueProd = inicioBloqueProd === -1 || finBloqueProd === -1 ? '' : guardMutante.slice(inicioBloqueProd, finBloqueProd + 2)
assert(bloqueProd.includes('process.exit(1)'),
  'El rechazo de producción corta el proceso con exit 1')
assert(bloqueProd !== '' && !bloqueProd.includes('process.env'),
  'El rechazo de producción es ABSOLUTO: ninguna variable de entorno participa de esa condición')
assert(bloqueProd !== '' && !bloqueProd.includes('permitidoExplicitamente') && !/QA_ALLOW_MUTATING_INTEGRATION_TESTS\s*===/.test(bloqueProd),
  'QA_ALLOW_MUTATING_INTEGRATION_TESTS no puede habilitar la escritura contra producción')
assert(!/if \(refDestino === PROD_SUPABASE_PROJECT_REF[^)]*(&&|\|\|)/.test(guardMutante),
  'La condición del rechazo de producción no tiene escapes (&&/||) que la puedan neutralizar')

assert(guardMutante.includes("process.env.QA_ALLOW_MUTATING_INTEGRATION_TESTS === 'true'"),
  "El guard mutante exige QA_ALLOW_MUTATING_INTEGRATION_TESTS === 'true' de forma literal")
assert(guardMutante.includes('if (!permitidoExplicitamente) {'),
  'La escritura está prohibida sin ese flag para CUALQUIER destino, no solo para los dudosos')

assert(guardMutante.includes('process.env.QA_EXPECTED_PROJECT_REF'),
  'El guard mutante soporta QA_EXPECTED_PROJECT_REF para blindar el destino')
assert(guardMutante.includes('refEsperado !== refDestino'),
  'QA_EXPECTED_PROJECT_REF rechaza cuando no coincide con el destino real')

// Se comparan solo las líneas de código: el propio archivo explica en un
// comentario POR QUÉ no usa `new URL(...)`, y esa mención no debe contar.
const guardMutanteCodigo = guardMutante.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^\\:])\/\/.*$/gm, '$1')
assert(!guardMutanteCodigo.includes('new URL('),
  'El parseo del project ref NO usa new URL( (el `const URL` del módulo lo sombrea y el guard fallaría en silencio)')
assert(guardMutante.includes('function projectRefDe(') && guardMutante.includes('const URL = process.env.SUPABASE_URL'),
  'El project ref se extrae con regex propia, coexistiendo con el `const URL` que sombrea al global')

assert(conteo.includes("tipo: 'movimiento_posterior'"),
  'El conteo serializado ofrece el tipo de diferencia movimiento_posterior')

const dirMigraciones = 'supabase/migrations'
const migraciones = fs.readdirSync(dirMigraciones)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => ({ nombre: f, sql: read(`${dirMigraciones}/${f}`) }))

assert(migraciones.some((m) => /alter table\s+(public\.)?products\s+add column\s+(if not exists\s+)?is_test/i.test(m.sql)),
  'Existe una migración que añade products.is_test (fuente canónica de datos de prueba)')
assert(migraciones.some((m) => /create or replace function\s+private\.sincronizar_stock_serializado\s*\(/i.test(m.sql)),
  'Existe una migración que crea private.sincronizar_stock_serializado (stock serializado derivado de los IMEI reales)')

// Todo consumidor que cuente stock desde public.inventory tiene que excluir el
// catálogo de prueba, si no el saneamiento (que deja las filas QA en cantidad=0)
// las convierte en "stock crítico" permanente e irresoluble. Se comprueba sobre
// la última definición de cada función, que es la que queda vigente.
const ultimaDefinicion = (nombre) => {
  const conLaFuncion = migraciones
    .filter((m) => new RegExp(`create or replace function\\s+public\\.${nombre}\\s*\\(`, 'i').test(m.sql))
    // Orden por unidad de código, no localeCompare: el locale coloca el '_' de
    // un nombre provisional antes de los dígitos y elegiría una definición vieja.
    .sort((a, b) => (a.nombre < b.nombre ? -1 : a.nombre > b.nombre ? 1 : 0))
  if (conLaFuncion.length === 0) return null
  const sql = conLaFuncion[conLaFuncion.length - 1].sql
  const desde = sql.search(new RegExp(`create or replace function\\s+public\\.${nombre}\\s*\\(`, 'i'))
  // Se corta en el siguiente CREATE FUNCTION: si no, el slice arrastraría los
  // cuerpos de las funciones siguientes y la assertion pasaría por el filtro
  // de otra función, no por el de ésta.
  const resto = sql.slice(desde)
  const siguiente = resto.slice(1).search(/create or replace function/i)
  return siguiente === -1 ? resto : resto.slice(0, siguiente + 1)
}

for (const fn of ['dashboard_operativo_admin', 'iniciar_inventario_fisico', 'inventario_valorizado_admin']) {
  const def = ultimaDefinicion(fn)
  assert(def !== null && /not\s+p\.is_test/i.test(def),
    `public.${fn} excluye el catálogo de prueba (not p.is_test) al leer inventory`)
}

if (process.exitCode) process.exit(process.exitCode)
console.log('Security regression checks passed.')
