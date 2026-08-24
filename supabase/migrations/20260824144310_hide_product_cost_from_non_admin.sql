revoke select on table public.products from authenticated, anon;
grant select (id, sku, nombre, categoria_id, precio_base, activo, created_at, imagen_url, favorito, updated_at, control_serial) on public.products to authenticated;

create or replace function public.costos_productos_admin()
returns table(product_id uuid, costo numeric)
language plpgsql
stable
security definer
set search_path='public','private'
as $$
begin
  if not private.auth_is_admin() then
    raise exception 'Solo administradores pueden consultar costos';
  end if;
  return query select p.id, p.costo from public.products p;
end$$;

revoke execute on function public.costos_productos_admin() from public, anon;
grant execute on function public.costos_productos_admin() to authenticated;
