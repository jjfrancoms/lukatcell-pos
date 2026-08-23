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
  v_filas integer;
begin
  if p_cantidad_delta = 0 then
    raise exception 'El ajuste no puede ser cero' using errcode = 'P0001';
  end if;

  if nullif(trim(p_motivo), '') is null then
    raise exception 'El motivo del ajuste es obligatorio' using errcode = 'P0001';
  end if;

  if auth.role() <> 'service_role' then
    if auth.uid() is null then
      raise exception 'Sesión no autenticada' using errcode = '42501';
    end if;

    select * into v_staff
    from public.staff
    where user_id = auth.uid()
      and activo = true
    limit 1;

    if v_staff.id is null then
      raise exception 'Personal no válido o inactivo' using errcode = '42501';
    end if;

    if p_staff_id is distinct from v_staff.id then
      raise exception 'No puedes registrar movimientos a nombre de otro empleado' using errcode = '42501';
    end if;

    if p_location_id is distinct from v_staff.location_id then
      raise exception 'No puedes ajustar inventario de otra sucursal' using errcode = '42501';
    end if;
  end if;

  update public.inventory
  set cantidad = greatest(0, cantidad + p_cantidad_delta),
      updated_at = now()
  where variant_id = p_variant_id
    and location_id = p_location_id;

  get diagnostics v_filas = row_count;
  if v_filas = 0 then
    raise exception 'No existe inventario para esa variante y sucursal' using errcode = 'P0001';
  end if;

  insert into public.inventory_movements (
    variant_id, location_id, cantidad_delta, motivo, staff_id
  ) values (
    p_variant_id, p_location_id, p_cantidad_delta, trim(p_motivo), p_staff_id
  );
end;
$$;

revoke all on function public.ajustar_stock(uuid, uuid, integer, text, uuid) from public, anon;
grant execute on function public.ajustar_stock(uuid, uuid, integer, text, uuid) to authenticated, service_role;
