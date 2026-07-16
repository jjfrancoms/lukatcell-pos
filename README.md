# LUKATCELL POS

Sistema de punto de venta para LUKATCELL (accesorios de celulares), construido con React + TypeScript + Supabase.

## Ya está hecho

- Proyecto Supabase real y activo: lukatcell-pos (ref: fbwkclpgnsxuqycazumj, región São Paulo)
- Esquema completo de base de datos aplicado: productos, variantes (color + modelo de celular), inventario por ubicación, ventas, pagos, sesiones de caja, movimientos de inventario
- Triggers automáticos: descuento de stock al vender, validación de stock antes de confirmar venta, cálculo de diferencia de caja al cerrar turno
- Row Level Security configurado (cajeros ven solo su sesión activa; inventario y ventas filtrados por ubicación; solo administradores editan catálogo)
- 4 pantallas funcionales conectadas a la base de datos real:
  - / Venta — búsqueda, carrito, cobro con 4 métodos de pago (efectivo/tarjeta/Yape/Plin), atajos de teclado (F2 buscar, F4 cobrar, Esc cancelar)
  - /caja — apertura y cierre de turno con cálculo automático de diferencia
  - /inventario — listado con alerta de stock bajo y filtros
  - /reportes — dashboard con ventas del día, ticket promedio, y exportación a Excel con estilo de marca
- Paleta e identidad visual de LUKATCELL aplicada (cian #17BFE0, naranja #FF8C00)
- Compila sin errores (tsc + vite build verificados)

## Pendiente antes de producción

1. Autenticación real: hoy las pantallas no tienen login. Falta implementar Supabase Auth y un hook useAuth() que resuelva staff_id, location_id y la sesión de caja activa. Las políticas RLS y las inserciones de venta ya están preparadas para usar auth.uid().
2. Cargar catálogo inicial: crear al menos una location, categorías, modelos de celular, productos y variantes de ejemplo (hoy las tablas están vacías).
3. Ligar venta a location_id y cash_session_id: la función registrarVenta en Venta.tsx inserta la venta sin estos campos; deben completarse desde el contexto de sesión una vez exista login.
4. Impresión térmica: no implementada aún (siguiente paso, vía servicio Node local con node-thermal-printer).
5. Offline-first (IndexedDB): no implementado en esta primera versión; se recomienda añadirlo cuando el flujo principal esté validado en tienda.

## Cómo correrlo localmente

```
npm install
npm run dev
```

Las credenciales de Supabase ya están en .env (proyecto real y activo).

## Panel de Supabase

https://supabase.com/dashboard/project/fbwkclpgnsxuqycazumj
