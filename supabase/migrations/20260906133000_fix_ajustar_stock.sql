-- Corrige ajustar_stock: hoy un retiro mayor al stock disponible se clampaba
-- silenciosamente a 0 (greatest(0, cantidad+delta)), dejando el movimiento
-- registrado con el delta pedido aunque el stock resultante no cuadre con él.
-- Ahora se rechaza explícitamente, y se prohíbe usar este ajuste genérico
-- sobre productos con control_serial=true (deben moverse por IMEI/serie).
create or replace function public.ajustar_stock(
  p_variant_id uuid,
  p_location_id uuid,
  p_cantidad_delta integer,
  p_motivo text,
  p_staff_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff public.staff;
  v_location uuid;
  v_control_serial boolean;
  v_actual integer;
begin
  select * into v_staff from public.staff where user_id = auth.uid() and activo = true limit 1;
  if v_staff.id is null then
    raise exception 'Personal no válido o inactivo' using errcode = 'P0001';
  end if;
  -- OJO: con puesto IS NULL, `puesto in (...)` da NULL (no false) en SQL, y
  -- `not (false or null)` también da NULL, que plpgsql trata como "no lanzar".
  -- Un cajero sin puesto asignado se saltaba este control. Se usa coalesce
  -- para que la comparación sea siempre estrictamente true/false.
  if not (v_staff.rol = 'administrador' or coalesce(v_staff.puesto, '') in ('tecnico','encargado','jefa')) then
    raise exception 'No tienes permiso para ajustar inventario' using errcode = 'P0001';
  end if;

  v_location := coalesce(p_location_id, v_staff.location_id);

  select p.control_serial into v_control_serial
  from public.product_variants pv
  join public.products p on p.id = pv.product_id
  where pv.id = p_variant_id;

  if coalesce(v_control_serial, false) then
    raise exception 'Este producto se controla por IMEI/serie — usa el flujo de seriales, no el ajuste genérico de stock' using errcode = 'P0001';
  end if;

  select cantidad into v_actual from public.inventory where variant_id = p_variant_id and location_id = v_location for update;
  v_actual := coalesce(v_actual, 0);

  if v_actual + p_cantidad_delta < 0 then
    raise exception 'Stock insuficiente. Disponible: %. Intentaste retirar: %.', v_actual, abs(p_cantidad_delta) using errcode = 'P0001';
  end if;

  insert into public.inventory (variant_id, location_id, cantidad, updated_at)
  values (p_variant_id, v_location, v_actual + p_cantidad_delta, now())
  on conflict (variant_id, location_id) do update set cantidad = excluded.cantidad, updated_at = now();

  insert into public.inventory_movements (variant_id, location_id, cantidad_delta, motivo, staff_id)
  values (p_variant_id, v_location, p_cantidad_delta, p_motivo, coalesce(p_staff_id, v_staff.id));
end;
$$;
