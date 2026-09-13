# Backlog — LukatCell POS

Estados: `READY`, `IN_PROGRESS`, `BLOCKED`, `DONE (local)`, `DONE (prod)`.
`DONE (local)` = validado en PostgreSQL local real y navegador, sin desplegar.
`DONE (prod)` = migración aplicada y verificada en producción; frontend en el commit de release.
Detalle y evidencia: [CURRENT_EXECUTION.md](CURRENT_EXECUTION.md).

Última reconstrucción: 2026-09-13, desde código, 168 migraciones de producción y catálogo real
(no desde versiones anteriores de este archivo, que describían la ola del 2026-08-24).

## Base desplegada

| Bloque | Estado |
|---|---|
| P0 integridad POS (P0.1–P0.4: ventas, IMEI, ledger, aislamiento QA, costo oculto) | DONE (prod) · SHA `70578db` |
| OLA 1–4: 15 migraciones (`20260913221937` … `20260913225613`) | DONE (prod) · 2026-09-13 · paridad PASS |
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

Deuda P2 registrada de OLA 1: T3 IMEI faltante pendiente, T4 clave en `crear_transferencia_stock`,
T5 sobrante (decisión de negocio), B3/B4 corrección/cierre con faltantes. (B7 sucursal activa vs
sucursal del staff: resuelta por `p2_b`.)

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
| 20 | Cierre diario con verificaciones P0/P1/warning (`p2_e`) | DONE (prod) · mutación 10 fallan · **la caja abierta desde 2026-09-07 bloquea el próximo cierre** |
| — | Offline: venta huérfana en SYNCING y cortes de red que agotaban ventas (`src/lib/offline.ts`) | DONE (local → prod con el deploy del commit de release) · E2E Offline 3/3 · mutante falla |
| — | WhatsApp: el webhook POST no verificaba firma → verificación `X-Hub-Signature-256` con fallo cerrado | DONE (local) · en `npm test` · mutación 2 fallan · **Edge Function NO desplegada** (decisión del dueño; requiere `WHATSAPP_APP_SECRET`) |

## OLA 4

| Fase | Entregable | Estado |
|---|---|---|
| 24 | Capacidades centralizadas (`p2_h` a mano, `p2_i` generada: 17 funciones) + flags por sucursal aplicados + `puede()` en la UI | DONE (prod) · mutación 1 falla sin `p2_i` |
| 23 | Reimpresión con rastro y copia numerada (`p2_g`) + bridge local revalidado (IPv6 corregido) | DONE (prod) · negocio 9 · **impresora física NO validada (sin hardware)** |
| — | DevOps: referencias de producción versionadas (`scripts/referencias/`) + workflow `integracion.yml` (ensayo compuesto, suites SQL, E2E) en PR | DONE (local) · YAML validado · aún sin ejecución en runner Linux |
| — | DevOps: `supabase migration repair` para reconstrucción desde cero | BLOCKED: acción del dueño |

## Datos de producción a clasificar (no sanear a ciegas)

5 reservas IMEI vencidas · 1 caja antigua abierta (2026-09-07) · 2 conciliaciones pendientes — READY.
Clasificados, sin sanear: intactos tras el release (verificado).

## Pendientes externos

| Tarea | Estado |
|---|---|
| Leaked Password Protection | BLOCKED: panel de Supabase (acción del dueño) |
| Confirmar registros de Auth deshabilitados | BLOCKED: panel de Supabase (acción del dueño) |
| `WHATSAPP_APP_SECRET` + despliegue de `agente-whatsapp` | BLOCKED: secreto externo y decisión del dueño |
| Credenciales POS externo / Culqi | BLOCKED: proveedor |
