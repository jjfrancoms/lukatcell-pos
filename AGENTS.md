# LukatCell POS — Multi-Agent Operating Model

Este archivo es la fuente de instrucciones para cualquier agente que trabaje en este repositorio.

## Objetivo

Reducir el tiempo de desarrollo evitando análisis repetidos, cambios incompatibles y pruebas tardías. El trabajo se divide en agentes con responsabilidades claras y una memoria compartida versionada en Git.

## Agentes

### 1. ORCHESTRATOR
Responsable de coordinar el trabajo.

Debe:
- Leer `docs/agents/STATE.md`, `docs/agents/BACKLOG.md` y `docs/agents/DECISIONS.md` antes de modificar código.
- Convertir cada solicitud en tareas pequeñas con criterios de aceptación.
- Detectar qué tareas pueden ejecutarse en paralelo.
- Asignar cada tarea a CREATOR, DEV o TESTER.
- No reabrir decisiones ya registradas salvo evidencia nueva.
- Actualizar la memoria al cerrar cada bloque.

### 2. CREATOR
Responsable de definición funcional, UX y arquitectura de la solución.

Entrega antes del desarrollo:
- problema a resolver;
- comportamiento esperado;
- roles afectados;
- estados y casos borde;
- cambios de UI;
- cambios de datos/API;
- criterios de aceptación;
- riesgos y dependencias.

No debe escribir una implementación grande sin dejar primero un contrato funcional mínimo.

### 3. DEV
Responsable de implementación.

Debe:
- trabajar únicamente contra criterios de aceptación definidos;
- preservar RLS, multi-sucursal y auditoría;
- preferir transacciones/RPC para operaciones multi-paso;
- nunca confiar en IDs, precios, totales, roles o sucursales enviados por el navegador cuando puedan derivarse en servidor;
- versionar todo DDL como migración Supabase;
- evitar borrar historial operativo;
- mantener compatibilidad con offline cuando corresponda;
- actualizar tipos/UI después del backend.

### 4. TESTER
Responsable de intentar romper la implementación.

Debe diseñar pruebas mientras DEV trabaja, no después.

Debe probar como mínimo:
- camino positivo;
- permisos por rol;
- bypass directo a RPC/RLS;
- datos manipulados desde cliente;
- duplicados/idempotencia;
- errores de red/reintentos si aplica;
- multi-sucursal;
- fechas/zonas horarias;
- turnos nocturnos si aplica;
- rollback/transacciones;
- regresiones de seguridad;
- build/lint/test/deploy.

Cuando sea seguro, usar pruebas SQL dentro de `BEGIN ... ROLLBACK` para no dejar datos sintéticos.

## Flujo obligatorio

`REQUEST -> CREATOR -> DEV + TESTER EN PARALELO -> FIX -> RETEST -> MERGE/DEPLOY -> MEMORY UPDATE`

El TESTER puede empezar en paralelo apenas los criterios de aceptación estén definidos.

## Handoff compacto

Cada agente debe entregar al siguiente este bloque:

```md
TASK: <id>
STATUS: ready | blocked | failed | passed
CHANGED: <archivos/migraciones>
DECISIONS: <decisiones nuevas>
RISKS: <riesgos restantes>
TESTS: <qué debe probarse>
NEXT: <acción exacta siguiente>
```

No transferir explicaciones largas si ya están registradas en `DECISIONS.md`.

## Memoria persistente

- `docs/agents/STATE.md`: estado actual verificable del sistema.
- `docs/agents/BACKLOG.md`: cola priorizada de funciones.
- `docs/agents/DECISIONS.md`: decisiones que no deben rediscutirse.
- `docs/agents/TEST_PROTOCOL.md`: protocolo mínimo de calidad.

Al cerrar una tarea, ORCHESTRATOR debe actualizar al menos STATE y BACKLOG. Si se tomó una decisión arquitectónica, también DECISIONS.

## Reglas de paralelización

Se pueden ejecutar en paralelo cuando no comparten la misma escritura:
- backend/migración y diseño de pruebas;
- nueva RPC y UI mock/adaptación de tipos;
- documentación y pruebas;
- auditoría de seguridad y desarrollo de una función no relacionada.

No ejecutar en paralelo:
- dos escrituras sobre el mismo archivo;
- dos migraciones que redefinan la misma función sin coordinación;
- cambios de RLS y funciones dependientes sin un orden explícito;
- deploy final antes de terminar pruebas críticas.

## Definition of Done

Una función no está terminada solo porque compila. Debe cumplir:
1. criterios de aceptación;
2. permisos correctos;
3. migración versionada si cambia BD;
4. pruebas positivas y negativas;
5. regresión automática cuando el riesgo lo justifique;
6. deploy verde;
7. memoria actualizada.

## Principios del proyecto ya establecidos

- `staff.rol` = permiso del sistema; `staff.puesto` = función laboral.
- Una persona tiene como máximo un turno activo por día.
- Los horarios históricos no se destruyen.
- Las excepciones diarias tienen prioridad sobre el patrón semanal.
- Permisos/vacaciones/licencias no son ausencias.
- Un vendedor no debe poder saltarse la UI mediante RPC/RLS.
- Ventas, caja e inventario validan identidad/sucursal en servidor.
- Administrador puede gestionar sin jornada; personal operativo requiere jornada en módulos operativos.
- Todas las tablas públicas deben mantener RLS.
- No exponer secretos ni correos internos innecesariamente al navegador.
