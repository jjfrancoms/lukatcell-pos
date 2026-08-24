# Agent State — LukatCell POS

Última actualización base: 2026-08-24

Este archivo resume únicamente hechos operativos importantes. No debe convertirse en un changelog detallado.

## Stack

- React + TypeScript + Vite
- Supabase Postgres/Auth/Edge Functions/Storage
- Vercel
- GitHub Actions/CI

## Equipo Elite

- 4 squads activos simultáneamente por decisión operativa.
- Activos actualmente: ELITE-01 Cierre técnico P2, ELITE-02 Servicio técnico, ELITE-15 Seguridad, ELITE-16 Testing.
- Cada squad conserva 2 ORCHESTRATOR, 2 CREATOR, 3 DEV y 3 TESTER lógicos.
- Ownership/locks obligatorios por archivo, función SQL o migración.
- El resto de squads permanece en espera hasta liberar capacidad.

## Módulos existentes

- Login/Auth
- Venta POS
- Caja
- Inventario/Catálogo
- Clientes
- Órdenes de servicio
- Taller técnico avanzado
- Reportes base
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
- Anulaciones
- Devoluciones y reembolsos
- Notas de crédito
- Autorizaciones operativas
- Cierre diario
- Proveedores
- Órdenes y recepciones de compra
- Transferencias entre sucursales
- Conteo físico
- IMEI/Seriales y reservas para venta

## P1 — estado

P1 está implementado: anulaciones, devoluciones, nota de crédito, motor de autorizaciones y cierre diario.

## P2 — estado

P2 está funcionalmente implementado:
- proveedores;
- órdenes de compra;
- recepción parcial/completa;
- transferencia entre sucursales;
- IMEI/serial por unidad;
- conteo físico.

Las regresiones estáticas cubren que las UIs sensibles usen RPC y no escriban inventario directamente. Las migraciones de P2 y el hardening de seguridad están alineadas con las versiones reales de producción.

## P3 — Taller técnico avanzado

Backend y UI base implementados:
- técnico asignado;
- IMEI/serie del equipo;
- diagnóstico y estado técnico;
- mano de obra;
- repuestos con descuento/reposición transaccional de stock;
- historial técnico automático;
- fecha prometida/SLA;
- garantía;
- fotos antes/después/diagnóstico en bucket privado;
- ticket de recepción existente accesible desde Taller.

Pruebas SQL transaccionales confirmaron flujo administrativo y repuestos; vendedor bloqueado por RPC y UPDATE directo. La vista `/taller` está protegida por `InventoryOpsRoute`.

## Seguridad estructural

- RLS activo en tablas públicas.
- Lecturas/escrituras sensibles limitadas por rol/sucursal.
- Login por username no expone email interno al navegador.
- `.env` no se mantiene versionado; `.env.example` es seguro.
- Ventas validan actor, sucursal, caja, precios y totales en servidor.
- Caja valida jornada, cajero, sucursal y una sola sesión abierta.
- Inventario restringe ajustes según puesto/rol.
- Auditoría registra cambios administrativos sensibles.
- `secdef_anon = 0`: ninguna RPC `SECURITY DEFINER` pública queda ejecutable por `anon`.
- Security Advisor mantiene avisos de RPC `SECURITY DEFINER` para authenticated que deben revisarse por intención, además de Leaked Password Protection desactivado.

## Testing / deploy

- `npm test` ejecuta regresiones estáticas de seguridad/arquitectura.
- Regresiones incluyen P2 y Taller P3.
- CI está configurado para test, lint y build.
- Se han realizado pruebas SQL con rollback para permisos, RLS, turnos, caja, ventas, inventario, compras, transferencias, seriales y Taller.
- El build de Taller falló inicialmente por tipado del formulario y fue corregido.
- Vercel del commit de corrección de Taller `636ecde6d55e99393a9dde1485223c4a48c42558` terminó en SUCCESS.

## Pendientes externos conocidos

- Activar Leaked Password Protection en Supabase Auth.
- Configurar `WHATSAPP_APP_SECRET` y validar firma `X-Hub-Signature-256` en POST de Meta.

## Siguiente prioridad de los 4 squads activos

- ELITE-01: cierre documental/final de P2.
- ELITE-02: pulido funcional de Taller y transición a reportes de servicio.
- ELITE-15: revisar warnings authenticated SECDEF y hardening adicional sin romper RPC transaccionales.
- ELITE-16: ampliar testing automatizado (Vitest/RTL/Playwright) empezando por flujos críticos.

## Regla de actualización

Después de terminar una función, actualizar solo:
- estado del módulo;
- riesgo nuevo;
- bloqueo nuevo;
- siguiente prioridad.

No copiar conversaciones completas aquí.
