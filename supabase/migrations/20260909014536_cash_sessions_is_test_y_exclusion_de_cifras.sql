-- ============================================================================
-- P0.3 bloques 3 y 4: las cajas de las corridas QA de P0.1 seguían
-- contaminando el negocio.
--
-- P0.2 marcó las 5 VENTAS de prueba (sales.is_test) pero no sus CAJAS. En
-- producción quedaron 5 cash_sessions de la cuenta QA: 4 cerradas con
-- diferencia -S/50 cada una (-S/200 en total) y 1 todavía ABIERTA, que
-- además podía bloquear el cierre diario real ("no puedes cerrar el día
-- mientras existan cajas abiertas").
--
-- private.resumen_cierre_diario ya excluía is_test para ventas y pagos, pero
-- su bloque de cajas leía cash_sessions sin distinguir, así que las cajas QA
-- seguían sumando a cajas_abiertas, cajas_cerradas y diferencia_cajas.
--
-- Se marcan por ID explícito (no se infiere "es de prueba" en runtime por
-- nombre de usuario: eso sería frágil y podría ocultar cajas reales). No se
-- borra ninguna sesión ni ningún movimiento.
-- ============================================================================

alter table public.cash_sessions add column if not exists is_test boolean not null default false;
alter table public.cash_sessions add column if not exists test_motivo text;

comment on column public.cash_sessions.is_test is
  'Caja sintética de pruebas de integridad. NO es una caja real del negocio: se excluye de cierre diario, dashboard, reportes y alertas. Solo se marca por migración administrativa explícita.';

create index if not exists cash_sessions_is_test_idx on public.cash_sessions(location_id) where is_test;

update public.cash_sessions
set is_test = true,
    test_motivo = 'Caja generada por las corridas de la suite de integración P0.1 (cuenta QA 5b7694df-...). Marcada en P0.3 bloque 3/4.'
where id in (
  'ead04cff-f9a0-48fe-86ce-01c8a9c99072',
  'a4c0d9a8-c874-4633-95dc-33c01612b6b1',
  '37425950-02be-433e-a8bb-f500a98096db',
  'd1a72aca-ae83-463a-83df-c4a094c38121',
  '17515f71-c558-4385-8849-12649fbc0fa4'
);

-- Cierre administrativo de la única caja QA que seguía abierta. No se borra:
-- se cierra dejando constancia. El trigger calcular_diferencia_caja recalcula
-- la diferencia, y audit_cash_sessions deja el rastro del UPDATE.
update public.cash_sessions
set cierre = now(),
    monto_final_contado = coalesce(monto_final_esperado, monto_inicial, 0),
    test_motivo = coalesce(test_motivo, '') || ' Cierre administrativo QA en P0.3: la caja quedó abierta tras las pruebas y podía bloquear el cierre diario real.'
where id = '17515f71-c558-4385-8849-12649fbc0fa4'
  and cierre is null;

-- ----------------------------------------------------------------------------
-- Exclusión de las cajas de prueba en todo lo que produce cifras de negocio.
-- ----------------------------------------------------------------------------
create or replace function private.resumen_cierre_diario(p_location_id uuid, p_fecha date)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
with ventas as (
 select coalesce(sum(s.total),0)::numeric total,count(*)::int cantidad
 from public.sales s where s.location_id=p_location_id and s.estado='completada' and not s.is_test and (s.fecha at time zone 'America/Lima')::date=p_fecha
), pagos as (
 select coalesce(sum(p.monto) filter(where p.metodo='efectivo'),0)::numeric efectivo,
        coalesce(sum(p.monto) filter(where p.metodo in('yape','plin')),0)::numeric digital,
        coalesce(sum(p.monto) filter(where p.metodo not in('efectivo','yape','plin')),0)::numeric otros
 from public.payments p join public.sales s on s.id=p.sale_id
 where s.location_id=p_location_id and s.estado='completada' and not s.is_test and (s.fecha at time zone 'America/Lima')::date=p_fecha
), reembolsos as (
 select coalesce(sum(d.monto),0)::numeric total from public.devoluciones d
 where d.location_id=p_location_id and d.estado='completada' and d.reembolso_estado='completado' and (d.reembolsado_at at time zone 'America/Lima')::date=p_fecha
), cajas as (
 select count(*) filter(where c.cierre is null)::int abiertas,
        count(*) filter(where c.cierre is not null)::int cerradas,
        coalesce(sum(c.diferencia) filter(where c.cierre is not null),0)::numeric diferencia
 from public.cash_sessions c where c.location_id=p_location_id and not c.is_test and (c.apertura at time zone 'America/Lima')::date=p_fecha
), ordenes as (
 select count(*) filter(where coalesce(o.estado,'') not in('entregado','cancelado'))::int abiertas from public.ordenes_servicio o where o.location_id=p_location_id
), stock as (
 select count(*) filter(where i.cantidad<=i.stock_minimo)::int critico from public.inventory i where i.location_id=p_location_id
)
select jsonb_build_object(
 'fecha',p_fecha,'location_id',p_location_id,
 'total_ventas',(select total from ventas),'cantidad_ventas',(select cantidad from ventas),
 'efectivo',(select efectivo from pagos),'digital',(select digital from pagos),'otros_pagos',(select otros from pagos),
 'total_reembolsos',(select total from reembolsos),
 'cajas_abiertas',(select abiertas from cajas),'cajas_cerradas',(select cerradas from cajas),'diferencia_cajas',(select diferencia from cajas),
 'ordenes_abiertas',(select abiertas from ordenes),'stock_critico',(select critico from stock)
); $function$;

create or replace function public.dashboard_operativo_admin()
returns jsonb
language sql
stable
set search_path to 'public', 'private'
as $function$
  with hoy as (select (now() at time zone 'America/Lima')::date fecha),
  ventas as (select coalesce(sum(s.total),0)::numeric total,count(*)::int cantidad from public.sales s,hoy h where private.auth_is_admin() and s.estado='completada' and not s.is_test and (s.fecha at time zone 'America/Lima')::date=h.fecha),
  cajas as (select count(*)::int abiertas from public.cash_sessions c where private.auth_is_admin() and c.cierre is null and not c.is_test),
  stock as (select count(*)::int criticos from public.inventory i where private.auth_is_admin() and i.cantidad<=i.stock_minimo),
  ordenes as (select count(*) filter(where coalesce(o.estado,'') not in('entregado','cancelado'))::int pendientes,count(*) filter(where o.estado='listo')::int listas from public.ordenes_servicio o where private.auth_is_admin()),
  personal as (
    select count(*)::int total,
      count(*) filter(where p.estado='descanso')::int descanso,
      count(*) filter(where p.estado='pendiente')::int pendientes,
      count(*) filter(where p.estado in('presente','tarde'))::int trabajando,
      count(*) filter(where p.estado='tarde')::int tarde,
      count(*) filter(where p.estado='salio')::int salieron,
      count(*) filter(where p.estado in('permiso','vacaciones','licencia'))::int permisos
    from public.personal_activo_hoy() p where private.auth_is_admin()
  ),
  config as (select count(*)::int incompletos from public.personal_configuracion_pendiente() where private.auth_is_admin())
  select case when not private.auth_is_admin() then null else jsonb_build_object(
    'fecha',(select fecha from hoy),'ventas_total',(select total from ventas),'ventas_cantidad',(select cantidad from ventas),
    'cajas_abiertas',(select abiertas from cajas),'stock_critico',(select criticos from stock),'ordenes_pendientes',(select pendientes from ordenes),'ordenes_listas',(select listas from ordenes),
    'personal_total',(select total from personal),'personal_descanso',(select descanso from personal),'personal_pendiente',(select pendientes from personal),'personal_trabajando',(select trabajando from personal),'personal_tarde',(select tarde from personal),'personal_salieron',(select salieron from personal),'personal_permisos',(select permisos from personal),
    'config_incompleta',(select incompletos from config)) end;
$function$;

-- Alertas: una caja de prueba no debe generar una notificación de
-- "diferencia de caja" para el dueño.
create or replace function public.generar_alertas_operativas_admin()
returns integer
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare n integer:=0; x integer;
begin
 if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
 insert into public.notificaciones(location_id,tipo,titulo,mensaje,prioridad,recurso_tipo,recurso_id,event_key)
 select i.location_id,'stock_critico','Stock crítico',p.nombre||coalesce(' · '||pv.color,'')||': '||i.cantidad||' unidad(es), mínimo '||i.stock_minimo,
        case when i.cantidad<=0 then 'critica' else 'alta' end,'variant',i.variant_id,
        'stock:'||i.location_id||':'||i.variant_id||':'||current_date
 from public.inventory i join public.product_variants pv on pv.id=i.variant_id join public.products p on p.id=pv.product_id
 where i.cantidad<=i.stock_minimo
 on conflict(event_key) do nothing; get diagnostics x=row_count; n:=n+x;

 insert into public.notificaciones(staff_id,location_id,tipo,titulo,mensaje,prioridad,recurso_tipo,recurso_id,event_key)
 select a.staff_id,s.location_id,'tardanza','Tardanza registrada',s.nombre||' registró '||coalesce(a.minutos_tarde,0)||' min de tardanza','alta','asistencia',a.id,'tarde:'||a.id
 from public.asistencias a join public.staff s on s.id=a.staff_id
 where a.fecha>=current_date-7 and coalesce(a.minutos_tarde,0)>0
 on conflict(event_key) do nothing; get diagnostics x=row_count; n:=n+x;

 insert into public.notificaciones(staff_id,location_id,tipo,titulo,mensaje,prioridad,recurso_tipo,recurso_id,event_key)
 select a.staff_id,s.location_id,'jornada_incompleta','Jornada sin salida',s.nombre||' tiene una entrada sin salida del '||a.fecha,'alta','asistencia',a.id,'sin-salida:'||a.id
 from public.asistencias a join public.staff s on s.id=a.staff_id
 where a.entrada is not null and a.salida is null and a.fecha<current_date
 on conflict(event_key) do nothing; get diagnostics x=row_count; n:=n+x;

 insert into public.notificaciones(location_id,tipo,titulo,mensaje,prioridad,recurso_tipo,recurso_id,event_key)
 select cs.location_id,'diferencia_caja','Diferencia de caja','Caja con diferencia de S/ '||coalesce(cs.diferencia,0)::text,
        case when abs(coalesce(cs.diferencia,0))>=coalesce((select diferencia_caja_critica from public.configuracion where id=1),20) then 'critica' else 'alta' end,
        'cash_session',cs.id,'caja-dif:'||cs.id
 from public.cash_sessions cs where cs.cierre is not null and not cs.is_test and abs(coalesce(cs.diferencia,0))>0 and cs.cierre>=now()-interval '30 days'
 on conflict(event_key) do nothing; get diagnostics x=row_count; n:=n+x;

 insert into public.notificaciones(staff_id,location_id,tipo,titulo,mensaje,prioridad,recurso_tipo,recurso_id,event_key)
 select pp.staff_id,s.location_id,'permiso_personal','Permiso / licencia registrado',s.nombre||': '||pp.tipo||' del '||pp.fecha_desde||' al '||pp.fecha_hasta,'media','personal_permiso',pp.id,'permiso:'||pp.id
 from public.personal_permisos pp join public.staff s on s.id=pp.staff_id
 where pp.activo and pp.created_at>=now()-interval '30 days'
 on conflict(event_key) do nothing; get diagnostics x=row_count; n:=n+x;
 return n;
end$function$;
