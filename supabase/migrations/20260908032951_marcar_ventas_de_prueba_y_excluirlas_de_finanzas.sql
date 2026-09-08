-- ============================================================================
-- P0.2 bloque 8: las ventas sintéticas que dejaron las corridas de la suite
-- de integración de P0.1 quedan marcadas como is_test y excluidas de toda
-- cifra financiera, en vez de borrarlas.
--
-- Por qué marcar y no borrar: sales/sale_items/payments/cash_movements son
-- append-only por diseño (no tienen policy de DELETE para ningún rol de app)
-- y esas 5 ventas ya consumieron los correlativos internos 51-55. Borrarlas
-- dejaría huecos en la numeración, que en un POS es una señal de auditoría
-- PEOR que una fila marcada. Se conserva la fila (trazabilidad intacta) y se
-- la saca de las cifras.
--
-- Nota fiscal: nubefact_activo=false en este proyecto, así que estas ventas
-- nunca generaron comprobante electrónico ni se declararon a SUNAT
-- (comprobante_serie/correlativo nulos, sin filas en
-- comprobantes_electronicos). No hay obligación tributaria atada a ellas.
--
-- Efecto medido: el cierre diario de 2026-09-06 en la sucursal
-- eb66cebb-... pasa de S/403 en 6 ventas a S/153 en 1 venta — ese día NO
-- estaba cerrado todavía, así que se corrigió antes de que las cifras
-- sintéticas quedaran congeladas en un cierre aprobado.
-- ============================================================================

alter table public.sales add column if not exists is_test boolean not null default false;
comment on column public.sales.is_test is
  'Venta sintética (pruebas de integridad), NO es una venta real del negocio. Se excluye de cierre diario, ganancias, dashboard y reportes. Solo se marca por SQL administrativo: registrar_venta nunca la setea.';

-- Índice parcial: las filas marcadas son poquísimas, solo interesa poder
-- encontrarlas rápido para auditar.
create index if not exists sales_is_test_idx on public.sales(business_date) where is_test;

-- Las 5 ventas de las corridas de scripts/verify-integrity-invariants.mjs
-- (cuenta QA 5b7694df-..., productos QA-INTEGRITY-*, S/50 c/u, 2026-09-06).
update public.sales set is_test = true
where cajero_id = '5b7694df-be37-4e0f-bb7f-d33cb13a470f'
  and exists (
    select 1 from public.sale_items si
    join public.product_variants pv on pv.id = si.variant_id
    join public.products p on p.id = pv.product_id
    where si.sale_id = sales.id and p.nombre ilike 'QA-INTEGRITY%'
  );

-- ----------------------------------------------------------------------------
-- Exclusión en las cifras que el negocio realmente lee. El cierre diario es
-- el más crítico: es el que se convierte en un registro financiero aprobado
-- y bloqueado.
-- ----------------------------------------------------------------------------
create or replace function private.resumen_cierre_diario(p_location_id uuid, p_fecha date)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
with ventas as (
 select coalesce(sum(s.total),0)::numeric total,count(*)::int cantidad
 from public.sales s where s.location_id=p_location_id and s.estado='completada' and not s.is_test and (s.fecha at time zone 'America/Lima')::date=p_fecha
), pagos as (
 select coalesce(sum(p.monto) filter(where p.metodo='efectivo'),0)::numeric efectivo,
        coalesce(sum(p.monto) filter(where p.metodo in('yape','plin')),0)::numeric digital,
        coalesce(sum(p.monto) filter(where p.metodo not in('efectivo','yape','plin')),0)::numeric otros
 from public.payments p join public.sales s on s.id=p.sale_id
 where s.location_id=p_location_id and s.estado='completada' and not s.is_test and (s.fecha at time zone 'America/Lima')::date=p_fecha
), reembolsos as (
 select coalesce(sum(d.monto),0)::numeric total from public.devoluciones d
 where d.location_id=p_location_id and d.estado='completada' and d.reembolso_estado='completado' and (d.reembolsado_at at time zone 'America/Lima')::date=p_fecha
), cajas as (
 select count(*) filter(where c.cierre is null)::int abiertas,
        count(*) filter(where c.cierre is not null)::int cerradas,
        coalesce(sum(c.diferencia) filter(where c.cierre is not null),0)::numeric diferencia
 from public.cash_sessions c where c.location_id=p_location_id and (c.apertura at time zone 'America/Lima')::date=p_fecha
), ordenes as (
 select count(*) filter(where coalesce(o.estado,'') not in('entregado','cancelado'))::int abiertas from public.ordenes_servicio o where o.location_id=p_location_id
), stock as (
 select count(*) filter(where i.cantidad<=i.stock_minimo)::int critico from public.inventory i where i.location_id=p_location_id
)
select jsonb_build_object(
 'fecha',p_fecha,'location_id',p_location_id,
 'total_ventas',(select total from ventas),'cantidad_ventas',(select cantidad from ventas),
 'efectivo',(select efectivo from pagos),'digital',(select digital from pagos),'otros_pagos',(select otros from pagos),
 'total_reembolsos',(select total from reembolsos),
 'cajas_abiertas',(select abiertas from cajas),'cajas_cerradas',(select cerradas from cajas),'diferencia_cajas',(select diferencia from cajas),
 'ordenes_abiertas',(select abiertas from ordenes),'stock_critico',(select critico from stock)
); $function$;

create or replace function public.resumen_ganancias(fecha_desde timestamp with time zone, fecha_hasta timestamp with time zone)
returns table(total_ventas numeric, total_costo numeric, total_ganancia numeric, margen_promedio numeric, num_ventas bigint)
language sql
stable
set search_path to 'public'
as $function$
  select
    coalesce(sum(si.subtotal), 0),
    coalesce(sum(coalesce(si.costo_snapshot, 0) * si.cantidad), 0),
    coalesce(sum(si.subtotal) - sum(coalesce(si.costo_snapshot, 0) * si.cantidad), 0),
    case when sum(si.subtotal) > 0
      then round(((sum(si.subtotal) - sum(coalesce(si.costo_snapshot, 0) * si.cantidad)) / sum(si.subtotal)) * 100, 1)
      else 0
    end,
    count(distinct s.id)
  from public.sale_items si
  join public.sales s on s.id = si.sale_id
  where private.auth_is_admin()
    and s.estado = 'completada'
    and not s.is_test
    and s.fecha >= fecha_desde
    and s.fecha < fecha_hasta;
$function$;

create or replace function public.top_productos_ganancia(fecha_desde timestamp with time zone, fecha_hasta timestamp with time zone, lim integer default 10)
returns table(producto_nombre character varying, producto_sku character varying, unidades_vendidas bigint, ingreso numeric, costo_total numeric, ganancia numeric, margen numeric)
language sql
stable
set search_path to 'public'
as $function$
  select
    p.nombre,
    p.sku,
    sum(si.cantidad)::bigint,
    sum(si.subtotal),
    sum(coalesce(si.costo_snapshot, 0) * si.cantidad),
    sum(si.subtotal) - sum(coalesce(si.costo_snapshot, 0) * si.cantidad),
    case when sum(si.subtotal) > 0
      then round(((sum(si.subtotal) - sum(coalesce(si.costo_snapshot, 0) * si.cantidad)) / sum(si.subtotal)) * 100, 1)
      else 0
    end
  from public.sale_items si
  join public.sales s on s.id = si.sale_id
  join public.product_variants pv on pv.id = si.variant_id
  join public.products p on p.id = pv.product_id
  where private.auth_is_admin()
    and s.estado = 'completada'
    and not s.is_test
    and s.fecha >= fecha_desde
    and s.fecha < fecha_hasta
  group by p.id, p.nombre, p.sku
  order by 6 desc
  limit greatest(1, least(coalesce(lim, 10), 100));
$function$;

create or replace function public.dashboard_operativo_admin()
returns jsonb
language sql
stable
set search_path to 'public', 'private'
as $function$
  with hoy as (select (now() at time zone 'America/Lima')::date fecha),
  ventas as (select coalesce(sum(s.total),0)::numeric total,count(*)::int cantidad from public.sales s,hoy h where private.auth_is_admin() and s.estado='completada' and not s.is_test and (s.fecha at time zone 'America/Lima')::date=h.fecha),
  cajas as (select count(*)::int abiertas from public.cash_sessions c where private.auth_is_admin() and c.cierre is null),
  stock as (select count(*)::int criticos from public.inventory i where private.auth_is_admin() and i.cantidad<=i.stock_minimo),
  ordenes as (select count(*) filter(where coalesce(o.estado,'') not in('entregado','cancelado'))::int pendientes,count(*) filter(where o.estado='listo')::int listas from public.ordenes_servicio o where private.auth_is_admin()),
  personal as (
    select count(*)::int total,
      count(*) filter(where p.estado='descanso')::int descanso,
      count(*) filter(where p.estado='pendiente')::int pendientes,
      count(*) filter(where p.estado in('presente','tarde'))::int trabajando,
      count(*) filter(where p.estado='tarde')::int tarde,
      count(*) filter(where p.estado='salio')::int salieron,
      count(*) filter(where p.estado in('permiso','vacaciones','licencia'))::int permisos
    from public.personal_activo_hoy() p where private.auth_is_admin()
  ),
  config as (select count(*)::int incompletos from public.personal_configuracion_pendiente() where private.auth_is_admin())
  select case when not private.auth_is_admin() then null else jsonb_build_object(
    'fecha',(select fecha from hoy),'ventas_total',(select total from ventas),'ventas_cantidad',(select cantidad from ventas),
    'cajas_abiertas',(select abiertas from cajas),'stock_critico',(select criticos from stock),'ordenes_pendientes',(select pendientes from ordenes),'ordenes_listas',(select listas from ordenes),
    'personal_total',(select total from personal),'personal_descanso',(select descanso from personal),'personal_pendiente',(select pendientes from personal),'personal_trabajando',(select trabajando from personal),'personal_tarde',(select tarde from personal),'personal_salieron',(select salieron from personal),'personal_permisos',(select permisos from personal),
    'config_incompleta',(select incompletos from config)) end;
$function$;

create or replace function public.reportes_avanzados_admin(p_desde date, p_hasta date, p_comparar_desde date default null, p_comparar_hasta date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'private'
as $function$
declare out jsonb; cur jsonb; cmp jsonb; begin
 if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
 if p_desde is null or p_hasta is null or p_hasta<p_desde then raise exception 'Rango inválido'; end if;

 with ventas as (
   select s.* from public.sales s where s.estado='completada' and not s.is_test and s.fecha>=p_desde::timestamptz and s.fecha<(p_hasta+1)::timestamptz
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
     select s.* from public.sales s where s.estado='completada' and not s.is_test and s.fecha>=p_comparar_desde::timestamptz and s.fecha<(p_comparar_hasta+1)::timestamptz
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
   where s.estado='completada' and not s.is_test and s.fecha>=p_desde::timestamptz and s.fecha<(p_hasta+1)::timestamptz group by st.id,st.nombre
 ) q),'[]'::jsonb),
 'por_sucursal',coalesce((select jsonb_agg(x order by (x->>'ventas')::numeric desc) from (
   select jsonb_build_object('location_id',l.id,'nombre',l.nombre,'ventas',sum(s.total),'tickets',count(*),'ticket_promedio',avg(s.total)) x
   from public.sales s join public.locations l on l.id=s.location_id
   where s.estado='completada' and not s.is_test and s.fecha>=p_desde::timestamptz and s.fecha<(p_hasta+1)::timestamptz group by l.id,l.nombre
 ) q),'[]'::jsonb),
 'por_categoria',coalesce((select jsonb_agg(x order by (x->>'margen')::numeric desc) from (
   select jsonb_build_object('categoria',coalesce(c.nombre,'Sin categoría'),'ventas',sum(si.subtotal-si.descuento),'costo',sum(coalesce(si.costo_snapshot,0)*si.cantidad),'margen',sum(si.subtotal-si.descuento-coalesce(si.costo_snapshot,0)*si.cantidad)) x
   from public.sale_items si join public.sales s on s.id=si.sale_id join public.product_variants pv on pv.id=si.variant_id join public.products p on p.id=pv.product_id left join public.categorias c on c.id=p.categoria_id
   where s.estado='completada' and not s.is_test and s.fecha>=p_desde::timestamptz and s.fecha<(p_hasta+1)::timestamptz group by c.nombre
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
end$function$;
