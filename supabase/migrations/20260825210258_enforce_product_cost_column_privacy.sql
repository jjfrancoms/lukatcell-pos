revoke select on table public.products from authenticated;
grant select (id, sku, nombre, categoria_id, precio_base, activo, created_at, imagen_url, favorito, updated_at, control_serial) on table public.products to authenticated;

revoke select on table public.products from anon;

-- Los administradores obtienen costos únicamente mediante RPCs SECURITY DEFINER que validan rol.
grant execute on function public.costos_productos_admin() to authenticated;
revoke execute on function public.costos_productos_admin() from anon, public;
