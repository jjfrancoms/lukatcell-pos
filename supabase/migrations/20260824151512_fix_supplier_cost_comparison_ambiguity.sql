create or replace function public.comparar_costos_proveedores_admin(p_variant_id uuid)
returns table(proveedor_id uuid,proveedor text,ultima_compra timestamptz,ultimo_costo numeric,costo_minimo numeric,costo_promedio numeric,unidades_compradas bigint)
language plpgsql
stable
security definer
set search_path='public','private'
as $$
begin
 if not private.auth_is_admin() then raise exception 'Solo administradores'; end if;
 return query
 with h as (
   select hc.proveedor_id as h_proveedor_id,hc.costo_unitario,hc.cantidad,hc.created_at,p.nombre as proveedor_nombre,
          row_number() over(partition by hc.proveedor_id order by hc.created_at desc) rn
   from public.historial_costos_compra hc join public.proveedores p on p.id=hc.proveedor_id
   where hc.variant_id=p_variant_id
 ), agg as (
   select h.h_proveedor_id as a_proveedor_id,max(h.proveedor_nombre) as proveedor_nombre,max(h.created_at) as ultima_compra,min(h.costo_unitario) as costo_minimo,round(avg(h.costo_unitario),2) as costo_promedio,sum(h.cantidad)::bigint as unidades
   from h group by h.h_proveedor_id
 )
 select a.a_proveedor_id,a.proveedor_nombre::text,a.ultima_compra,
        (select h2.costo_unitario from h h2 where h2.h_proveedor_id=a.a_proveedor_id and h2.rn=1 limit 1)::numeric,
        a.costo_minimo::numeric,a.costo_promedio::numeric,a.unidades
 from agg a order by a.costo_promedio,a.proveedor_nombre;
end$$;

revoke execute on function public.comparar_costos_proveedores_admin(uuid) from public,anon;
grant execute on function public.comparar_costos_proveedores_admin(uuid) to authenticated;
