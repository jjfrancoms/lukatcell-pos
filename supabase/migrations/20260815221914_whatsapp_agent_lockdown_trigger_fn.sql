-- ============================================================================
-- Reconstruida desde el historial de migraciones de producción
-- (supabase_migrations.schema_migrations, versión 20260815221914).
--
-- Esta migración se aplicó en su momento sin dejar archivo en el repositorio.
-- El SQL de abajo es EXACTAMENTE el que quedó registrado en producción; no se
-- reejecutó nada al recuperarlo. Ver docs/POS_INTEGRITY_HARDENING.md (P0.2
-- bloque 11) para el mapeo completo.
-- ============================================================================

-- notificar_cambio_estado() es una función de trigger (returns trigger), no un RPC público.
-- El linter de seguridad la marca como ejecutable por anon/authenticated vía PostgREST;
-- se revoca explícitamente (no afecta su uso como trigger, que se invoca por el motor, no por rol).
revoke execute on function notificar_cambio_estado() from public, anon, authenticated;;
