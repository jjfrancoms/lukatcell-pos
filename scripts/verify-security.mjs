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
const notify = read('supabase/functions/notificar-estado/index.ts')
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
assert(notify.includes('SUPABASE_SERVICE_ROLE_KEY'), 'notificar-estado exige autenticacion propia')
assert(notify.includes('token === SUPABASE_SERVICE_ROLE_KEY'), 'notificar-estado solo acepta service role')

if (process.exitCode) process.exit(process.exitCode)
console.log('Security regression checks passed.')
