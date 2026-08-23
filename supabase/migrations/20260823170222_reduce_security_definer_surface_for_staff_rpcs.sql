create or replace function private.resolver_turno_programado(p_staff_id uuid, p_momento timestamp without time zone)
returns table(jornada_fecha date, turno_id uuid)
language sql
stable
security invoker
set search_path = public
as $$
  with reloj as (
    select p_momento::date as hoy, (p_momento::date - 1) as ayer
  ), candidatos as (
    select r.ayer as jornada_fecha, st.turno_id, 1 as prioridad
    from reloj r
    join public.staff_turnos st on st.staff_id = p_staff_id
    join public.turnos t on t.id = st.turno_id and t.activo = true
    where st.activo = true
      and t.cruza_medianoche = true
      and st.dia_semana = extract(dow from r.ayer)::smallint
      and (st.fecha_desde is null or st.fecha_desde <= r.ayer)
      and (st.fecha_hasta is null or st.fecha_hasta >= r.ayer)
      and p_momento >= (r.ayer::timestamp + t.hora_inicio)
      and p_momento <= (r.hoy::timestamp + t.hora_fin)
    union all
    select r.hoy, st.turno_id, 2
    from reloj r
    join public.staff_turnos st on st.staff_id = p_staff_id
    join public.turnos t on t.id = st.turno_id and t.activo = true
    where st.activo = true
      and st.dia_semana = extract(dow from r.hoy)::smallint
      and (st.fecha_desde is null or st.fecha_desde <= r.hoy)
      and (st.fecha_hasta is null or st.fecha_hasta >= r.hoy)
  )
  select c.jornada_fecha, c.turno_id
  from candidatos c
  order by c.prioridad
  limit 1;
$$;

revoke all on function private.resolver_turno_programado(uuid, timestamp without time zone) from public, anon;
grant execute on function private.resolver_turno_programado(uuid, timestamp without time zone) to authenticated;

create or replace function public.mi_estado_jornada()
returns table(
  asistencia_id uuid,
  fecha date,
  entrada timestamptz,
  salida timestamptz,
  estado text,
  minutos_tarde integer,
  turno_id uuid,
  turno_nombre text,
  hora_inicio time,
  hora_fin time,
  tolerancia_minutos integer
)
language sql
security invoker
set search_path = public
as $$
  with reloj as (
    select (now() at time zone 'America/Lima')::timestamp as ahora_local,
           (now() at time zone 'America/Lima')::date as fecha_local
  ), yo as (
    select id from public.staff where user_id = auth.uid() and activo = true limit 1
  ), asistencia_actual as (
    select a.*
    from public.asistencias a
    join yo on yo.id = a.staff_id
    cross join reloj r
    where a.fecha = r.fecha_local
       or (a.fecha = r.fecha_local - 1 and a.salida is null)
    order by (a.salida is null) desc, a.entrada desc nulls last
    limit 1
  ), programado as (
    select rp.jornada_fecha, rp.turno_id
    from yo
    cross join reloj r
    cross join lateral private.resolver_turno_programado(yo.id, r.ahora_local) rp
  )
  select a.id,
         coalesce(a.fecha, p.jornada_fecha),
         a.entrada,
         a.salida,
         a.estado,
         coalesce(a.minutos_tarde, 0),
         coalesce(a.turno_id, p.turno_id),
         t.nombre,
         t.hora_inicio,
         t.hora_fin,
         t.tolerancia_minutos
  from yo
  left join asistencia_actual a on true
  left join programado p on true
  left join public.turnos t on t.id = coalesce(a.turno_id, p.turno_id);
$$;

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
security invoker
set search_path = public
as $$
declare
  v_fecha date := (now() at time zone 'America/Lima')::date;
  v_ahora_local timestamp := now() at time zone 'America/Lima';
begin
  if not private.auth_is_admin() then
    raise exception 'Acceso restringido a administradores';
  end if;

  return query
  select s.id,
         s.nombre::text,
         s.puesto::text,
         s.rol::text,
         a.entrada,
         a.salida,
         case
           when a.entrada is not null and a.salida is not null then 'salio'::text
           when a.entrada is not null then coalesce(a.estado::text, 'presente')
           when rp.turno_id is null then 'descanso'::text
           else 'pendiente'::text
         end,
         coalesce(a.minutos_tarde, 0),
         coalesce(ta.nombre, tp.nombre)::text,
         coalesce(ta.hora_inicio, tp.hora_inicio),
         coalesce(ta.hora_fin, tp.hora_fin)
  from public.staff s
  left join lateral (
    select ax.*
    from public.asistencias ax
    where ax.staff_id = s.id
      and (ax.fecha = v_fecha or (ax.fecha = v_fecha - 1 and ax.salida is null))
    order by (ax.salida is null) desc, ax.entrada desc nulls last
    limit 1
  ) a on true
  left join lateral private.resolver_turno_programado(s.id, v_ahora_local) rp on true
  left join public.turnos ta on ta.id = a.turno_id
  left join public.turnos tp on tp.id = rp.turno_id
  where s.activo = true
  order by s.nombre;
end;
$$;

create or replace function public.personal_configuracion_pendiente()
returns table(
  staff_id uuid,
  nombre text,
  username text,
  puesto text,
  dias_programados integer,
  falta_login boolean,
  falta_puesto boolean,
  falta_horario boolean
)
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not private.auth_is_admin() then
    raise exception 'Acceso restringido a administradores';
  end if;

  return query
  select s.id,
         s.nombre::text,
         s.username::text,
         s.puesto::text,
         count(st.id)::integer,
         (s.user_id is null),
         (s.puesto is null),
         (count(st.id) = 0)
  from public.staff s
  left join public.staff_turnos st on st.staff_id = s.id and st.activo = true
  where s.activo = true
  group by s.id, s.nombre, s.username, s.puesto, s.user_id
  having s.user_id is null or s.puesto is null or count(st.id) = 0
  order by s.nombre;
end;
$$;

create or replace function public.reprogramar_staff_turnos(p_staff_id uuid, p_programacion jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_fecha date := (now() at time zone 'America/Lima')::date;
  v_admin_location uuid;
  v_total integer;
  v_dias_distintos integer;
begin
  if not private.auth_is_admin() then
    raise exception 'Acceso restringido a administradores';
  end if;

  v_admin_location := private.auth_location_id();

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

create or replace function public.registrar_mi_entrada()
returns public.asistencias
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff public.staff;
  v_turno public.turnos;
  v_existente public.asistencias;
  v_fecha_local date := (now() at time zone 'America/Lima')::date;
  v_fecha_jornada date;
  v_turno_id uuid;
  v_ahora_local timestamp := now() at time zone 'America/Lima';
  v_inicio_local timestamp;
  v_retraso_real integer := 0;
  v_estado text := 'presente';
begin
  select * into v_staff from public.staff where user_id = auth.uid() and activo = true limit 1;
  if v_staff.id is null then raise exception 'Personal no válido o inactivo'; end if;

  select r.jornada_fecha, r.turno_id into v_fecha_jornada, v_turno_id
  from private.resolver_turno_programado(v_staff.id, v_ahora_local) r;

  if v_turno_id is not null then
    select * into v_turno from public.turnos where id = v_turno_id;
  end if;

  if v_turno.id is null and v_staff.rol <> 'administrador' then
    raise exception 'No tienes un turno asignado para este momento';
  end if;

  if v_fecha_jornada is null then v_fecha_jornada := v_fecha_local; end if;

  select * into v_existente from public.asistencias
  where staff_id = v_staff.id and fecha = v_fecha_jornada;
  if v_existente.id is not null and v_existente.entrada is not null then
    return v_existente;
  end if;

  if v_turno.id is not null then
    v_inicio_local := v_fecha_jornada::timestamp + v_turno.hora_inicio;
    v_retraso_real := greatest(0, floor(extract(epoch from (v_ahora_local - v_inicio_local)) / 60)::integer);
    if v_retraso_real > v_turno.tolerancia_minutos then v_estado := 'tarde'; end if;
  end if;

  insert into public.asistencias (staff_id, turno_id, fecha, entrada, estado, minutos_tarde, registrado_por)
  values (v_staff.id, v_turno.id, v_fecha_jornada, now(), v_estado, v_retraso_real, v_staff.id)
  on conflict (staff_id, fecha) do update
    set entrada = coalesce(public.asistencias.entrada, excluded.entrada),
        turno_id = coalesce(public.asistencias.turno_id, excluded.turno_id),
        estado = case when public.asistencias.entrada is null then excluded.estado else public.asistencias.estado end,
        minutos_tarde = case when public.asistencias.entrada is null then excluded.minutos_tarde else public.asistencias.minutos_tarde end,
        updated_at = now()
  returning * into v_existente;

  return v_existente;
end;
$$;

drop function public.resolver_turno_programado(uuid, timestamp without time zone);

revoke all on function public.mi_estado_jornada() from public;
revoke execute on function public.mi_estado_jornada() from anon;
grant execute on function public.mi_estado_jornada() to authenticated;
revoke all on function public.personal_activo_hoy() from public;
revoke execute on function public.personal_activo_hoy() from anon;
grant execute on function public.personal_activo_hoy() to authenticated;
revoke all on function public.personal_configuracion_pendiente() from public;
revoke execute on function public.personal_configuracion_pendiente() from anon;
grant execute on function public.personal_configuracion_pendiente() to authenticated;
revoke all on function public.reprogramar_staff_turnos(uuid,jsonb) from public;
revoke execute on function public.reprogramar_staff_turnos(uuid,jsonb) from anon;
grant execute on function public.reprogramar_staff_turnos(uuid,jsonb) to authenticated;
