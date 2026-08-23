create or replace function public.validar_linea_venta_catalogo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_precio numeric;
  v_esperado_centavos bigint;
  v_subtotal_centavos bigint;
begin
  if auth.role() = 'service_role' then
    return new;
  end if;

  if new.cantidad is null or new.cantidad <= 0 then
    raise exception 'Cantidad inválida en la venta' using errcode = 'P0001';
  end if;

  select coalesce(pv.precio_override, p.precio_base)
    into v_precio
  from public.product_variants pv
  join public.products p on p.id = pv.product_id
  where pv.id = new.variant_id
    and p.activo = true;

  if v_precio is null then
    raise exception 'Producto no disponible en el catálogo' using errcode = 'P0001';
  end if;

  if round(new.precio_unitario * 100) <> round(v_precio * 100) then
    raise exception 'El precio del producto cambió. Actualiza el catálogo y revisa la venta' using errcode = 'P0001';
  end if;

  if coalesce(new.descuento, 0) < 0 or coalesce(new.descuento, 0) > new.precio_unitario then
    raise exception 'Descuento inválido en la venta' using errcode = 'P0001';
  end if;

  v_esperado_centavos := (round(new.precio_unitario * 100)::bigint - round(coalesce(new.descuento, 0) * 100)::bigint) * new.cantidad;
  v_subtotal_centavos := round(new.subtotal * 100)::bigint;

  if v_subtotal_centavos <> v_esperado_centavos then
    raise exception 'Subtotal de producto inválido' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.validar_linea_venta_catalogo() from public, anon, authenticated;

drop trigger if exists trg_validar_linea_venta_catalogo on public.sale_items;
create trigger trg_validar_linea_venta_catalogo
before insert or update on public.sale_items
for each row
execute function public.validar_linea_venta_catalogo();

create or replace function public.validar_totales_venta_diferido()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale public.sales;
  v_items_total numeric;
  v_items_count bigint;
  v_pagos_total numeric;
  v_tiene_efectivo boolean;
begin
  if auth.role() = 'service_role' then
    return new;
  end if;

  select * into v_sale
  from public.sales
  where id = new.id;

  select coalesce(sum(subtotal), 0), count(*)
    into v_items_total, v_items_count
  from public.sale_items
  where sale_id = new.id;

  if v_items_count = 0 then
    raise exception 'La venta no tiene productos' using errcode = 'P0001';
  end if;

  if round(v_items_total * 100) <> round(v_sale.subtotal * 100) then
    raise exception 'El subtotal de la venta no coincide con sus productos' using errcode = 'P0001';
  end if;

  if round((v_sale.subtotal + v_sale.impuesto) * 100) <> round(v_sale.total * 100) then
    raise exception 'El total de la venta no coincide con subtotal e impuesto' using errcode = 'P0001';
  end if;

  select coalesce(sum(monto), 0), coalesce(bool_or(metodo = 'efectivo'), false)
    into v_pagos_total, v_tiene_efectivo
  from public.payments
  where sale_id = new.id;

  if round(v_pagos_total * 100) < round(v_sale.total * 100) then
    raise exception 'Los pagos no cubren el total de la venta' using errcode = 'P0001';
  end if;

  if round(v_pagos_total * 100) > round(v_sale.total * 100) and not v_tiene_efectivo then
    raise exception 'Solo un pago con efectivo puede superar el total para generar vuelto' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.validar_totales_venta_diferido() from public, anon, authenticated;

drop trigger if exists trg_validar_totales_venta_diferido on public.sales;
create constraint trigger trg_validar_totales_venta_diferido
after insert on public.sales
deferrable initially deferred
for each row
execute function public.validar_totales_venta_diferido();
