create table if not exists public.personal_permisos (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff(id) on delete cascade,
  tipo text not null check (tipo in ('permiso','vacaciones','licencia')),
  fecha_desde date not null,
  fecha_hasta date not null,
  motivo text not null,
  activo boolean not null default true,
  registrado_por uuid null references public.staff(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (fecha_hasta >= fecha_desde)
);

create index if not exists personal_permisos_staff_fechas_idx on public.personal_permisos(staff_id, fecha_desde, fecha_hasta) where activo;
alter table public.personal_permisos enable row level security;

drop policy if exists personal_permisos_select_own_or_admin on public.personal_permisos;
create policy personal_permisos_select_own_or_admin on public.personal_permisos
for select to authenticated
using (private.auth_is_admin() or staff_id = private.auth_staff_id());

drop policy if exists personal_permisos_admin_write on public.personal_permisos;
create policy personal_permisos_admin_write on public.personal_permisos
for all to authenticated
using (private.auth_is_admin())
with check (private.auth_is_admin());

revoke all on public.personal_permisos from anon;
grant select, insert, update, delete on public.personal_permisos to authenticated;

create or replace function private.validar_permiso_sin_solape()
returns trigger language plpgsql set search_path=public,private as $$
begin
  if new.activo and exists(
    select 1 from public.personal_permisos p
    where p.staff_id=new.staff_id and p.activo=true and p.id<>new.id
      and daterange(p.fecha_desde,p.fecha_hasta,'[]') && daterange(new.fecha_desde,new.fecha_hasta,'[]')
  ) then raise exception 'Ya existe un permiso, vacaciones o licencia que se cruza con esas fechas'; end if;
  new.updated_at:=now(); return new;
end; $$;
revoke all on function private.validar_permiso_sin_solape() from public,anon,authenticated;

drop trigger if exists validar_permiso_sin_solape on public.personal_permisos;
create trigger validar_permiso_sin_solape before insert or update on public.personal_permisos for each row execute function private.validar_permiso_sin_solape();

drop trigger if exists audit_personal_permisos on public.personal_permisos;
create trigger audit_personal_permisos after insert or update or delete on public.personal_permisos for each row execute function private.registrar_auditoria();

create or replace function public.registrar_permiso_personal(p_staff_id uuid,p_tipo text,p_fecha_desde date,p_fecha_hasta date,p_motivo text)
returns public.personal_permisos language plpgsql security invoker set search_path=public,private as $$
declare v_result public.personal_permisos;
begin
  if not private.auth_is_admin() then raise exception 'Solo administración puede registrar permisos'; end if;
  if p_staff_id is null or p_fecha_desde is null or p_fecha_hasta is null then raise exception 'Personal y fechas son obligatorios'; end if;
  if p_tipo not in('permiso','vacaciones','licencia') then raise exception 'Tipo de permiso no válido'; end if;
  if p_fecha_hasta<p_fecha_desde then raise exception 'La fecha final no puede ser anterior a la inicial'; end if;
  if length(trim(coalesce(p_motivo,'')))<3 then raise exception 'Ingresa el motivo'; end if;
  insert into public.personal_permisos(staff_id,tipo,fecha_desde,fecha_hasta,motivo,registrado_por)
  values(p_staff_id,p_tipo,p_fecha_desde,p_fecha_hasta,trim(p_motivo),private.auth_staff_id()) returning * into v_result;
  return v_result;
end; $$;

create or replace function public.cancelar_permiso_personal(p_permiso_id uuid)
returns boolean language plpgsql security invoker set search_path=public,private as $$
declare v_count integer;
begin
  if not private.auth_is_admin() then raise exception 'Solo administración puede cancelar permisos'; end if;
  update public.personal_permisos set activo=false,updated_at=now() where id=p_permiso_id and activo=true;
  get diagnostics v_count=row_count; return v_count>0;
end; $$;

create or replace function public.permisos_personal_admin(p_mes date default date_trunc('month',(now() at time zone 'America/Lima'))::date)
returns table(permiso_id uuid,staff_id uuid,nombre text,username text,tipo text,fecha_desde date,fecha_hasta date,motivo text,activo boolean,registrado_por_nombre text)
language sql stable security invoker set search_path=public,private as $$
select p.id,p.staff_id,s.nombre::text,s.username::text,p.tipo,p.fecha_desde,p.fecha_hasta,p.motivo,p.activo,r.nombre::text
from public.personal_permisos p join public.staff s on s.id=p.staff_id left join public.staff r on r.id=p.registrado_por
where private.auth_is_admin() and p.fecha_desde<(date_trunc('month',p_mes)+interval '1 month')::date and p.fecha_hasta>=date_trunc('month',p_mes)::date
order by p.activo desc,p.fecha_desde desc,s.nombre; $$;

revoke all on function public.registrar_permiso_personal(uuid,text,date,date,text) from public,anon;
revoke all on function public.cancelar_permiso_personal(uuid) from public,anon;
revoke all on function public.permisos_personal_admin(date) from public,anon;
grant execute on function public.registrar_permiso_personal(uuid,text,date,date,text) to authenticated;
grant execute on function public.cancelar_permiso_personal(uuid) to authenticated;
grant execute on function public.permisos_personal_admin(date) to authenticated;

create or replace function public.mi_estado_jornada()
returns table(asistencia_id uuid,fecha date,entrada timestamptz,salida timestamptz,estado text,minutos_tarde integer,turno_id uuid,turno_nombre text,hora_inicio time,hora_fin time,tolerancia_minutos integer)
language sql security invoker set search_path=public,private as $$
with reloj as(select (now() at time zone 'America/Lima')::timestamp ahora_local,(now() at time zone 'America/Lima')::date fecha_local),
yo as(select id from public.staff where user_id=auth.uid() and activo=true limit 1),
asistencia_actual as(select a.* from public.asistencias a join yo on yo.id=a.staff_id cross join reloj r where a.fecha=r.fecha_local or(a.fecha=r.fecha_local-1 and a.salida is null) order by(a.salida is null) desc,a.entrada desc nulls last limit 1),
programado as(select rp.jornada_fecha,rp.turno_id from yo cross join reloj r cross join lateral private.resolver_turno_programado(yo.id,r.ahora_local) rp)
select a.id,coalesce(a.fecha,p.jornada_fecha,r.fecha_local),a.entrada,a.salida,case when a.id is null and pe.tipo is not null then pe.tipo else a.estado end,coalesce(a.minutos_tarde,0),coalesce(a.turno_id,p.turno_id),t.nombre,t.hora_inicio,t.hora_fin,t.tolerancia_minutos
from yo cross join reloj r left join asistencia_actual a on true left join programado p on true
left join lateral(select pp.tipo from public.personal_permisos pp where pp.staff_id=yo.id and pp.activo=true and coalesce(a.fecha,p.jornada_fecha,r.fecha_local) between pp.fecha_desde and pp.fecha_hasta order by pp.created_at desc limit 1) pe on true
left join public.turnos t on t.id=coalesce(a.turno_id,p.turno_id); $$;

create or replace function public.personal_activo_hoy()
returns table(staff_id uuid,nombre text,puesto text,rol text,entrada timestamptz,salida timestamptz,estado text,minutos_tarde integer,turno_nombre text,hora_inicio time,hora_fin time)
language plpgsql security invoker set search_path=public,private as $$
declare v_fecha date:=(now() at time zone 'America/Lima')::date; v_ahora_local timestamp:=now() at time zone 'America/Lima';
begin
 if not private.auth_is_admin() then raise exception 'Acceso restringido a administradores'; end if;
 return query select s.id,s.nombre::text,s.puesto::text,s.rol::text,a.entrada,a.salida,
 case when a.entrada is not null and a.salida is not null then 'salio'::text when a.entrada is not null then coalesce(a.estado::text,'presente') when pe.tipo is not null then pe.tipo when rp.turno_id is null then 'descanso'::text else 'pendiente'::text end,
 coalesce(a.minutos_tarde,0),coalesce(ta.nombre,tp.nombre)::text,coalesce(ta.hora_inicio,tp.hora_inicio),coalesce(ta.hora_fin,tp.hora_fin)
 from public.staff s
 left join lateral(select ax.* from public.asistencias ax where ax.staff_id=s.id and(ax.fecha=v_fecha or(ax.fecha=v_fecha-1 and ax.salida is null)) order by(ax.salida is null) desc,ax.entrada desc nulls last limit 1) a on true
 left join lateral private.resolver_turno_programado(s.id,v_ahora_local) rp on true
 left join lateral(select pp.tipo from public.personal_permisos pp where pp.staff_id=s.id and pp.activo=true and coalesce(a.fecha,rp.jornada_fecha,v_fecha) between pp.fecha_desde and pp.fecha_hasta order by pp.created_at desc limit 1) pe on true
 left join public.turnos ta on ta.id=a.turno_id left join public.turnos tp on tp.id=rp.turno_id where s.activo=true order by s.nombre;
end; $$;

create or replace function public.dashboard_operativo_admin()
returns jsonb language sql stable security invoker set search_path=public,private as $$
with hoy as(select (now() at time zone 'America/Lima')::date fecha),
ventas as(select coalesce(sum(s.total),0)::numeric total,count(*)::int cantidad from public.sales s,hoy h where private.auth_is_admin() and s.estado='completada' and(s.fecha at time zone 'America/Lima')::date=h.fecha),
cajas as(select count(*)::int abiertas from public.cash_sessions c where private.auth_is_admin() and c.cierre is null),
stock as(select count(*)::int criticos from public.inventory i where private.auth_is_admin() and i.cantidad<=i.stock_minimo),
ordenes as(select count(*) filter(where coalesce(o.estado,'') not in('entregado','cancelado'))::int pendientes,count(*) filter(where o.estado='listo')::int listas from public.ordenes_servicio o where private.auth_is_admin()),
personal as(select count(*)::int total,count(*) filter(where p.estado='descanso')::int descanso,count(*) filter(where p.estado='pendiente')::int pendientes,count(*) filter(where p.estado in('presente','tarde'))::int trabajando,count(*) filter(where p.estado='tarde')::int tarde,count(*) filter(where p.estado='salio')::int salieron,count(*) filter(where p.estado in('permiso','vacaciones','licencia'))::int permisos from public.personal_activo_hoy() p where private.auth_is_admin()),
config as(select count(*)::int incompletos from public.personal_configuracion_pendiente() where private.auth_is_admin())
select case when not private.auth_is_admin() then null else jsonb_build_object('fecha',(select fecha from hoy),'ventas_total',(select total from ventas),'ventas_cantidad',(select cantidad from ventas),'cajas_abiertas',(select abiertas from cajas),'stock_critico',(select criticos from stock),'ordenes_pendientes',(select pendientes from ordenes),'ordenes_listas',(select listas from ordenes),'personal_total',(select total from personal),'personal_descanso',(select descanso from personal),'personal_pendiente',(select pendientes from personal),'personal_trabajando',(select trabajando from personal),'personal_tarde',(select tarde from personal),'personal_salieron',(select salieron from personal),'personal_permisos',(select permisos from personal),'config_incompleta',(select incompletos from config)) end; $$;

create or replace function public.registrar_mi_entrada()
returns public.asistencias language plpgsql security definer set search_path=public,private as $$
declare v_staff public.staff; v_turno public.turnos; v_existente public.asistencias; v_fecha_local date:=(now() at time zone 'America/Lima')::date; v_fecha_jornada date; v_turno_id uuid; v_ahora_local timestamp:=now() at time zone 'America/Lima'; v_inicio_local timestamp; v_retraso_real integer:=0; v_estado text:='presente'; v_permiso text;
begin
 select * into v_staff from public.staff where user_id=auth.uid() and activo=true limit 1; if v_staff.id is null then raise exception 'Personal no válido o inactivo'; end if;
 select r.jornada_fecha,r.turno_id into v_fecha_jornada,v_turno_id from private.resolver_turno_programado(v_staff.id,v_ahora_local) r; if v_fecha_jornada is null then v_fecha_jornada:=v_fecha_local; end if;
 if v_turno_id is not null then select * into v_turno from public.turnos where id=v_turno_id; end if; if v_turno.id is null and v_staff.rol<>'administrador' then raise exception 'No tienes un turno asignado para este momento'; end if;
 select pp.tipo into v_permiso from public.personal_permisos pp where pp.staff_id=v_staff.id and pp.activo=true and v_fecha_jornada between pp.fecha_desde and pp.fecha_hasta order by pp.created_at desc limit 1;
 if v_permiso is not null and v_staff.rol<>'administrador' then raise exception 'Tienes % registrado para esta jornada',v_permiso; end if;
 select * into v_existente from public.asistencias where staff_id=v_staff.id and fecha=v_fecha_jornada; if v_existente.id is not null and v_existente.entrada is not null then return v_existente; end if;
 if v_turno.id is not null then v_inicio_local:=v_fecha_jornada::timestamp+v_turno.hora_inicio; v_retraso_real:=greatest(0,floor(extract(epoch from(v_ahora_local-v_inicio_local))/60)::integer); if v_retraso_real>v_turno.tolerancia_minutos then v_estado:='tarde'; end if; end if;
 insert into public.asistencias(staff_id,turno_id,fecha,entrada,estado,minutos_tarde,registrado_por) values(v_staff.id,v_turno.id,v_fecha_jornada,now(),v_estado,v_retraso_real,v_staff.id)
 on conflict(staff_id,fecha) do update set entrada=coalesce(public.asistencias.entrada,excluded.entrada),turno_id=coalesce(public.asistencias.turno_id,excluded.turno_id),estado=case when public.asistencias.entrada is null then excluded.estado else public.asistencias.estado end,minutos_tarde=case when public.asistencias.entrada is null then excluded.minutos_tarde else public.asistencias.minutos_tarde end,updated_at=now() returning * into v_existente; return v_existente;
end; $$;

create or replace function public.registrar_justificacion_asistencia(p_staff_id uuid,p_fecha date,p_observacion text)
returns public.asistencias language plpgsql security invoker set search_path=public,private as $$
declare v_turno_id uuid; v_existente public.asistencias; v_result public.asistencias; v_hoy date:=(now() at time zone 'America/Lima')::date;
begin
 if not private.auth_is_admin() then raise exception 'Solo un administrador puede justificar asistencias'; end if; if p_staff_id is null or p_fecha is null then raise exception 'Personal y fecha son obligatorios'; end if; if p_fecha>v_hoy then raise exception 'No se puede justificar una fecha futura'; end if; if length(trim(coalesce(p_observacion,'')))<3 then raise exception 'Ingresa un motivo de justificación'; end if;
 if exists(select 1 from public.personal_permisos pp where pp.staff_id=p_staff_id and pp.activo=true and p_fecha between pp.fecha_desde and pp.fecha_hasta) then raise exception 'La fecha ya está cubierta por un permiso, vacaciones o licencia'; end if;
 select st.turno_id into v_turno_id from public.staff_turnos st where st.staff_id=p_staff_id and st.dia_semana=extract(dow from p_fecha)::smallint and coalesce(st.fecha_desde,(st.created_at at time zone 'America/Lima')::date)<=p_fecha and(st.fecha_hasta is null or st.fecha_hasta>=p_fecha) order by coalesce(st.fecha_desde,(st.created_at at time zone 'America/Lima')::date) desc,st.created_at desc limit 1; if v_turno_id is null then raise exception 'La persona no estaba programada para trabajar en esa fecha'; end if;
 select * into v_existente from public.asistencias where staff_id=p_staff_id and fecha=p_fecha; if v_existente.id is not null and v_existente.entrada is not null then raise exception 'La fecha ya tiene una entrada registrada y no puede marcarse como ausencia justificada'; end if;
 insert into public.asistencias(staff_id,turno_id,fecha,estado,minutos_tarde,observacion,registrado_por) values(p_staff_id,v_turno_id,p_fecha,'justificado',0,trim(p_observacion),private.auth_staff_id()) on conflict(staff_id,fecha) do update set turno_id=coalesce(public.asistencias.turno_id,excluded.turno_id),estado='justificado',minutos_tarde=0,observacion=excluded.observacion,registrado_por=excluded.registrado_por,updated_at=now() returning * into v_result; return v_result;
end; $$;

drop function if exists public.asistencia_mensual_admin(date);
create function public.asistencia_mensual_admin(p_mes date default date_trunc('month',(now() at time zone 'America/Lima'))::date)
returns table(staff_id uuid,nombre text,username text,puesto text,dias_programados_mes integer,dias_programados_hasta_hoy integer,dias_con_entrada integer,tardanzas integer,minutos_tarde integer,ausencias integer,justificados integer,permisos integer,horas_programadas_mes numeric,horas_programadas_hasta_hoy numeric,horas_trabajadas numeric,jornadas_incompletas integer)
language sql stable security invoker set search_path=public,private as $$
with limites as(select date_trunc('month',p_mes)::date inicio,(date_trunc('month',p_mes)+interval '1 month - 1 day')::date fin,least((now() at time zone 'America/Lima')::date,(date_trunc('month',p_mes)+interval '1 month - 1 day')::date) hasta_hoy),
dias as(select gs::date fecha from limites l,generate_series(l.inicio,l.fin,interval '1 day') gs),
activos as(select s.id,s.nombre::text,s.username::text,s.puesto::text from public.staff s where s.activo=true and private.auth_is_admin()),
programacion as(select distinct on(a.id,d.fecha) a.id staff_id,d.fecha,st.turno_id,round((extract(epoch from(case when t.cruza_medianoche or t.hora_fin<=t.hora_inicio then(t.hora_fin-t.hora_inicio)+interval '24 hours' else(t.hora_fin-t.hora_inicio) end))/3600.0)::numeric,2) horas_programadas from activos a cross join dias d join public.staff_turnos st on st.staff_id=a.id and st.dia_semana=extract(dow from d.fecha)::smallint and coalesce(st.fecha_desde,(st.created_at at time zone 'America/Lima')::date)<=d.fecha and(st.fecha_hasta is null or st.fecha_hasta>=d.fecha) join public.turnos t on t.id=st.turno_id order by a.id,d.fecha,coalesce(st.fecha_desde,(st.created_at at time zone 'America/Lima')::date) desc,st.created_at desc),
resumen_prog as(select p.staff_id,count(*)::int programados_mes,count(*) filter(where p.fecha<=l.hasta_hoy)::int programados_hasta_hoy,round(coalesce(sum(p.horas_programadas),0),2) horas_programadas_mes,round(coalesce(sum(p.horas_programadas) filter(where p.fecha<=l.hasta_hoy),0),2) horas_programadas_hasta_hoy from programacion p cross join limites l group by p.staff_id),
resumen_asistencia as(select a.staff_id,count(*) filter(where a.entrada is not null)::int con_entrada,count(*) filter(where a.estado='tarde')::int tardanzas,coalesce(sum(a.minutos_tarde),0)::int minutos_tarde,count(*) filter(where a.estado='justificado')::int justificados,count(*) filter(where a.entrada is not null and a.salida is null)::int incompletas,round(coalesce(sum(case when a.entrada is not null and a.salida is not null then extract(epoch from(a.salida-a.entrada))/3600.0 else 0 end),0)::numeric,2) horas from public.asistencias a,limites l where a.fecha between l.inicio and l.fin group by a.staff_id),
resumen_permisos as(select p.staff_id,count(*)::int permisos from programacion p join public.personal_permisos pp on pp.staff_id=p.staff_id and pp.activo=true and p.fecha between pp.fecha_desde and pp.fecha_hasta cross join limites l where p.fecha<=l.hasta_hoy group by p.staff_id),
ausencias_calc as(select p.staff_id,count(*) filter(where p.fecha<l.hasta_hoy and not exists(select 1 from public.asistencias asi where asi.staff_id=p.staff_id and asi.fecha=p.fecha and(asi.entrada is not null or asi.estado='justificado')) and not exists(select 1 from public.personal_permisos pp where pp.staff_id=p.staff_id and pp.activo=true and p.fecha between pp.fecha_desde and pp.fecha_hasta))::int ausencias from programacion p cross join limites l group by p.staff_id)
select s.id,s.nombre,s.username,s.puesto,coalesce(rp.programados_mes,0),coalesce(rp.programados_hasta_hoy,0),coalesce(ra.con_entrada,0),coalesce(ra.tardanzas,0),coalesce(ra.minutos_tarde,0),coalesce(ac.ausencias,0),coalesce(ra.justificados,0),coalesce(rpe.permisos,0),coalesce(rp.horas_programadas_mes,0),coalesce(rp.horas_programadas_hasta_hoy,0),coalesce(ra.horas,0),coalesce(ra.incompletas,0)
from activos s left join resumen_prog rp on rp.staff_id=s.id left join resumen_asistencia ra on ra.staff_id=s.id left join resumen_permisos rpe on rpe.staff_id=s.id left join ausencias_calc ac on ac.staff_id=s.id order by s.nombre; $$;

revoke all on function public.asistencia_mensual_admin(date) from public,anon;
grant execute on function public.asistencia_mensual_admin(date) to authenticated;
