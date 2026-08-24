create or replace function public.registrar_justificacion_asistencia(
  p_staff_id uuid,
  p_fecha date,
  p_observacion text
)
returns public.asistencias
language plpgsql
security invoker
set search_path = public, private
as $$
declare
  v_turno_id uuid;
  v_existente public.asistencias;
  v_result public.asistencias;
  v_hoy date := (now() at time zone 'America/Lima')::date;
begin
  if not private.auth_is_admin() then
    raise exception 'Solo un administrador puede justificar asistencias';
  end if;
  if p_staff_id is null or p_fecha is null then
    raise exception 'Personal y fecha son obligatorios';
  end if;
  if p_fecha > v_hoy then
    raise exception 'No se puede justificar una fecha futura';
  end if;
  if length(trim(coalesce(p_observacion, ''))) < 3 then
    raise exception 'Ingresa un motivo de justificación';
  end if;

  select st.turno_id into v_turno_id
  from public.staff_turnos st
  where st.staff_id = p_staff_id
    and st.dia_semana = extract(dow from p_fecha)::smallint
    and coalesce(st.fecha_desde, (st.created_at at time zone 'America/Lima')::date) <= p_fecha
    and (st.fecha_hasta is null or st.fecha_hasta >= p_fecha)
  order by coalesce(st.fecha_desde, (st.created_at at time zone 'America/Lima')::date) desc, st.created_at desc
  limit 1;

  if v_turno_id is null then
    raise exception 'La persona no estaba programada para trabajar en esa fecha';
  end if;

  select * into v_existente
  from public.asistencias
  where staff_id = p_staff_id and fecha = p_fecha;

  if v_existente.id is not null and v_existente.entrada is not null then
    raise exception 'La fecha ya tiene una entrada registrada y no puede marcarse como ausencia justificada';
  end if;

  insert into public.asistencias (
    staff_id, turno_id, fecha, estado, minutos_tarde, observacion, registrado_por
  ) values (
    p_staff_id, v_turno_id, p_fecha, 'justificado', 0, trim(p_observacion), private.auth_staff_id()
  )
  on conflict (staff_id, fecha) do update set
    turno_id = coalesce(public.asistencias.turno_id, excluded.turno_id),
    estado = 'justificado',
    minutos_tarde = 0,
    observacion = excluded.observacion,
    registrado_por = excluded.registrado_por,
    updated_at = now()
  returning * into v_result;

  return v_result;
end;
$$;

create or replace function public.quitar_justificacion_asistencia(p_asistencia_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = public, private
as $$
declare
  v_count integer;
begin
  if not private.auth_is_admin() then
    raise exception 'Solo un administrador puede modificar justificaciones';
  end if;

  delete from public.asistencias
  where id = p_asistencia_id
    and estado = 'justificado'
    and entrada is null;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

create or replace function public.justificaciones_asistencia_admin(
  p_mes date default date_trunc('month', (now() at time zone 'America/Lima'))::date
)
returns table(
  asistencia_id uuid,
  staff_id uuid,
  nombre text,
  username text,
  fecha date,
  turno_nombre text,
  observacion text,
  registrado_por_nombre text
)
language sql
stable
security invoker
set search_path = public, private
as $$
  select
    a.id,
    a.staff_id,
    s.nombre::text,
    s.username::text,
    a.fecha,
    t.nombre::text,
    a.observacion,
    rp.nombre::text
  from public.asistencias a
  join public.staff s on s.id = a.staff_id
  left join public.turnos t on t.id = a.turno_id
  left join public.staff rp on rp.id = a.registrado_por
  where private.auth_is_admin()
    and a.estado = 'justificado'
    and a.fecha >= date_trunc('month', p_mes)::date
    and a.fecha < (date_trunc('month', p_mes) + interval '1 month')::date
  order by a.fecha desc, s.nombre;
$$;

revoke all on function public.registrar_justificacion_asistencia(uuid,date,text) from public, anon;
revoke all on function public.quitar_justificacion_asistencia(uuid) from public, anon;
revoke all on function public.justificaciones_asistencia_admin(date) from public, anon;
grant execute on function public.registrar_justificacion_asistencia(uuid,date,text) to authenticated;
grant execute on function public.quitar_justificacion_asistencia(uuid) to authenticated;
grant execute on function public.justificaciones_asistencia_admin(date) to authenticated;
