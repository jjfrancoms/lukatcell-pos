create or replace function public.preservar_historial_staff_turnos()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fecha date := (now() at time zone 'America/Lima')::date;
begin
  if old.activo then
    update public.staff_turnos
    set activo = false,
        fecha_hasta = greatest(coalesce(old.fecha_desde, v_fecha - 1), v_fecha - 1)
    where id = old.id;
  end if;
  return null;
end;
$$;

revoke all on function public.preservar_historial_staff_turnos() from public, anon, authenticated;

drop trigger if exists trg_preservar_historial_staff_turnos on public.staff_turnos;
create trigger trg_preservar_historial_staff_turnos
before delete on public.staff_turnos
for each row execute function public.preservar_historial_staff_turnos();
