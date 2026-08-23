-- Jornada operativa: entrada/salida, tardanzas y estado actual del trabajador.

create or replace function public.mi_estado_jornada()
returns table (
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
  with yo as (
    select id from public.staff where user_id = auth.uid() and activo = true limit 1
  ), hoy_turno as (
    select st.staff_id, t.*
    from public.staff_turnos st
    join public.turnos t on t.id = st.turno_id and t.activo = true
    join yo on yo.id = st.staff_id
    where st.activo = true
      and st.dia_semana = extract(dow from current_date)::smallint
      and (st.fecha_desde is null or st.fecha_desde <= current_date)
      and (st.fecha_hasta is null or st.fecha_hasta >= current_date)
    order by st.fecha_desde desc nulls last
    limit 1
  )
  select a.id, a.fecha, a.entrada, a.salida, a.estado, a.minutos_tarde,
         ht.id, ht.nombre, ht.hora_inicio, ht.hora_fin, ht.tolerancia_minutos
  from yo
  left join public.asistencias a on a.staff_id = yo.id and a.fecha = current_date
  left join hoy_turno ht on ht.staff_id = yo.id;
$$;

grant execute on function public.mi_estado_jornada() to authenticated;

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
  v_inicio timestamptz;
  v_tarde integer := 0;
  v_estado text := 'presente';
begin
  select * into v_staff from public.staff where user_id = auth.uid() and activo = true limit 1;
  if v_staff.id is null then raise exception 'Personal no válido o inactivo'; end if;

  select t.* into v_turno
  from public.staff_turnos st
  join public.turnos t on t.id = st.turno_id and t.activo = true
  where st.staff_id = v_staff.id and st.activo = true
    and st.dia_semana = extract(dow from current_date)::smallint
    and (st.fecha_desde is null or st.fecha_desde <= current_date)
    and (st.fecha_hasta is null or st.fecha_hasta >= current_date)
  order by st.fecha_desde desc nulls last limit 1;

  if v_turno.id is null and v_staff.rol <> 'administrador' then
    raise exception 'No tienes un turno asignado para hoy';
  end if;

  select * into v_existente from public.asistencias where staff_id = v_staff.id and fecha = current_date;
  if v_existente.id is not null and v_existente.entrada is not null then
    return v_existente;
  end if;

  if v_turno.id is not null then
    v_inicio := current_date::timestamp + v_turno.hora_inicio;
    v_tarde := greatest(0, floor(extract(epoch from (now() - v_inicio)) / 60)::integer - v_turno.tolerancia_minutos);
    if v_tarde > 0 then v_estado := 'tarde'; end if;
  end if;

  insert into public.asistencias (staff_id, turno_id, fecha, entrada, estado, minutos_tarde, registrado_por)
  values (v_staff.id, v_turno.id, current_date, now(), v_estado, v_tarde, v_staff.id)
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

grant execute on function public.registrar_mi_entrada() to authenticated;

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
begin
  select * into v_staff from public.staff where user_id = auth.uid() and activo = true limit 1;
  if v_staff.id is null then raise exception 'Personal no válido o inactivo'; end if;

  select id into v_caja_abierta from public.cash_sessions
  where cajero_id = v_staff.id and cierre is null
  order by apertura desc limit 1;
  if v_caja_abierta is not null then
    raise exception 'Debes cerrar tu caja antes de registrar la salida';
  end if;

  select * into v_asistencia from public.asistencias where staff_id = v_staff.id and fecha = current_date;
  if v_asistencia.id is null or v_asistencia.entrada is null then
    raise exception 'Primero debes registrar tu entrada';
  end if;
  if v_asistencia.salida is not null then return v_asistencia; end if;

  update public.asistencias set salida = now(), updated_at = now()
  where id = v_asistencia.id returning * into v_asistencia;
  return v_asistencia;
end;
$$;

grant execute on function public.registrar_mi_salida() to authenticated;

-- Resumen para administradores: quién está trabajando hoy.
create or replace view public.personal_activo_hoy as
select s.id as staff_id, s.nombre, s.puesto, s.rol, a.entrada, a.salida, a.estado, a.minutos_tarde,
       t.nombre as turno_nombre, t.hora_inicio, t.hora_fin
from public.staff s
left join public.asistencias a on a.staff_id = s.id and a.fecha = current_date
left join public.turnos t on t.id = a.turno_id
where s.activo = true;

grant select on public.personal_activo_hoy to authenticated;
