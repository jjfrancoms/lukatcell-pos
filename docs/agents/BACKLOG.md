# Backlog multiagente — LukatCell POS

Estados: `READY`, `IN_PROGRESS`, `BLOCKED`, `DONE`.

## P0 — terminar coherencia del bloque actual

| ID | Tarea | Agente principal | Tester paralelo | Estado |
|---|---|---|---|---|
| P0-01 | Versionar en GitHub la migración `monthly_attendance_respects_shift_overrides` si falta | DEV | TESTER | READY |
| P0-02 | Añadir `/cambios-turno` y sus RPC a regresiones automáticas | DEV | TESTER | READY |
| P0-03 | Dashboard: representar permiso/vacaciones/licencia como estado propio | CREATOR + DEV | TESTER | READY |
| P0-04 | Verificar Vercel + Security Advisor después del bloque | TESTER | — | READY |

## P1 — funciones críticas para POS real

| ID | Tarea | Agente principal | Tester paralelo | Estado |
|---|---|---|---|---|
| P1-01 | Anulación de venta con autorización, motivo y auditoría | CREATOR + DEV | TESTER | READY |
| P1-02 | Devolución total/parcial con reversión de stock y pago | CREATOR + DEV | TESTER | READY |
| P1-03 | Nota de crédito vinculada a venta/comprobante | DEV | TESTER | READY |
| P1-04 | Motor de autorizaciones: descuentos, anulaciones, ajustes sensibles | CREATOR + DEV | TESTER | READY |
| P1-05 | Cierre diario general de tienda | CREATOR + DEV | TESTER | READY |

## P2 — abastecimiento e inventario avanzado

| ID | Tarea | Agente principal | Tester paralelo | Estado |
|---|---|---|---|---|
| P2-01 | Proveedores | CREATOR + DEV | TESTER | READY |
| P2-02 | Órdenes de compra | DEV | TESTER | READY |
| P2-03 | Recepción parcial/completa con ingreso automático de stock | DEV | TESTER | READY |
| P2-04 | Transferencias entre sucursales | CREATOR + DEV | TESTER | READY |
| P2-05 | IMEI / número de serie por unidad | CREATOR + DEV | TESTER | READY |
| P2-06 | Conteo físico / ajuste por inventario | DEV | TESTER | READY |

## P3 — servicio técnico

| ID | Tarea | Agente principal | Tester paralelo | Estado |
|---|---|---|---|---|
| P3-01 | Técnico asignado a orden | DEV | TESTER | READY |
| P3-02 | Repuestos utilizados y descuento de inventario | DEV | TESTER | READY |
| P3-03 | Mano de obra | DEV | TESTER | READY |
| P3-04 | Fotos antes/después | DEV | TESTER | READY |
| P3-05 | Garantía de reparación | CREATOR + DEV | TESTER | READY |
| P3-06 | Ticket/recepción imprimible | DEV | TESTER | READY |

## P4 — reportes/gerencia

| ID | Tarea | Agente principal | Tester paralelo | Estado |
|---|---|---|---|---|
| P4-01 | Ventas por vendedor | DEV | TESTER | READY |
| P4-02 | Ticket promedio y comparación de periodos | DEV | TESTER | READY |
| P4-03 | Margen y rentabilidad por producto/categoría | DEV | TESTER | READY |
| P4-04 | Inventario valorizado | DEV | TESTER | READY |
| P4-05 | Reporte servicio técnico | DEV | TESTER | READY |
| P4-06 | Exportación Excel/PDF | DEV | TESTER | READY |

## P5 — hardware y operación

| ID | Tarea | Agente principal | Tester paralelo | Estado |
|---|---|---|---|---|
| P5-01 | Impresión térmica ESC/POS | DEV | TESTER | READY |
| P5-02 | Reimpresión de ticket/comprobante | DEV | TESTER | READY |
| P5-03 | Cajón monedero | DEV | TESTER | READY |
| P5-04 | Impresión de etiquetas | DEV | TESTER | READY |
| P5-05 | Backup local de tickets | DEV | TESTER | READY |

## P6 — calidad/plataforma

| ID | Tarea | Agente principal | Tester paralelo | Estado |
|---|---|---|---|---|
| P6-01 | Vitest + React Testing Library | TESTER + DEV | — | READY |
| P6-02 | Playwright E2E | TESTER + DEV | — | READY |
| P6-03 | E2E: Login → Entrada → Caja → Venta → Cierre → Salida | TESTER | DEV fixes | READY |
| P6-04 | Staging Supabase separado | DEV | TESTER | READY |
| P6-05 | Error tracking/monitoring | DEV | TESTER | READY |
| P6-06 | Backups y recuperación documentada | DEV | TESTER | READY |

## Bloqueados por configuración externa

| ID | Tarea | Estado |
|---|---|---|
| EXT-01 | Activar Leaked Password Protection | BLOCKED: Supabase Dashboard |
| EXT-02 | Configurar `WHATSAPP_APP_SECRET` | BLOCKED: Meta/Supabase secret |
| EXT-03 | Validar `X-Hub-Signature-256` | BLOCKED hasta EXT-02 |

## Regla de prioridad

ORCHESTRATOR debe seleccionar primero P0. Al terminar P0, trabajar P1 antes de P2-P6 salvo solicitud explícita del usuario.

Cada tarea grande debe dividirse en subtareas `CREATOR`, `DEV` y `TESTER` y actualizar este archivo al cerrarse.
