-- ============================================================================
-- Reconstruida desde el historial de migraciones de producción
-- (supabase_migrations.schema_migrations, versión 20260721134725).
--
-- Esta migración se aplicó en su momento sin dejar archivo en el repositorio.
-- El SQL de abajo es EXACTAMENTE el que quedó registrado en producción; no se
-- reejecutó nada al recuperarlo. Ver docs/POS_INTEGRITY_HARDENING.md (P0.2
-- bloque 11) para el mapeo completo.
-- ============================================================================


-- FASE 2b: Campo de costo para margen de ganancia
alter table products add column if not exists costo numeric(10,2) default 0;

update products set costo = precio_base * 0.55 where sku like 'FUN-%';
update products set costo = precio_base * 0.50 where sku like 'CAB-%';
update products set costo = precio_base * 0.45 where sku like 'AUD-%';
update products set costo = precio_base * 0.40 where sku like 'CAR-%';
update products set costo = precio_base * 0.50 where sku like 'MIC-%';
update products set costo = precio_base * 0.55 where sku like 'TEC-%';
update products set costo = precio_base * 0.50 where sku like 'IMP-%';
update products set costo = precio_base * 0.10 where sku like 'SRV-%';
update products set costo = precio_base * 0.50 where sku like 'PC-%';

-- FASE 3b: Clientes frecuentes
create table if not exists clientes (
  id uuid primary key default uuid_generate_v4(),
  nombre varchar not null,
  telefono varchar,
  email varchar,
  notas text,
  created_at timestamptz default now()
);

alter table sales add column if not exists cliente_id uuid references clientes(id);

create policy anon_clientes_all on clientes for all using (true) with check (true);
alter table clientes enable row level security;

-- FASE 2a: Órdenes de servicio
create table if not exists ordenes_servicio (
  id uuid primary key default uuid_generate_v4(),
  numero serial,
  cliente_id uuid references clientes(id),
  cliente_nombre varchar not null,
  cliente_telefono varchar,
  equipo_marca varchar,
  equipo_modelo varchar,
  problema text not null,
  diagnostico text,
  estado varchar not null default 'recibido',
  costo_estimado numeric(10,2) default 0,
  costo_final numeric(10,2),
  fecha_recepcion timestamptz default now(),
  fecha_entrega timestamptz,
  notas text,
  location_id uuid references locations(id)
);

create policy anon_ordenes_all on ordenes_servicio for all using (true) with check (true);
alter table ordenes_servicio enable row level security;

-- Función para dashboard de ganancias
create or replace function resumen_ganancias(fecha_desde timestamptz, fecha_hasta timestamptz)
returns table (
  total_ventas numeric,
  total_costo numeric,
  total_ganancia numeric,
  margen_promedio numeric,
  num_ventas bigint
)
language sql security definer stable
as $$
  select
    coalesce(sum(si.subtotal), 0) as total_ventas,
    coalesce(sum(p.costo * si.cantidad), 0) as total_costo,
    coalesce(sum(si.subtotal) - sum(p.costo * si.cantidad), 0) as total_ganancia,
    case when sum(si.subtotal) > 0
      then round(((sum(si.subtotal) - sum(p.costo * si.cantidad)) / sum(si.subtotal)) * 100, 1)
      else 0
    end as margen_promedio,
    count(distinct s.id) as num_ventas
  from sale_items si
  join sales s on s.id = si.sale_id
  join product_variants pv on pv.id = si.variant_id
  join products p on p.id = pv.product_id
  where s.estado = 'completada'
    and s.fecha >= fecha_desde and s.fecha < fecha_hasta;
$$;

-- Top productos por ganancia
create or replace function top_productos_ganancia(fecha_desde timestamptz, fecha_hasta timestamptz, lim integer default 10)
returns table (
  producto_nombre varchar,
  producto_sku varchar,
  unidades_vendidas bigint,
  ingreso numeric,
  costo_total numeric,
  ganancia numeric,
  margen numeric
)
language sql security definer stable
as $$
  select
    p.nombre, p.sku,
    sum(si.cantidad)::bigint as unidades_vendidas,
    sum(si.subtotal) as ingreso,
    sum(p.costo * si.cantidad) as costo_total,
    sum(si.subtotal) - sum(p.costo * si.cantidad) as ganancia,
    case when sum(si.subtotal) > 0
      then round(((sum(si.subtotal) - sum(p.costo * si.cantidad)) / sum(si.subtotal)) * 100, 1)
      else 0
    end as margen
  from sale_items si
  join sales s on s.id = si.sale_id
  join product_variants pv on pv.id = si.variant_id
  join products p on p.id = pv.product_id
  where s.estado = 'completada'
    and s.fecha >= fecha_desde and s.fecha < fecha_hasta
  group by p.id, p.nombre, p.sku
  order by ganancia desc
  limit lim;
$$;

-- Permitir update en sales para vincular cliente
create policy anon_sales_update on sales for update using (true);
;
