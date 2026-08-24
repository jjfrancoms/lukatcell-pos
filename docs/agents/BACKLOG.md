# Backlog multiagente — LukatCell POS

Estados: `READY`, `IN_PROGRESS`, `BLOCKED`, `DONE`.

## P0 — terminar coherencia del bloque actual

| ID | Tarea | Agente principal | Tester paralelo | Estado |
|---|---|---|---|---|
| P0-01 | Versionar en GitHub la migración `monthly_attendance_respects_shift_overrides` | DEV-1 | TESTER-1 | DONE |
| P0-02 | Añadir `/cambios-turno` y sus RPC a regresiones automáticas | DEV-2 | TESTER-3 | DONE |
| P0-03 | Dashboard: representar permiso/vacaciones/licencia como estado propio | CREATOR-1 + DEV-2 | TESTER-2 | DONE |
| P0-04 | Verificar Vercel + Security Advisor después del bloque | TESTER-3 + TESTER-1 | — | DONE |
| P0-FIX-01 | Corregir permiso EXECUTE de `private.resolver_turno_fecha` detectado por tests | DEV-1 | TESTER-1 | DONE |

## P1 — funciones críticas para POS real

| ID | Tarea | Agente principal | Tester paralelo | Estado |
|---|---|---|---|---|
| P1-01 | Anulación de venta con autorización, motivo y auditoría | CREATOR-1 + CREATOR-2 + DEV-1/2 | TESTER-1/2/3 | READY |
| P1-02 | Devolución total/parcial con reversión de stock y pago | CREATOR-1 + CREATOR-2 + DEV-1/2/3 | TESTER-1/2/3 | READY |
| P1-03 | Nota de crédito vinculada a venta/comprobante | DEV-1 + DEV-3 | TESTER-1/2/3 | READY |
| P1-04 | Motor de autorizaciones: descuentos, anulaciones, ajustes sensibles | CREATOR-1 + CREATOR-2 + DEV-1/2 | TESTER-1/2 | READY |
| P1-05 | Cierre diario general de tienda | CREATOR-1 + DEV-1/2 | TESTER-1/2/3 | READY |

## P2 — abastecimiento e inventario avanzado

| ID | Tarea | Agente principal | Tester paralelo | Estado |
|---|---|---|---|---|
| P2-01 | Proveedores | CREATOR-1 + DEV-1/2 | TESTER-1/2 | READY |
| P2-02 | Órdenes de compra | DEV-1/2 | TESTER-1/2 | READY |
| P2-03 | Recepción parcial/completa con ingreso automático de stock | DEV-1/2 | TESTER-1/2 | READY |
| P2-04 | Transferencias entre sucursales | CREATOR-2 + DEV-1/2 | TESTER-1/2 | READY |
| P2-05 | IMEI / número de serie por unidad | CREATOR-2 + DEV-1/2 | TESTER-1/2 | READY |
| P2-06 | Conteo físico / ajuste por inventario | DEV-1/2 | TESTER-1/2 | READY |

## P3 — servicio técnico

| ID | Tarea | Agente principal | Tester paralelo | Estado |
|---|---|---|---|---|
| P3-01 | Técnico asignado a orden | DEV-1/2 | TESTER-1/2 | READY |
| P3-02 | Repuestos utilizados y descuento de inventario | DEV-1/2 | TESTER-1/2 | READY |
| P3-03 | Mano de obra | DEV-1/2 | TESTER-2 | READY |
| P3-04 | Fotos antes/después | DEV-2/3 | TESTER-2/3 | READY |
| P3-05 | Garantía de reparación | CREATOR-1 + DEV-1/2 | TESTER-1/2 | READY |
| P3-06 | Ticket/recepción imprimible | DEV-2/3 | TESTER-2/3 | READY |

## P4 — reportes/gerencia

| ID | Tarea | Agente principal | Tester paralelo | Estado |
|---|---|---|---|---|
| P4-01 | Ventas por vendedor | DEV-1/2 | TESTER-2 | READY |
| P4-02 | Ticket promedio y comparación de periodos | DEV-1/2 | TESTER-2 | READY |
| P4-03 | Margen y rentabilidad por producto/categoría | DEV-1/2 | TESTER-1/2 | READY |
| P4-04 | Inventario valorizado | DEV-1/2 | TESTER-1/2 | READY |
| P4-05 | Reporte servicio técnico | DEV-1/2 | TESTER-2 | READY |
| P4-06 | Exportación Excel/PDF | DEV-2/3 | TESTER-3 | READY |

## P5 — hardware y operación

| ID | Tarea | Agente principal | Tester paralelo | Estado |
|---|---|---|---|---|
| P5-01 | Impresión térmica ESC/POS | DEV-3 | TESTER-3 | READY |
| P5-02 | Reimpresión de ticket/comprobante | DEV-2/3 | TESTER-3 | READY |
| P5-03 | Cajón monedero | DEV-3 | TESTER-3 | READY |
| P5-04 | Impresión de etiquetas | DEV-3 | TESTER-3 | READY |
| P5-05 | Backup local de tickets | DEV-3 | TESTER-3 | READY |

## P6 — calidad/plataforma

| ID | Tarea | Agente principal | Tester paralelo | Estado |
|---|---|---|---|---|
| P6-01 | Vitest + React Testing Library | TESTER-3 + DEV-2 | TESTER-2 | READY |
| P6-02 | Playwright E2E | TESTER-3 + DEV-2 | TESTER-2 | READY |
| P6-03 | E2E: Login → Entrada → Caja → Venta → Cierre → Salida | TESTER-2/3 | DEV fixes | READY |
| P6-04 | Staging Supabase separado | DEV-1 | TESTER-1 | READY |
| P6-05 | Error tracking/monitoring | DEV-3 | TESTER-3 | READY |
| P6-06 | Backups y recuperación documentada | DEV-1/3 | TESTER-1/3 | READY |

## Bloqueados por configuración externa

| ID | Tarea | Estado |
|---|---|---|
| EXT-01 | Activar Leaked Password Protection | BLOCKED: Supabase Dashboard |
| EXT-02 | Configurar `WHATSAPP_APP_SECRET` | BLOCKED: Meta/Supabase secret |
| EXT-03 | Validar `X-Hub-Signature-256` | BLOCKED hasta EXT-02 |

## Regla de prioridad

P0 está cerrado. ORCHESTRATOR debe seleccionar ahora P1-01 y dividirlo entre CREATOR-1/2, DEV-1/2/3 y TESTER-1/2/3 según `TEAM_MATRIX.md`.

Cada tarea grande debe actualizar este archivo al cerrarse.
