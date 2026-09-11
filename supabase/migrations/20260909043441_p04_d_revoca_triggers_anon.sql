-- ============================================================================
-- P0.4 / R5 — Las dos últimas funciones de trigger SECURITY DEFINER con
-- EXECUTE heredado por PUBLIC (y por tanto por anon).
--
-- Hallazgo de la verificación consolidada post-migración: el objetivo del
-- release era "anon SECURITY DEFINER = 0" y quedaba en 2. La migración C
-- revocó private.vincular_autorizacion_descuento() y
-- private.estado_dispositivos_cierre(uuid), que son exactamente de esta clase,
-- pero estas dos no estaban en la lista.
--
-- Explotabilidad real hoy: nula. `anon` no tiene USAGE sobre el esquema
-- `private`, PostgREST no lo expone, y una función que devuelve `trigger` no
-- puede invocarse directamente por SQL. Se corrige igualmente porque dejar 2
-- de 19 con el grant heredado es arbitrario, y porque el grant sobrevive a
-- cualquier futuro cambio de exposición del esquema.
--
-- Disparar un trigger NO comprueba el privilegio EXECUTE sobre su función, así
-- que revocarlo no afecta a la operación. Precedente en esta misma base: 17
-- funciones de trigger ya estaban revocadas y sus triggers siguen firmando.
-- Ambas siguen attachadas (2 triggers) tras el cambio.
-- ============================================================================

revoke all on function private.historial_orden_tecnica() from public, anon, authenticated;
revoke all on function private.recalcular_caja_tras_movimiento() from public, anon, authenticated;
