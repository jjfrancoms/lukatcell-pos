-- La migración anterior (reservas_imei_por_transaccion) agregó
-- producto_control_serial a variantes_actualizadas_desde/variantes_por_
-- categoria/buscar_por_barcode/obtener_favoritos, pero se pasó por alto
-- `buscar_variantes` — la RPC que realmente usa el cuadro de búsqueda de
-- Venta.tsx para encontrar un producto por nombre/modelo/SKU. Sin este
-- campo aquí también, buscar un celular serializado por nombre en la
-- pantalla de venta seguiría sin poder disparar el selector de IMEI.
drop function if exists public.buscar_variantes(text);
create function public.buscar_variantes(texto text)
returns table(id uuid, product_id uuid, color varchar, modelo_celular_id uuid, precio_override numeric, codigo_barras varchar, producto_nombre varchar, producto_sku varchar, producto_precio numeric, producto_imagen text, producto_control_serial boolean, modelo_marca varchar, modelo_modelo varchar, updated_at timestamptz)
language sql stable set search_path = public
as $$
  select pv.id, pv.product_id, pv.color, pv.modelo_celular_id,
    pv.precio_override, pv.codigo_barras,
    p.nombre, p.sku, p.precio_base, p.imagen_url, coalesce(p.control_serial, false),
    m.marca, m.modelo,
    greatest(p.updated_at, pv.updated_at) as updated_at
  from product_variants pv
  join products p on p.id = pv.product_id
  left join modelos_celular m on m.id = pv.modelo_celular_id
  where p.activo = true and (
    pv.codigo_barras = texto or p.nombre ilike '%'||texto||'%'
    or p.sku ilike '%'||texto||'%' or m.modelo ilike '%'||texto||'%'
    or m.marca ilike '%'||texto||'%' or pv.color ilike '%'||texto||'%'
  ) limit 20;
$$;
revoke all on function public.buscar_variantes(text) from public, anon;
grant execute on function public.buscar_variantes(text) to authenticated;
