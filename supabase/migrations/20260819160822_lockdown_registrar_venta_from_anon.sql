-- Bug de seguridad de la migración anterior: `revoke all ... from public` NO alcanza
-- el grant EXECUTE que Supabase otorga por defecto a anon/authenticated/service_role
-- en toda función nueva del schema public (via ALTER DEFAULT PRIVILEGES del proyecto).
-- Sin este fix, cualquiera con la anon key (sin iniciar sesión) podía llamar
-- registrar_venta y crear ventas reales / descontar stock real.
revoke execute on function registrar_venta(jsonb, jsonb, numeric, numeric, numeric, uuid, uuid, text, uuid, uuid, uuid) from anon;
revoke execute on function variantes_actualizadas_desde(timestamptz) from anon;
