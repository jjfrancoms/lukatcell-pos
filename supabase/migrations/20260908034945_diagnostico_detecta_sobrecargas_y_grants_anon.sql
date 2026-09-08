-- ============================================================================
-- P0.2: el diagnóstico de solo lectura ahora también vigila las dos clases de
-- error que este mismo pase cometió y que ningún test detectó:
--   - sobrecargas ambiguas de RPC (agregar un parámetro con CREATE OR REPLACE
--     crea una función nueva en vez de reemplazar, y PostgREST puede resolver
--     a la vieja),
--   - funciones SECURITY DEFINER ejecutables por anon (toda función nueva
--     nace con EXECUTE para PUBLIC).
-- ============================================================================
create or replace function public.diagnostico_integridad_admin()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_staff public.staff;
  v_result jsonb;
begin
  select * into v_staff from public.staff where user_id = auth.uid() and activo = true limit 1;
  if v_staff.id is null or v_staff.rol <> 'administrador' then
    raise exception 'Solo administración';
  end if;

  v_result := jsonb_build_object(
    'consumir_autorizacion_descuento_revocada', not exists(
      select 1 from information_schema.role_routine_grants
      where routine_name = 'consumir_autorizacion_descuento' and grantee in ('authenticated', 'anon') and privilege_type = 'EXECUTE'
    ),
    'registrar_uso_cupon_revocada', not exists(
      select 1 from information_schema.role_routine_grants
      where routine_name = 'registrar_uso_cupon' and grantee in ('authenticated', 'anon') and privilege_type = 'EXECUTE'
    ),
    'consultar_autorizacion_descuento_otorgada', exists(
      select 1 from information_schema.role_routine_grants
      where routine_name = 'consultar_autorizacion_descuento' and grantee = 'authenticated' and privilege_type = 'EXECUTE'
    ),
    'registrar_venta_acepta_codigo_cupon', exists(
      select 1 from pg_proc where proname = 'registrar_venta' and prosrc ilike '%p_codigo_cupon%'
    ),
    'inventario_fisico_seriales_existe', exists(
      select 1 from information_schema.tables where table_name = 'inventario_fisico_seriales'
    ),
    -- Sobrecargas ambiguas: cualquier función de public/private con más de una
    -- firma. PostgREST puede resolver a la versión equivocada y ejecutar
    -- lógica vieja sin que nada falle visiblemente.
    'rpc_con_sobrecargas_ambiguas', coalesce((
      select jsonb_agg(jsonb_build_object('funcion', proname, 'firmas', n))
      from (
        select p.proname, count(*) n
        from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname in ('public', 'private')
        group by p.proname having count(*) > 1
      ) q
    ), '[]'::jsonb),
    -- SECURITY DEFINER invocable sin autenticar.
    'security_definer_ejecutables_por_anon', coalesce((
      select jsonb_agg(distinct p.proname)
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public' and p.prosecdef
        and has_function_privilege('anon', p.oid, 'EXECUTE')
    ), '[]'::jsonb),
    'conteos_fisicos_abiertos_hace_mas_de_2_dias', (
      select coalesce(jsonb_agg(jsonb_build_object('id', id, 'location_id', location_id, 'fecha_inicio', fecha_inicio)), '[]'::jsonb)
      from public.inventarios_fisicos where estado = 'abierto' and fecha_inicio < now() - interval '2 days'
    ),
    'cash_sessions_abiertas_hace_mas_de_2_dias', (
      select coalesce(jsonb_agg(jsonb_build_object('id', id, 'location_id', location_id, 'apertura', apertura)), '[]'::jsonb)
      from public.cash_sessions where cierre is null and apertura < now() - interval '2 days'
    ),
    'productos_qa_activos_en_produccion', (
      select coalesce(jsonb_agg(jsonb_build_object('id', id, 'nombre', nombre)), '[]'::jsonb)
      from public.products where nombre ilike 'QA-INTEGRITY%' and activo = true
    ),
    'ventas_marcadas_como_prueba', (select count(*)::int from public.sales where is_test)
  );

  return v_result;
end$function$;

revoke all on function public.diagnostico_integridad_admin() from public, anon;
grant execute on function public.diagnostico_integridad_admin() to authenticated;
