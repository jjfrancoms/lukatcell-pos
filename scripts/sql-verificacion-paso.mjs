#!/usr/bin/env node
// Genera la consulta de SÓLO LECTURA que verifica en producción el paso N del release.
//
// Entrada: .p04-pgtest/pasos-release/paso-(N-1).json y paso-N.json (los escribe el ensayo compuesto).
// Salida: una única SELECT con las expectativas incrustadas que devuelve banderas y, como mucho, la
// lista de funciones que NO coinciden. Producción no devuelve hashes que haya que copiar a mano: un
// error al transcribir las expectativas sólo puede producir un FALSO FALLO, nunca un falso éxito.
//
// Qué se exige tras aplicar la migración N en producción:
//   · huellas de columnas, constraints, policies, grants de funciones, RLS y privilegios de columna
//     idénticas a las del ensayo en el paso N;
//   · mismo número de funciones;
//   · md5(prosrc) idéntico en TODAS las funciones que la migración N creó o cambió en el ensayo.
// (La huella global de funciones no se compara: producción tiene 41 funciones que difieren del repo sólo
//  en formato o comentarios, verificadas una a una, y ninguna migración nueva las toca sin reescribirlas.)
//
// Uso: node scripts/sql-verificacion-paso.mjs <N>
import fs from 'node:fs'

const N = Number(process.argv[2])
const dir = new URL('../.p04-pgtest/pasos-release/', import.meta.url).pathname
const leer = (n) => JSON.parse(fs.readFileSync(`${dir}paso-${String(n).padStart(2, '0')}.json`, 'utf8'))
if (!Number.isInteger(N) || N < 1) { console.error('Uso: node scripts/sql-verificacion-paso.mjs <N ≥ 1>'); process.exit(2) }
const antes = leer(N - 1), despues = leer(N)

const cambiadas = Object.keys(despues.funciones).filter((k) => antes.funciones[k] !== despues.funciones[k]).sort()
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`
const h = despues.huella

const esperadas = cambiadas.length
  ? `(values ${cambiadas.map((f) => `(${lit(f)}, ${lit(despues.funciones[f])})`).join(',\n    ')})`
  : `(select null::text, null::text where false)`

const sql = `-- Verificación del paso ${N}: ${despues.migracion} (${cambiadas.length} funciones creadas o cambiadas)
with esperadas(firma, md5) as ${esperadas},
reales as (
  select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' as firma, md5(p.prosrc) as md5
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private')
),
distintas as (
  select e.firma from esperadas e left join reales r on r.firma = e.firma where r.md5 is distinct from e.md5
)
select
  (select count(*) from reales) = ${Number(h.n_funciones)} as n_funciones_ok,
  (select md5(string_agg(table_schema::text||'.'||table_name::text||'.'||column_name::text||':'||data_type::text||':'||is_nullable::text, E'\\n' order by table_schema::text collate "C", table_name::text collate "C", column_name::text collate "C")) from information_schema.columns where table_schema in ('public','private')) = ${lit(h.huella_columnas)} as columnas_ok,
  (select md5(string_agg(c.conrelid::regclass::text||'.'||c.conname::text||':'||c.contype::text, E'\\n' order by c.conrelid::regclass::text collate "C", c.conname::text collate "C")) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in ('public','private') and c.contype <> 'n') = ${lit(h.huella_constraints)} as constraints_ok,
  (select md5(string_agg(schemaname::text||'.'||tablename::text||'.'||policyname::text||':'||cmd::text, E'\\n' order by schemaname::text collate "C", tablename::text collate "C", policyname::text collate "C")) from pg_policies where schemaname in ('public','private')) = ${lit(h.huella_policies)} as policies_ok,
  (select md5(string_agg(n.nspname::text||'.'||p.proname::text||'('||pg_get_function_identity_arguments(p.oid)||'):'||has_function_privilege('anon',p.oid,'EXECUTE')::text||has_function_privilege('authenticated',p.oid,'EXECUTE')::text, E'\\n' order by n.nspname::text collate "C", p.proname::text collate "C", pg_get_function_identity_arguments(p.oid) collate "C")) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')) = ${lit(h.huella_grants_funciones)} as grants_funciones_ok,
  (select md5(string_agg(n.nspname::text||'.'||c.relname::text||':'||c.relrowsecurity::text, E'\\n' order by n.nspname::text collate "C", c.relname::text collate "C")) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('public','private')) = ${lit(h.huella_rls)} as rls_ok,
  (select md5(string_agg(table_schema::text||'.'||table_name::text||'.'||column_name::text||':'||grantee::text||':'||privilege_type::text, E'\\n' order by table_schema::text collate "C", table_name::text collate "C", column_name::text collate "C", grantee::text collate "C", privilege_type::text collate "C")) from information_schema.column_privileges where table_schema in ('public','private') and grantee in ('anon','authenticated','service_role')) = ${lit(h.huella_privilegios_columna)} as privilegios_columna_ok,
  (select count(*) from distintas) as funciones_distintas,
  (select string_agg(firma, ' | ') from distintas) as cuales,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.prosecdef and n.nspname in ('public','private') and has_function_privilege('anon', p.oid, 'EXECUTE')) as anon_secdef,
  (select count(*) from supabase_migrations.schema_migrations) as migraciones_registradas;`

console.log(sql)
