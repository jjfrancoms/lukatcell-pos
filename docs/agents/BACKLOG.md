# Backlog — LukatCell POS

Estados: `READY`, `IN_PROGRESS`, `BLOCKED`, `DONE (local)`, `DONE (prod)`.
`DONE (local)` = validado en PostgreSQL local real y navegador, sin desplegar.
`DONE (prod)` = migración aplicada y verificada en producción; frontend en el commit de release.
Detalle y evidencia: [CURRENT_EXECUTION.md](CURRENT_EXECUTION.md).

Última reconstrucción: 2026-09-13, desde código, 168 migraciones de producción y catálogo real
(no desde versiones anteriores de este archivo, que describían la ola del 2026-08-24).
Revisión 2026-09-17 (agente 4): fechas de negocio expresadas en hora de **America/Lima** (UTC−5),
no en UTC; commit de release y CI con su evidencia; hallazgos abiertos del red team.

**Fechas:** producción corre en `TimeZone=UTC`. Toda fecha comercial de este documento es la de
`America/Lima`. Conversión reproducible:
`node -e "console.log(new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Lima',dateStyle:'short',timeStyle:'short'}).format(new Date('2026-09-07T00:52:00Z')))"` → `2026-09-06 19:52`.

## Base desplegada

| Bloque | Estado |
|---|---|
| P0 integridad POS (P0.1–P0.4: ventas, IMEI, ledger, aislamiento QA, costo oculto) | DONE (prod) · SHA `70578db` |
| OLA 1–4: 15 migraciones (`20260913221937` … `20260913225613`) | DONE (prod) · 2026-09-13 · paridad PASS · commit de release `5149079` · CI `success` (run `34788694062`, headSha `514907991ca8…`) |
| `origin/elite/wave-2` | Descartada: anterior a P0, reintroduce defectos corregidos. No se fusiona. |

## OLA 1 — P1

| Fase | Entregable | Estado |
|---|---|---|
| 13 | Transferencias parciales: recepción por línea/serial, diferencias, idempotencia con huella de contenido | DONE (prod) · 63/63 |
| 14 | Recepción de compras idempotente, correcciones, compatibilidad con bundles offline viejos | DONE (prod) · 96/96 |
| — | Caja: umbral de egreso + autorización operativa reutilizada, idempotencia por contenido | DONE (prod) · 32/32 + E2E 6/6 |
| 18 | Conciliación de pagos: cuadre por venta, confirmación de proveedor idempotente | DONE (prod) · 41/41 |
| 18 | Terminal de conciliación y reembolsos a través del proveedor append-only (`p2_j`, UI en Conciliación) | DONE (prod) · negocio 21 |
| 18 | Adaptadores automáticos de reembolso Culqi / POS externo | BLOCKED: credenciales y contrato del proveedor (no se simulan; el reembolso se registra con la referencia del proveedor) |
| — | Reconciliación de deriva de prod (`resolver_turno_fecha`, `registrar_justificacion_asistencia`) | DONE (prod) · no-op verificado |

Deuda P2 de OLA 1 — estado tras la ola P3 (2026-09-27): **T3 y T4 DONE (prod)** (`p3_b`, que además
cierra el hallazgo nuevo T7: IMEI conciliado en la línea equivocada), **B3 y B4 DONE (prod)**
(`p3_c`). **T5 (sobrante) sigue abierto: decisión de negocio del dueño** — expediente con cuatro
opciones y recomendación en CURRENT_EXECUTION. (B7 sucursal activa vs sucursal del staff: resuelta
por `p2_b`.)

## OLA 2

| Fase | Entregable | Estado |
|---|---|---|
| 22 | Reportes: `business_date` America/Lima, `is_test=false`, costo histórico, filtro por sucursal, devoluciones netas | DONE (prod) · negocio 28/28 · mutación 19/28 fallan sin la corrección |
| — | Multi-sucursal: toda decisión de sucursal del actor vía `auth_location_id()` (`p2_b`, generada: 32 funciones) + guardas de cambio de sucursal con ventas offline | DONE (prod) · negocio 9/9 · mutación 5 fallan |
| — | RLS tautológica de `cliente_puntos_movimientos` (`p2_c`) | DONE (prod) · mutación: fuga reproducida |
| — | Promociones | Auditado: sin hallazgos (escrituras admin, vigencias en instantes) |
| — | CRM: perfil acotado a sucursal y sin `is_test`, actualización sólo admin, consentimiento fechado, columnas escribibles de `clientes` (`p2_d`) | DONE (prod) · mutación 10 fallan |

## OLA 3

| Fase | Entregable | Estado |
|---|---|---|
| 21 | Centro de incidencias (`p2_f`, `Incidencias.tsx`, ruta `/incidencias`) | DONE (prod) · negocio 17 · mutación 12 fallan |
| 20 | Cierre diario con verificaciones P0/P1/warning (`p2_e`) | DONE (prod) · mutación 10 fallan · **la caja abierta desde el 2026-09-06 19:52 Lima (= 2026-09-07 00:52 UTC) bloquea el próximo cierre** |
| — | Offline: venta huérfana en SYNCING y cortes de red que agotaban ventas (`src/lib/offline.ts`) | DONE (local → prod con el deploy del commit de release) · E2E Offline 3/3 · mutante falla |
| — | WhatsApp: el webhook POST no verificaba firma → verificación `X-Hub-Signature-256` con fallo cerrado | DONE (local) · en `npm test` · mutación 2 fallan · **Edge Function NO desplegada** (decisión del dueño; requiere `WHATSAPP_APP_SECRET`) |

## OLA 4

| Fase | Entregable | Estado |
|---|---|---|
| 24 | Capacidades centralizadas (`p2_h` a mano, `p2_i` generada: 17 funciones) + flags por sucursal aplicados + `puede()` en la UI | DONE (prod) · mutación 1 falla sin `p2_i` |
| 23 | Reimpresión con rastro y copia numerada (`p2_g`) + bridge local revalidado (IPv6 corregido) | DONE (prod) · negocio 9 · **impresora física NO validada (sin hardware)** |
| — | DevOps: referencias de producción versionadas (`scripts/referencias/`) + workflow `integracion.yml` (ensayo compuesto, suites SQL, E2E) en PR | DONE (local) · revisado 2026-09-17: `npm ci` en los 3 manifiestos, PostgreSQL embebido documentado y comprobado en preflight, guarda anti-`.env`/anti-secretos, `shell: bash` (`-eo pipefail`) para que `tee` no enmascare el código de salida, una suite por paso y artefacto de evidencia · **ejecutado en runner Linux** el 2026-09-27: run 36332296929, job `postgres-y-navegador`, conclusión `success`, sin correcciones |
| — | DevOps: `supabase migration repair` para reconstrucción desde cero | BLOCKED: acción del dueño |

## Datos de producción a clasificar (no sanear a ciegas)

5 reservas IMEI vencidas (creadas 2026-09-06 19:31–19:52 Lima) · 1 caja antigua abierta `db4fb8e5`
(abierta 2026-09-06 19:52 Lima = 2026-09-07 00:52 UTC) · 2 conciliaciones pendientes — READY.
Clasificados, sin sanear: intactos tras el release (verificado). Las fechas escritas antes como
2026-09-07 eran la fecha UTC; la fecha comercial de esos datos es el **2026-09-06** en Lima.

## Hallazgos abiertos del red team (agente 4, 2026-09-17)

Detectados por `scripts/compuesto/zz_red_team.mjs` sobre el esquema compuesto (153 + 16 migraciones),
cada uno **demostrado ejecutando el ataque**, no sólo leyendo el catálogo. Ninguno se parchea aquí:
el SQL es de otros agentes. Reproducción: `node scripts/verify-migraciones-compuestas.mjs`.

| # | Hallazgo | Alcance real | Estado |
|---|---|---|---|
| RT-1 | `clientes_actualizacion_autenticados` es `USING true / WITH CHECK true` y `_p2_d` deja `documento` y `direccion` con privilegio de columna para `authenticated`: un autenticado **sin fila en `staff`** reescribe el documento de cualquier cliente. Demostrado: `UPDATE … set documento` aceptado, 1 fila. | **Alcanzable por la API** (`PATCH /rest/v1/clientes`). Es el de mayor severidad. | **DONE (prod)** · `p3_d` (20260927151419) |
| RT-2 | 69 de 74 tablas de `public` conceden **TRUNCATE** a `authenticated` (privilegios por defecto `grant all on tables`). **La RLS no filtra TRUNCATE.** Demostrado: `truncate public.auditoria_eventos` aceptado por un autenticado sin staff. | No alcanzable por PostgREST (no expone TRUNCATE); sí por cualquier ruta con SQL directo. Defensa en profundidad. | **DONE (prod)** · `p3_d` (20260927151419) |
| RT-3 | 9 secuencias con `USAGE`+`UPDATE` para `authenticated`, entre ellas `boleta_correlativo_seq`, `factura_correlativo_seq`, `nota_credito_*`, `sales_numero_seq`. `UPDATE` sobre secuencia = `setval`. Demostrado: `setval('public.boleta_correlativo_seq', 1, false)` aceptado. Las 3 secuencias del release (`incidencia_eventos`, `reembolso_proveedor_eventos`, `reimpresiones_venta`) llegaron **sin** privilegios: el patrón correcto ya se conoce. | No alcanzable por PostgREST; correlativo fiscal reescribible con SQL directo. | **DONE (prod)** · `p3_d` (20260927151419) |
| RT-4 | `cliente_puntos_movimientos`, `inventory_movements` y `orden_servicio_historial` son tablas de libro con `UPDATE`/`DELETE` para `authenticated` y **sin trigger append-only**. Hoy la RLS lo bloquea (sólo tienen policy de `SELECT`), así que es latente: basta una policy permisiva futura para abrirlo. Las tablas nuevas del release sí llevan trigger. | Latente. | **DONE (prod)** · `p3_d` (20260927151419) |

### Para otros agentes (detectado en la revisión adversaria de `_p3_*`, no parcheado aquí)

| # | Hallazgo | Dueño |
|---|---|---|
| RT-5 | El ensayo compuesto **ignora en silencio** cualquier migración nueva que nadie registre en su lista `P1`: `_p3_b_transferencias_t3_t4.sql` y `_p3_c_recepcion_b3_b4.sql` estaban en `supabase/migrations/` sin registrar, y el ensayo daba «16/16 aplicadas» sin aplicarlas. No hay guarda que compare el directorio con la lista, así que una migración puede llegar a revisión con cobertura 0 y el ensayo no lo dice. Es un fallo ABIERTO del propio gate. | dueño de `scripts/verify-migraciones-compuestas.mjs` |
| RT-6 | Con `_p3_b` aplicada, el módulo ya existente `sucursal_activa.mjs` **regresa**: «la transferencia nace con origen en la sucursal activa y su creador puede despacharla» falla con «La creación de una transferencia exige client_transaction_id (idempotencia)». `_p3_b` vuelve obligatorio `client_transaction_id` y no se actualizó el módulo que ya llamaba a `crear_transferencia_stock` sin él. Verificado aplicando `_p3_a`+`_p3_b`+`_p3_c` juntas (18/18) en un ensayo espejo. | agente de `_p3_b` |
| RT-7 | Sin `_p3_b` aplicada, `transferencias.mjs` no falla limpio: lanza `Cannot read properties of undefined (reading '0')` («se ejecuta sin excepción» en rojo) en vez de dar un FAIL con nombre. Fallo abierto de robustez del módulo. | agente de `_p3_b` |

Revisión adversaria de `_p3_a`/`_p3_b`/`_p3_c` con las tres aplicadas: **ningún hallazgo nuevo del red
team**. No añaden tablas sin RLS, ni funciones ejecutables por `anon`, ni secuencias con privilegios,
ni `SECURITY DEFINER` sin `search_path`, ni policies que se auto-cumplan. Sus `SECURITY DEFINER` usan
`set search_path to 'public','private'`, que es seguro porque `authenticated` no puede crear objetos
en esos esquemas — comprobación F5 del red team, añadida para vigilarlo.

Cerrados en esta pasada: `search_path` — `_p3_a_search_path_funciones_privadas.sql` (agente 1) lleva a
**0** las funciones de `public`/`private` sin `search_path` fijado; las 155 `SECURITY DEFINER` ya lo
tenían. Verificado con el red team corriendo sobre el compuesto con `_p3_a` aplicada.

## Pendientes externos

| Tarea | Estado |
|---|---|
| Leaked Password Protection | BLOCKED: panel de Supabase (acción del dueño) |
| Confirmar registros de Auth deshabilitados | BLOCKED: panel de Supabase (acción del dueño) |
| `WHATSAPP_APP_SECRET` + despliegue de `agente-whatsapp` | BLOCKED: secreto externo y decisión del dueño |
| Credenciales POS externo / Culqi | BLOCKED: proveedor |
