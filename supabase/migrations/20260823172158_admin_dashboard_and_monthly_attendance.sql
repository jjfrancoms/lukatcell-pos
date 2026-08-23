create or replace function public.dashboard_operativo_admin()
returns jsonb
language sql
stable
security invoker
set search_path = public, private
as $$
  with hoy as (
    select (now() at time zone 'America/Lima')::date as fecha
  ), ventas as (
    select
      coalesce(sum(s.total), 0)::numeric as total,
      count(*)::int as cantidad
    from public.sales s, hoy h
    where private.auth_is_admin()
      and s.estado = 'completada'
      and (s.fecha at time zone 'America/Lima')::date = h.fecha
  ), cajas as (
    select count(*)::int as abiertas
    from public.cash_sessions c
    where private.auth_is_admin() and c.cierre is null
  ), stock as (
    select count(*)::int as criticos
    from public.inventory i
    where private.auth_is_admin() and i.cantidad <= i.stock_minimo
  ), ordenes as (
    select
      count(*) filter (where coalesce(o.estado, '') not in ('entregado','cancelado'))::int as pendientes,
      count(*) filter (where o.estado = 'listo')::int as listas
    from public.ordenes_servicio o
    where private.auth_is_admin()
  ), personal as (
    select
      count(*)::int as total,
      count(*) filter (where p.estado = 'descanso')::int as descanso,
      count(*) filter (where p.estado = 'pendiente')::int as pendientes,
      count(*) filter (where p.estado in ('presente','tarde'))::int as trabajando,
      count(*) filter (where p.estado = 'tarde')::int as tarde,
      count(*) filter (where p.estado = 'salio')::int as salieron
    from public.personal_activo_hoy() p
    where private.auth_is_admin()
  ), config as (
    select count(*)::int as incompletos
    from public.personal_configuracion_pendiente()
    where private.auth_is_admin()
  )
  select case when not private.auth_is_admin() then null else jsonb_build_object(
    'fecha', (select fecha from hoy),
    'ventas_total', (select total from ventas),
    'ventas_cantidad', (select cantidad from ventas),
    'cajas_abiertas', (select abiertas from cajas),
    'stock_critico', (select criticos from stock),
    'ordenes_pendientes', (select pendientes from ordenes),
    'ordenes_listas', (select listas from ordenes),
    'personal_total', (select total from personal),
    'personal_descanso', (select descanso from personal),
    'personal_pendiente', (select pendientes from personal),
    'personal_trabajando', (select trabajando from personal),
    'personal_tarde', (select tarde from personal),
    'personal_salieron', (select salieron from personal),
    'config_incompleta', (select incompletos from config)
  ) end;
$$;

revoke all on function public.dashboard_operativo_admin() from public, anon;
grant execute on function public.dashboard_operativo_admin() to authenticated;

create or replace function public.asistencia_mensual_admin(p_mes date default date_trunc('month', now() at time zone 'America/Lima')::date)
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
  horas_trabajadas numeric
)
language sql
stable
security invoker
set search_path = public, private
as $$
  with limites as (
    select
      date_trunc('month', p_mes)::date as inicio,
      (date_trunc('month', p_mes) + interval '1 month - 1 day')::date as fin,
      least((now() at time zone 'America/Lima')::date,
            (date_trunc('month', p_mes) + interval '1 month - 1 day')::date) as hasta_hoy
  ), dias as (
    select gs::date as fecha
    from limites l, generate_series(l.inicio, l.fin, interval '1 day') gs
  ), activos as (
    select s.id, s.nombre::text, s.username::text, s.puesto::text
    from public.staff s
    where s.activo = true and private.auth_is_admin()
  ), programacion as (
    select distinct a.id as staff_id, d.fecha
    from activos a
    cross join dias d
    join public.staff_turnos st
      on st.staff_id = a.id
     and st.dia_semana = extract(dow from d.fecha)::smallint
     and (st.fecha_desde is null or st.fecha_desde <= d.fecha)
     and (st.fecha_hasta is null or st.fecha_hasta >= d.fecha)
  ), resumen_prog as (
    select p.staff_id,
      count(*)::int as programados_mes,
      count(*) filter (where p.fecha <= l.hasta_hoy)::int as programados_hasta_hoy
    from programacion p cross join limites l
    group by p.staff_id
  ), resumen_asistencia as (
    select a.staff_id,
      count(*) filter (where a.entrada is not null)::int as con_entrada,
      count(*) filter (where a.estado = 'tarde')::int as tardanzas,
      coalesce(sum(a.minutos_tarde),0)::int as minutos_tarde,
      count(*) filter (where a.estado = 'justificado')::int as justificados,
      round(coalesce(sum(
        case when a.entrada is not null and a.salida is not null
          then extract(epoch from (a.salida - a.entrada)) / 3600.0
          else 0 end
      ),0)::numeric, 2) as horas
    from public.asistencias a, limites l
    where a.fecha between l.inicio and l.fin
    group by a.staff_id
  ), ausencias_calc as (
    select p.staff_id,
      count(*) filter (
        where p.fecha <= l.hasta_hoy
          and not exists (
            select 1 from public.asistencias asi
            where asi.staff_id = p.staff_id and asi.fecha = p.fecha
              and (asi.entrada is not null or asi.estado = 'justificado')
          )
      )::int as ausencias
    from programacion p cross join limites l
    group by p.staff_id
  )
  select
    s.id,
    s.nombre,
    s.username,
    s.puesto,
    coalesce(rp.programados_mes,0),
    coalesce(rp.programados_hasta_hoy,0),
    coalesce(ra.con_entrada,0),
    coalesce(ra.tardanzas,0),
    coalesce(ra.minutos_tarde,0),
    coalesce(ac.ausencias,0),
    coalesce(ra.justificados,0),
    coalesce(ra.horas,0)
  from activos s
  left join resumen_prog rp on rp.staff_id = s.id
  left join resumen_asistencia ra on ra.staff_id = s.id
  left join ausencias_calc ac on ac.staff_id = s.id
  order by s.nombre;
$$;

revoke all on function public.asistencia_mensual_admin(date) from public, anon;
grant execute on function public.asistencia_mensual_admin(date) to authenticated;
