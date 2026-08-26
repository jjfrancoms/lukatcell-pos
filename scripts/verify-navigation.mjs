import fs from 'node:fs'

const read = (path) => fs.readFileSync(path, 'utf8')
const assert = (ok, message) => {
  if (!ok) { console.error(`FAIL: ${message}`); process.exitCode = 1 }
  else console.log(`PASS: ${message}`)
}

const app = read('src/App.tsx')
const layout = read('src/components/Layout.tsx')
const destinations = [...layout.matchAll(/to:\s*'([^']+)'/g)].map((match) => match[1])
const protectedRoutes = [...app.matchAll(/path="([^"]+)"/g)]
  .map((match) => match[1].startsWith('/') ? match[1] : `/${match[1]}`)
  .filter((path) => path !== '/login')

assert(layout.includes("label:'Inicio / Dashboard'") && layout.includes("label:'Nueva venta'"), 'Dashboard y Nueva venta son accesos principales')
assert(layout.includes("label:'Caja'") && layout.includes("label:'Inventario'") && layout.includes("label:'Clientes'"), 'Caja, Inventario y Clientes son accesos principales')
assert(layout.includes("id:'ventas'") && layout.includes("id:'inventario-compras'") && layout.includes("id:'crm-comunicacion'") && layout.includes("id:'gestion'") && layout.includes("id:'sistema'"), 'El resto se divide en las cinco categorías acordadas')
assert(layout.includes('sharedSections.filter(section=>section.items.length>0)'), 'Las categorías sin hijos permitidos se ocultan')
assert(layout.includes('useState<Record<string,boolean>>({})'), 'Los grupos empiezan cerrados')
assert(layout.includes('setOpenSections(prev=>({...prev,[active.id]:true}))'), 'La categoría de la ruta activa se abre automáticamente')
assert(layout.includes("isAdmin?[{to:'/dashboard'") && layout.includes('...(isAdmin?['), 'Los accesos administrativos respetan el rol')
assert(layout.includes("['tecnico','encargado','jefa'].includes"), 'Inventario avanzado respeta el puesto autorizado')
assert(layout.includes('title={`${section.label} · abrir menú`}') && layout.includes('setCollapsed(false);setOpenSections({[section.id]:true})'), 'El modo compacto conserva tooltips y permite abrir submenús')
assert(layout.includes("aria-label={menuOpen?'Cerrar menú':'Abrir menú'}"), 'El control móvil tiene nombre accesible')

for (const route of protectedRoutes) assert(destinations.includes(route), `La ruta ${route} conserva acceso en el menú`)
assert(destinations.includes('/'), 'La ruta principal de venta conserva acceso en el menú')

if (process.exitCode) process.exit(process.exitCode)
console.log('Navigation regression checks passed.')
