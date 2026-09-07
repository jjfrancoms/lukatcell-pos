-- ============================================================================
-- P0.1 bloque 7: registrar_venta nunca validaba que `impuesto` correspondiera
-- a la configuración real del negocio. validar_totales_venta_diferido (el
-- constraint trigger diferido que ya valida subtotal=sum(items) y
-- subtotal+impuesto=total) confiaba en el `impuesto` que mandara el cliente
-- para esa segunda comprobación — un cliente podía enviar p_impuesto=0 con
-- IGV activo (o cualquier otro valor) y, mientras total=subtotal+impuesto
-- cuadrara internamente, la venta pasaba igual: el negocio cobraba/declaraba
-- menos IGV del que corresponde.
--
-- Semántica de negocio confirmada en src/lib/money.ts (calcularTotalesCarrito,
-- sin tocar): el precio de catálogo NO incluye IGV — el impuesto se agrega
-- ENCIMA del subtotal (impuesto = subtotal * tasa; total = subtotal + impuesto),
-- no se extrae de un precio ya incluido. El backend reproduce exactamente esa
-- misma fórmula, en centavos enteros (igual que el frontend), para no
-- introducir divergencias de redondeo.
-- ============================================================================

create or replace function public.validar_totales_venta_diferido()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_sale public.sales;
  v_items_total numeric;
  v_items_count bigint;
  v_pagos_total numeric;
  v_tiene_efectivo boolean;
  v_igv_activo boolean;
  v_igv_pct numeric;
  v_impuesto_esperado_centavos bigint;
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

  select coalesce(igv_activo, false), coalesce(igv_porcentaje, 0) into v_igv_activo, v_igv_pct from public.configuracion where id = 1;
  v_impuesto_esperado_centavos := round(round(v_sale.subtotal * 100) * (case when v_igv_activo then v_igv_pct / 100.0 else 0 end));
  if round(v_sale.impuesto * 100) <> v_impuesto_esperado_centavos then
    raise exception 'El impuesto de la venta no corresponde a la configuración vigente (esperado: %, recibido: %)',
      round(v_impuesto_esperado_centavos / 100.0, 2)::text, round(v_sale.impuesto, 2)::text using errcode = 'P0001';
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
$function$;
