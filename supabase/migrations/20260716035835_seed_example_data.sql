-- ============================================================================
-- Reconstruida desde el historial de migraciones de producción
-- (supabase_migrations.schema_migrations, versión 20260716035835).
--
-- Esta migración se aplicó en su momento sin dejar archivo en el repositorio.
-- El SQL de abajo es EXACTAMENTE el que quedó registrado en producción; no se
-- reejecutó nada al recuperarlo. Ver docs/POS_INTEGRITY_HARDENING.md (P0.2
-- bloque 11) para el mapeo completo.
-- ============================================================================


-- Ubicación (tienda)
insert into locations (nombre, direccion) values
  ('Tienda San Juan de Lurigancho', 'Av. Jardines Este 388 - Mercado Corazón de Jesús');

-- Categorías
insert into categorias (nombre) values
  ('Fundas'), ('Cables'), ('Audífonos'), ('Cargadores'), ('Mica y protectores');

-- Modelos de celular compatibles
insert into modelos_celular (marca, modelo) values
  ('Apple', 'iPhone 13'),
  ('Apple', 'iPhone 14'),
  ('Samsung', 'Galaxy A54'),
  ('Samsung', 'Galaxy S23'),
  ('Xiaomi', 'Redmi Note 12');

-- Productos
insert into products (sku, nombre, categoria_id, precio_base)
select 'FUN-001', 'Funda de silicona', id, 15.00 from categorias where nombre = 'Fundas';
insert into products (sku, nombre, categoria_id, precio_base)
select 'CAB-001', 'Cable USB-C 1m', id, 12.00 from categorias where nombre = 'Cables';
insert into products (sku, nombre, categoria_id, precio_base)
select 'AUD-001', 'Audífonos Bluetooth TWS', id, 45.00 from categorias where nombre = 'Audífonos';
insert into products (sku, nombre, categoria_id, precio_base)
select 'CAR-001', 'Cargador rápido 20W', id, 35.00 from categorias where nombre = 'Cargadores';
insert into products (sku, nombre, categoria_id, precio_base)
select 'MIC-001', 'Mica templada 9H', id, 8.00 from categorias where nombre = 'Mica y protectores';

-- Variantes: Fundas (color + modelo compatible)
insert into product_variants (product_id, color, modelo_celular_id, codigo_barras)
select p.id, v.color, m.id, v.codigo
from products p, (values
  ('Negro', 'iPhone 13', '7750000000011'),
  ('Transparente', 'iPhone 13', '7750000000012'),
  ('Negro', 'Galaxy A54', '7750000000013'),
  ('Azul', 'Redmi Note 12', '7750000000014'),
  ('Negro', 'iPhone 14', '7750000000015')
) as v(color, modelo, codigo)
join modelos_celular m on m.modelo = v.modelo
where p.sku = 'FUN-001';

-- Variantes: Cables (solo color)
insert into product_variants (product_id, color, codigo_barras)
select p.id, v.color, v.codigo
from products p, (values
  ('Blanco', '7750000000021'),
  ('Negro', '7750000000022')
) as v(color, codigo)
where p.sku = 'CAB-001';

-- Variantes: Audífonos (solo color)
insert into product_variants (product_id, color, codigo_barras)
select p.id, v.color, v.codigo
from products p, (values
  ('Negro', '7750000000031'),
  ('Blanco', '7750000000032')
) as v(color, codigo)
where p.sku = 'AUD-001';

-- Variantes: Cargador (sin color/modelo, único)
insert into product_variants (product_id, codigo_barras)
select id, '7750000000041' from products where sku = 'CAR-001';

-- Variantes: Mica (por modelo compatible)
insert into product_variants (product_id, modelo_celular_id, codigo_barras)
select p.id, m.id, v.codigo
from products p, (values
  ('iPhone 13', '7750000000051'),
  ('Galaxy A54', '7750000000052'),
  ('Redmi Note 12', '7750000000053')
) as v(modelo, codigo)
join modelos_celular m on m.modelo = v.modelo
where p.sku = 'MIC-001';

-- Inventario inicial: 20 unidades de cada variante en la tienda
insert into inventory (variant_id, location_id, cantidad, stock_minimo)
select pv.id, l.id, 20, 5
from product_variants pv, locations l
where l.nombre = 'Tienda San Juan de Lurigancho';
;
