create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.auth_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff
    where user_id = auth.uid() and rol = 'administrador' and activo = true
  );
$$;

create or replace function private.auth_location_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select location_id from public.staff
  where user_id = auth.uid() and activo = true
  limit 1;
$$;

create or replace function private.auth_staff_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.staff
  where user_id = auth.uid() and activo = true
  limit 1;
$$;

revoke all on function private.auth_is_admin() from public, anon;
revoke all on function private.auth_location_id() from public, anon;
revoke all on function private.auth_staff_id() from public, anon;
grant execute on function private.auth_is_admin() to authenticated;
grant execute on function private.auth_location_id() to authenticated;
grant execute on function private.auth_staff_id() to authenticated;

drop policy if exists caja_propia on public.cash_sessions;
create policy caja_propia on public.cash_sessions for all to authenticated
using (private.auth_is_admin() or cajero_id = private.auth_staff_id())
with check (private.auth_is_admin() or cajero_id = private.auth_staff_id());

drop policy if exists clientes_eliminacion_admin on public.clientes;
create policy clientes_eliminacion_admin on public.clientes for delete to authenticated
using (private.auth_is_admin());

drop policy if exists comprobantes_lectura_sucursal on public.comprobantes_electronicos;
create policy comprobantes_lectura_sucursal on public.comprobantes_electronicos for select to authenticated
using (
  private.auth_is_admin()
  or exists (
    select 1 from public.sales s
    where s.id = comprobantes_electronicos.sale_id
      and s.location_id = private.auth_location_id()
  )
);

drop policy if exists inventario_escritura_admin on public.inventory;
create policy inventario_escritura_admin on public.inventory for all to authenticated
using (private.auth_is_admin()) with check (private.auth_is_admin());

drop policy if exists inventario_lectura on public.inventory;
create policy inventario_lectura on public.inventory for select to authenticated
using (private.auth_is_admin() or location_id = private.auth_location_id());

drop policy if exists movimientos_insercion_admin on public.inventory_movements;
create policy movimientos_insercion_admin on public.inventory_movements for insert to authenticated
with check (private.auth_is_admin());

drop policy if exists movimientos_lectura on public.inventory_movements;
create policy movimientos_lectura on public.inventory_movements for select to authenticated
using (private.auth_is_admin() or location_id = private.auth_location_id());

drop policy if exists ordenes_actualizacion_sucursal on public.ordenes_servicio;
create policy ordenes_actualizacion_sucursal on public.ordenes_servicio for update to authenticated
using (private.auth_is_admin() or location_id = private.auth_location_id())
with check (private.auth_is_admin() or location_id = private.auth_location_id());

drop policy if exists ordenes_eliminacion_admin on public.ordenes_servicio;
create policy ordenes_eliminacion_admin on public.ordenes_servicio for delete to authenticated
using (private.auth_is_admin());

drop policy if exists ordenes_insercion_sucursal on public.ordenes_servicio;
create policy ordenes_insercion_sucursal on public.ordenes_servicio for insert to authenticated
with check (location_id = private.auth_location_id());

drop policy if exists ordenes_lectura_sucursal on public.ordenes_servicio;
create policy ordenes_lectura_sucursal on public.ordenes_servicio for select to authenticated
using (private.auth_is_admin() or location_id = private.auth_location_id());

drop policy if exists pagos_digitales_lectura_sucursal on public.pagos_digitales;
create policy pagos_digitales_lectura_sucursal on public.pagos_digitales for select to authenticated
using (private.auth_is_admin() or location_id = private.auth_location_id());

drop policy if exists payments_lectura_sucursal on public.payments;
create policy payments_lectura_sucursal on public.payments for select to authenticated
using (
  private.auth_is_admin()
  or exists (select 1 from public.sales s where s.id = payments.sale_id and s.location_id = private.auth_location_id())
);

drop policy if exists sale_items_lectura_sucursal on public.sale_items;
create policy sale_items_lectura_sucursal on public.sale_items for select to authenticated
using (
  private.auth_is_admin()
  or exists (select 1 from public.sales s where s.id = sale_items.sale_id and s.location_id = private.auth_location_id())
);

drop policy if exists variantes_escritura on public.product_variants;
create policy variantes_escritura on public.product_variants for all to authenticated
using (private.auth_is_admin()) with check (private.auth_is_admin());

drop policy if exists catalogo_escritura on public.products;
create policy catalogo_escritura on public.products for all to authenticated
using (private.auth_is_admin()) with check (private.auth_is_admin());

drop policy if exists ventas_por_ubicacion on public.sales;
create policy ventas_por_ubicacion on public.sales for select to authenticated
using (private.auth_is_admin() or location_id = private.auth_location_id());

drop policy if exists staff_admin_update on public.staff;
create policy staff_admin_update on public.staff for update to authenticated
using (private.auth_is_admin()) with check (private.auth_is_admin());

drop policy if exists staff_propio on public.staff;
create policy staff_propio on public.staff for select to authenticated
using (private.auth_is_admin() or user_id = auth.uid());

create or replace function public.resumen_ganancias(fecha_desde timestamptz, fecha_hasta timestamptz)
returns table(total_ventas numeric, total_costo numeric, total_ganancia numeric, margen_promedio numeric, num_ventas bigint)
language sql
stable
security invoker
set search_path = public
as $$
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
    and s.fecha >= fecha_desde
    and s.fecha < fecha_hasta;
$$;

create or replace function public.top_productos_ganancia(fecha_desde timestamptz, fecha_hasta timestamptz, lim integer default 10)
returns table(producto_nombre varchar, producto_sku varchar, unidades_vendidas bigint, ingreso numeric, costo_total numeric, ganancia numeric, margen numeric)
language sql
stable
security invoker
set search_path = public
as $$
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
    and s.fecha >= fecha_desde
    and s.fecha < fecha_hasta
  group by p.id, p.nombre, p.sku
  order by 6 desc
  limit greatest(1, least(coalesce(lim, 10), 100));
$$;

revoke all on function public.auth_is_admin() from public, anon, authenticated;
revoke all on function public.auth_location_id() from public, anon, authenticated;
revoke all on function public.auth_staff_id() from public, anon, authenticated;
drop function public.auth_is_admin();
drop function public.auth_location_id();
drop function public.auth_staff_id();
