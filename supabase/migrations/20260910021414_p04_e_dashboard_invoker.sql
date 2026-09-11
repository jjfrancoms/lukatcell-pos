-- ============================================================================
-- P0.4 / R6 — REGRESIÓN INTRODUCIDA POR LA MIGRACIÓN A. Corrección urgente.
--
-- La migración A añadió a dashboard_operativo_admin dos joins (product_variants
-- y products) para poder filtrar `not p.is_test`. Pero esa función, a
-- diferencia de las otras cuatro que se tocaron, NO es SECURITY DEFINER: se
-- ejecuta como el invocador. Y `authenticated` no tiene SELECT sobre
-- public.products (se lo quitaron las migraciones de privacidad de `costo`):
-- sólo tiene privilegio sobre la columna `id`, no sobre `is_test`.
--
-- Resultado en producción: el dashboard administrativo devolvía
--     ERROR 42501: permission denied for table products
-- para TODOS los usuarios reales. Roto por completo.
--
-- Por qué no lo detectó el ensayo previo: se ejecutó dentro de una transacción
-- abortada con el rol `postgres`, que es dueño de todo y no pasa por los
-- privilegios de tabla ni por RLS. El número salía 0 —el valor correcto— y
-- parecía sano. La comprobación sólo es válida si se hace con
--     set local role authenticated
-- y un `request.jwt.claims` real.
--
-- Corrección: NO se concede `select (is_test)` a authenticated. Un grant nuevo
-- resolvería el error de privilegio pero dejaría el join expuesto a las
-- policies RLS de products; si alguna filtrara filas, el join las descartaría
-- en silencio y el KPI quedaría subcontado sin error visible — exactamente la
-- clase de fallo de R1. En vez de eso, el conjunto de variantes de prueba se
-- calcula en un helper SECURITY DEFINER, y la consulta del dashboard vuelve a
-- leer sólo public.inventory, preservando intacta la semántica RLS que tenía
-- antes de P0.4.
--
-- Verificado con `set local role authenticated`: el dashboard responde,
-- stock_critico = 0, y el contraste sin filtro da 8, lo que prueba que el
-- filtro sigue aplicándose de verdad y no está devolviendo 0 por estar roto.
-- ============================================================================

create or replace function private.variantes_de_prueba()
returns setof uuid
language sql
stable
security definer
set search_path to 'public', 'private'
as $$
  select pv.id from public.product_variants pv
  join public.products p on p.id = pv.product_id
  where p.is_test;
$$;

comment on function private.variantes_de_prueba() is
  'Variantes pertenecientes a productos de prueba. SECURITY DEFINER para que un consumidor que corre como invocador (dashboard_operativo_admin) pueda excluirlas sin necesitar SELECT sobre products.';

revoke all on function private.variantes_de_prueba() from public, anon;
grant execute on function private.variantes_de_prueba() to authenticated;

create or replace function public.dashboard_operativo_admin()
returns jsonb
language sql
stable
set search_path to 'public', 'private'
as $function$
  with hoy as (select (now() at time zone 'America/Lima')::date fecha),
  ventas as (select coalesce(sum(s.total),0)::numeric total,count(*)::int cantidad from public.sales s,hoy h where private.auth_is_admin() and s.estado='completada' and not s.is_test and (s.fecha at time zone 'America/Lima')::date=h.fecha),
  cajas as (select count(*)::int abiertas from public.cash_sessions c where private.auth_is_admin() and c.cierre is null and not c.is_test),
  stock as (select count(*)::int criticos from public.inventory i
            where private.auth_is_admin() and i.cantidad<=i.stock_minimo
              and i.variant_id not in (select private.variantes_de_prueba())),
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
