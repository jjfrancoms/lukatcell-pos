# LUKATCELL POS — Smoke & Security Test Report

Fecha: 2026-08-23
Entorno: Supabase producción + `main` + Vercel

## Resultado general

Las pruebas críticas de permisos, jornadas, caja, inventario, ventas, RLS y personal pasaron después de corregir los fallos encontrados durante la ejecución.

## Pruebas ejecutadas

| Prueba | Resultado |
|---|---|
| 5 empleados activos | PASS |
| 5 empleados con exactamente 6 días distintos | PASS |
| Turnos duplicados activos por empleado/día | PASS — 0 duplicados |
| Inserción de segundo turno activo mismo día | PASS — rechazada |
| Perfiles activos sin puesto | PASS — 0 |
| Perfiles sin Auth | 3 pendientes esperados |
| Vendedor ajusta stock por RPC | PASS — bloqueado |
| Vendedor escribe `inventory` directamente | PASS — bloqueado |
| Vendedor ejecuta RPC administrativas de Personal | PASS — bloqueado |
| Vendedor elimina cliente | PASS — bloqueado |
| Apertura de caja sin jornada | PASS — rechazada |
| Una sola caja abierta por empleado | PASS — índice activo |
| Línea de venta con precio/subtotal manipulado | PASS — rechazada |
| Trigger de contexto de venta | PASS |
| Trigger de validación de línea | PASS |
| Validación diferida de totales/pagos | PASS |
| `personal_activo_hoy` para administrador | PASS — 5 personas |
| Estado del día | PASS — 1 descanso / 4 programados en la prueba |
| Reprogramación conserva historial | PASS |
| Turno nocturno 20:00–04:00 a la 01:00 | PASS — pertenece al día anterior |
| Turno nocturno después de 04:00 | PASS — ya no está activo |
| Llegada 15 min tarde, tolerancia 10 | PASS — guarda ~15 min reales y estado `tarde` |
| RLS comprobante de otra sucursal | PASS — invisible |
| RLS pago digital de otra sucursal | PASS — invisible |
| Tablas públicas sin RLS | PASS — 0 |
| SECURITY DEFINER ejecutables por `anon` | PASS — 0 |
| Helpers auth expuestos en `public` | PASS — movidos a `private` |
| Vendedor tras mover helpers privados | PASS — solo su staff/sucursal |
| Admin tras mover helpers privados | PASS — 5 staff + reportes + Personal |
| Vendedor lee su jornada tras reducir SECURITY DEFINER | PASS |
| Vendedor accede a `personal_activo_hoy` | PASS — bloqueado |
| Admin usa Personal/configuración/reprogramación | PASS |
| Vercel del `main` final probado | PASS — success |

Todas las pruebas que requerían modificar datos de negocio se hicieron dentro de `BEGIN ... ROLLBACK`, por lo que no dejaron datos sintéticos permanentes.

## Fallos encontrados y corregidos

### 1. `personal_activo_hoy()` — columna `rol` ambigua

Detectado al probar la RPC como administrador. PostgreSQL devolvía `column reference "rol" is ambiguous`.

Corrección: alias explícito de `staff` y referencia `s_admin.rol`.

### 2. `notificar-estado` público sin autenticar llamante

La Edge Function podía recibir peticiones externas y usar el token de WhatsApp del servidor.

Corrección: ahora exige exactamente el Bearer `service_role` usado por el trigger interno.

### 3. `emitir-comprobante` aceptaba cualquier usuario autenticado

Un vendedor podía intentar forzar reintentos hacia Nubefact fuera de la UI.

Corrección: `service_role` sigue permitido para el trigger; un JWT de usuario solo se acepta si corresponde a staff administrador activo.

### 4. Lectura entre sucursales

`comprobantes_electronicos` y `pagos_digitales` permitían lectura a cualquier autenticado.

Corrección: RLS por sucursal, con acceso global de administrador.

### 5. Helpers auth expuestos como RPC públicas

`auth_is_admin`, `auth_location_id` y `auth_staff_id` estaban en `public` como `SECURITY DEFINER`.

Corrección: movidos al esquema `private`; las políticas RLS y reportes fueron actualizados.

### 6. Tardanza representaba solo exceso sobre tolerancia

Ejemplo anterior: 15 min tarde con tolerancia 10 se guardaba como 5.

Corrección: `minutos_tarde` guarda el retraso real; la tolerancia únicamente decide si el estado pasa a `tarde`.

### 7. Jornada cruzando medianoche incompleta

Corrección: resolución de turno anterior/actual, salida hasta el día siguiente y estado de jornada compatible con horarios nocturnos.

## Automatización de regresiones

Se añadió:

```text
npm test
```

que ejecuta `scripts/verify-security.mjs`.

CI quedó configurado como:

1. `npm ci`
2. `npm test`
3. `npm run lint`
4. `npm run build`

## Pendientes externos, no resolubles únicamente desde código

### WhatsApp / Meta

Issue #2: falta configurar `WHATSAPP_APP_SECRET` en Supabase Secrets y desplegar validación HMAC de `X-Hub-Signature-256` para POST del webhook.

### Supabase Auth

Issue #3: activar Leaked Password Protection desde Supabase Dashboard.

### Credenciales del personal

`tecnico`, `vendedor2` y `vendedor3` siguen sin Auth porque no se deben inventar correos ni contraseñas. La UI de Personal ya ofrece **Crear acceso** para vincularlos de forma segura cuando administración proporcione las credenciales.

## Advertencias SECURITY DEFINER restantes

El Security Advisor conserva advertencias para cinco RPC que requieren elevación de privilegios de forma deliberada:

- `ajustar_stock` — permite ajustes autorizados sin conceder escritura directa de inventario.
- `crear_primer_admin` — bootstrap protegido para una instalación sin personal.
- `registrar_mi_entrada` — registra hora del servidor y reglas de jornada.
- `registrar_mi_salida` — controla caja abierta y salida del servidor.
- `registrar_venta` — transacción validada de venta sin conceder INSERT directo a tablas financieras.

Estas funciones tienen controles internos y no están disponibles para `anon`.
