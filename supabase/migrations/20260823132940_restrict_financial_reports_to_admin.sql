create or replace function public.resumen_ganancias(
  fecha_desde timestamptz,
  fecha_hasta timestamptz
)
returns table(
  total_ventas numeric,
  total_costo numeric,
  total_ganancia numeric,
  margen_promedio numeric,
  num_ventas bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(sum(si.subtotal), 0) as total_ventas,
    coalesce(sum(coalesce(si.costo_snapshot, 0) * si.cantidad), 0) as total_costo,
    coalesce(sum(si.subtotal) - sum(coalesce(si.costo_snapshot, 0) * si.cantidad), 0) as total_ganancia,
    case when sum(si.subtotal) > 0
      then round(((sum(si.subtotal) - sum(coalesce(si.costo_snapshot, 0) * si.cantidad)) / sum(si.subtotal)) * 100, 1)
      else 0
    end as margen_promedio,
    count(distinct s.id) as num_ventas
  from public.sale_items si
  join public.sales s on s.id = si.sale_id
  where public.auth_is_admin()
    and s.estado = 'completada'
    and s.fecha >= fecha_desde
    and s.fecha < fecha_hasta;
$$;

create or replace function public.top_productos_ganancia(
  fecha_desde timestamptz,
  fecha_hasta timestamptz,
  lim integer default 10
)
returns table(
  producto_nombre varchar,
  producto_sku varchar,
  unidades_vendidas bigint,
  ingreso numeric,
  costo_total numeric,
  ganancia numeric,
  margen numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.nombre,
    p.sku,
    sum(si.cantidad)::bigint as unidades_vendidas,
    sum(si.subtotal) as ingreso,
    sum(coalesce(si.costo_snapshot, 0) * si.cantidad) as costo_total,
    sum(si.subtotal) - sum(coalesce(si.costo_snapshot, 0) * si.cantidad) as ganancia,
    case when sum(si.subtotal) > 0
      then round(((sum(si.subtotal) - sum(coalesce(si.costo_snapshot, 0) * si.cantidad)) / sum(si.subtotal)) * 100, 1)
      else 0
    end as margen
  from public.sale_items si
  join public.sales s on s.id = si.sale_id
  join public.product_variants pv on pv.id = si.variant_id
  join public.products p on p.id = pv.product_id
  where public.auth_is_admin()
    and s.estado = 'completada'
    and s.fecha >= fecha_desde
    and s.fecha < fecha_hasta
  group by p.id, p.nombre, p.sku
  order by ganancia desc
  limit greatest(1, least(coalesce(lim, 10), 100));
$$;

revoke all on function public.resumen_ganancias(timestamptz, timestamptz) from public, anon;
revoke all on function public.top_productos_ganancia(timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.resumen_ganancias(timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.top_productos_ganancia(timestamptz, timestamptz, integer) to authenticated, service_role;
