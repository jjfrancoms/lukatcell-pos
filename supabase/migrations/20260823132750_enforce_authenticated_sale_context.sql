create or replace function public.validar_contexto_venta_autenticada()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff public.staff;
begin
  if auth.role() = 'service_role' then
    return new;
  end if;

  if auth.uid() is null then
    raise exception 'Venta rechazada: sesión no autenticada' using errcode = '42501';
  end if;

  select * into v_staff
  from public.staff
  where user_id = auth.uid()
    and activo = true
  limit 1;

  if v_staff.id is null then
    raise exception 'Venta rechazada: personal no válido o inactivo' using errcode = '42501';
  end if;

  if new.cajero_id is distinct from v_staff.id then
    raise exception 'Venta rechazada: cajero no corresponde a la sesión' using errcode = '42501';
  end if;

  if new.location_id is distinct from v_staff.location_id then
    raise exception 'Venta rechazada: sucursal no corresponde al personal' using errcode = '42501';
  end if;

  if new.cash_session_id is null then
    raise exception 'Venta rechazada: se requiere una caja asociada' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.cash_sessions cs
    where cs.id = new.cash_session_id
      and cs.cajero_id = v_staff.id
      and cs.location_id = v_staff.location_id
  ) then
    raise exception 'Venta rechazada: la caja no pertenece al cajero o sucursal' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.validar_contexto_venta_autenticada() from public, anon, authenticated;
grant execute on function public.validar_contexto_venta_autenticada() to service_role;

drop trigger if exists trg_validar_contexto_venta_autenticada on public.sales;
create trigger trg_validar_contexto_venta_autenticada
before insert on public.sales
for each row
execute function public.validar_contexto_venta_autenticada();
