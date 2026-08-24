# Equipo Elite — Squads por pendiente principal

Este documento asigna un **Equipo Elite completo** a cada bloque principal pendiente de LukatCell POS.

Cada Equipo Elite contiene:
- 2 ORCHESTRATOR
- 2 CREATOR
- 3 DEV
- 3 TESTER

Total por squad: **10 agentes lógicos especializados**.

La coordinación global se denomina **ELITE COMMAND** y evita colisiones entre squads, controla dependencias, locks de archivos/SQL y orden de integración.

## Regla de ejecución actual

Por decisión del usuario, **solo pueden existir 4 squads Equipo Elite activos simultáneamente**.

Los demás squads permanecen en cola `READY` y ELITE COMMAND activa uno nuevo únicamente cuando otro squad pasa a `DONE`, `BLOCKED` o libera su carril principal.

Esto limita la capacidad activa a **40 roles lógicos simultáneos** y reduce colisiones, regresiones cruzadas y sobrecarga de coordinación.

### Cuatro squads activos iniciales

1. **ELITE-01 — Cierre técnico P2**
2. **ELITE-02 — Servicio técnico avanzado**
3. **ELITE-15 — Seguridad**
4. **ELITE-16 — Testing**

### Regla de reemplazo

Cuando ELITE-01 cierre P2, su slot pasa al siguiente bloque prioritario compatible. Orden inicial de entrada:

`ELITE-04 Cierre gerencial → ELITE-06 Pagos → ELITE-08 Inventario avanzado → ELITE-09 Compras avanzadas → ELITE-10 Multi-sucursal → ELITE-03 Reportes → ELITE-05 Promociones → ELITE-07 CRM → ELITE-13 Notificaciones → ELITE-14 WhatsApp → ELITE-18 Personal avanzado → ELITE-12 Offline → ELITE-11 Hardware → ELITE-17 DevOps`.

ELITE-15 Seguridad y ELITE-16 Testing son transversales y pueden permanecer activos mientras existan cambios críticos que revisar.

---

## ELITE COMMAND — Coordinación global

Responsabilidades:
- mantener máximo 4 squads activos;
- ordenar prioridades entre squads;
- congelar contratos de datos antes de integrar frontend;
- asignar locks de tablas/RPC/archivos;
- validar dependencias cruzadas;
- consolidar `STATE.md`, `BACKLOG.md` y `DECISIONS.md`;
- impedir que dos squads redefinan el mismo objeto simultáneamente;
- decidir cuándo un squad puede pasar de diseño a implementación;
- exigir TESTER + deploy verde antes de cerrar un bloque.

---

## Catálogo de squads

| Squad | Bloque principal | Estado operativo inicial |
|---|---|---|
| ELITE-01 | Cierre técnico P2 | ACTIVE |
| ELITE-02 | Servicio técnico avanzado | ACTIVE |
| ELITE-03 | Reportes avanzados | READY |
| ELITE-04 | Cierre gerencial avanzado | READY |
| ELITE-05 | Descuentos y promociones | READY |
| ELITE-06 | Pagos | READY |
| ELITE-07 | Clientes / CRM | READY |
| ELITE-08 | Inventario avanzado | READY |
| ELITE-09 | Compras avanzadas | READY |
| ELITE-10 | Multi-sucursal avanzado | READY |
| ELITE-11 | Hardware POS | READY |
| ELITE-12 | Offline avanzado | READY |
| ELITE-13 | Notificaciones | READY |
| ELITE-14 | WhatsApp | READY / external blockers |
| ELITE-15 | Seguridad | ACTIVE |
| ELITE-16 | Testing | ACTIVE |
| ELITE-17 | DevOps | READY |
| ELITE-18 | Personal avanzado | READY |

## Alcance resumido

- **ELITE-01:** regresiones P2, Vercel, Security Advisor, STATE/BACKLOG.
- **ELITE-02:** técnico, repuestos, stock, IMEI, mano de obra, fotos, historial, garantía, SLA y ticket.
- **ELITE-03:** vendedor/sucursal, ticket promedio, margen, periodos, reparación, inventario, caja, Excel/PDF.
- **ELITE-04:** firma/aprobación de cierre, bloqueo del día, pagos, diferencias, reporte final.
- **ELITE-05:** límites de descuento, autorización, combos, 2x1, cupones, promociones y precios especiales.
- **ELITE-06:** pago mixto, Yape/Plin, POS externo, Culqi y reembolsos.
- **ELITE-07:** perfil cliente, historial, segmentación, fidelización y campañas.
- **ELITE-08:** reconciliación IMEI, reservas, tránsito, valorización, costos y alertas.
- **ELITE-09:** cuentas por pagar, facturas, proveedores, precios y documentos de recepción.
- **ELITE-10:** UI sucursales, usuarios multi-sucursal, dashboards y permisos.
- **ELITE-11:** ESC/POS, cajón, etiquetas, tickets, backup y reimpresión.
- **ELITE-12:** órdenes/clientes/movimientos/asistencia offline y conflictos.
- **ELITE-13:** alertas de stock, jornada, caja, turnos, permisos y sincronización.
- **ELITE-14:** firma Meta, plantillas, conversaciones, handoff humano y comprobantes.
- **ELITE-15:** Auth, MFA, rate limiting, CAPTCHA, sesiones y security gates.
- **ELITE-16:** Vitest, RTL, Playwright, E2E y regresión transversal.
- **ELITE-17:** staging, backups, DR, monitoring y error tracking.
- **ELITE-18:** accesos, datos laborales, horarios, vacaciones y adjuntos.

## WIP global

- máximo **4 squads ACTIVE**;
- máximo una escritura activa por archivo;
- máximo una redefinición activa por función SQL;
- un squad bloqueado libera su slot si no puede avanzar sin intervención externa;
- Seguridad y Testing pueden auditar a los otros dos squads sin tomar ownership de sus archivos salvo reasignación explícita.
