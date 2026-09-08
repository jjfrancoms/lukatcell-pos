-- ============================================================================
-- Reconstruida desde el historial de migraciones de producción
-- (supabase_migrations.schema_migrations, versión 20260716035046).
--
-- Esta migración se aplicó en su momento sin dejar archivo en el repositorio.
-- El SQL de abajo es EXACTAMENTE el que quedó registrado en producción; no se
-- reejecutó nada al recuperarlo. Ver docs/POS_INTEGRITY_HARDENING.md (P0.2
-- bloque 11) para el mapeo completo.
-- ============================================================================


-- Extensiones
create extension if not exists "uuid-ossp";

-- Ubicaciones (tiendas/sucursales)
create table locations (
  id uuid primary key default uuid_generate_v4(),
  nombre varchar not null,
  direccion varchar,
  activo boolean default true,
  created_at timestamptz default now()
);

-- Staff (cajeros/administradores), ligado a auth.users
create table staff (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) unique,
  nombre varchar not null,
  rol varchar not null default 'cajero', -- cajero, administrador
  location_id uuid references locations(id),
  activo boolean default true,
  created_at timestamptz default now()
);

-- Categorías
create table categorias (
  id uuid primary key default uuid_generate_v4(),
  nombre varchar not null unique
);

-- Modelos de celular compatibles (para variantes de accesorios)
create table modelos_celular (
  id uuid primary key default uuid_generate_v4(),
  marca varchar not null,      -- Samsung, Apple, Xiaomi, etc.
  modelo varchar not null,     -- iPhone 13, Galaxy A54, etc.
  unique (marca, modelo)
);

-- Productos base
create table products (
  id uuid primary key default uuid_generate_v4(),
  sku varchar unique,
  nombre varchar not null,
  categoria_id uuid references categorias(id),
  precio_base numeric(10,2) not null default 0,
  activo boolean default true,
  created_at timestamptz default now()
);

-- Variantes: color y/o modelo compatible
create table product_variants (
  id uuid primary key default uuid_generate_v4(),
  product_id uuid references products(id) on delete cascade,
  color varchar,
  modelo_celular_id uuid references modelos_celular(id),
  precio_override numeric(10,2),
  codigo_barras varchar unique,
  created_at timestamptz default now()
);

-- Inventario por ubicación
create table inventory (
  variant_id uuid references product_variants(id) on delete cascade,
  location_id uuid references locations(id) on delete cascade,
  cantidad integer not null default 0,
  stock_minimo integer not null default 3,
  updated_at timestamptz default now(),
  primary key (variant_id, location_id)
);

-- Sesiones de caja
create table cash_sessions (
  id uuid primary key default uuid_generate_v4(),
  cajero_id uuid references staff(id),
  location_id uuid references locations(id),
  apertura timestamptz default now(),
  cierre timestamptz,
  monto_inicial numeric(10,2) not null default 0,
  monto_final_esperado numeric(10,2),
  monto_final_contado numeric(10,2),
  diferencia numeric(10,2)
);

-- Ventas
create table sales (
  id uuid primary key default uuid_generate_v4(),
  location_id uuid references locations(id),
  cajero_id uuid references staff(id),
  cash_session_id uuid references cash_sessions(id),
  fecha timestamptz default now(),
  subtotal numeric(10,2) not null default 0,
  impuesto numeric(10,2) not null default 0,
  total numeric(10,2) not null default 0,
  estado varchar not null default 'completada', -- completada, anulada, revision_requerida
  cliente_doc varchar
);

-- Detalle de venta
create table sale_items (
  id uuid primary key default uuid_generate_v4(),
  sale_id uuid references sales(id) on delete cascade,
  variant_id uuid references product_variants(id),
  cantidad integer not null,
  precio_unitario numeric(10,2) not null,
  subtotal numeric(10,2) not null
);

-- Pagos (puede haber varios métodos en una venta)
create table payments (
  id uuid primary key default uuid_generate_v4(),
  sale_id uuid references sales(id) on delete cascade,
  metodo varchar not null, -- efectivo, tarjeta, yape, plin
  monto numeric(10,2) not null,
  referencia varchar
);

-- Movimientos manuales de inventario (ajustes, mermas, devoluciones)
create table inventory_movements (
  id uuid primary key default uuid_generate_v4(),
  variant_id uuid references product_variants(id),
  location_id uuid references locations(id),
  cantidad_delta integer not null, -- positivo o negativo
  motivo varchar not null,
  staff_id uuid references staff(id),
  created_at timestamptz default now()
);

-- Índices
create index idx_variants_product on product_variants(product_id);
create index idx_inventory_location on inventory(location_id);
create index idx_sales_location_fecha on sales(location_id, fecha);
create index idx_sale_items_sale on sale_items(sale_id);
;
