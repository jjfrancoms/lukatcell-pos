-- ============================================================================
-- P0.2 corrección: dos regresiones que introdujeron los bloques anteriores de
-- este mismo pase y que detectó el Security Advisor + la revisión de
-- sobrecargas. Ambas son graves y ninguna la reportó un test.
--
-- 1) SOBRECARGA AMBIGUA DE registrar_venta (rompía ventas con promoción HOY).
--    El bloque 1 agregó p_codigo_cupon con CREATE OR REPLACE. En Postgres,
--    agregar un parámetro cambia la firma: no reemplaza, CREA una función
--    nueva. Quedaron dos registrar_venta (19 y 20 parámetros). El frontend
--    desplegado en producción todavía llama la de 19, que NO arma la tabla
--    temporal venta_promo_ceiling — y validar_linea_venta_catalogo (que sí
--    está actualizado, porque el trigger es compartido) al no encontrarla
--    asume techo de promoción 0 y rechaza la línea con "La promoción indicada
--    no es válida para este producto en esta venta". Es decir: cualquier
--    venta con promoción de un cajero no-admin estaba siendo rechazada en
--    vivo. Se elimina la firma vieja; al quedar una sola función con
--    p_codigo_cupon DEFAULT null, tanto el frontend viejo (19 parámetros por
--    nombre) como el nuevo (20) resuelven a la misma y correcta.
--    Es exactamente la disciplina que P0.1 ya había aplicado a otras RPC y
--    que este pase omitió.
--
-- 2) FUNCIONES NUEVAS EJECUTABLES POR anon. Toda función recién creada en
--    Postgres nace con EXECUTE para PUBLIC (que incluye anon); el
--    `grant ... to authenticated` explícito no quita ese grant implícito. Las
--    8 funciones nuevas de este pase quedaron invocables sin autenticar,
--    revirtiendo el endurecimiento que ya habían hecho
--    revoke_anon_security_definer_except_login y
--    harden_security_definer_public_grants. Todas validan auth.uid() por
--    dentro (un anon no habría logrado escribir nada), pero exponerlas es
--    superficie de ataque innecesaria y contradice la política del proyecto.
-- ============================================================================

drop function if exists public.registrar_venta(
  jsonb, jsonb, numeric, numeric, numeric, uuid, uuid, text, uuid, uuid, uuid,
  text, text, text, text, text, timestamptz, boolean, uuid
);

revoke all on function public.registrar_venta(
  jsonb, jsonb, numeric, numeric, numeric, uuid, uuid, text, uuid, uuid, uuid,
  text, text, text, text, text, timestamptz, boolean, uuid, text
) from public, anon;
grant execute on function public.registrar_venta(
  jsonb, jsonb, numeric, numeric, numeric, uuid, uuid, text, uuid, uuid, uuid,
  text, text, text, text, text, timestamptz, boolean, uuid, text
) to authenticated;

revoke all on function public.consultar_autorizacion_descuento(uuid, numeric, numeric) from public, anon;
grant execute on function public.consultar_autorizacion_descuento(uuid, numeric, numeric) to authenticated;

revoke all on function public.registrar_serial_contado(uuid, uuid, text) from public, anon;
grant execute on function public.registrar_serial_contado(uuid, uuid, text) to authenticated;

revoke all on function public.resolver_reconciliacion_serial(uuid, text) from public, anon;
grant execute on function public.resolver_reconciliacion_serial(uuid, text) to authenticated;

revoke all on function public.detalle_inventario_fisico(uuid) from public, anon;
grant execute on function public.detalle_inventario_fisico(uuid) to authenticated;

revoke all on function public.diagnostico_integridad_admin() from public, anon;
grant execute on function public.diagnostico_integridad_admin() to authenticated;

revoke all on function public.registrar_heartbeat_pos(text, integer, integer, text, text) from public, anon;
grant execute on function public.registrar_heartbeat_pos(text, integer, integer, text, text) to authenticated;

revoke all on function public.marcar_dispositivo_fuera_de_servicio(text, text) from public, anon;
grant execute on function public.marcar_dispositivo_fuera_de_servicio(text, text) to authenticated;

revoke all on function public.estado_terminales_sucursal() from public, anon;
grant execute on function public.estado_terminales_sucursal() to authenticated;

-- private.calcular_promocion_carrito no debe ser invocable desde la API en
-- absoluto: es un detalle interno que usan resolver_promociones_carrito y
-- registrar_venta.
revoke all on function private.calcular_promocion_carrito(jsonb, text) from public, anon, authenticated;
