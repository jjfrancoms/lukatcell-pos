// Resolución de archivos de migración por nombre lógico.
//
// Una migración nueva vive como `_p2_a_reportes_business_date.sql` mientras no está en producción y,
// al aplicarse, se renombra con la versión real que asignó Supabase:
// `20260913123456_p2_a_reportes_business_date.sql`. Los scripts de verificación y los generadores
// la piden por su nombre lógico y reciben el archivo que exista. Nunca se aceptan ambas formas a la
// vez (fallo cerrado: sería una migración duplicada).
import fs from 'node:fs'

export const MIGRACIONES = new URL('../../supabase/migrations/', import.meta.url).pathname

const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function candidatosMigracion(logico) {
  const sinGuion = logico.replace(/^_/, '')
  const versionada = new RegExp(`^\\d{14}_${escapar(sinGuion)}$`)
  return fs.readdirSync(MIGRACIONES).filter((f) => f === logico || versionada.test(f))
}

export function resolverMigracion(logico) {
  const c = candidatosMigracion(logico)
  if (c.length !== 1) throw new Error(`migración ${logico}: ${c.length ? `ambigua (${c.join(', ')})` : 'no encontrada'}`)
  return c[0]
}

// ¿Ya se aplicó en producción? (existe la forma versionada)
export function yaVersionada(logico) {
  const sinGuion = logico.replace(/^_/, '')
  return candidatosMigracion(logico).some((f) => f !== logico && f.endsWith(`_${sinGuion}`))
}
