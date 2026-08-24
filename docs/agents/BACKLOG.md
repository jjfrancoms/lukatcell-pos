# Backlog multiagente — LukatCell POS

Estados: `READY`, `IN_PROGRESS`, `BLOCKED`, `DONE`.

## Equipos activos

Por decisión operativa trabajan solo 4 Equipo Elite simultáneamente:
- ELITE-01 — Cierre técnico P2
- ELITE-02 — Servicio técnico avanzado
- ELITE-15 — Seguridad
- ELITE-16 — Testing

Los demás squads quedan en espera hasta liberar un cupo.

## P0 — coherencia de personal/turnos

| ID | Tarea | Estado |
|---|---|---|
| P0-01 | Migración mensual respeta excepciones | DONE |
| P0-02 | Regresiones Cambios de turno | DONE |
| P0-03 | Dashboard permisos/vacaciones/licencias | DONE |
| P0-04 | Vercel + Security Advisor | DONE |
| P0-FIX-01 | Permiso EXECUTE resolver_turno_fecha | DONE |

## P1 — funciones críticas para POS real

| ID | Tarea | Estado |
|---|---|---|
| P1-01 | Anulación de venta con autorización, motivo y auditoría | DONE |
| P1-02 | Devolución total/parcial con reversión de stock y reembolso | DONE |
| P1-03 | Nota de crédito vinculada a venta/comprobante | DONE |
| P1-04 | Motor de autorizaciones | DONE |
| P1-05 | Cierre diario general de tienda | DONE |

## P2 — abastecimiento e inventario avanzado

| ID | Tarea | Estado |
|---|---|---|
| P2-01 | Proveedores | DONE |
| P2-02 | Órdenes de compra | DONE |
| P2-03 | Recepción parcial/completa con ingreso automático de stock | DONE |
| P2-04 | Transferencias entre sucursales | DONE |
| P2-05 | IMEI / número de serie por unidad | DONE |
| P2-06 | Conteo físico / ajuste por inventario | DONE |
| P2-SEC-01 | Revocar `anon` de RPC privilegiadas de P2 | DONE |
| P2-TEST-01 | Regresiones estáticas de Proveedores/Compras/Transferencias/Conteo/Seriales | DONE |
| P2-DEPLOY-01 | Build Vercel después del bloque | DONE |
| P2-DOC-01 | Alinear migraciones GitHub con versiones de producción | DONE |

## P3 — servicio técnico avanzado

| ID | Tarea | Estado |
|---|---|---|
| P3-01 | Técnico asignado a orden | DONE |
| P3-02 | Repuestos utilizados y descuento/reposición de inventario | DONE |
| P3-03 | Mano de obra y total recalculado | DONE |
| P3-04 | Fotos antes/después/diagnóstico | DONE |
| P3-05 | Garantía de reparación | DONE |
| P3-06 | Ticket/recepción imprimible desde Taller | DONE |
| P3-07 | IMEI/serie del equipo | DONE |
| P3-08 | Fecha prometida/SLA | DONE |
| P3-09 | Historial estructurado de diagnóstico/estados/repuestos | DONE |
| P3-TEST-01 | Tests SQL admin/repuestos + vendedor bloqueado | DONE |
| P3-UI-01 | Vista `/taller` con protección por rol/jornada | DONE |
| P3-BUILD-01 | Corregir tipado de Taller y lograr Vercel SUCCESS | DONE |
| P3-POLISH-01 | Mejorar UX de selección de repuestos/fotos e indicadores SLA | READY |

## P4 — reportes/gerencia

| ID | Tarea | Estado |
|---|---|---|
| P4-01 | Ventas por vendedor | READY |
| P4-02 | Ventas por sucursal | READY |
| P4-03 | Ticket promedio y comparación de periodos | READY |
| P4-04 | Margen y rentabilidad por producto/categoría | READY |
| P4-05 | Inventario valorizado | READY |
| P4-06 | Rentabilidad de servicio técnico | READY |
| P4-07 | Cajas por empleado | READY |
| P4-08 | Exportación Excel/PDF | READY |

## P5 — hardware y operación

| ID | Tarea | Estado |
|---|---|---|
| P5-01 | Impresión térmica ESC/POS | READY |
| P5-02 | Reimpresión de ticket/comprobante | READY |
| P5-03 | Cajón monedero | READY |
| P5-04 | Impresión de etiquetas | READY |
| P5-05 | Backup local de tickets | READY |

## P6 — calidad/plataforma

| ID | Tarea | Estado |
|---|---|---|
| P6-01 | Vitest + React Testing Library | IN_PROGRESS |
| P6-02 | Playwright E2E | READY |
| P6-03 | E2E Login → Entrada → Caja → Venta → Cierre → Salida | READY |
| P6-04 | Pruebas offline automatizadas | READY |
| P6-05 | Pruebas pagos | READY |
| P6-06 | Pruebas multi-sucursal | READY |
| P6-07 | Staging Supabase separado | READY |
| P6-08 | Error tracking/monitoring | READY |
| P6-09 | Backups y recuperación documentada | READY |

## Seguridad activa — ELITE-15

| ID | Tarea | Estado |
|---|---|---|
| SEC-01 | Mantener `SECURITY DEFINER` inaccesible a anon | DONE |
| SEC-02 | Revisar función por función los warnings authenticated SECDEF | IN_PROGRESS |
| SEC-03 | Proteger información de costo en inventario para no-admin | READY |
| SEC-04 | Leaked Password Protection | BLOCKED: Supabase Dashboard |
| SEC-05 | MFA administradores | READY |
| SEC-06 | Rate limiting / CAPTCHA login | READY |
| SEC-07 | Auditoría de login/sesiones | READY |

## Bloqueados por configuración externa

| ID | Tarea | Estado |
|---|---|---|
| EXT-01 | Activar Leaked Password Protection | BLOCKED: Supabase Dashboard |
| EXT-02 | Configurar `WHATSAPP_APP_SECRET` | BLOCKED: Meta/Supabase secret |
| EXT-03 | Validar `X-Hub-Signature-256` | BLOCKED hasta EXT-02 |

## Próxima liberación de squads

Cuando ELITE-01 cierre su último chequeo, su cupo pasa al siguiente bloque prioritario. Recomendación de ELITE COMMAND: activar ELITE-03 Reportes avanzados después de cerrar definitivamente ELITE-01.
