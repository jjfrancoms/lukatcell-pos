# Agent State — LukatCell POS

Última actualización base: 2026-08-24

Este archivo resume únicamente hechos operativos importantes. No debe convertirse en un changelog detallado.

## Stack

- React + TypeScript + Vite
- Supabase Postgres/Auth/Edge Functions/Storage
- Vercel
- GitHub Actions/CI

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

## Seguridad estructural

- RLS activo en tablas públicas.
- Lecturas/escrituras sensibles limitadas por rol/sucursal.
- Login por username no expone email interno al navegador.
- `.env` no se mantiene versionado; `.env.example` es seguro.
- Ventas validan actor, sucursal, caja, precios y totales en servidor.
- Caja valida jornada, cajero, sucursal y una sola sesión abierta.
- Inventario restringe ajustes según puesto/rol.
- Auditoría registra cambios administrativos sensibles.

## Dashboard/Asistencia

- Dashboard admin con ventas, cajas, personal, órdenes, stock crítico y configuración pendiente.
- Resumen mensual de asistencia.
- Tardanzas reales.
- Horas programadas y registradas.
- Jornadas sin salida.
- Justificaciones.
- Permisos/vacaciones/licencias.
- Cambios temporales de turno afectan programación del día.

## Testing

- `npm test` ejecuta regresiones estáticas de seguridad/arquitectura.
- CI ejecuta test, lint y build.
- Se han realizado pruebas SQL transaccionales con rollback para permisos, RLS, turnos, caja, ventas e inventario.
- Mantener tests de bypass como requisito para funciones sensibles.

## Pendientes externos conocidos

- Activar Leaked Password Protection en Supabase Auth.
- Configurar `WHATSAPP_APP_SECRET` y validar firma `X-Hub-Signature-256` en POST de Meta.

## Riesgos/pendientes inmediatos

1. Confirmar que la migración más reciente de asistencia que respeta excepciones diarias esté también versionada en GitHub.
2. Añadir Cambios de turno a regresiones estáticas si aún no aparece.
3. Dashboard: reflejar visualmente estado permiso/vacaciones/licencia en todos los contadores/etiquetas.
4. Crear credenciales reales para perfiles pendientes sin inventarlas.
5. Próximos módulos prioritarios: devoluciones/anulaciones, autorizaciones, proveedores/compras, IMEI/seriales y cierre diario.

## Regla de actualización

Después de terminar una función, actualizar solo:
- estado del módulo;
- riesgo nuevo;
- bloqueo nuevo;
- siguiente prioridad.

No copiar conversaciones completas aquí.
