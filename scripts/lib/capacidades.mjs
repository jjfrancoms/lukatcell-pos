// Regla ÚNICA de sustitución de autorización por puesto → capacidad (Fase 24).
// La usan scripts/generar-p2i.mjs (para generar la migración) y el ensayo
// compuesto (para verificar que las funciones P0 intocables sólo cambiaron por
// esta sustitución). Si cambia aquí, cambia en ambos.

const TRES = 'tecnico,encargado,jefa'
const DOS = 'encargado,jefa'

// Funciones cuyo chequeo de la lista de tres puestos es de TALLER; el resto de
// funciones con esa lista son de INVENTARIO. Una función con la lista de tres que
// no esté en ninguno de los dos conjuntos aborta la generación.
export const TALLER = new Set([
  'public.actualizar_orden_servicio_tecnica', 'public.agregar_repuesto_orden',
  'public.retirar_repuesto_orden', 'public.registrar_foto_orden',
])
export const INVENTARIO = new Set([
  'public.ajustar_stock', 'public.despachar_transferencia_stock', 'public.iniciar_inventario_fisico',
  'public.recibir_orden_compra', 'public.recibir_transferencia_parcial', 'public.registrar_conteo_fisico',
  'public.registrar_serial_contado', 'public.registrar_seriales',
])

const lista = (s) => s.replace(/[\s']/g, '').toLowerCase()

// "<v>.rol = 'administrador' or coalesce(<v>.puesto, '') in (...)"
const RE_PERMITE = /([a-z_][a-z0-9_]*)\.rol\s*=\s*'administrador'\s*or\s*coalesce\(\s*\1\.puesto\s*,\s*''\s*\)\s*in\s*\(([^)]*)\)/gi
// "<v>.rol <> 'administrador' and coalesce(<v>.puesto, '') not in (...)"
const RE_NIEGA = /([a-z_][a-z0-9_]*)\.rol\s*<>\s*'administrador'\s*and\s*coalesce\(\s*\1\.puesto\s*,\s*''\s*\)\s*not\s+in\s*\(([^)]*)\)/gi

function capacidad(funcion, l) {
  if (l === DOS) return 'supervisar'
  if (l === TRES) {
    if (TALLER.has(funcion)) return 'operar_taller'
    if (INVENTARIO.has(funcion)) return 'operar_inventario'
    throw new Error(`${funcion}: usa la lista de tres puestos pero no está clasificada como taller ni inventario`)
  }
  throw new Error(`${funcion}: lista de puestos desconocida (${l})`)
}

// Devuelve { texto, sustituciones }. Lanza si encuentra algo que no sabe clasificar.
export function sustituirCapacidades(funcion, texto) {
  let sustituciones = 0
  let salida = texto.replace(RE_PERMITE, (_, __, l) => { sustituciones++; return `private.tiene_capacidad('${capacidad(funcion, lista(l))}')` })
  salida = salida.replace(RE_NIEGA, (_, __, l) => { sustituciones++; return `not private.tiene_capacidad('${capacidad(funcion, lista(l))}')` })
  return { texto: salida, sustituciones }
}

// ¿Queda alguna autorización por lista literal de puestos?
export function quedaAutorizacionPorPuesto(texto) {
  return /\.rol\s*(=|<>)\s*'administrador'\s*(or|and)\s*coalesce\(\s*[a-z_][a-z0-9_]*\.puesto/i.test(texto)
}
