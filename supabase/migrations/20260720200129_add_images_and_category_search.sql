-- ============================================================================
-- Reconstruida desde el historial de migraciones de producción
-- (supabase_migrations.schema_migrations, versión 20260720200129).
--
-- Esta migración se aplicó en su momento sin dejar archivo en el repositorio.
-- El SQL de abajo es EXACTAMENTE el que quedó registrado en producción; no se
-- reejecutó nada al recuperarlo. Ver docs/POS_INTEGRITY_HARDENING.md (P0.2
-- bloque 11) para el mapeo completo.
-- ============================================================================


alter table products add column if not exists imagen_url text;

update products set imagen_url = 'https://images.unsplash.com/photo-1601784551446-20c9e07cdbdb?w=200&h=200&fit=crop' where sku = 'FUN-001';
update products set imagen_url = 'https://images.unsplash.com/photo-1589578228447-e1a4e481c6c8?w=200&h=200&fit=crop' where sku = 'CAB-001';
update products set imagen_url = 'https://images.unsplash.com/photo-1590658268037-6bf12f032f55?w=200&h=200&fit=crop' where sku = 'AUD-001';
update products set imagen_url = 'https://images.unsplash.com/photo-1583863788434-e58a36330cf0?w=200&h=200&fit=crop' where sku = 'CAR-001';
update products set imagen_url = 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=200&h=200&fit=crop' where sku = 'MIC-001';
update products set imagen_url = 'https://images.unsplash.com/photo-1587829741301-dc798b83add3?w=200&h=200&fit=crop' where sku = 'TEC-001';
update products set imagen_url = 'https://images.unsplash.com/photo-1618384887929-16ec33fab9ef?w=200&h=200&fit=crop' where sku = 'TEC-002';
update products set imagen_url = 'https://images.unsplash.com/photo-1612815154858-60aa4c59eaa6?w=200&h=200&fit=crop' where sku = 'IMP-001';
update products set imagen_url = 'https://images.unsplash.com/photo-1612815154858-60aa4c59eaa6?w=200&h=200&fit=crop' where sku = 'IMP-002';
update products set imagen_url = 'https://images.unsplash.com/photo-1586953208270-767889fa9b0e?w=200&h=200&fit=crop' where sku = 'IMP-003';
update products set imagen_url = 'https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=200&h=200&fit=crop' where sku like 'SRV-%';
update products set imagen_url = 'https://images.unsplash.com/photo-1527864550417-7fd91fc51a46?w=200&h=200&fit=crop' where sku = 'PC-001';
update products set imagen_url = 'https://images.unsplash.com/photo-1563297007-0686b7003af7?w=200&h=200&fit=crop' where sku = 'PC-002';
update products set imagen_url = 'https://images.unsplash.com/photo-1625723044792-44de16ccb4e9?w=200&h=200&fit=crop' where sku = 'PC-003';

-- Recrear función de búsqueda con imagen
drop function if exists buscar_variantes(text);
create function buscar_variantes(texto text)
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
  where p.activo = true and (
    pv.codigo_barras = texto or p.nombre ilike '%'||texto||'%'
    or p.sku ilike '%'||texto||'%' or m.modelo ilike '%'||texto||'%'
    or m.marca ilike '%'||texto||'%' or pv.color ilike '%'||texto||'%'
  ) limit 20;
$$;

-- Función para variantes por categoría
create function variantes_por_categoria(cat_id uuid)
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
  where p.activo = true and p.categoria_id = cat_id
  limit 30;
$$;
;
