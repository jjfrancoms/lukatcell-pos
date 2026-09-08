-- ============================================================================
-- Reconstruida desde el historial de migraciones de producción
-- (supabase_migrations.schema_migrations, versión 20260721141914).
--
-- Esta migración se aplicó en su momento sin dejar archivo en el repositorio.
-- El SQL de abajo es EXACTAMENTE el que quedó registrado en producción; no se
-- reejecutó nada al recuperarlo. Ver docs/POS_INTEGRITY_HARDENING.md (P0.2
-- bloque 11) para el mapeo completo.
-- ============================================================================

-- Reemplazo de la única política abierta en clientes y ordenes_servicio
-- por una política restringida a usuarios autenticados, antes de quitar el acceso anónimo total.
create policy clientes_autenticados_all on clientes
  for all to authenticated
  using (true) with check (true);

create policy ordenes_autenticadas_all on ordenes_servicio
  for all to authenticated
  using (true) with check (true);

-- Quitar políticas anónimas abiertas ahora que existe login real (Fase 4).
drop policy if exists anon_cash_insert on cash_sessions;
drop policy if exists anon_cash_read on cash_sessions;
drop policy if exists anon_cash_update on cash_sessions;

drop policy if exists anon_clientes_all on clientes;

drop policy if exists anon_inventory on inventory;
drop policy if exists anon_inventory_update on inventory;

drop policy if exists anon_movements_insert on inventory_movements;
drop policy if exists anon_movements_read on inventory_movements;

drop policy if exists anon_ordenes_all on ordenes_servicio;

drop policy if exists anon_payments_insert on payments;
drop policy if exists anon_payments_read on payments;

drop policy if exists anon_sales_insert on sales;
drop policy if exists anon_sales_read on sales;
drop policy if exists anon_sales_update on sales;

drop policy if exists anon_sale_items_insert on sale_items;
drop policy if exists anon_sale_items_read on sale_items;
;
