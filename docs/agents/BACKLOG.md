# Backlog multiagente — LukatCell POS

Estados: `READY`, `IN_PROGRESS`, `BLOCKED`, `DONE`.

## Equipos activos

Solo 4 Equipo Elite simultáneos:
- ELITE-04 — Cierre gerencial avanzado
- ELITE-06 — Pagos
- ELITE-08 — Inventario avanzado
- ELITE-09 — Compras avanzadas

## Bloques cerrados

P0 personal/turnos: DONE.
P1 POS crítico: DONE.
P2 abastecimiento/inventario base: DONE.
P3 Taller técnico avanzado base: DONE.
Navegación/sidebar por categorías: DONE.

## ELITE-04 — Cierre gerencial

| Tarea | Estado |
|---|---|
| Firma/aprobación de cierre | DONE |
| Bloqueo financiero posterior del día | DONE |
| Diferencia crítica con autorización | DONE |
| Conciliaciones pendientes en cierre | DONE |
| Reporte final imprimible | DONE |
| Build/deploy final de la ola | BLOCKED: Vercel build-rate-limit |

## ELITE-06 — Pagos

| Tarea | Estado |
|---|---|
| Pago mixto base | DONE (preexistente) |
| Conciliación de pagos no efectivos | DONE |
| Diferencia/rechazo/confirmación | DONE |
| Resumen por fecha real de venta | DONE |
| UI Conciliación | DONE |
| Auto-conciliación Culqi/pagos digitales | IN_PROGRESS |
| Reembolso automático con proveedor | READY |
| Integración POS externo tarjeta | READY |
| Digital verificado dentro de pago mixto | READY |

## ELITE-08 — Inventario avanzado

| Tarea | Estado |
|---|---|
| Historial de costos | DONE |
| Valorización de inventario | DONE |
| UI Valorización | DONE |
| Privacidad real de costo para no-admin | IN_PROGRESS |
| Reconciliación stock ↔ IMEI/serial | READY |
| Reservas avanzadas de stock | READY |
| Tránsito avanzado | READY |
| Alertas automáticas | READY |

## ELITE-09 — Compras avanzadas

| Tarea | Estado |
|---|---|
| Facturas proveedor | DONE |
| Cuentas por pagar | DONE |
| Pagos proveedor | DONE |
| Histórico costos de compra | DONE |
| UI Cuentas por pagar | DONE |
| Adjuntar documento de factura/recepción | READY |
| Vincular factura a orden desde UI | READY |
| Comparar proveedores/precios | READY |

## Quality gates de esta ola

| Gate | Estado |
|---|---|
| Pruebas SQL admin positivas | DONE |
| Pruebas vendedor bloqueado | DONE |
| Tablas públicas sin RLS | DONE = 0 |
| SECDEF ejecutable por anon | DONE = 0 |
| Regresión estática nueva | DONE / versionada |
| Vercel | BLOCKED por build-rate-limit |
| Build local alternativo | BLOCKED por DNS del entorno |

## Pendientes externos generales

| Tarea | Estado |
|---|---|
| Leaked Password Protection | BLOCKED: Supabase Dashboard |
| `WHATSAPP_APP_SECRET` | BLOCKED: secret externo |
| Validar firma Meta `X-Hub-Signature-256` | BLOCKED hasta secret |

## Siguiente ola cuando se liberen estos 4

`ELITE-10 Multi-sucursal → ELITE-03 Reportes → ELITE-05 Promociones → ELITE-07 CRM`.
