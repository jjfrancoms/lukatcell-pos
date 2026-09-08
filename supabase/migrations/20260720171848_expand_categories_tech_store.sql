-- ============================================================================
-- Reconstruida desde el historial de migraciones de producción
-- (supabase_migrations.schema_migrations, versión 20260720171848).
--
-- Esta migración se aplicó en su momento sin dejar archivo en el repositorio.
-- El SQL de abajo es EXACTAMENTE el que quedó registrado en producción; no se
-- reejecutó nada al recuperarlo. Ver docs/POS_INTEGRITY_HARDENING.md (P0.2
-- bloque 11) para el mapeo completo.
-- ============================================================================


-- Nuevas categorías para tienda de tecnología general
insert into categorias (nombre) values
  ('Teclados'),
  ('Insumos de impresora'),
  ('Reparación técnica'),
  ('Accesorios de PC');

-- Productos: Teclados
insert into products (sku, nombre, categoria_id, precio_base)
select 'TEC-001', 'Teclado membrana USB', id, 45.00 from categorias where nombre = 'Teclados';
insert into products (sku, nombre, categoria_id, precio_base)
select 'TEC-002', 'Teclado mecánico gamer RGB', id, 120.00 from categorias where nombre = 'Teclados';

-- Productos: Insumos de impresora
insert into products (sku, nombre, categoria_id, precio_base)
select 'IMP-001', 'Cartucho de tinta negro genérico', id, 25.00 from categorias where nombre = 'Insumos de impresora';
insert into products (sku, nombre, categoria_id, precio_base)
select 'IMP-002', 'Toner láser genérico', id, 60.00 from categorias where nombre = 'Insumos de impresora';
insert into products (sku, nombre, categoria_id, precio_base)
select 'IMP-003', 'Resma de papel bond A4', id, 14.00 from categorias where nombre = 'Insumos de impresora';

-- Productos: Reparación técnica (servicios, sin variantes de color/modelo)
insert into products (sku, nombre, categoria_id, precio_base)
select 'SRV-001', 'Cambio de pantalla (mano de obra)', id, 50.00 from categorias where nombre = 'Reparación técnica';
insert into products (sku, nombre, categoria_id, precio_base)
select 'SRV-002', 'Cambio de batería (mano de obra)', id, 35.00 from categorias where nombre = 'Reparación técnica';
insert into products (sku, nombre, categoria_id, precio_base)
select 'SRV-003', 'Diagnóstico técnico', id, 15.00 from categorias where nombre = 'Reparación técnica';
insert into products (sku, nombre, categoria_id, precio_base)
select 'SRV-004', 'Liberación / desbloqueo de equipo', id, 40.00 from categorias where nombre = 'Reparación técnica';

-- Productos: Accesorios de PC
insert into products (sku, nombre, categoria_id, precio_base)
select 'PC-001', 'Mouse óptico USB', id, 18.00 from categorias where nombre = 'Accesorios de PC';
insert into products (sku, nombre, categoria_id, precio_base)
select 'PC-002', 'Mousepad', id, 10.00 from categorias where nombre = 'Accesorios de PC';
insert into products (sku, nombre, categoria_id, precio_base)
select 'PC-003', 'Hub USB 4 puertos', id, 22.00 from categorias where nombre = 'Accesorios de PC';

-- Variantes: Teclados (por color, sin modelo de celular)
insert into product_variants (product_id, color, codigo_barras)
select p.id, v.color, v.codigo
from products p, (values ('Negro', '7750000000061')) as v(color, codigo)
where p.sku = 'TEC-001';
insert into product_variants (product_id, color, codigo_barras)
select p.id, v.color, v.codigo
from products p, (values ('Negro/RGB', '7750000000062')) as v(color, codigo)
where p.sku = 'TEC-002';

-- Variantes: Insumos de impresora (única variante cada uno)
insert into product_variants (product_id, codigo_barras)
select id, '7750000000071' from products where sku = 'IMP-001';
insert into product_variants (product_id, codigo_barras)
select id, '7750000000072' from products where sku = 'IMP-002';
insert into product_variants (product_id, codigo_barras)
select id, '7750000000073' from products where sku = 'IMP-003';

-- Variantes: Servicios de reparación (única variante, sin stock físico real)
insert into product_variants (product_id, codigo_barras)
select id, '7750000000081' from products where sku = 'SRV-001';
insert into product_variants (product_id, codigo_barras)
select id, '7750000000082' from products where sku = 'SRV-002';
insert into product_variants (product_id, codigo_barras)
select id, '7750000000083' from products where sku = 'SRV-003';
insert into product_variants (product_id, codigo_barras)
select id, '7750000000084' from products where sku = 'SRV-004';

-- Variantes: Accesorios de PC (por color)
insert into product_variants (product_id, color, codigo_barras)
select p.id, v.color, v.codigo
from products p, (values ('Negro', '7750000000091')) as v(color, codigo)
where p.sku = 'PC-001';
insert into product_variants (product_id, codigo_barras)
select id, '7750000000092' from products where sku = 'PC-002';
insert into product_variants (product_id, codigo_barras)
select id, '7750000000093' from products where sku = 'PC-003';

-- Inventario: 20 unidades para productos físicos, 999 (ilimitado simbólico) para servicios
insert into inventory (variant_id, location_id, cantidad, stock_minimo)
select pv.id, l.id,
  case when p.sku like 'SRV-%' then 999 else 20 end,
  case when p.sku like 'SRV-%' then 0 else 5 end
from product_variants pv
join products p on p.id = pv.product_id
cross join locations l
where l.nombre = 'Tienda San Juan de Lurigancho'
and pv.id not in (select variant_id from inventory);
;
