# TEST_PROTOCOL — LukatCell POS

## Objetivo

Detectar fallos antes de producción y convertir bugs importantes en regresiones permanentes.

## Matriz mínima por función

### A. Funcional
- camino feliz;
- campos obligatorios;
- límites/valores vacíos;
- duplicados;
- estados anteriores/posteriores;
- reintento/idempotencia.

### B. Roles
Probar, según corresponda:
- administrador/jefa;
- vendedor;
- técnico;
- encargado;
- usuario autenticado sin permiso;
- anon cuando el endpoint exista públicamente.

### C. Bypass
Intentar saltarse la UI mediante:
- llamada RPC directa;
- insert/update/delete directo;
- IDs de otro staff;
- `location_id` de otra sucursal;
- monto/precio/total manipulado;
- caja de otro empleado;
- fechas fuera de vigencia.

### D. Integridad temporal
- zona America/Lima;
- cambio de día;
- turno cruzando medianoche;
- fecha futura/pasada;
- vigencia de turnos;
- permisos/vacaciones;
- excepción diaria.

### E. Multi-sucursal
Crear escenario sintético cuando sea necesario y confirmar que no hay lectura/escritura cruzada.

### F. Offline
Para funciones offline:
- desconexión;
- persistencia local;
- reconexión;
- reintento;
- doble envío;
- conflicto por datos cambiados.

## SQL seguro

Preferir:

```sql
begin;
-- preparar escenario sintético
-- ejecutar caso
-- comprobar resultado
rollback;
```

Nunca dejar fixtures de test permanentes en producción salvo instrucción explícita.

## Seguridad

Después de DDL/RLS/funciones:
- revisar Security Advisor;
- verificar RLS;
- buscar funciones `SECURITY DEFINER` expuestas;
- verificar grants `anon/authenticated/service_role`;
- confirmar que UI no sea la única defensa.

## Frontend

Mínimo:
- `npm test`;
- `npm run lint`;
- `npm run build`;
- Vercel/CI verde;
- rutas protegidas;
- estados loading/error/empty;
- móvil y escritorio para pantallas operativas críticas.

## Criterio PASS

Un test solo es PASS si verifica una condición concreta. “No lanzó error” no es suficiente cuando se esperaba un dato, bloqueo o cambio específico.

## Reporte del TESTER

```md
TASK: P1-XX
RESULT: PASS | FAIL
TESTS:
- PASS: ...
- PASS: ...
- FAIL: ...
BUGS:
- <descripción + severidad>
REGRESSION_NEEDED: yes/no
RETEST_REQUIRED: yes/no
```

## Severidad

- P0: corrupción de datos, bypass de permisos, pérdida financiera, secreto expuesto.
- P1: flujo principal roto o dato incorrecto importante.
- P2: comportamiento incorrecto con workaround.
- P3: UI/cosmético.

P0/P1 deben corregirse antes de marcar la tarea como DONE.
