# Equipo Elite — Squads por pendiente principal

Cada Equipo Elite contiene 2 ORCHESTRATOR, 2 CREATOR, 3 DEV y 3 TESTER. ELITE COMMAND coordina dependencias, locks y orden de integración.

## Regla de ejecución

Por decisión operativa solo pueden existir **4 squads Equipo Elite activos simultáneamente**.

## Ola activa actual

1. **ELITE-04 — Cierre gerencial avanzado — ACTIVE**
2. **ELITE-06 — Pagos — ACTIVE**
3. **ELITE-08 — Inventario avanzado — ACTIVE**
4. **ELITE-09 — Compras avanzadas — ACTIVE**

La ola anterior ELITE-01/02/15/16 terminó su bloque principal y liberó estos cuatro slots. Seguridad y Testing siguen siendo gates obligatorios dentro de cada squad, aunque sus squads dedicados ya no ocupan un slot activo.

## Orden de reemplazo restante

`ELITE-10 Multi-sucursal → ELITE-03 Reportes → ELITE-05 Promociones → ELITE-07 CRM → ELITE-13 Notificaciones → ELITE-14 WhatsApp → ELITE-18 Personal avanzado → ELITE-12 Offline → ELITE-11 Hardware → ELITE-17 DevOps`.

## Catálogo

| Squad | Bloque | Estado |
|---|---|---|
| ELITE-01 | Cierre técnico P2 | DONE |
| ELITE-02 | Servicio técnico avanzado base | DONE |
| ELITE-03 | Reportes avanzados | READY |
| ELITE-04 | Cierre gerencial avanzado | ACTIVE |
| ELITE-05 | Descuentos y promociones | READY |
| ELITE-06 | Pagos | ACTIVE |
| ELITE-07 | Clientes / CRM | READY |
| ELITE-08 | Inventario avanzado | ACTIVE |
| ELITE-09 | Compras avanzadas | ACTIVE |
| ELITE-10 | Multi-sucursal avanzado | READY |
| ELITE-11 | Hardware POS | READY |
| ELITE-12 | Offline avanzado | READY |
| ELITE-13 | Notificaciones | READY |
| ELITE-14 | WhatsApp | READY / external blockers |
| ELITE-15 | Seguridad — primera ronda | DONE / transversal |
| ELITE-16 | Testing — primera ronda | DONE / transversal |
| ELITE-17 | DevOps | READY |
| ELITE-18 | Personal avanzado | READY |

## Alcance de la ola actual

### ELITE-04
Firma/aprobación del cierre, bloqueo financiero del día, diferencia crítica con autorización, conciliaciones pendientes y reporte final imprimible.

### ELITE-06
Pago mixto ya existente; esta fase agrega conciliación, diferencias, integración con confirmaciones digitales, POS externo y reembolsos de proveedor.

### ELITE-08
Valorización, historial de costos, reconciliación de IMEI, reservas/tránsito, privacidad de costos y alertas.

### ELITE-09
Facturas proveedor, cuentas por pagar, pagos, histórico de precios, comparación de proveedores y documentos de compra/recepción.

## WIP global

- máximo 4 squads ACTIVE;
- máximo una escritura activa por archivo;
- máximo una redefinición activa por función SQL;
- TESTER + seguridad + deploy verde son gates de cierre;
- un bloqueo externo de deploy no se interpreta como código aprobado.
