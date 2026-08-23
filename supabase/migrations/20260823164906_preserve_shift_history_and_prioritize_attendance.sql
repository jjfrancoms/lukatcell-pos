create or replace function public.reprogramar_staff_turnos(p_staff_id uuid, p_programacion jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fecha date := (now() at time zone 'America/Lima')::date;
  v_admin_location uuid;
  v_total integer;
  v_dias_distintos integer;
begin
  select s.location_id into v_admin_location
  from public.staff s
  where s.user_id = auth.uid()
    and s.rol = 'administrador'
    and s.activo = true;

  if v_admin_location is null then
    raise exception 'Acceso restringido a administradores';
  end if;

  if not exists (
    select 1 from public.staff s
    where s.id = p_staff_id
      and s.location_id = v_admin_location
  ) then
    raise exception 'El personal no pertenece a tu sucursal';
  end if;

  if p_programacion is null or jsonb_typeof(p_programacion) <> 'array' then
    raise exception 'Programación inválida';
  end if;

  select count(*), count(distinct (x->>'dia_semana')::int)
  into v_total, v_dias_distintos
  from jsonb_array_elements(p_programacion) x;

  if v_total <> v_dias_distintos then
    raise exception 'No se puede asignar más de un turno por día';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_programacion) x
    where (x->>'dia_semana') is null
       or (x->>'turno_id') is null
       or (x->>'dia_semana')::int not between 0 and 6
       or not exists (
         select 1 from public.turnos t
         where t.id = (x->>'turno_id')::uuid
           and t.activo = true
       )
  ) then
    raise exception 'La programación contiene días o turnos inválidos';
  end if;

  update public.staff_turnos st
  set activo = false,
      fecha_hasta = greatest(coalesce(st.fecha_desde, v_fecha - 1), v_fecha - 1)
  where st.staff_id = p_staff_id
    and st.activo = true;

  insert into public.staff_turnos (staff_id, turno_id, dia_semana, fecha_desde, activo)
  select p_staff_id,
         (x->>'turno_id')::uuid,
         (x->>'dia_semana')::smallint,
         v_fecha,
         true
  from jsonb_array_elements(p_programacion) x;
end;
$$;

revoke all on function public.reprogramar_staff_turnos(uuid, jsonb) from public;
revoke execute on function public.reprogramar_staff_turnos(uuid, jsonb) from anon;
grant execute on function public.reprogramar_staff_turnos(uuid, jsonb) to authenticated;

create or replace function public.personal_activo_hoy()
returns table(
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
    select 1 from public.staff s_admin
    where s_admin.user_id = auth.uid()
      and s_admin.rol = 'administrador'
      and s_admin.activo = true
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
           when a.entrada is not null and a.salida is not null then 'salio'::text
           when a.entrada is not null then coalesce(a.estado::text, 'presente')
           when p.turno_id is null then 'descanso'::text
           else 'pendiente'::text
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
