# Equipo Elite — Squads por pendiente principal

Este documento asigna un **Equipo Elite completo** a cada bloque principal pendiente de LukatCell POS.

Cada Equipo Elite contiene:
- 2 ORCHESTRATOR
- 2 CREATOR
- 3 DEV
- 3 TESTER

Total por squad: **10 agentes lógicos especializados**.

La coordinación global se denomina **ELITE COMMAND** y evita colisiones entre squads, controla dependencias, locks de archivos/SQL y orden de integración.

> Importante: los squads pueden diseñar y preparar trabajo en paralelo, pero las escrituras sobre los mismos archivos, RPC, tablas o migraciones siguen sujetas al WIP/ownership definido en `AGENTS.md`.

---

## ELITE COMMAND — Coordinación global

Responsabilidades:
- ordenar prioridades entre squads;
- congelar contratos de datos antes de integrar frontend;
- asignar locks de tablas/RPC/archivos;
- validar dependencias cruzadas;
- consolidar `STATE.md`, `BACKLOG.md` y `DECISIONS.md`;
- impedir que dos squads redefinan el mismo objeto simultáneamente;
- decidir cuándo un squad puede pasar de diseño a implementación;
- exigir TESTER + deploy verde antes de cerrar un bloque.

---

## ELITE-01 — Cierre técnico P2

Objetivo: cerrar formalmente inventario/compras/serialización P2.

Scope:
- regresiones automáticas de Proveedores;
- regresiones de Compras;
- regresiones de Transferencias;
- regresiones de Conteo físico;
- regresiones de IMEI/Seriales;
- verificación final de Vercel;
- Security Advisor final;
- actualizar `STATE.md`;
- actualizar `BACKLOG.md`.

Prioridad: **P0 inmediata**.

Dependencias: ninguna.

---

## ELITE-02 — Servicio técnico avanzado

Scope:
- técnico asignado;
- repuestos utilizados;
- descuento automático de inventario por repuestos;
- IMEI/serie del equipo;
- mano de obra;
- fotos antes/después;
- historial de diagnóstico/estados;
- garantía de reparación;
- fecha prometida/SLA;
- ticket de recepción imprimible.

Prioridad: **P1**.

Dependencias principales:
- ELITE-01 para stock/IMEI estable;
- coordinación con ELITE-11 Hardware para impresión;
- coordinación con ELITE-13 Notificaciones y ELITE-14 WhatsApp.

---

## ELITE-03 — Reportes avanzados

Scope:
- ventas por vendedor;
- ventas por sucursal;
- ticket promedio;
- margen;
- comparativa entre periodos;
- rentabilidad de reparaciones;
- inventario valorizado;
- cajas por empleado;
- exportación Excel;
- exportación PDF.

Prioridad: **P2**.

Dependencias:
- ELITE-02 para rentabilidad de reparaciones;
- ELITE-04 para cierre gerencial;
- ELITE-08/09 para valorización y compras.

---

## ELITE-04 — Cierre gerencial avanzado

Scope:
- aprobación/firma de cierre;
- bloqueo posterior del día;
- detalle por método de pago;
- diferencias críticas con autorización;
- reporte final de tienda.

Prioridad: **P1**.

Dependencias:
- motor de autorizaciones existente;
- ELITE-06 Pagos;
- ELITE-03 Reportes para reporte gerencial consolidado.

---

## ELITE-05 — Descuentos y promociones

Scope:
- límites por vendedor;
- descuento con autorización;
- combos;
- 2x1;
- cupones;
- promociones por fecha;
- precios especiales.

Prioridad: **P2**.

Dependencias:
- motor de autorizaciones existente;
- coordinación con ventas, devoluciones y reportes.

---

## ELITE-06 — Pagos

Scope:
- pago mixto completamente automatizado;
- Yape/Plin avanzado;
- tarjeta POS externo;
- conciliación Culqi;
- reembolsos automáticos con proveedor.

Prioridad: **P1/P2**.

Dependencias:
- Culqi existente;
- devoluciones/reembolsos existentes;
- ELITE-11 Hardware para POS externo cuando aplique.

---

## ELITE-07 — Clientes / CRM

Scope:
- perfil completo;
- total gastado;
- última compra;
- historial completo de compras;
- historial de reparaciones;
- segmentación;
- puntos/fidelización;
- campañas WhatsApp;
- consentimiento de comunicaciones.

Prioridad: **P2**.

Dependencias:
- ELITE-02 Servicio técnico;
- ELITE-14 WhatsApp;
- ELITE-10 Multi-sucursal para aislamiento de datos si aplica.

---

## ELITE-08 — Inventario avanzado

Scope:
- reconciliación física de IMEI;
- stock reservado;
- stock en tránsito avanzado;
- valorización;
- costo promedio/último costo;
- historial de costos;
- alertas automáticas.

Prioridad: **P1/P2**.

Dependencias:
- ELITE-01 P2 cerrado;
- ELITE-09 Compras avanzadas;
- ELITE-10 Multi-sucursal;
- ELITE-13 Notificaciones.

---

## ELITE-09 — Compras avanzadas

Scope:
- cuentas por pagar;
- facturas de proveedor;
- comparación de proveedores;
- histórico de precios;
- recepción con documentos.

Prioridad: **P2**.

Dependencias:
- compras/proveedores P2 existentes;
- ELITE-08 para política de costos/valorización.

---

## ELITE-10 — Multi-sucursal avanzado

Scope:
- crear/editar sucursales desde UI;
- usuarios multi-sucursal;
- dashboard por tienda;
- dashboard consolidado;
- permisos entre sucursales.

Prioridad: **P2**.

Dependencias:
- RLS actual;
- transferencias existentes;
- coordinación con ELITE-03, ELITE-07 y ELITE-08.

---

## ELITE-11 — Hardware POS

Scope:
- impresora térmica ESC/POS;
- autoimpresión;
- cajón monedero;
- impresora de etiquetas;
- ticket de servicio técnico;
- backup local de tickets;
- estado de impresora;
- reimpresión.

Prioridad: **P3**.

Dependencias:
- ELITE-02 para ticket de servicio;
- ELITE-06 para POS externo;
- ELITE-12 para backup/offline.

---

## ELITE-12 — Offline avanzado

Scope:
- órdenes offline;
- clientes offline;
- movimientos offline;
- asistencia offline;
- resolución de conflictos.

Prioridad: **P3**.

Dependencias:
- outbox/idempotencia existente;
- contratos congelados de ELITE-02/07/08;
- ELITE-16 Testing para E2E offline.

---

## ELITE-13 — Notificaciones

Scope:
- stock crítico;
- tardanzas;
- jornada sin entrada;
- jornada sin salida;
- diferencias de caja;
- cambios de turno;
- nuevos permisos;
- fallos de sincronización;
- alertas operativas.

Prioridad: **P2/P3**.

Dependencias:
- Dashboard/Jornada/Caja actuales;
- ELITE-08 inventario;
- ELITE-14 WhatsApp para canal externo.

---

## ELITE-14 — WhatsApp

Scope:
- validar firma `X-Hub-Signature-256`;
- configurar `WHATSAPP_APP_SECRET`;
- plantillas oficiales;
- historial de conversaciones;
- transferencia agente IA → humano;
- envío de comprobantes.

Prioridad: **P1 bloqueo externo + P2**.

Dependencias externas:
- `WHATSAPP_APP_SECRET` debe configurarse directamente en Supabase/Meta;
- no almacenar secretos en repo ni conversación.

---

## ELITE-15 — Seguridad

Scope:
- activar Leaked Password Protection;
- MFA para administradores;
- rate limiting de login;
- CAPTCHA tras intentos fallidos;
- gestión de sesiones;
- políticas de contraseña;
- auditoría de logins.

Prioridad: **P1 continuo**.

Dependencias externas:
- Leaked Password Protection requiere configuración Supabase Auth;
- MFA/CAPTCHA pueden requerir cambios de Auth/UX.

Este squad actúa además como **security gate transversal** sobre todos los demás.

---

## ELITE-16 — Testing

Scope:
- Vitest;
- React Testing Library;
- Playwright;
- E2E completo por roles;
- pruebas offline;
- pruebas de pagos;
- pruebas de hardware;
- pruebas de múltiples sucursales.

Prioridad: **P1 continuo**.

Rol transversal:
- recibe criterios de todos los otros squads;
- crea regresiones reutilizables;
- bloquea cierre de módulos críticos si no pasan tests.

---

## ELITE-17 — DevOps

Scope:
- entorno staging;
- Supabase de desarrollo;
- backups verificados;
- recuperación ante desastre;
- monitoring;
- error tracking;
- alertas de producción.

Prioridad: **P2**.

Rol transversal:
- provee entornos para ELITE-16;
- protege producción de pruebas destructivas;
- establece observabilidad y recuperación.

---

## ELITE-18 — Personal avanzado

Scope:
- cambio de contraseña;
- contraseña temporal obligatoria;
- recuperación de acceso;
- foto/DNI/teléfono/dirección;
- documentos laborales;
- calendario avanzado de horarios;
- solicitudes de cambio de turno;
- saldo de vacaciones;
- adjuntos de justificaciones.

Prioridad: **P2/P3**.

Dependencias:
- Auth/Security con ELITE-15;
- horarios/asistencia existentes;
- notificaciones con ELITE-13.

---

# Resumen de capacidad

Pendientes principales asignados: **18**.

Equipos Elite completos: **18 squads**.

Agentes lógicos por squad: **10**.

Capacidad lógica total asignada: **180 roles de agente**, coordinados por **ELITE COMMAND**.

Esto NO significa 180 procesos escribiendo a la vez. La ejecución real debe respetar locks, dependencias y WIP para evitar degradar el proyecto.

---

# Orden recomendado de activación

## Ola 1 — crítica
1. ELITE-01 Cierre P2
2. ELITE-15 Seguridad
3. ELITE-16 Testing
4. ELITE-02 Servicio técnico
5. ELITE-04 Cierre gerencial
6. ELITE-06 Pagos

## Ola 2 — núcleo empresarial
7. ELITE-08 Inventario avanzado
8. ELITE-09 Compras avanzadas
9. ELITE-10 Multi-sucursal
10. ELITE-03 Reportes
11. ELITE-05 Promociones
12. ELITE-07 CRM

## Ola 3 — plataforma
13. ELITE-13 Notificaciones
14. ELITE-14 WhatsApp
15. ELITE-18 Personal avanzado
16. ELITE-12 Offline avanzado
17. ELITE-11 Hardware POS
18. ELITE-17 DevOps

ELITE COMMAND puede adelantar tareas independientes cuando no existan conflictos de escritura ni dependencias pendientes.
