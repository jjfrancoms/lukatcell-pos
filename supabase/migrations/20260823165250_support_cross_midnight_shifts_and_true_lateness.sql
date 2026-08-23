create or replace function public.resolver_turno_programado(p_staff_id uuid, p_momento timestamp without time zone)
returns table(jornada_fecha date, turno_id uuid)
language sql
stable
security definer
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

revoke all on function public.resolver_turno_programado(uuid, timestamp without time zone) from public, anon, authenticated;

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
  from public.resolver_turno_programado(v_staff.id, v_ahora_local) r;

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

create or replace function public.registrar_mi_salida()
returns public.asistencias
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff public.staff;
  v_asistencia public.asistencias;
  v_caja_abierta uuid;
  v_fecha date := (now() at time zone 'America/Lima')::date;
begin
  select * into v_staff from public.staff where user_id = auth.uid() and activo = true limit 1;
  if v_staff.id is null then raise exception 'Personal no válido o inactivo'; end if;

  select id into v_caja_abierta from public.cash_sessions
  where cajero_id = v_staff.id and cierre is null
  order by apertura desc limit 1;
  if v_caja_abierta is not null then
    raise exception 'Debes cerrar tu caja antes de registrar la salida';
  end if;

  select * into v_asistencia
  from public.asistencias
  where staff_id = v_staff.id
    and fecha between (v_fecha - 1) and v_fecha
    and entrada is not null
    and salida is null
  order by entrada desc
  limit 1;

  if v_asistencia.id is null then
    select * into v_asistencia
    from public.asistencias
    where staff_id = v_staff.id
      and fecha between (v_fecha - 1) and v_fecha
      and entrada is not null
    order by entrada desc
    limit 1;
    if v_asistencia.id is not null and v_asistencia.salida is not null then return v_asistencia; end if;
    raise exception 'Primero debes registrar tu entrada';
  end if;

  update public.asistencias set salida = now(), updated_at = now()
  where id = v_asistencia.id returning * into v_asistencia;
  return v_asistencia;
end;
$$;

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
security definer
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
    cross join lateral public.resolver_turno_programado(yo.id, r.ahora_local) rp
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
security definer
set search_path = public
as $$
declare
  v_fecha date := (now() at time zone 'America/Lima')::date;
  v_ahora_local timestamp := now() at time zone 'America/Lima';
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
  left join lateral public.resolver_turno_programado(s.id, v_ahora_local) rp on true
  left join public.turnos ta on ta.id = a.turno_id
  left join public.turnos tp on tp.id = rp.turno_id
  where s.activo = true
  order by s.nombre;
end;
$$;

revoke all on function public.registrar_mi_entrada() from public;
revoke execute on function public.registrar_mi_entrada() from anon;
grant execute on function public.registrar_mi_entrada() to authenticated;
revoke all on function public.registrar_mi_salida() from public;
revoke execute on function public.registrar_mi_salida() from anon;
grant execute on function public.registrar_mi_salida() to authenticated;
revoke all on function public.mi_estado_jornada() from public;
revoke execute on function public.mi_estado_jornada() from anon;
grant execute on function public.mi_estado_jornada() to authenticated;
revoke all on function public.personal_activo_hoy() from public;
revoke execute on function public.personal_activo_hoy() from anon;
grant execute on function public.personal_activo_hoy() to authenticated;
