-- P6: soporte para sincronización incremental del catálogo (updated_at)
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

alter table products add column if not exists updated_at timestamptz not null default now();
alter table product_variants add column if not exists updated_at timestamptz not null default now();

drop trigger if exists trg_products_updated_at on products;
create trigger trg_products_updated_at before update on products
  for each row execute function set_updated_at();

drop trigger if exists trg_variants_updated_at on product_variants;
create trigger trg_variants_updated_at before update on product_variants
  for each row execute function set_updated_at();

create index if not exists idx_products_updated_at on products(updated_at);
create index if not exists idx_variants_updated_at on product_variants(updated_at);

-- buscar_variantes cambia de forma (agrega updated_at) -> hay que dropearla primero
drop function if exists buscar_variantes(text);

create function buscar_variantes(texto text)
returns table(id uuid, product_id uuid, color character varying, modelo_celular_id uuid, precio_override numeric, codigo_barras character varying, producto_nombre character varying, producto_sku character varying, producto_precio numeric, producto_imagen text, modelo_marca character varying, modelo_modelo character varying, updated_at timestamptz)
language sql stable security definer
as $$
  select pv.id, pv.product_id, pv.color, pv.modelo_celular_id,
    pv.precio_override, pv.codigo_barras,
    p.nombre, p.sku, p.precio_base, p.imagen_url,
    m.marca, m.modelo,
    greatest(p.updated_at, pv.updated_at) as updated_at
  from product_variants pv
  join products p on p.id = pv.product_id
  left join modelos_celular m on m.id = pv.modelo_celular_id
  where p.activo = true and (
    pv.codigo_barras = texto or p.nombre ilike '%'||texto||'%'
    or p.sku ilike '%'||texto||'%' or m.modelo ilike '%'||texto||'%'
    or m.marca ilike '%'||texto||'%' or pv.color ilike '%'||texto||'%'
  ) limit 20;
$$;

create or replace function variantes_actualizadas_desde(desde timestamptz)
returns table(id uuid, product_id uuid, color character varying, modelo_celular_id uuid, precio_override numeric, codigo_barras character varying, producto_nombre character varying, producto_sku character varying, producto_precio numeric, producto_imagen text, producto_activo boolean, modelo_marca character varying, modelo_modelo character varying, updated_at timestamptz)
language sql stable security definer
as $$
  select pv.id, pv.product_id, pv.color, pv.modelo_celular_id,
    pv.precio_override, pv.codigo_barras,
    p.nombre, p.sku, p.precio_base, p.imagen_url, p.activo,
    m.marca, m.modelo,
    greatest(p.updated_at, pv.updated_at) as updated_at
  from product_variants pv
  join products p on p.id = pv.product_id
  left join modelos_celular m on m.id = pv.modelo_celular_id
  where greatest(p.updated_at, pv.updated_at) > desde
  order by greatest(p.updated_at, pv.updated_at) asc
  limit 500;
$$;

revoke all on function variantes_actualizadas_desde(timestamptz) from public;
grant execute on function variantes_actualizadas_desde(timestamptz) to authenticated;
