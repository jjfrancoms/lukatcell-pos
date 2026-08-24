create or replace function public.reportes_avanzados_admin(p_desde date,p_hasta date,p_comparar_desde date default null,p_comparar_hasta date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path='public','private'
as $$
declare out jsonb; cur jsonb; cmp jsonb; begin
 if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
 if p_desde is null or p_hasta is null or p_hasta<p_desde then raise exception 'Rango inválido'; end if;

 with ventas as (
   select s.* from public.sales s where s.estado='completada' and s.fecha>=p_desde::timestamptz and s.fecha<(p_hasta+1)::timestamptz
 ), margen as (
   select coalesce(sum(si.subtotal-si.descuento),0) ingreso,coalesce(sum(coalesce(si.costo_snapshot,0)*si.cantidad),0) costo
   from public.sale_items si join ventas v on v.id=si.sale_id
 )
 select jsonb_build_object(
   'ventas_total',coalesce((select sum(total) from ventas),0),
   'ventas_cantidad',(select count(*) from ventas),
   'ticket_promedio',coalesce((select avg(total) from ventas),0),
   'margen_bruto',coalesce((select ingreso-costo from margen),0),
   'costo_ventas',coalesce((select costo from margen),0)
 ) into cur;

 if p_comparar_desde is not null and p_comparar_hasta is not null then
   with ventas as (
     select s.* from public.sales s where s.estado='completada' and s.fecha>=p_comparar_desde::timestamptz and s.fecha<(p_comparar_hasta+1)::timestamptz
   ), margen as (
     select coalesce(sum(si.subtotal-si.descuento),0) ingreso,coalesce(sum(coalesce(si.costo_snapshot,0)*si.cantidad),0) costo
     from public.sale_items si join ventas v on v.id=si.sale_id
   )
   select jsonb_build_object('ventas_total',coalesce((select sum(total) from ventas),0),'ventas_cantidad',(select count(*) from ventas),'ticket_promedio',coalesce((select avg(total) from ventas),0),'margen_bruto',coalesce((select ingreso-costo from margen),0)) into cmp;
 end if;

 select jsonb_build_object(
 'resumen',cur,
 'comparacion',cmp,
 'por_vendedor',coalesce((select jsonb_agg(x order by (x->>'ventas')::numeric desc) from (
   select jsonb_build_object('staff_id',st.id,'nombre',st.nombre,'ventas',sum(s.total),'tickets',count(*),'ticket_promedio',avg(s.total)) x
   from public.sales s join public.staff st on st.id=s.cajero_id
   where s.estado='completada' and s.fecha>=p_desde::timestamptz and s.fecha<(p_hasta+1)::timestamptz group by st.id,st.nombre
 ) q),'[]'::jsonb),
 'por_sucursal',coalesce((select jsonb_agg(x order by (x->>'ventas')::numeric desc) from (
   select jsonb_build_object('location_id',l.id,'nombre',l.nombre,'ventas',sum(s.total),'tickets',count(*),'ticket_promedio',avg(s.total)) x
   from public.sales s join public.locations l on l.id=s.location_id
   where s.estado='completada' and s.fecha>=p_desde::timestamptz and s.fecha<(p_hasta+1)::timestamptz group by l.id,l.nombre
 ) q),'[]'::jsonb),
 'por_categoria',coalesce((select jsonb_agg(x order by (x->>'margen')::numeric desc) from (
   select jsonb_build_object('categoria',coalesce(c.nombre,'Sin categoría'),'ventas',sum(si.subtotal-si.descuento),'costo',sum(coalesce(si.costo_snapshot,0)*si.cantidad),'margen',sum(si.subtotal-si.descuento-coalesce(si.costo_snapshot,0)*si.cantidad)) x
   from public.sale_items si join public.sales s on s.id=si.sale_id join public.product_variants pv on pv.id=si.variant_id join public.products p on p.id=pv.product_id left join public.categorias c on c.id=p.categoria_id
   where s.estado='completada' and s.fecha>=p_desde::timestamptz and s.fecha<(p_hasta+1)::timestamptz group by c.nombre
 ) q),'[]'::jsonb),
 'taller',coalesce((select jsonb_build_object('ordenes',count(*),'ingresos',coalesce(sum(o.costo_final),0),'costo_repuestos',coalesce(sum(parts.costo),0),'rentabilidad',coalesce(sum(o.costo_final),0)-coalesce(sum(parts.costo),0))
   from public.ordenes_servicio o left join lateral(select sum(r.costo_unitario*r.cantidad) costo from public.orden_servicio_repuestos r where r.orden_id=o.id) parts on true
   where o.estado='entregado' and coalesce(o.fecha_entrega,o.updated_at)>=p_desde::timestamptz and coalesce(o.fecha_entrega,o.updated_at)<(p_hasta+1)::timestamptz),'{}'::jsonb),
 'cajas_por_empleado',coalesce((select jsonb_agg(x order by (x->>'sesiones')::int desc) from (
   select jsonb_build_object('staff_id',st.id,'nombre',st.nombre,'sesiones',count(*),'diferencia_total',coalesce(sum(cs.diferencia),0),'diferencia_abs',coalesce(sum(abs(cs.diferencia)),0)) x
   from public.cash_sessions cs join public.staff st on st.id=cs.cajero_id
   where cs.apertura>=p_desde::timestamptz and cs.apertura<(p_hasta+1)::timestamptz group by st.id,st.nombre
 ) q),'[]'::jsonb)
 ) into out;
 return out;
end$$;
revoke execute on function public.reportes_avanzados_admin(date,date,date,date) from public,anon;
grant execute on function public.reportes_avanzados_admin(date,date,date,date) to authenticated;
