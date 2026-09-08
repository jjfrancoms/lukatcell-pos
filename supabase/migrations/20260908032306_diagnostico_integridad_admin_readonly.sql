-- ============================================================================
-- P0.2 bloque 7 (apoyo): diagnóstico de solo lectura para verificar el
-- estado de integridad en producción SIN escribir nada — la contraparte
-- segura de scripts/verify-integrity-invariants.mjs, que sí escribe y por
-- eso ahora está bloqueado contra producción por defecto.
--
-- Nota de diseño: un script Node con solo la anon key NO puede consultar
-- information_schema/pg_catalog (PostgREST solo expone el esquema `public`),
-- así que la introspección tiene que vivir en una RPC SECURITY DEFINER que
-- corre del lado del servidor y devuelve el reporte ya armado. Es STABLE y
-- no escribe absolutamente nada.
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
    )
  );

  return v_result;
end$function$;

grant execute on function public.diagnostico_integridad_admin() to authenticated;
