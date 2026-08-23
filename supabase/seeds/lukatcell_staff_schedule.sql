-- Seed operativo de horarios LUKATCELL.
-- No crea cuentas Auth ni inventa correos/contraseñas.
-- Solo actúa sobre perfiles existentes con estos usernames.
-- Puede ejecutarse varias veces: desactiva la programación activa previa y crea la vigente.

do $$
declare
  v_fecha date := (now() at time zone 'America/Lima')::date;
  v_apertura uuid;
  v_completo uuid;
  v_cierre uuid;
begin
  select id into v_apertura from public.turnos where nombre = 'Apertura' and activo = true order by created_at limit 1;
  select id into v_completo from public.turnos where nombre = 'Completo' and activo = true order by created_at limit 1;
  select id into v_cierre from public.turnos where nombre = 'Cierre' and activo = true order by created_at limit 1;

  if v_apertura is null or v_completo is null or v_cierre is null then
    raise exception 'Faltan turnos base Apertura/Completo/Cierre';
  end if;

  update public.staff set puesto = 'jefa' where username = 'admin';
  update public.staff set puesto = 'vendedor' where username in ('yoxi', 'vendedor2', 'vendedor3');
  update public.staff set puesto = 'tecnico' where username = 'tecnico';

  update public.staff_turnos st
  set activo = false,
      fecha_hasta = greatest(coalesce(st.fecha_desde, v_fecha - 1), v_fecha - 1)
  where st.activo = true
    and st.staff_id in (
      select id from public.staff where username in ('admin','yoxi','vendedor2','vendedor3','tecnico')
    );

  -- admin / jefa: descanso domingo; Completo lunes-sábado.
  insert into public.staff_turnos(staff_id, turno_id, dia_semana, fecha_desde, activo)
  select s.id, v_completo, d, v_fecha, true
  from public.staff s
  cross join unnest(array[1,2,3,4,5,6]::smallint[]) d
  where s.username = 'admin';

  -- yoxi / vendedor: descanso lunes; Apertura domingo y martes-sábado.
  insert into public.staff_turnos(staff_id, turno_id, dia_semana, fecha_desde, activo)
  select s.id, v_apertura, d, v_fecha, true
  from public.staff s
  cross join unnest(array[0,2,3,4,5,6]::smallint[]) d
  where s.username = 'yoxi';

  -- vendedor2: descanso martes; Completo.
  insert into public.staff_turnos(staff_id, turno_id, dia_semana, fecha_desde, activo)
  select s.id, v_completo, d, v_fecha, true
  from public.staff s
  cross join unnest(array[0,1,3,4,5,6]::smallint[]) d
  where s.username = 'vendedor2';

  -- vendedor3: descanso miércoles; Cierre.
  insert into public.staff_turnos(staff_id, turno_id, dia_semana, fecha_desde, activo)
  select s.id, v_cierre, d, v_fecha, true
  from public.staff s
  cross join unnest(array[0,1,2,4,5,6]::smallint[]) d
  where s.username = 'vendedor3';

  -- técnico: descanso jueves; Completo.
  insert into public.staff_turnos(staff_id, turno_id, dia_semana, fecha_desde, activo)
  select s.id, v_completo, d, v_fecha, true
  from public.staff s
  cross join unnest(array[0,1,2,3,5,6]::smallint[]) d
  where s.username = 'tecnico';
end $$;
