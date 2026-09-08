-- ============================================================================
-- Reconstruida desde el historial de migraciones de producción
-- (supabase_migrations.schema_migrations, versión 20260720201145).
--
-- Esta migración se aplicó en su momento sin dejar archivo en el repositorio.
-- El SQL de abajo es EXACTAMENTE el que quedó registrado en producción; no se
-- reejecutó nada al recuperarlo. Ver docs/POS_INTEGRITY_HARDENING.md (P0.2
-- bloque 11) para el mapeo completo.
-- ============================================================================


-- Favoritos en productos
alter table products add column if not exists favorito boolean default false;

-- Marcar los más vendidos como favoritos
update products set favorito = true where sku in ('FUN-001', 'MIC-001', 'CAB-001', 'AUD-001', 'CAR-001', 'SRV-001');

-- Campo de descuento en sale_items
alter table sale_items add column if not exists descuento numeric(10,2) default 0;

-- Función para obtener favoritos
create or replace function obtener_favoritos()
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
  where p.activo = true and p.favorito = true
  order by p.nombre
  limit 20;
$$;
;
