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
  ['dashboard','DashboardAdmin'],['permisos','PermisosPersonal'],['cambios-turno','CambiosTurno'],['anulaciones','Anulaciones'],['devoluciones','Devoluciones'],['notas-credito','NotasCredito'],['cierre-diario','CierreDiario'],['auditoria','Auditoria']
]) assert(app.includes(`path="${path}" element={<AdminRoute><${component} /></AdminRoute>}`), `${path} protegido por AdminRoute`)
assert(app.includes('path="autorizaciones" element={<Autorizaciones />}'), 'Autorizaciones disponible a personal autenticado')

assert(layout.includes("{ to: '/anulaciones', label: 'Anulaciones'"), 'Anulaciones solo en menú admin')
assert(layout.includes("{ to: '/devoluciones', label: 'Devoluciones'"), 'Devoluciones solo en menú admin')
assert(layout.includes("{ to: '/notas-credito', label: 'Notas de crédito'"), 'Notas de crédito solo en menú admin')
assert(layout.includes("{ to: '/cierre-diario', label: 'Cierre diario'"), 'Cierre diario solo en menú admin')
assert(layout.includes("{ to: '/autorizaciones', label: 'Autorizaciones'"), 'Autorizaciones en navegación operativa')

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

assert(jornada.includes("['permiso', 'vacaciones', 'licencia']"), 'Mi Jornada reconoce permisos')
assert(dashboard.includes('personal_permisos'), 'Dashboard cuenta permisos')
assert(audit.includes("rpc('auditoria_reciente_admin'"), 'Auditoría usa RPC admin')
assert(notify.includes('token === SUPABASE_SERVICE_ROLE_KEY'), 'notificar-estado exige service role')
assert(receipt.includes("staff.rol === \"administrador\""), 'Reintentos Nubefact exigen admin')

if (process.exitCode) process.exit(process.exitCode)
console.log('Security regression checks passed.')
