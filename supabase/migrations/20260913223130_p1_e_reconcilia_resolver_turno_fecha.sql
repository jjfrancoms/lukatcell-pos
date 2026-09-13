-- ============================================================================
-- P1.E — Reconciliación de DERIVA DE PRODUCCIÓN: private.resolver_turno_fecha
-- ============================================================================
-- El ensayo compuesto (scripts/verify-migraciones-compuestas.mjs) reproduce
-- las 153 migraciones de producción sobre un PostgreSQL local y compara la
-- huella del esquema con la de producción. Encontró que
-- private.resolver_turno_fecha(uuid, date) EXISTE en producción pero NINGUNA
-- migración la crea: sólo aparece un GRANT (20260824125442) y una llamada
-- (20260824124052). Se creó a mano desde el panel de Supabase.
--
-- Ampliación (diff función por función de las 167, 2026-09-13): en el mismo
-- cambio manual se reescribió public.registrar_justificacion_asistencia para
-- resolver el turno con private.resolver_turno_fecha (respeta las excepciones
-- de turno). El repo seguía con la versión de 20260824122859, que consulta
-- staff_turnos directamente e ignora las excepciones: una reconstrucción desde
-- el repo habría devuelto una lógica distinta a la que corre en producción.
-- Son las DOS únicas funciones con deriva de lógica. Las demás diferencias de
-- texto (41 funciones) son sólo formato, comentarios internos, un `;` tras el
-- `end` final o un alias sin `as`; están verificadas en el ensayo.
--
-- Consecuencia: el repositorio no podía reconstruir producción. Esta migración
-- codifica la función con la definición EXACTA capturada de producción
-- (pg_get_functiondef) y su ACL real (EXECUTE para postgres y authenticated;
-- sin PUBLIC, sin anon, sin service_role).
--
-- En producción es un no-op idempotente: CREATE OR REPLACE con el mismo cuerpo,
-- misma firma, mismo tipo de retorno y mismos privilegios.
--
-- Límite conocido: una reconstrucción desde cero con la herramienta de Supabase
-- aplica por versión, y 20260824124052 necesita la función antes de que esta
-- migración exista en el orden. Resolverlo del todo exige reparar el historial
-- (supabase migration repair), que es una acción del dueño; queda registrado
-- como deuda de DevOps. No se edita ninguna migración ya aplicada ni se
-- registra ninguna versión a mano.
-- ============================================================================

create or replace function private.resolver_turno_fecha(p_staff_id uuid, p_fecha date)
 returns table(turno_id uuid, es_excepcion boolean)
 language plpgsql
 stable
 set search_path to 'public', 'private'
as $function$
declare v_existe boolean; v_turno uuid;
begin
  select true,e.turno_id into v_existe,v_turno
  from public.staff_turno_excepciones e
  where e.staff_id=p_staff_id and e.fecha=p_fecha and e.activo=true
  order by e.created_at desc limit 1;
  if coalesce(v_existe,false) then
    return query select v_turno,true;
    return;
  end if;
  select st.turno_id into v_turno
  from public.staff_turnos st
  where st.staff_id=p_staff_id and st.activo=true
    and st.dia_semana=extract(dow from p_fecha)::smallint
    and coalesce(st.fecha_desde,(st.created_at at time zone 'America/Lima')::date)<=p_fecha
    and (st.fecha_hasta is null or st.fecha_hasta>=p_fecha)
  order by coalesce(st.fecha_desde,(st.created_at at time zone 'America/Lima')::date) desc,st.created_at desc limit 1;
  if v_turno is not null then return query select v_turno,false; end if;
end; $function$;

revoke all on function private.resolver_turno_fecha(uuid, date) from public;
grant execute on function private.resolver_turno_fecha(uuid, date) to authenticated;

-- Definición EXACTA de producción (pg_get_functiondef; md5(prosrc)
-- f81ed6d75748bae9551219851ed3e889). SECURITY INVOKER, como en producción.
-- ACL real: postgres, authenticated y service_role; sin PUBLIC ni anon.
create or replace function public.registrar_justificacion_asistencia(p_staff_id uuid, p_fecha date, p_observacion text)
 returns asistencias
 language plpgsql
 set search_path to 'public', 'private'
as $function$
declare v_turno_id uuid; v_existente public.asistencias; v_result public.asistencias; v_hoy date:=(now() at time zone 'America/Lima')::date;
begin
 if not private.auth_is_admin() then raise exception 'Solo un administrador puede justificar asistencias'; end if;
 if p_staff_id is null or p_fecha is null then raise exception 'Personal y fecha son obligatorios'; end if;
 if p_fecha>v_hoy then raise exception 'No se puede justificar una fecha futura'; end if;
 if length(trim(coalesce(p_observacion,'')))<3 then raise exception 'Ingresa un motivo de justificación'; end if;
 if exists(select 1 from public.personal_permisos pp where pp.staff_id=p_staff_id and pp.activo=true and p_fecha between pp.fecha_desde and pp.fecha_hasta) then raise exception 'La fecha ya está cubierta por un permiso, vacaciones o licencia'; end if;
 select r.turno_id into v_turno_id from private.resolver_turno_fecha(p_staff_id,p_fecha) r;
 if v_turno_id is null then raise exception 'La persona no estaba programada para trabajar en esa fecha'; end if;
 select * into v_existente from public.asistencias where staff_id=p_staff_id and fecha=p_fecha;
 if v_existente.id is not null and v_existente.entrada is not null then raise exception 'La fecha ya tiene una entrada registrada y no puede marcarse como ausencia justificada'; end if;
 insert into public.asistencias(staff_id,turno_id,fecha,estado,minutos_tarde,observacion,registrado_por) values(p_staff_id,v_turno_id,p_fecha,'justificado',0,trim(p_observacion),private.auth_staff_id())
 on conflict(staff_id,fecha) do update set turno_id=coalesce(public.asistencias.turno_id,excluded.turno_id),estado='justificado',minutos_tarde=0,observacion=excluded.observacion,registrado_por=excluded.registrado_por,updated_at=now() returning * into v_result;
 return v_result;
end; $function$;

revoke all on function public.registrar_justificacion_asistencia(uuid, date, text) from public;
grant execute on function public.registrar_justificacion_asistencia(uuid, date, text) to authenticated, service_role;
