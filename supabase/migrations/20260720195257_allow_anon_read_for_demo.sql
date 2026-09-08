-- ============================================================================
-- Reconstruida desde el historial de migraciones de producción
-- (supabase_migrations.schema_migrations, versión 20260720195257).
--
-- Esta migración se aplicó en su momento sin dejar archivo en el repositorio.
-- El SQL de abajo es EXACTAMENTE el que quedó registrado en producción; no se
-- reejecutó nada al recuperarlo. Ver docs/POS_INTEGRITY_HARDENING.md (P0.2
-- bloque 11) para el mapeo completo.
-- ============================================================================


-- Permitir lectura anónima para demo (catálogo, inventario, ventas, caja)
create policy anon_products on products for select using (true);
create policy anon_variants on product_variants for select using (true);
create policy anon_modelos on modelos_celular for select using (true);
create policy anon_categorias on categorias for select using (true);
create policy anon_inventory on inventory for select using (true);
create policy anon_locations on locations for select using (true);

-- Permitir inserción anónima para demo (ventas, pagos, caja)
create policy anon_sales_insert on sales for insert with check (true);
create policy anon_sales_read on sales for select using (true);
create policy anon_sale_items_insert on sale_items for insert with check (true);
create policy anon_sale_items_read on sale_items for select using (true);
create policy anon_payments_insert on payments for insert with check (true);
create policy anon_payments_read on payments for select using (true);
create policy anon_cash_insert on cash_sessions for insert with check (true);
create policy anon_cash_read on cash_sessions for select using (true);
create policy anon_cash_update on cash_sessions for update using (true);
;
