-- ============================================================================
-- Reconstruida desde el historial de migraciones de producción
-- (supabase_migrations.schema_migrations, versión 20260720195356).
--
-- Esta migración se aplicó en su momento sin dejar archivo en el repositorio.
-- El SQL de abajo es EXACTAMENTE el que quedó registrado en producción; no se
-- reejecutó nada al recuperarlo. Ver docs/POS_INTEGRITY_HARDENING.md (P0.2
-- bloque 11) para el mapeo completo.
-- ============================================================================


create or replace function buscar_variantes(texto text)
returns table (
  id uuid,
  product_id uuid,
  color varchar,
  modelo_celular_id uuid,
  precio_override numeric,
  codigo_barras varchar,
  producto_nombre varchar,
  producto_sku varchar,
  producto_precio numeric,
  modelo_marca varchar,
  modelo_modelo varchar
)
language sql
security definer
stable
as $$
  select
    pv.id,
    pv.product_id,
    pv.color,
    pv.modelo_celular_id,
    pv.precio_override,
    pv.codigo_barras,
    p.nombre as producto_nombre,
    p.sku as producto_sku,
    p.precio_base as producto_precio,
    m.marca as modelo_marca,
    m.modelo as modelo_modelo
  from product_variants pv
  join products p on p.id = pv.product_id
  left join modelos_celular m on m.id = pv.modelo_celular_id
  where p.activo = true
    and (
      pv.codigo_barras = texto
      or p.nombre ilike '%' || texto || '%'
      or p.sku ilike '%' || texto || '%'
      or m.modelo ilike '%' || texto || '%'
      or m.marca ilike '%' || texto || '%'
      or pv.color ilike '%' || texto || '%'
    )
  limit 20;
$$;
;
