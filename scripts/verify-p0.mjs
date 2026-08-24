import fs from 'node:fs'

const read=(p)=>fs.readFileSync(p,'utf8')
function assert(ok,msg){if(!ok){console.error(`FAIL: ${msg}`);process.exitCode=1}else console.log(`PASS: ${msg}`)}

const inventario=read('src/pages/Inventario.tsx')
const venta=read('src/pages/Venta.tsx')
const promo=read('supabase/migrations/20260824170318_promotion_cart_resolution_and_coupon_usage.sql')
const anon=read('supabase/migrations/20260824171002_revoke_anon_direct_public_surface.sql')
const cost=read('supabase/migrations/20260824171500_hide_product_cost_after_ui_migrated.sql')

assert(!inventario.includes('product:products(id, nombre, sku, imagen_url, costo,'),'Inventario operativo no solicita products.costo')
assert(inventario.includes("rpc('costos_productos_admin'"),'Costo se carga por RPC solo administrativa')
assert(inventario.includes("rpc('actualizar_costo_producto_admin'"),'Costo se actualiza por RPC administrativa')
assert(!inventario.includes("from('products').update({ costo })"),'Inventario no actualiza costo directamente')

assert(venta.includes("rpc('limite_descuento_actual'"),'Venta obtiene límite de descuento desde servidor')
assert(venta.includes("rpc('solicitar_autorizacion'"),'Descuento sobre límite usa autorizaciones')
assert(venta.includes("rpc('resolver_promociones_carrito'"),'Venta resuelve promociones antes de cobrar')
assert(venta.includes("rpc('registrar_uso_cupon'"),'Venta registra uso idempotente de cupón')
assert(venta.includes("Los cupones requieren conexión"),'Cupones no se aceptan offline sin validación servidor')
assert(venta.includes('id="btn-cobrar"'),'F4 y botón comparten el mismo gate de cobro')

assert(promo.includes('requiere_cupon boolean'),'Promociones distinguen reglas automáticas y cupones')
assert(promo.includes('unique(cupon_id,sale_id)'),'Uso de cupón es idempotente por venta')
assert(promo.includes('resolver_promociones_carrito'),'Migración incluye resolución de descuento por línea')
assert(promo.includes('registrar_uso_cupon'),'Migración incluye contabilización segura de cupón')
assert(promo.includes('revoke execute on function public.resolver_promociones_carrito'),'Resolver promociones no queda abierto a anon')

assert(anon.includes("revoke all privileges on table %I.%I from anon"),'Hardening revoca acceso directo de anon a tablas públicas')
assert(anon.includes('revoke execute on function public.set_updated_at() from public,anon,authenticated'),'Trigger técnico no es invocable por API')

assert(cost.includes('RELEASE ORDER'),'Migración de costo declara orden seguro de release')
assert(cost.includes('revoke select on table public.products from authenticated'),'Release revoca SELECT completo de products')
assert(!cost.includes('grant select(id,sku,nombre,categoria_id,precio_base,activo,created_at,imagen_url,favorito,costo'),'Grant seguro no reexpone costo')

if(process.exitCode)process.exit(process.exitCode)
console.log('P0 regression checks passed.')
