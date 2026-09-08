-- ============================================================================
-- Reconstruida desde el historial de migraciones de producción
-- (supabase_migrations.schema_migrations, versión 20260721134034).
--
-- Esta migración se aplicó en su momento sin dejar archivo en el repositorio.
-- El SQL de abajo es EXACTAMENTE el que quedó registrado en producción; no se
-- reejecutó nada al recuperarlo. Ver docs/POS_INTEGRITY_HARDENING.md (P0.2
-- bloque 11) para el mapeo completo.
-- ============================================================================


-- Función para buscar exactamente por código de barras (scanner)
create or replace function buscar_por_barcode(barcode text)
returns table (
  id uuid, product_id uuid, color varchar, modelo_celular_id uuid,
  precio_override numeric, codigo_barras varchar,
  producto_nombre varchar, producto_sku varchar, producto_precio numeric,
  producto_imagen text, modelo_marca varchar, modelo_modelo varchar
)
language sql security definer stable
as $$
  select pv.id, pv.product_id, pv.color, pv.modelo_celular_id,
    pv.precio_override, pv.codigo_barras,
    p.nombre, p.sku, p.precio_base, p.imagen_url,
    m.marca, m.modelo
  from product_variants pv
  join products p on p.id = pv.product_id
  left join modelos_celular m on m.id = pv.modelo_celular_id
  where pv.codigo_barras = barcode and p.activo = true
  limit 1;
$$;

-- Función para ajustar stock manualmente
create or replace function ajustar_stock(
  p_variant_id uuid,
  p_location_id uuid,
  p_cantidad_delta integer,
  p_motivo text,
  p_staff_id uuid default null
)
returns void
language plpgsql security definer
as $$
begin
  update inventory
    set cantidad = greatest(0, cantidad + p_cantidad_delta),
        updated_at = now()
    where variant_id = p_variant_id and location_id = p_location_id;

  insert into inventory_movements (variant_id, location_id, cantidad_delta, motivo, staff_id)
    values (p_variant_id, p_location_id, p_cantidad_delta, p_motivo, p_staff_id);
end;
$$;

-- Política para permitir llamar a la función de ajuste (demo)
create policy anon_movements_insert on inventory_movements for insert with check (true);
create policy anon_movements_read on inventory_movements for select using (true);
create policy anon_inventory_update on inventory for update using (true);
;
