# LUKATCELL POS

Sistema de punto de venta para LUKATCELL (tienda de tecnología: cases, micas, audífonos, teclados, insumos de impresora, reparación técnica y más), construido con React + TypeScript + Supabase.

## Roadmap y estado

- **Fase 1 — Responsive + correcciones**: sidebar de escritorio colapsable, menú móvil, fallback de imagen rota, favoritos con respaldo cuando no hay ninguno marcado. ✅
- **Fase 2a — Órdenes de servicio**: registro de reparaciones, datos de cliente y equipo, seguimiento por estado (recibido → diagnosticado → en reparación → listo → entregado), comprobante imprimible. ✅
- **Fase 2b — Dashboard de ganancias**: costo por producto editable (solo admin), margen por venta/producto vía RPC `resumen_ganancias` / `top_productos_ganancia`, top productos por ganancia. ✅
- **Fase 3a — Pago mixto**: varias formas de pago en una misma venta (ej. efectivo + Yape), registro detallado por método en `payments`. ✅
- **Fase 3b — Clientes frecuentes**: registro nombre + teléfono, historial de compras, notas por cliente. ✅
- **Fase 4 — Producción real**:
  - Login con Supabase Auth (cajero vs administrador) vía tabla `staff` + políticas RLS. ✅
  - Impresión de comprobantes (venta y orden de servicio) vía diálogo de impresión del navegador con plantilla de 80mm. ✅ — impresión térmica ESC/POS cruda (corte automático, código de barras) requeriría un servicio local (`node-thermal-printer`) corriendo en la PC de la tienda; no aplica a un deploy serverless en Vercel, queda como mejora futura opcional.
  - Offline-first: catálogo cacheado en IndexedDB (`idb`), ventas realizadas sin conexión se encolan y sincronizan automáticamente al reconectar. ✅
  - Dominio personalizado: pendiente de que el dominio se apunte por DNS (ver sección de deploy).

## Primer ingreso

No hay usuarios todavía. Al abrir la app por primera vez, la pantalla de login detecta que no existe personal registrado y muestra la pestaña **"Crear administrador"**: completa tu nombre, correo y contraseña para crear la primera cuenta (queda como `administrador`). Desde ahí puedes crear más cuentas de `cajero` insertando filas en la tabla `staff` desde el panel de Supabase (vinculadas a un usuario creado en Authentication → Users).

## Seguridad

Las políticas RLS que permitían acceso anónimo total (heredadas de la etapa sin login) fueron retiradas: ahora todas las tablas de negocio (ventas, caja, pagos, inventario, clientes, órdenes de servicio) requieren sesión autenticada. El catálogo de productos (nombre/precio) se mantiene de lectura pública porque no es información sensible.

## Cómo correrlo localmente

```
npm install
npm run dev
```

Las credenciales de Supabase ya están en `.env` (proyecto real y activo).

## Panel de Supabase

https://supabase.com/dashboard/project/fbwkclpgnsxuqycazumj
