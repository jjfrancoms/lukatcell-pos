create or replace function public.asistencia_mensual_admin(
  p_mes date default date_trunc('month', now() at time zone 'America/Lima')::date
)
returns table(
  staff_id uuid,
  nombre text,
  username text,
  puesto text,
  dias_programados_mes integer,
  dias_programados_hasta_hoy integer,
  dias_con_entrada integer,
  tardanzas integer,
  minutos_tarde integer,
  ausencias integer,
  justificados integer,
  permisos integer,
  horas_programadas_mes numeric,
  horas_programadas_hasta_hoy numeric,
  horas_trabajadas numeric,
  jornadas_incompletas integer
)
language sql
stable
set search_path to 'public', 'private'
as $function$
with limites as(
 select date_trunc('month',p_mes)::date inicio,(date_trunc('month',p_mes)+interval '1 month - 1 day')::date fin,
 least((now() at time zone 'America/Lima')::date,(date_trunc('month',p_mes)+interval '1 month - 1 day')::date) hasta_hoy
),
dias as(select gs::date fecha from limites l,generate_series(l.inicio,l.fin,interval '1 day') gs),
activos as(select s.id,s.nombre::text,s.username::text,s.puesto::text from public.staff s where s.activo=true and private.auth_is_admin()),
programacion as(
 select a.id staff_id,d.fecha,rf.turno_id,
   round((extract(epoch from(case when t.cruza_medianoche or t.hora_fin<=t.hora_inicio then(t.hora_fin-t.hora_inicio)+interval '24 hours' else(t.hora_fin-t.hora_inicio) end))/3600.0)::numeric,2) horas_programadas
 from activos a cross join dias d
 cross join lateral private.resolver_turno_fecha(a.id,d.fecha) rf
 join public.turnos t on t.id=rf.turno_id and t.activo=true
 where rf.turno_id is not null
),
resumen_prog as(
 select p.staff_id,count(*)::int programados_mes,count(*) filter(where p.fecha<=l.hasta_hoy)::int programados_hasta_hoy,
 round(coalesce(sum(p.horas_programadas),0),2) horas_programadas_mes,
 round(coalesce(sum(p.horas_programadas) filter(where p.fecha<=l.hasta_hoy),0),2) horas_programadas_hasta_hoy
 from programacion p cross join limites l group by p.staff_id
),
resumen_asistencia as(
 select a.staff_id,count(*) filter(where a.entrada is not null)::int con_entrada,count(*) filter(where a.estado='tarde')::int tardanzas,
 coalesce(sum(a.minutos_tarde),0)::int minutos_tarde,count(*) filter(where a.estado='justificado')::int justificados,
 count(*) filter(where a.entrada is not null and a.salida is null)::int incompletas,
 round(coalesce(sum(case when a.entrada is not null and a.salida is not null then extract(epoch from(a.salida-a.entrada))/3600.0 else 0 end),0)::numeric,2) horas
 from public.asistencias a,limites l where a.fecha between l.inicio and l.fin group by a.staff_id
),
resumen_permisos as(
 select p.staff_id,count(*)::int permisos from programacion p
 join public.personal_permisos pp on pp.staff_id=p.staff_id and pp.activo=true and p.fecha between pp.fecha_desde and pp.fecha_hasta
 cross join limites l where p.fecha<=l.hasta_hoy group by p.staff_id
),
ausencias_calc as(
 select p.staff_id,count(*) filter(where p.fecha<l.hasta_hoy
   and not exists(select 1 from public.asistencias asi where asi.staff_id=p.staff_id and asi.fecha=p.fecha and(asi.entrada is not null or asi.estado='justificado'))
   and not exists(select 1 from public.personal_permisos pp where pp.staff_id=p.staff_id and pp.activo=true and p.fecha between pp.fecha_desde and pp.fecha_hasta))::int ausencias
 from programacion p cross join limites l group by p.staff_id
)
select s.id,s.nombre,s.username,s.puesto,coalesce(rp.programados_mes,0),coalesce(rp.programados_hasta_hoy,0),coalesce(ra.con_entrada,0),coalesce(ra.tardanzas,0),coalesce(ra.minutos_tarde,0),coalesce(ac.ausencias,0),coalesce(ra.justificados,0),coalesce(rpe.permisos,0),coalesce(rp.horas_programadas_mes,0),coalesce(rp.horas_programadas_hasta_hoy,0),coalesce(ra.horas,0),coalesce(ra.incompletas,0)
from activos s left join resumen_prog rp on rp.staff_id=s.id left join resumen_asistencia ra on ra.staff_id=s.id left join resumen_permisos rpe on rpe.staff_id=s.id left join ausencias_calc ac on ac.staff_id=s.id order by s.nombre;
$function$;
