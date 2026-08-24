# EQUIPO ELITE — TEAM MATRIX — LukatCell POS

**Equipo Elite** es el nombre oficial del grupo multiagente de LukatCell POS.

## Capacidad paralela

- ORCHESTRATOR: 2
- CREATOR: 2
- DEV: 3
- TESTER: 3

Total operativo: 10 agentes especializados.

## Asignación base

| Agente | Especialidad | Carril | Puede trabajar en paralelo con |
|---|---|---|---|
| ORCHESTRATOR-1 | planificación/priority | coordinación | todos |
| ORCHESTRATOR-2 | integración/handoffs | coordinación | todos |
| CREATOR-1 | producto/UX/operación | diseño | CREATOR-2, DEV/TEST activos |
| CREATOR-2 | arquitectura/datos/integraciones | diseño | CREATOR-1, DEV/TEST activos |
| DEV-1 | SQL/Supabase/RLS/RPC | Lane A | DEV-2, DEV-3 |
| DEV-2 | React/TypeScript/UI | Lane B | DEV-1, DEV-3 |
| DEV-3 | integrations/offline/hardware | Lane C | DEV-1, DEV-2 |
| TESTER-1 | security/RLS/roles | Lane A test | TESTER-2, TESTER-3 |
| TESTER-2 | functional/business | Lane B test | TESTER-1, TESTER-3 |
| TESTER-3 | regression/deploy/E2E | Lane C test | TESTER-1, TESTER-2 |

## Ejemplo: Anulación de venta

CREATOR-1:
- flujo cajero/admin;
- motivo;
- estados visuales;
- consecuencias de negocio.

CREATOR-2:
- modelo de datos;
- RPC transaccional;
- impacto comprobante/pago/stock;
- auditoría.

DEV-1:
- migración + RPC + RLS + auditoría.

DEV-2:
- modal/acción de anulación + estados UI.

DEV-3:
- impacto Nubefact/Culqi/offline si aplica.

TESTER-1:
- vendedor no autorizado;
- bypass RPC;
- sucursal incorrecta;
- doble anulación.

TESTER-2:
- venta válida;
- motivo obligatorio;
- stock/pagos/estado final.

TESTER-3:
- regresión automática;
- build/deploy;
- E2E cuando exista Playwright.

## Regla anti-colisiones

Cada tarea debe declarar:

`OWNER + FILES/OBJECTS LOCKED + DEPENDS_ON`

Ejemplo:

```md
TASK: P1-01-A
OWNER: DEV-1
LOCKED: registrar_anulacion_venta(), sales, sale_items
DEPENDS_ON: P1-01-CREATOR
```

Mientras ese lock esté activo, otro DEV no redefine esos objetos.

## Paralelización recomendada por fase

### Fase diseño
- CREATOR-1 + CREATOR-2 en paralelo.
- TESTER-1/2 pueden preparar matriz de pruebas con criterios preliminares.

### Fase implementación
- DEV-1 backend.
- DEV-2 frontend con contrato congelado.
- DEV-3 integración relacionada o siguiente tarea independiente.
- TESTER-1 prueba backend en cuanto exista.
- TESTER-2 prueba UI/negocio en cuanto exista.

### Fase cierre
- TESTER-3 ejecuta regresión/build/deploy.
- ORCHESTRATOR-2 verifica integración.
- ORCHESTRATOR-1 actualiza STATE/BACKLOG/DECISIONS.

## WIP limit

Para no degradar calidad:
- máximo 3 tareas de implementación simultáneas;
- máximo 1 escritura activa por archivo;
- máximo 1 redefinición activa por función SQL;
- una tarea P0/P1 crítica tiene prioridad sobre mejoras P4-P6.

## Memoria

Los agentes de **Equipo Elite** no deben confiar en memoria conversacional únicamente. La verdad durable vive en:
- `STATE.md`
- `BACKLOG.md`
- `DECISIONS.md`
- `TEST_PROTOCOL.md`
- migraciones Supabase
- código actual de `main`
