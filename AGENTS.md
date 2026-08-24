# LukatCell POS — Multi-Agent Operating Model

Este archivo es la fuente de instrucciones para cualquier agente que trabaje en este repositorio.

## Objetivo

Reducir el tiempo de desarrollo evitando análisis repetidos, cambios incompatibles y pruebas tardías. El trabajo se divide en agentes con responsabilidades claras, carriles paralelos y una memoria compartida versionada en Git.

## Equipo multiagente

### ORCHESTRATOR-1 — Coordinación principal
- Lee `STATE.md`, `BACKLOG.md`, `DECISIONS.md` y `TEST_PROTOCOL.md`.
- Descompone solicitudes en tareas pequeñas.
- Define dependencias y orden de integración.
- Asigna carriles y evita conflictos de escritura.
- Cierra tareas y actualiza memoria.

### ORCHESTRATOR-2 — Integración y continuidad
- Revisa que las tareas paralelas sigan siendo compatibles.
- Mantiene handoffs, bloqueos y dependencias.
- Verifica que backend, frontend y tests converjan antes de deploy.
- Sustituye a ORCHESTRATOR-1 cuando éste esté ocupado con otra línea.

### CREATOR-1 — Producto / UX / operaciones
- Define flujo funcional y experiencia de usuario.
- Roles, estados, casos borde y criterios de aceptación.
- Se enfoca en POS, caja, personal, servicio técnico y operación diaria.

### CREATOR-2 — Arquitectura / datos / integraciones
- Define contratos de datos, RPC, RLS, eventos e integraciones externas.
- Se enfoca en Supabase, multi-sucursal, offline, WhatsApp, Nubefact y Culqi.

### DEV-1 — Backend / Supabase
- Migraciones, SQL, RPC, RLS, triggers y Edge Functions.
- Seguridad servidor, integridad transaccional y auditoría.

### DEV-2 — Frontend / UX
- React/TypeScript, navegación, formularios, dashboard y estados visuales.
- Respeta contratos definidos por Creator y backend.

### DEV-3 — Integraciones / offline / hardware
- Culqi, Nubefact, WhatsApp, sincronización offline, impresión y hardware POS.
- Puede apoyar frontend/backend cuando su carril esté libre.

### TESTER-1 — Seguridad / permisos
- RLS, RPC, bypass de UI, roles, sucursales, datos manipulados, secretos.

### TESTER-2 — Funcional / negocio
- Camino positivo, casos borde, caja, ventas, turnos, permisos, devoluciones, stock.

### TESTER-3 — Regresión / deploy / E2E
- `npm test`, lint, build, Vercel, CI, regresiones automáticas y Playwright/E2E cuando esté disponible.

## Carriles paralelos

### Lane A — Backend
Propietario habitual: DEV-1.
Tester paralelo: TESTER-1.

### Lane B — Frontend
Propietario habitual: DEV-2.
Tester paralelo: TESTER-2.

### Lane C — Integraciones / plataforma
Propietario habitual: DEV-3.
Tester paralelo: TESTER-3.

CREATOR-1 y CREATOR-2 pueden preparar las siguientes tareas mientras los DEV implementan la tarea actual.

## Regla de ownership

Antes de escribir, ORCHESTRATOR asigna un `OWNER` por archivo/función/migración.

No se permite:
- dos DEV modificando el mismo archivo simultáneamente;
- dos migraciones redefiniendo la misma función sin dependencia explícita;
- frontend consumiendo una RPC cuya firma todavía no está congelada;
- TESTER corrigiendo código salvo que ORCHESTRATOR le reasigne formalmente la tarea.

## Flujo rápido

`REQUEST -> ORCHESTRATOR -> CREATOR-1 + CREATOR-2 -> DEV-1 + DEV-2 + DEV-3 || TESTER-1 + TESTER-2 + TESTER-3 -> FIX -> RETEST -> DEPLOY -> MEMORY UPDATE`

Los seis agentes de DEV/TEST pueden trabajar en paralelo si sus escrituras no colisionan.

## Contrato mínimo de una tarea

```md
TASK: <id>
OWNER: <agente>
LANE: A | B | C
STATUS: ready | in_progress | blocked | failed | passed
DEPENDS_ON: <ids o none>
ACCEPTANCE: <criterios concretos>
CHANGED: <archivos/migraciones>
DECISIONS: <decisiones nuevas>
RISKS: <riesgos restantes>
TESTS: <qué probar / resultado>
NEXT: <acción exacta siguiente>
```

## Memoria persistente

- `docs/agents/STATE.md`: estado verificable actual.
- `docs/agents/BACKLOG.md`: cola priorizada.
- `docs/agents/DECISIONS.md`: decisiones que no deben rediscutirse.
- `docs/agents/TEST_PROTOCOL.md`: protocolo de pruebas.
- `docs/agents/TEAM_MATRIX.md`: asignación de agentes/carriles y reglas de concurrencia.

Todos los agentes deben leer la memoria relevante antes de trabajar. ORCHESTRATOR actualiza STATE/BACKLOG al cerrar cada bloque; DECISIONS cuando exista una decisión arquitectónica nueva.

## Definition of Done

Una función no está terminada solo porque compila. Debe cumplir:
1. criterios de aceptación;
2. permisos correctos;
3. migración versionada si cambia BD;
4. pruebas positivas y negativas;
5. regresión automática cuando el riesgo lo justifique;
6. deploy verde;
7. memoria actualizada.

## Principios ya establecidos

- `staff.rol` = permiso del sistema; `staff.puesto` = función laboral.
- Una persona tiene como máximo un turno activo por día.
- Los horarios históricos no se destruyen.
- Las excepciones diarias tienen prioridad sobre el patrón semanal.
- Permisos/vacaciones/licencias no son ausencias.
- Un vendedor no debe poder saltarse la UI mediante RPC/RLS.
- Ventas, caja e inventario validan identidad/sucursal en servidor.
- Administrador puede gestionar sin jornada; personal operativo requiere jornada en módulos operativos.
- Todas las tablas públicas mantienen RLS.
- No exponer secretos ni correos internos innecesariamente al navegador.
