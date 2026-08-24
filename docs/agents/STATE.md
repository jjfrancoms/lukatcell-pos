# Agent State — LukatCell POS

Última actualización base: 2026-08-24

Este archivo resume únicamente hechos operativos importantes. No debe convertirse en un changelog detallado.

## Stack

- React + TypeScript + Vite
- Supabase Postgres/Auth/Edge Functions/Storage
- Vercel
- GitHub Actions/CI

## Equipo multiagente

- 2 ORCHESTRATOR
- 2 CREATOR
- 3 DEV
- 3 TESTER
- Carriles paralelos A Backend, B Frontend, C Integraciones/Plataforma.
- Ownership/locks obligatorios por archivo, función SQL o migración.
- Máximo 3 tareas de implementación simultáneas.

## Módulos existentes

- Login/Auth
- Venta POS
- Caja
- Inventario/Catálogo
- Clientes
- Órdenes de servicio
- Reportes
- Personal
- Mi Jornada/Asistencia
- Dashboard administrativo
- Auditoría
- Permisos/Vacaciones/Licencias
- Cambios temporales de turno
- Comprobantes electrónicos
- Pagos digitales
- WhatsApp/Agente base
- Offline de ventas

## Estado personal/turnos

- 5 perfiles activos.
- Puestos usados: jefa, vendedor, técnico.
- Tres perfiles operativos todavía pueden existir sin login Auth hasta que administración use `Crear acceso`.
- Cada perfil tiene patrón semanal de 6 días + 1 descanso diferenciado.
- Máximo un turno activo por persona/día.
- Historial de turnos preservado.
- Cambios diarios/excepciones soportados.
- Turnos cruzando medianoche soportados.
- El resumen mensual respeta excepciones diarias.

## Seguridad estructural

- RLS activo en tablas públicas.
- Lecturas/escrituras sensibles limitadas por rol/sucursal.
- Login por username no expone email interno al navegador.
- `.env` no se mantiene versionado; `.env.example` es seguro.
- Ventas validan actor, sucursal, caja, precios y totales en servidor.
- Caja valida jornada, cajero, sucursal y una sola sesión abierta.
- Inventario restringe ajustes según puesto/rol.
- Auditoría registra cambios administrativos sensibles.
- Security Advisor conserva únicamente 5 RPC SECURITY DEFINER intencionales para authenticated + Leaked Password Protection pendiente.

## Dashboard/Asistencia

- Dashboard admin con ventas, cajas, personal, órdenes, stock crítico y configuración pendiente.
- Permiso, vacaciones y licencia son estados visuales propios.
- Resumen mensual de asistencia.
- Tardanzas reales.
- Horas programadas y registradas.
- Jornadas sin salida.
- Justificaciones.
- Permisos/vacaciones/licencias.
- Cambios temporales de turno afectan programación del día y resumen mensual.

## Testing

- `npm test` ejecuta regresiones estáticas de seguridad/arquitectura.
- Regresiones incluyen Cambios de turno y estados de permisos del Dashboard.
- CI ejecuta test, lint y build.
- Se han realizado pruebas SQL transaccionales con rollback para permisos, RLS, turnos, caja, ventas e inventario.
- TESTER detectó y DEV corrigió permiso faltante de `private.resolver_turno_fecha`; resumen mensual volvió a pasar como authenticated admin.
- Vercel del cambio de Dashboard P0 terminó en success.

## Pendientes externos conocidos

- Activar Leaked Password Protection en Supabase Auth.
- Configurar `WHATSAPP_APP_SECRET` y validar firma `X-Hub-Signature-256` en POST de Meta.

## Siguiente prioridad

P0 cerrado.

Siguiente tarea: `P1-01` Anulación de venta con autorización, motivo, integridad de stock/pagos/comprobante y auditoría.

## Regla de actualización

Después de terminar una función, actualizar solo:
- estado del módulo;
- riesgo nuevo;
- bloqueo nuevo;
- siguiente prioridad.

No copiar conversaciones completas aquí.
