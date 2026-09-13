#!/usr/bin/env node
// ============================================================================
// Generador de supabase/migrations/_p2_i_capacidades_funciones.sql (Fase 24)
//
// Toma las definiciones reales del esquema compuesto (volcadas por el ensayo en
// .p04-pgtest/defs-despues/) y reemplaza cada autorización por lista literal de
// puestos por private.tiene_capacidad(...) (definida a mano en _p2_h), con la
// regla única de scripts/lib/capacidades.mjs.
//
// Falla cerrado: función con la lista de tres puestos sin clasificar, lista
// desconocida, o autorización por puesto que sobreviva a la sustitución.
//
// Uso (el volcado NO debe incluir _p2_i; sí _p2_h):
//   ENSAYO_OMITIR=_p2_i_capacidades_funciones.sql node scripts/verify-migraciones-compuestas.mjs
//   node scripts/generar-p2i.mjs
// ============================================================================
import fs from 'node:fs'
import { sustituirCapacidades, quedaAutorizacionPorPuesto, TALLER, INVENTARIO } from './lib/capacidades.mjs'

const RAIZ = new URL('..', import.meta.url).pathname
const DEFS = RAIZ + '.p04-pgtest/defs-despues/'
const SALIDA = RAIZ + 'supabase/migrations/_p2_i_capacidades_funciones.sql'

// Una migración ya aplicada en producción es inmutable: no se regenera encima; se crea otra nueva.
const { yaVersionada } = await import('./lib/migraciones.mjs')
if (yaVersionada('_p2_i_capacidades_funciones.sql')) {
  console.error('GENERADOR _p2_i: ABORTADO — la migración ya está aplicada en producción (archivo versionado). Crea una migración nueva.')
  process.exit(1)
}

if (!fs.existsSync(DEFS)) {
  console.error('Falta .p04-pgtest/defs-despues/. Ejecuta antes:')
  console.error('  ENSAYO_OMITIR=_p2_i_capacidades_funciones.sql node scripts/verify-migraciones-compuestas.mjs')
  process.exit(1)
}
if (!fs.existsSync(DEFS + 'private.tiene_capacidad.sql')) {
  console.error('El volcado no incluye private.tiene_capacidad: _p2_h debe estar aplicada antes de generar.')
  process.exit(1)
}

const bloques = []
const errores = []
for (const archivo of fs.readdirSync(DEFS).sort()) {
  const nombre = archivo.replace(/\.sql$/, '')
  if (nombre === 'private.tiene_capacidad') continue
  const texto = fs.readFileSync(DEFS + archivo, 'utf8')
  for (const def of texto.split(/^-- acl: .*$/m).map((s) => s.trim()).filter(Boolean)) {
    if (!quedaAutorizacionPorPuesto(def)) continue
    const firma = def.split('\n')[0].replace(/^CREATE OR REPLACE FUNCTION /, '')
    try {
      const { texto: nuevo, sustituciones } = sustituirCapacidades(nombre, def)
      if (quedaAutorizacionPorPuesto(nuevo)) { errores.push(`${firma}: queda autorización por puesto sin clasificar`); continue }
      const caps = [...new Set([...nuevo.matchAll(/tiene_capacidad\('([a-z_]+)'\)/g)].map((m) => m[1]))]
      bloques.push({ nombre, firma, sustituciones, caps, sql: nuevo.replace(/;\s*$/, '') + ';' })
    } catch (e) {
      errores.push(e.message)
    }
  }
}

const clasificadas = new Set(bloques.map((b) => b.nombre))
for (const f of [...TALLER, ...INVENTARIO]) if (!clasificadas.has(f)) errores.push(`${f}: clasificada pero sin autorización por puesto en el volcado (¿cambió?)`)

if (errores.length) {
  console.error('GENERADOR _p2_i: ABORTADO')
  for (const e of errores) console.error(`  - ${e}`)
  process.exit(1)
}

const cabecera = `-- ============================================================================
-- P2.I — FASE 24 · Funciones con capacidades centralizadas
-- ============================================================================
-- GENERADO por scripts/generar-p2i.mjs con la regla de scripts/lib/capacidades.mjs.
-- NO editar a mano: regenerar.
--
-- Cada autorización por lista literal de puestos se sustituye por
-- private.tiene_capacidad(...) (_p2_h). Misma firma y atributos: CREATE OR
-- REPLACE conserva los privilegios. Para el personal de producción actual el
-- resultado es idéntico (ver _p2_h); además, puede_inventario y puede_taller de
-- la sucursal activa pasan a aplicarse de verdad.
--
-- Incluye funciones que P0 declaró intocables; el ensayo verifica que su cuerpo
-- final es exactamente el anterior con esta sustitución (y la de _p2_b).
--
-- Funciones (${bloques.length}):
${bloques.map((b) => `--   ${b.firma}  [${b.caps.join(', ')} × ${b.sustituciones}]`).join('\n')}
-- ============================================================================
`
fs.writeFileSync(SALIDA, cabecera + '\n' + bloques.map((b) => `-- ${b.nombre}\n${b.sql}\n`).join('\n'))
console.log(`GENERADOR _p2_i: ${bloques.length} funciones, ${bloques.reduce((a, b) => a + b.sustituciones, 0)} sustituciones → ${SALIDA.replace(RAIZ, '')}`)
