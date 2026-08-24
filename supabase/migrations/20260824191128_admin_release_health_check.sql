create or replace function public.release_health_admin()
returns table(
  public_tables bigint,
  tables_without_rls bigint,
  anon_tables bigint,
  anon_secdef bigint,
  whatsapp_pendientes bigint,
  whatsapp_fallidos bigint,
  notificaciones_no_leidas bigint,
  solicitudes_personal_pendientes bigint,
  conciliaciones_pendientes bigint,
  healthy boolean
)
language sql
stable
security definer
set search_path='public','private'
as $$
  select
    (select count(*) from information_schema.tables t where t.table_schema='public' and t.table_type='BASE TABLE'),
    (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity),
    (select count(distinct table_name) from information_schema.table_privileges where grantee='anon' and table_schema='public'),
    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE')),
    (select count(*) from public.whatsapp_envios where estado='pendiente'),
    (select count(*) from public.whatsapp_envios where estado='fallido'),
    (select count(*) from public.notificaciones where leida_at is null),
    (select count(*) from public.personal_solicitudes where estado='pendiente'),
    (select count(*) from public.conciliaciones_pago where estado='pendiente'),
    (
      private.auth_is_admin()
      and (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity)=0
      and (select count(distinct table_name) from information_schema.table_privileges where grantee='anon' and table_schema='public')=0
      and (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE'))=0
    )
  where private.auth_is_admin();
$$;
revoke execute on function public.release_health_admin() from public,anon;
grant execute on function public.release_health_admin() to authenticated;
