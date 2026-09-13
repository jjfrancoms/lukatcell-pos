# Equipo Elite — modelo de ejecución

ELITE COMMAND coordina; cada squad tiene roles ORCHESTRATOR, CREATOR, DEV y TESTER con propiedad
exclusiva de archivos y funciones SQL. Estado vivo en [CURRENT_EXECUTION.md](CURRENT_EXECUTION.md).

## Reglas de WIP

- Máximo 4 squads activos; máximo una escritura activa por archivo y una redefinición activa por
  función SQL.
- TESTER, seguridad y ensayo compuesto son gates de cierre. Un bloqueo externo no equivale a código
  aprobado.
- Todo hallazgo de un squad se verifica con una prueba que falla antes y pasa después.

## Realidad operativa de la ola 2026-09 (P1)

Los cuatro squads iniciales y dos agentes posteriores (E2E, integración) murieron por límite de uso.
Desde entonces: **máximo 2 agentes** y el coordinador ejecuta directamente el ensayo compuesto, la
reconciliación de deriva y los gates. Lo que produjeron los squads (UI de Transferencias y Compras,
E2E) se revisó y validó antes de aceptarlo.

## Estado por bloque

| Bloque | Estado |
|---|---|
| OLA 1 — transferencias, recepción, caja, pagos (Fases 13/14/18) | DONE (prod) · 2026-09-13 |
| OLA 2 — reportes (22), multi-sucursal, promociones, CRM | DONE (prod) · 2026-09-13 |
| OLA 3 — incidencias (21), cierre diario (20), offline, WhatsApp | DONE (prod) · WhatsApp: código listo, Edge Function no desplegada (decisión del dueño) |
| OLA 4 — permisos (24), hardware (23), DevOps | DONE (prod) · impresora física sin validar; `migration repair` pendiente del dueño |

El catálogo ELITE-01…18 de agosto se sustituye por las olas anteriores; ver [BACKLOG.md](BACKLOG.md).
