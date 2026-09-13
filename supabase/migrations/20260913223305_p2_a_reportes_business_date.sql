-- ============================================================================
-- P2.A — FASE 22 · Reportes por día comercial (America/Lima) y por sucursal
-- ============================================================================
-- Auditoría (2026-09-13) de reportes_avanzados_admin, resumen_ganancias y
-- top_productos_ganancia contra el esquema y los datos reales:
--
-- D1. reportes_avanzados_admin filtraba con `s.fecha >= p_desde::timestamptz`.
--     Ese cast usa la zona de la SESIÓN, que en producción es UTC: el "día" iba
--     de 19:00 a 19:00 hora de Lima. Una venta de las 20:00 del lunes caía en
--     el martes. Hoy no hay ninguna venta real en esa franja (5 ventas, 0
--     afectadas), así que el defecto está latente, no ausente. Ahora se filtra
--     por sales.business_date, que el trigger de P0.2 calcula en Lima.
-- D2. Lo mismo en cajas (apertura) y taller (fecha de entrega): ahora se
--     convierten explícitamente a fecha de Lima.
-- D3. El margen restaba el descuento DOS veces. El trigger
--     validar_linea_venta_catalogo exige sale_items.subtotal =
--     (precio_unitario - descuento) * cantidad, o sea que subtotal ya es neto;
--     el reporte hacía `subtotal - descuento`. Toda venta con descuento
--     subestimaba ingreso y margen, y el reporte no cuadraba con
--     resumen_ganancias, que sí usa subtotal.
-- D4. Ningún reporte filtraba por sucursal. Se añade p_location_id opcional.
-- D5. Las devoluciones no restaban nada. Se AÑADEN campos netos (no se cambia
--     el significado de ventas_total): devoluciones_monto y costo_devuelto,
--     ingreso_neto y margen_neto. devolucion_items.monto es la parte
--     proporcional de sale_items.subtotal (sin IGV), así que se resta del
--     ingreso sin IGV, no de ventas_total (con IGV). La devolución cuenta en
--     el día comercial en que se registró, no en el de la venta original.
--
-- Invariantes que se mantienen: ventas is_test fuera; sólo ventas
-- 'completada'; costo histórico (costo_snapshot), nunca el costo actual.
--
-- COMPATIBILIDAD. Cambia la firma (parámetro nuevo al final, con default).
-- CREATE OR REPLACE con otra lista de argumentos crearía una SOBRECARGA y
-- PostgREST no podría elegir entre dos candidatas con los mismos nombres; por
-- eso se hace DROP de la firma vieja. Las llamadas existentes (bundles en
-- caché incluidos) usan argumentos con nombre y siguen resolviendo a la nueva
-- gracias al default. DROP pierde los privilegios: se reponen exactamente los
-- de producción (EXECUTE para authenticated y service_role; sin PUBLIC ni anon).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Resumen de un periodo. Invocador y sin EXECUTE para nadie: sólo se usa desde
-- reportes_avanzados_admin (SECURITY DEFINER), que ya validó al administrador.
-- ---------------------------------------------------------------------------
create or replace function private.reporte_resumen_periodo(p_desde date, p_hasta date, p_location_id uuid)
returns jsonb
language sql
stable
set search_path to 'public', 'private'
as $function$
  with ventas as (
    select s.id, s.total
    from public.sales s
    where s.estado = 'completada' and not s.is_test
      and s.business_date between p_desde and p_hasta
      and (p_location_id is null or s.location_id = p_location_id)
  ), lineas as (
    select coalesce(sum(si.subtotal), 0) as ingreso,
           coalesce(sum(coalesce(si.costo_snapshot, 0) * si.cantidad), 0) as costo,
           coalesce(sum(coalesce(si.descuento, 0) * si.cantidad), 0) as descuentos
    from public.sale_items si
    join ventas v on v.id = si.sale_id
  ), devs as (
    select coalesce(sum(di.monto), 0) as monto,
           coalesce(sum(coalesce(si.costo_snapshot, 0) * di.cantidad), 0) as costo,
           count(distinct d.id) as cantidad
    from public.devoluciones d
    join public.sales s on s.id = d.sale_id and not s.is_test
    join public.devolucion_items di on di.devolucion_id = d.id
    join public.sale_items si on si.id = di.sale_item_id
    where d.estado = 'completada'
      and (d.created_at at time zone 'America/Lima')::date between p_desde and p_hasta
      and (p_location_id is null or d.location_id = p_location_id)
  )
  select jsonb_build_object(
    'ventas_total',          coalesce((select sum(total) from ventas), 0),
    'ventas_cantidad',       (select count(*) from ventas),
    'ticket_promedio',       coalesce((select avg(total) from ventas), 0),
    'ingreso',               l.ingreso,
    'descuentos',            l.descuentos,
    'costo_ventas',          l.costo,
    'margen_bruto',          l.ingreso - l.costo,
    'devoluciones_cantidad', dv.cantidad,
    'devoluciones_monto',    dv.monto,
    'costo_devuelto',        dv.costo,
    'ingreso_neto',          l.ingreso - dv.monto,
    'margen_neto',           (l.ingreso - l.costo) - (dv.monto - dv.costo)
  )
  from lineas l cross join devs dv;
$function$;

revoke all on function private.reporte_resumen_periodo(date, date, uuid) from public;

-- ---------------------------------------------------------------------------
drop function if exists public.reportes_avanzados_admin(date, date, date, date);

create function public.reportes_avanzados_admin(
  p_desde           date,
  p_hasta           date,
  p_comparar_desde  date default null,
  p_comparar_hasta  date default null,
  p_location_id     uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_cur jsonb;
  v_cmp jsonb;
begin
  if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde then raise exception 'Rango inválido'; end if;
  if p_hasta - p_desde > 366 then raise exception 'El rango máximo es de 367 días'; end if;
  if p_location_id is not null and not exists (select 1 from public.locations where id = p_location_id) then
    raise exception 'Sucursal no encontrada';
  end if;

  v_cur := private.reporte_resumen_periodo(p_desde, p_hasta, p_location_id);

  -- Igual que antes: la comparación sólo se calcula con ambos extremos.
  if p_comparar_desde is not null and p_comparar_hasta is not null then
    if p_comparar_hasta < p_comparar_desde or p_comparar_hasta - p_comparar_desde > 366 then
      raise exception 'Rango de comparación inválido';
    end if;
    v_cmp := private.reporte_resumen_periodo(p_comparar_desde, p_comparar_hasta, p_location_id);
  end if;

  return jsonb_build_object(
    'periodo', jsonb_build_object('desde', p_desde, 'hasta', p_hasta, 'location_id', p_location_id,
                                  'zona_horaria', 'America/Lima', 'base', 'business_date'),
    'resumen', v_cur,
    'comparacion', v_cmp,
    'por_vendedor', coalesce((select jsonb_agg(x order by (x->>'ventas')::numeric desc) from (
      select jsonb_build_object('staff_id', st.id, 'nombre', st.nombre, 'ventas', sum(s.total),
                                'tickets', count(*), 'ticket_promedio', avg(s.total)) x
      from public.sales s join public.staff st on st.id = s.cajero_id
      where s.estado = 'completada' and not s.is_test
        and s.business_date between p_desde and p_hasta
        and (p_location_id is null or s.location_id = p_location_id)
      group by st.id, st.nombre
    ) q), '[]'::jsonb),
    'por_sucursal', coalesce((select jsonb_agg(x order by (x->>'ventas')::numeric desc) from (
      select jsonb_build_object('location_id', l.id, 'nombre', l.nombre, 'ventas', sum(s.total),
                                'tickets', count(*), 'ticket_promedio', avg(s.total)) x
      from public.sales s join public.locations l on l.id = s.location_id
      where s.estado = 'completada' and not s.is_test
        and s.business_date between p_desde and p_hasta
        and (p_location_id is null or s.location_id = p_location_id)
      group by l.id, l.nombre
    ) q), '[]'::jsonb),
    'por_categoria', coalesce((select jsonb_agg(x order by (x->>'margen')::numeric desc) from (
      select jsonb_build_object('categoria', coalesce(c.nombre, 'Sin categoría'),
                                'ventas', sum(si.subtotal),
                                'costo', sum(coalesce(si.costo_snapshot, 0) * si.cantidad),
                                'margen', sum(si.subtotal - coalesce(si.costo_snapshot, 0) * si.cantidad)) x
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
      join public.product_variants pv on pv.id = si.variant_id
      join public.products p on p.id = pv.product_id
      left join public.categorias c on c.id = p.categoria_id
      where s.estado = 'completada' and not s.is_test
        and s.business_date between p_desde and p_hasta
        and (p_location_id is null or s.location_id = p_location_id)
      group by c.nombre
    ) q), '[]'::jsonb),
    'taller', coalesce((
      select jsonb_build_object('ordenes', count(*), 'ingresos', coalesce(sum(o.costo_final), 0),
                                'costo_repuestos', coalesce(sum(parts.costo), 0),
                                'rentabilidad', coalesce(sum(o.costo_final), 0) - coalesce(sum(parts.costo), 0))
      from public.ordenes_servicio o
      left join lateral (
        select sum(r.costo_unitario * r.cantidad) costo from public.orden_servicio_repuestos r where r.orden_id = o.id
      ) parts on true
      where o.estado = 'entregado'
        and (coalesce(o.fecha_entrega, o.updated_at) at time zone 'America/Lima')::date between p_desde and p_hasta
        and (p_location_id is null or o.location_id = p_location_id)
    ), '{}'::jsonb),
    'cajas_por_empleado', coalesce((select jsonb_agg(x order by (x->>'sesiones')::int desc) from (
      select jsonb_build_object('staff_id', st.id, 'nombre', st.nombre, 'sesiones', count(*),
                                'diferencia_total', coalesce(sum(cs.diferencia), 0),
                                'diferencia_abs', coalesce(sum(abs(cs.diferencia)), 0)) x
      from public.cash_sessions cs join public.staff st on st.id = cs.cajero_id
      where (cs.apertura at time zone 'America/Lima')::date between p_desde and p_hasta
        and (p_location_id is null or cs.location_id = p_location_id)
      group by st.id, st.nombre
    ) q), '[]'::jsonb)
  );
end
$function$;

revoke all on function public.reportes_avanzados_admin(date, date, date, date, uuid) from public;
grant execute on function public.reportes_avanzados_admin(date, date, date, date, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- resumen_ganancias / top_productos_ganancia: reciben INSTANTES (el cliente
-- manda el inicio del día comercial de Lima), así que no cambia la ventana;
-- sólo se añade el filtro de sucursal. Siguen siendo SECURITY INVOKER.
-- ---------------------------------------------------------------------------
drop function if exists public.resumen_ganancias(timestamp with time zone, timestamp with time zone);

create function public.resumen_ganancias(
  fecha_desde   timestamp with time zone,
  fecha_hasta   timestamp with time zone,
  p_location_id uuid default null
)
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
    and s.fecha < fecha_hasta
    and (p_location_id is null or s.location_id = p_location_id);
$function$;

revoke all on function public.resumen_ganancias(timestamp with time zone, timestamp with time zone, uuid) from public;
grant execute on function public.resumen_ganancias(timestamp with time zone, timestamp with time zone, uuid) to authenticated, service_role;

drop function if exists public.top_productos_ganancia(timestamp with time zone, timestamp with time zone, integer);

create function public.top_productos_ganancia(
  fecha_desde   timestamp with time zone,
  fecha_hasta   timestamp with time zone,
  lim           integer default 10,
  p_location_id uuid default null
)
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
    and (p_location_id is null or s.location_id = p_location_id)
  group by p.id, p.nombre, p.sku
  order by 6 desc
  limit greatest(1, least(coalesce(lim, 10), 100));
$function$;

revoke all on function public.top_productos_ganancia(timestamp with time zone, timestamp with time zone, integer, uuid) from public;
grant execute on function public.top_productos_ganancia(timestamp with time zone, timestamp with time zone, integer, uuid) to authenticated, service_role;
