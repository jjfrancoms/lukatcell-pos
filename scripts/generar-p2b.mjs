#!/usr/bin/env node
// ============================================================================
// Generador de supabase/migrations/_p2_b_sucursal_activa.sql
//
// Problema: ~36 funciones deciden la sucursal del actor con la sucursal BASE
// (`<var_staff>.location_id`), mientras el frontend y las 30 policies RLS usan
// la ACTIVA (`private.auth_location_id()`, validada contra staff_locations).
//
// Reescribirlas a mano es propenso a errores. Este generador toma las
// definiciones REALES del esquema compuesto (153 migraciones de producción +
// P1/P2, volcadas por el ensayo en .p04-pgtest/defs-despues/) y aplica UNA sola
// sustitución mecánica por función:
//
//     <var_staff>.location_id   →   private.auth_location_id()
//
// donde <var_staff> es la variable en la que la función carga al actor con
// `select * into <var> from public.staff where user_id = auth.uid()`.
//
// Falla cerrado:
//   - si el mismo alias corto también nombra otra tabla en la función (una
//     sustitución textual cambiaría otra columna), aborta;
//   - si tras sustituir queda alguna lectura de la sucursal base, aborta;
//   - si una función carga al actor en dos variables distintas, aborta.
//
// Uso (el volcado debe NO incluir _p2_b):
//   ENSAYO_OMITIR=_p2_b_sucursal_activa.sql node scripts/verify-migraciones-compuestas.mjs
//   node scripts/generar-p2b.mjs
// La migración resultante se versiona; este script queda para auditarla y
// regenerarla si cambia una función de origen.
// ============================================================================
import fs from 'node:fs'

const RAIZ = new URL('..', import.meta.url).pathname
const DEFS = RAIZ + '.p04-pgtest/defs-despues/'
const SALIDA = RAIZ + 'supabase/migrations/_p2_b_sucursal_activa.sql'

// Una migración ya aplicada en producción es inmutable: no se regenera encima; se crea otra nueva.
const { yaVersionada } = await import('./lib/migraciones.mjs')
if (yaVersionada('_p2_b_sucursal_activa.sql')) {
  console.error('GENERADOR _p2_b: ABORTADO — la migración ya está aplicada en producción (archivo versionado). Crea una migración nueva.')
  process.exit(1)
}

if (!fs.existsSync(DEFS)) {
  console.error('Falta .p04-pgtest/defs-despues/. Ejecuta antes:')
  console.error('  ENSAYO_OMITIR=_p2_b_sucursal_activa.sql node scripts/verify-migraciones-compuestas.mjs')
  process.exit(1)
}

const RE_STAFF = /into\s+([a-z_][a-z0-9_]*)\s+from\s+(?:public\.)?staff\s+where\s+(?:[a-z_]+\.)?user_id\s*=\s*auth\.uid\(\)/gi
const EXCLUIR = new Set(['private.auth_location_id'])
const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const bloques = []
const errores = []
for (const archivo of fs.readdirSync(DEFS).sort()) {
  const nombre = archivo.replace(/\.sql$/, '')
  if (EXCLUIR.has(nombre)) continue
  const texto = fs.readFileSync(DEFS + archivo, 'utf8')
  // Un archivo puede tener varias sobrecargas: cada una va precedida de "-- acl: ...".
  for (const def of texto.split(/^-- acl: .*$/m).map((s) => s.trim()).filter(Boolean)) {
    const vars = [...new Set([...def.matchAll(RE_STAFF)].map((m) => m[1].toLowerCase()))]
    if (vars.length === 0) continue
    const firma = def.split('\n')[0].replace(/^CREATE OR REPLACE FUNCTION /, '')
    if (vars.length > 1) { errores.push(`${firma}: carga al actor en varias variables (${vars.join(', ')})`); continue }
    const v = vars[0]
    const reUso = new RegExp(`(?<![a-z0-9_])${escapar(v)}\\.location_id(?![a-z0-9_])`, 'gi')
    const usos = (def.match(reUso) || []).length
    if (usos === 0) continue

    // ¿El alias también nombra otra tabla? (from|join <tabla> [as] <v>)
    const reAlias = new RegExp(`(?:from|join)\\s+(?:public\\.)?([a-z_]+)\\s+(?:as\\s+)?${escapar(v)}(?![a-z0-9_])`, 'gi')
    const otras = [...def.matchAll(reAlias)].map((m) => m[1].toLowerCase()).filter((t) => t !== 'staff')
    if (otras.length) { errores.push(`${firma}: el alias "${v}" también nombra ${[...new Set(otras)].join(', ')}`); continue }

    const nuevo = def.replace(reUso, 'private.auth_location_id()')
    if (reUso.test(nuevo)) { errores.push(`${firma}: quedan lecturas de ${v}.location_id`); continue }
    bloques.push({ nombre, firma, v, usos, sql: nuevo.replace(/;\s*$/, '') + ';' })
  }
}

if (errores.length) {
  console.error('GENERADOR _p2_b: ABORTADO')
  for (const e of errores) console.error(`  - ${e}`)
  process.exit(1)
}

const cabecera = `-- ============================================================================
-- P2.B — Sucursal del actor = sucursal ACTIVA en todo el servidor
-- ============================================================================
-- GENERADO por scripts/generar-p2b.mjs a partir de las definiciones reales del
-- esquema compuesto. NO editar a mano: regenerar.
--
-- Hallazgo: el frontend (src/lib/auth.tsx) y las 30 policies RLS que filtran por
-- sucursal usan private.auth_location_id() — la sucursal activa, validada contra
-- staff_locations —, pero estas funciones decidían con la sucursal BASE del
-- staff. Quien cambiaba de sucursal activa no podía abrir caja ni vender allí,
-- una autorización de descuento se guardaba en una sucursal y se buscaba en
-- otra, y P1 dejaba crear una transferencia con origen base que luego no se
-- podía despachar desde la activa.
--
-- Cambio: en cada función, y sólo en ella, <var_staff>.location_id →
-- private.auth_location_id(). Misma firma, mismo tipo de retorno, mismos
-- atributos: CREATE OR REPLACE conserva los privilegios. Para quien no tiene
-- una sucursal activa distinta (hoy, todo el personal de producción) el
-- resultado es idéntico: auth_location_id() devuelve la base.
--
-- Incluye tres funciones que P0 declaró intocables (iniciar_inventario_fisico,
-- cerrar_inventario_fisico, resolver_reconciliacion_serial). El ensayo compuesto
-- verifica que su cuerpo final es EXACTAMENTE el anterior con esta sustitución
-- y ninguna otra diferencia.
--
-- Funciones (${bloques.length}):
${bloques.map((b) => `--   ${b.firma}  [${b.v}.location_id × ${b.usos}]`).join('\n')}
-- ============================================================================
`

fs.writeFileSync(SALIDA, cabecera + '\n' + bloques.map((b) => `-- ${b.nombre}\n${b.sql}\n`).join('\n'))
console.log(`GENERADOR _p2_b: ${bloques.length} funciones, ${bloques.reduce((a, b) => a + b.usos, 0)} sustituciones → ${SALIDA.replace(RAIZ, '')}`)
