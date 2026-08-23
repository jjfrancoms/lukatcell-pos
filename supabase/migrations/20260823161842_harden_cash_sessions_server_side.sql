create unique index if not exists cash_sessions_one_open_per_staff
on public.cash_sessions (cajero_id)
where cierre is null;

create or replace function public.calcular_diferencia_caja()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ventas_efectivo numeric := 0;
begin
  if new.cierre is not null then
    select coalesce(sum(p.monto), 0)
      into v_ventas_efectivo
    from public.payments p
    join public.sales s on s.id = p.sale_id
    where s.cash_session_id = old.id
      and s.estado = 'completada'
      and p.metodo = 'efectivo';

    new.monto_final_esperado := round(coalesce(old.monto_inicial, 0) + v_ventas_efectivo, 2);
    new.diferencia := round(coalesce(new.monto_final_contado, 0) - new.monto_final_esperado, 2);
  else
    new.monto_final_esperado := null;
    new.monto_final_contado := null;
    new.diferencia := null;
  end if;

  return new;
end;
$$;

create or replace function public.validar_contexto_caja()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff public.staff;
  v_fecha date := (now() at time zone 'America/Lima')::date;
begin
  if auth.uid() is null then
    return new;
  end if;

  select * into v_staff
  from public.staff
  where user_id = auth.uid() and activo = true
  limit 1;

  if v_staff.id is null then
    raise exception 'Personal no válido o inactivo';
  end if;

  if tg_op = 'INSERT' then
    if new.cajero_id is distinct from v_staff.id then
      raise exception 'No puedes abrir caja a nombre de otro empleado';
    end if;

    if new.location_id is distinct from v_staff.location_id then
      raise exception 'La caja debe pertenecer a tu sucursal';
    end if;

    if coalesce(new.monto_inicial, 0) < 0 then
      raise exception 'El monto inicial no puede ser negativo';
    end if;

    if not exists (
      select 1
      from public.asistencias a
      where a.staff_id = v_staff.id
        and a.fecha = v_fecha
        and a.entrada is not null
        and a.salida is null
    ) then
      raise exception 'Debes tener una jornada activa para abrir caja';
    end if;

    new.apertura := now();
    new.cierre := null;
    new.monto_final_esperado := null;
    new.monto_final_contado := null;
    new.diferencia := null;
    return new;
  end if;

  if old.cajero_id is distinct from v_staff.id then
    raise exception 'Solo el cajero propietario puede modificar esta caja';
  end if;

  if new.cajero_id is distinct from old.cajero_id
     or new.location_id is distinct from old.location_id
     or new.apertura is distinct from old.apertura
     or new.monto_inicial is distinct from old.monto_inicial then
    raise exception 'No se puede modificar la identidad ni la apertura de una caja';
  end if;

  if old.cierre is not null then
    if new is distinct from old then
      raise exception 'Una caja cerrada no se puede modificar ni reabrir';
    end if;
    return new;
  end if;

  if new.cierre is not null then
    if new.monto_final_contado is null or new.monto_final_contado < 0 then
      raise exception 'Debes indicar un monto contado válido para cerrar caja';
    end if;
    new.cierre := now();
  elsif new.monto_final_esperado is not null
     or new.monto_final_contado is not null
     or new.diferencia is not null then
    raise exception 'Los montos de cierre solo se registran al cerrar caja';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validar_contexto_caja on public.cash_sessions;
create trigger trg_validar_contexto_caja
before insert or update on public.cash_sessions
for each row execute function public.validar_contexto_caja();

revoke all on function public.calcular_diferencia_caja() from public;
revoke execute on function public.calcular_diferencia_caja() from anon, authenticated;
grant execute on function public.calcular_diferencia_caja() to service_role;

revoke all on function public.validar_contexto_caja() from public;
revoke execute on function public.validar_contexto_caja() from anon, authenticated;
grant execute on function public.validar_contexto_caja() to service_role;
