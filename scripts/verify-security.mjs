import fs from 'node:fs'

function read(path) {
  return fs.readFileSync(path, 'utf8')
}

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`)
    process.exitCode = 1
  } else {
    console.log(`PASS: ${message}`)
  }
}

const login = read('src/pages/Login.tsx')
const personal = read('src/pages/Personal.tsx')
const app = read('src/App.tsx')
const layout = read('src/components/Layout.tsx')
const dashboard = read('src/pages/DashboardAdmin.tsx')
const notify = read('supabase/functions/notificar-estado/index.ts')
const receipt = read('supabase/functions/emitir-comprobante/index.ts')
const userLogin = read('supabase/functions/login-por-usuario/index.ts')
const bootstrap = read('supabase/functions/estado-bootstrap/index.ts')
const linkLogin = read('supabase/functions/vincular-login-personal/index.ts')

assert(!login.includes("rpc('email_por_username'"), 'Login no expone email_por_username al navegador')
assert(login.includes("functions.invoke('login-por-usuario'"), 'Login usa la Edge Function login-por-usuario')
assert(login.includes("functions.invoke('estado-bootstrap'"), 'Bootstrap usa Edge Function, no RPC publica')
assert(!login.includes("rpc('hay_staff'"), 'Login no llama hay_staff directamente')
assert(userLogin.includes('SUPABASE_SERVICE_ROLE_KEY'), 'login-por-usuario resuelve correo solo en servidor')
assert(bootstrap.includes('SUPABASE_SERVICE_ROLE_KEY'), 'estado-bootstrap consulta staff solo en servidor')
assert(linkLogin.includes('SUPABASE_SERVICE_ROLE_KEY'), 'vincular-login-personal usa privilegios solo en servidor')
assert(linkLogin.includes("rol !== 'administrador'"), 'vincular-login-personal exige administrador')
assert(personal.includes("functions.invoke('crear-personal'"), 'Alta de personal usa Edge Function administrativa')
assert(personal.includes("functions.invoke('vincular-login-personal'"), 'Personal vincula accesos pendientes mediante Edge Function segura')
assert(personal.includes("rpc('reprogramar_staff_turnos'"), 'Personal actualiza horarios mediante una transaccion servidor')
assert(!personal.includes("from('staff_turnos').delete()"), 'Personal no desactiva horarios en una peticion separada')
assert(app.includes('path="dashboard" element={<AdminRoute><DashboardAdmin /></AdminRoute>}'), 'Dashboard esta protegido por AdminRoute')
assert(layout.includes("{ to: '/dashboard', label: 'Dashboard'"), 'Dashboard solo se agrega en navegacion administrativa')
assert(dashboard.includes("rpc('dashboard_operativo_admin'"), 'Dashboard usa RPC administrativa')
assert(dashboard.includes("rpc('asistencia_mensual_admin'"), 'Dashboard usa resumen mensual de asistencia')
assert(notify.includes('SUPABASE_SERVICE_ROLE_KEY'), 'notificar-estado exige autenticacion propia')
assert(notify.includes('token === SUPABASE_SERVICE_ROLE_KEY'), 'notificar-estado solo acepta service role')
assert(receipt.includes("staff.rol === \"administrador\""), 'Reintentos Nubefact exigen administrador activo')

if (process.exitCode) process.exit(process.exitCode)
console.log('Security regression checks passed.')
