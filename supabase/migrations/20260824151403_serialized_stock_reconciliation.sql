create or replace function public.reconciliacion_seriales_admin(p_location_id uuid default null)
returns table(variant_id uuid, producto text, color text, stock_numerico integer, seriales_disponibles integer, diferencia integer)
language plpgsql
stable
security definer
set search_path='public','private'
as $$
declare s public.staff; loc uuid;
begin
  if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  loc:=coalesce(p_location_id,s.location_id);
  return query
  select i.variant_id,p.nombre::text,pv.color::text,i.cantidad,
         count(ps.id) filter(where ps.estado='disponible' and ps.location_id=loc)::int,
         (i.cantidad-count(ps.id) filter(where ps.estado='disponible' and ps.location_id=loc))::int
  from public.inventory i
  join public.product_variants pv on pv.id=i.variant_id
  join public.products p on p.id=pv.product_id and p.control_serial=true
  left join public.product_serials ps on ps.variant_id=i.variant_id
  where i.location_id=loc
  group by i.variant_id,p.nombre,pv.color,i.cantidad
  order by abs(i.cantidad-count(ps.id) filter(where ps.estado='disponible' and ps.location_id=loc)) desc,p.nombre;
end$$;

revoke execute on function public.reconciliacion_seriales_admin(uuid) from public, anon;
grant execute on function public.reconciliacion_seriales_admin(uuid) to authenticated;
