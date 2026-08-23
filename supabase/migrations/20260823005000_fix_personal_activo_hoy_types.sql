-- Asegura que la función devuelva exactamente los tipos declarados aunque
-- columnas existentes de staff/turnos sean varchar u otros tipos textuales.
create or replace function public.personal_activo_hoy()
returns table (
  staff_id uuid,
  nombre text,
  puesto text,
  rol text,
  entrada timestamptz,
  salida timestamptz,
  estado text,
  minutos_tarde integer,
  turno_nombre text,
  hora_inicio time,
  hora_fin time
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fecha date := (now() at time zone 'America/Lima')::date;
begin
  if not exists (
    select 1 from public.staff
    where user_id = auth.uid() and rol = 'administrador' and activo = true
  ) then
    raise exception 'Acceso restringido a administradores';
  end if;

  return query
  select s.id,
         s.nombre::text,
         s.puesto::text,
         s.rol::text,
         a.entrada,
         a.salida,
         a.estado::text,
         a.minutos_tarde,
         t.nombre::text,
         t.hora_inicio,
         t.hora_fin
  from public.staff s
  left join public.asistencias a on a.staff_id = s.id and a.fecha = v_fecha
  left join public.turnos t on t.id = a.turno_id
  where s.activo = true
  order by s.nombre;
end;
$$;

grant execute on function public.personal_activo_hoy() to authenticated;
