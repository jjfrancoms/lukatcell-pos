# Agent State — LukatCell POS

Última actualización base: 2026-08-24

## Stack

- React + TypeScript + Vite
- Supabase Postgres/Auth/Edge Functions/Storage
- Vercel
- GitHub Actions/CI

## Equipo Elite

Máximo 4 squads activos simultáneamente.

Activos:
- ELITE-04 — Cierre gerencial avanzado
- ELITE-06 — Pagos
- ELITE-08 — Inventario avanzado
- ELITE-09 — Compras avanzadas

La ola ELITE-01/02/15/16 cerró su bloque principal. Seguridad y Testing siguen siendo gates obligatorios dentro de cada squad.

## Núcleo implementado

- POS/Venta, Caja, Inventario, Clientes y Órdenes
- Personal, Jornada, Turnos, Permisos y Cambios de turno
- Dashboard, Auditoría y Reportes base
- Comprobantes, pagos digitales base, WhatsApp base y ventas offline
- Anulaciones, devoluciones/reembolsos, notas de crédito y autorizaciones
- Cierre diario base
- Proveedores, órdenes/recepciones de compra
- Transferencias, conteo físico e IMEI/seriales
- Taller técnico avanzado
- Sidebar simplificado: accesos operativos principales visibles y módulos secundarios agrupados por categoría, con permisos, ruta activa, móvil y modo compacto preservados

## Navegación — 2026-08-25

- Principales: Dashboard (solo administración), Nueva venta, Caja, Inventario y Clientes.
- Categorías: Ventas; Inventario y compras; CRM y comunicación; Gestión; Sistema / Administración.
- Los grupos inician cerrados salvo el de la ruta activa; las categorías vacías se ocultan.
- Verificación visual completada para administrador y vendedor en escritorio, compacto y móvil.

## Ola activa — avances

### ELITE-04
Implementado backend + UI:
- aprobación/firma gerencial de cierre;
- diferencia crítica con autorización operativa;
- conteo de conciliaciones pendientes;
- reporte final JSON + impresión;
- bloqueo de INSERT/UPDATE/DELETE de sales/payments para un día ya aprobado.

### ELITE-06
Pago mixto ya existía. Implementado:
- tabla de conciliaciones de pagos no efectivos;
- sincronización desde payments;
- conciliado/diferencia/rechazado;
- resumen por fecha real de venta;
- UI `/conciliacion-pagos`.

### ELITE-08
Implementado:
- historial de cambios de costo;
- RPC administrativo de costo;
- valorización de inventario por sucursal;
- UI `/valorizacion-inventario`.

Pendiente crítico: el frontend de Inventario aún solicita `products.costo`; por eso el ocultamiento de costo para vendedor todavía NO está cerrado.

### ELITE-09
Implementado:
- facturas proveedor;
- pagos proveedor;
- cuentas por pagar y vencimientos;
- histórico de costo real de recepción;
- UI `/cuentas-por-pagar`.

## Verificaciones

Pruebas SQL con `BEGIN/ROLLBACK`:
- historial de costo + valorización: PASS;
- factura 100 + pago parcial 40 = saldo 60: PASS;
- conciliación de pago: PASS;
- aprobación normal de cierre: PASS;
- diferencia crítica sin autorización: bloqueada correctamente;
- vendedor bloqueado en los cuatro módulos administrativos: PASS.

Seguridad actual:
- tablas públicas sin RLS = 0;
- SECURITY DEFINER ejecutable por anon = 0.
- Security Advisor mantiene warnings de funciones SECURITY DEFINER para authenticated, muchas intencionales y con validación interna, además de Leaked Password Protection desactivado.

## Deploy

La ola anterior tuvo Vercel SUCCESS.

El último intento de esta ola fue rechazado por **Vercel build-rate-limit** (`upgradeToPro=build-rate-limit`). No existe todavía evidencia de build verde para las UIs nuevas. Un intento local alternativo tampoco pudo ejecutarse por DNS del entorno, así que no debe marcarse esta ola como desplegada hasta obtener un nuevo Vercel SUCCESS.

## Bloqueos externos

- Vercel build-rate-limit temporal/del plan para la ola actual.
- Leaked Password Protection requiere Supabase Dashboard.
- `WHATSAPP_APP_SECRET` requiere secret externo para firma Meta.

## Próximo trabajo dentro de los 4 squads activos

- ELITE-04: cerrar build + detalles gerenciales finales.
- ELITE-06: auto-conciliación con pagos digitales/Culqi y reembolso proveedor.
- ELITE-08: privacidad real de costo + reconciliación serial/stock + alertas.
- ELITE-09: documentos de factura/recepción + comparación de proveedores/precios.
