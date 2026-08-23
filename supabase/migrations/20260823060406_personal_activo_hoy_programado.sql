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
  v_dow smallint := extract(dow from (now() at time zone 'America/Lima')::date)::smallint;
begin
  if not exists (
    select 1 from public.staff
    where user_id = auth.uid() and rol = 'administrador' and activo = true
  ) then
    raise exception 'Acceso restringido a administradores';
  end if;

  return query
  with programado as (
    select distinct on (st.staff_id)
      st.staff_id,
      t.id as turno_id,
      t.nombre,
      t.hora_inicio,
      t.hora_fin
    from public.staff_turnos st
    join public.turnos t on t.id = st.turno_id and t.activo = true
    where st.activo = true
      and st.dia_semana = v_dow
      and (st.fecha_desde is null or st.fecha_desde <= v_fecha)
      and (st.fecha_hasta is null or st.fecha_hasta >= v_fecha)
    order by st.staff_id, st.fecha_desde desc nulls last, st.created_at desc
  )
  select s.id,
         s.nombre::text,
         s.puesto::text,
         s.rol::text,
         a.entrada,
         a.salida,
         case
           when p.turno_id is null then 'descanso'::text
           when a.entrada is null then 'pendiente'::text
           when a.salida is null then coalesce(a.estado::text, 'presente')
           else 'salio'::text
         end as estado,
         coalesce(a.minutos_tarde, 0),
         coalesce(t.nombre, p.nombre)::text,
         coalesce(t.hora_inicio, p.hora_inicio),
         coalesce(t.hora_fin, p.hora_fin)
  from public.staff s
  left join public.asistencias a on a.staff_id = s.id and a.fecha = v_fecha
  left join public.turnos t on t.id = a.turno_id
  left join programado p on p.staff_id = s.id
  where s.activo = true
  order by s.nombre;
end;
$$;

revoke all on function public.personal_activo_hoy() from public;
revoke execute on function public.personal_activo_hoy() from anon;
grant execute on function public.personal_activo_hoy() to authenticated;
