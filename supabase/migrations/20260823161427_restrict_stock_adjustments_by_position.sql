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
  v_staff_id uuid;
  v_location_id uuid;
begin
  select * into v_staff
  from public.staff
  where user_id = auth.uid() and activo = true
  limit 1;

  if v_staff.id is null then
    raise exception 'Personal no válido o inactivo';
  end if;

  if not (v_staff.rol = 'administrador' or v_staff.puesto in ('tecnico','encargado')) then
    raise exception 'No tienes permiso para ajustar inventario';
  end if;

  v_staff_id := v_staff.id;
  v_location_id := v_staff.location_id;

  if p_staff_id is not null and p_staff_id <> v_staff_id then
    raise exception 'No puedes registrar movimientos a nombre de otro empleado';
  end if;

  if p_location_id is distinct from v_location_id then
    raise exception 'No puedes ajustar inventario de otra sucursal';
  end if;

  if p_cantidad_delta = 0 then
    raise exception 'La cantidad del ajuste no puede ser cero';
  end if;

  update public.inventory
  set cantidad = greatest(0, cantidad + p_cantidad_delta),
      updated_at = now()
  where variant_id = p_variant_id and location_id = v_location_id;

  if not found then
    raise exception 'Inventario no encontrado para el producto y sucursal indicados';
  end if;

  insert into public.inventory_movements (variant_id, location_id, cantidad_delta, motivo, staff_id)
  values (p_variant_id, v_location_id, p_cantidad_delta, nullif(trim(p_motivo), ''), v_staff_id);
end;
$$;

revoke all on function public.ajustar_stock(uuid, uuid, integer, text, uuid) from public;
revoke execute on function public.ajustar_stock(uuid, uuid, integer, text, uuid) from anon;
grant execute on function public.ajustar_stock(uuid, uuid, integer, text, uuid) to authenticated;
grant execute on function public.ajustar_stock(uuid, uuid, integer, text, uuid) to service_role;
