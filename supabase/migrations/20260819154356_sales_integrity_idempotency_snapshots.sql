-- P1 (integridad transaccional) + P2 (idempotencia) + P3 (snapshots de precio/costo)
-- Todo en una migración porque comparten la misma tabla `sales`/`sale_items` y la misma RPC.

-- ============================================================
-- Configuración: nuevos toggles de negocio
-- ============================================================
alter table configuracion
  add column if not exists permitir_stock_negativo boolean not null default false,
  add column if not exists auto_imprimir_ticket boolean not null default true,
  add column if not exists tamano_papel text not null default '80mm';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'configuracion_tamano_papel_check'
  ) then
    alter table configuracion
      add constraint configuracion_tamano_papel_check check (tamano_papel in ('58mm', '80mm'));
  end if;
end $$;

-- ============================================================
-- sales: idempotencia (client_transaction_id) + numeración correlativa
-- ============================================================
alter table sales
  add column if not exists client_transaction_id uuid unique;

create sequence if not exists sales_numero_seq;

alter table sales
  add column if not exists numero integer not null default nextval('sales_numero_seq');

alter sequence sales_numero_seq owned by sales.numero;

create unique index if not exists sales_numero_key on sales(numero);

-- ============================================================
-- sale_items: snapshot de nombre y costo al momento de la venta
-- ============================================================
alter table sale_items
  add column if not exists producto_nombre_snapshot text,
  add column if not exists costo_snapshot numeric(10,2);

-- backfill best-effort para las filas existentes (no hay histórico real, se usa el costo actual como aproximación)
update sale_items si
  set producto_nombre_snapshot = coalesce(si.producto_nombre_snapshot, p.nombre),
      costo_snapshot = coalesce(si.costo_snapshot, p.costo)
  from product_variants pv
  join products p on p.id = pv.product_id
  where pv.id = si.variant_id
    and (si.producto_nombre_snapshot is null or si.costo_snapshot is null);

-- ============================================================
-- descontar_inventario: UPDATE atómico con guard de stock (elimina la race condition)
-- ============================================================
create or replace function descontar_inventario()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_location_id uuid;
  v_permitir_negativo boolean;
  v_filas integer;
begin
  select location_id into v_location_id from sales where id = new.sale_id;

  select coalesce(permitir_stock_negativo, false) into v_permitir_negativo
    from configuracion where id = 1;

  if v_permitir_negativo then
    update inventory
      set cantidad = cantidad - new.cantidad, updated_at = now()
      where variant_id = new.variant_id and location_id = v_location_id;
  else
    update inventory
      set cantidad = cantidad - new.cantidad, updated_at = now()
      where variant_id = new.variant_id and location_id = v_location_id
        and cantidad >= new.cantidad;
  end if;

  get diagnostics v_filas = row_count;
  if v_filas = 0 then
    raise exception 'Stock insuficiente para completar la venta'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- ============================================================
-- registrar_venta: transacción única (venta + items + pagos), idempotente por client_transaction_id
-- ============================================================
create or replace function registrar_venta(
  p_items jsonb,
  p_pagos jsonb,
  p_subtotal numeric,
  p_impuesto numeric,
  p_total numeric,
  p_client_transaction_id uuid default null,
  p_cliente_id uuid default null,
  p_cliente_doc text default null,
  p_location_id uuid default null,
  p_cajero_id uuid default null,
  p_cash_session_id uuid default null
)
returns sales
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale sales;
  v_item jsonb;
  v_pago jsonb;
begin
  if p_client_transaction_id is not null then
    select * into v_sale from sales where client_transaction_id = p_client_transaction_id;
    if found then
      return v_sale;
    end if;
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La venta no tiene productos' using errcode = 'P0001';
  end if;
  if p_pagos is null or jsonb_array_length(p_pagos) = 0 then
    raise exception 'La venta no tiene un método de pago' using errcode = 'P0001';
  end if;

  begin
    insert into sales (subtotal, impuesto, total, estado, cliente_id, cliente_doc, location_id, cajero_id, cash_session_id, client_transaction_id)
    values (p_subtotal, p_impuesto, p_total, 'completada', p_cliente_id, p_cliente_doc, p_location_id, p_cajero_id, p_cash_session_id, p_client_transaction_id)
    returning * into v_sale;
  exception
    when unique_violation then
      select * into v_sale from sales where client_transaction_id = p_client_transaction_id;
      if found then
        return v_sale;
      end if;
      raise;
  end;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into sale_items (sale_id, variant_id, cantidad, precio_unitario, subtotal, descuento, producto_nombre_snapshot, costo_snapshot)
    select
      v_sale.id,
      (v_item->>'variant_id')::uuid,
      (v_item->>'cantidad')::integer,
      (v_item->>'precio_unitario')::numeric,
      (v_item->>'subtotal')::numeric,
      coalesce((v_item->>'descuento')::numeric, 0),
      p.nombre,
      p.costo
    from product_variants pv
    join products p on p.id = pv.product_id
    where pv.id = (v_item->>'variant_id')::uuid;

    if not found then
      raise exception 'Producto no encontrado en el catálogo' using errcode = 'P0001';
    end if;
  end loop;

  for v_pago in select * from jsonb_array_elements(p_pagos)
  loop
    insert into payments (sale_id, metodo, monto, referencia)
    values (v_sale.id, v_pago->>'metodo', (v_pago->>'monto')::numeric, nullif(v_pago->>'referencia', ''));
  end loop;

  return v_sale;
end;
$$;

revoke all on function registrar_venta(jsonb, jsonb, numeric, numeric, numeric, uuid, uuid, text, uuid, uuid, uuid) from public;
grant execute on function registrar_venta(jsonb, jsonb, numeric, numeric, numeric, uuid, uuid, text, uuid, uuid, uuid) to authenticated;

-- ============================================================
-- Reportes de utilidad: usar costo_snapshot en vez de products.costo en vivo (P3)
-- ============================================================
create or replace function resumen_ganancias(fecha_desde timestamp with time zone, fecha_hasta timestamp with time zone)
returns table(total_ventas numeric, total_costo numeric, total_ganancia numeric, margen_promedio numeric, num_ventas bigint)
language sql stable security definer
as $$
  select
    coalesce(sum(si.subtotal), 0) as total_ventas,
    coalesce(sum(coalesce(si.costo_snapshot, 0) * si.cantidad), 0) as total_costo,
    coalesce(sum(si.subtotal) - sum(coalesce(si.costo_snapshot, 0) * si.cantidad), 0) as total_ganancia,
    case when sum(si.subtotal) > 0
      then round(((sum(si.subtotal) - sum(coalesce(si.costo_snapshot, 0) * si.cantidad)) / sum(si.subtotal)) * 100, 1)
      else 0
    end as margen_promedio,
    count(distinct s.id) as num_ventas
  from sale_items si
  join sales s on s.id = si.sale_id
  where s.estado = 'completada'
    and s.fecha >= fecha_desde and s.fecha < fecha_hasta;
$$;

create or replace function top_productos_ganancia(fecha_desde timestamp with time zone, fecha_hasta timestamp with time zone, lim integer default 10)
returns table(producto_nombre character varying, producto_sku character varying, unidades_vendidas bigint, ingreso numeric, costo_total numeric, ganancia numeric, margen numeric)
language sql stable security definer
as $$
  select
    p.nombre, p.sku,
    sum(si.cantidad)::bigint as unidades_vendidas,
    sum(si.subtotal) as ingreso,
    sum(coalesce(si.costo_snapshot, 0) * si.cantidad) as costo_total,
    sum(si.subtotal) - sum(coalesce(si.costo_snapshot, 0) * si.cantidad) as ganancia,
    case when sum(si.subtotal) > 0
      then round(((sum(si.subtotal) - sum(coalesce(si.costo_snapshot, 0) * si.cantidad)) / sum(si.subtotal)) * 100, 1)
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

-- ============================================================
-- Forzar que sales/sale_items/payments solo se escriban vía registrar_venta()
-- (elimina el camino de "frontend orquestando inserts secuenciales")
-- ============================================================
drop policy if exists "ventas_insercion" on sales;
drop policy if exists "sale_items_insercion" on sale_items;
drop policy if exists "payments_insercion" on payments;
