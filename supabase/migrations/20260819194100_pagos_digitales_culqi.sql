-- Pago digital verificado (Yape/Plin vía Culqi)
-- ============================================================
-- Antes de esto, un pago con "yape"/"plin" solo guardaba un código de
-- operación tecleado a mano por el cajero — sin garantía real de que el
-- dinero llegó. Esta migración agrega la tabla que registra el ciclo de
-- vida de una orden de cobro creada en Culqi (pendiente -> pagado/expirado),
-- confirmada exclusivamente por el webhook de Culqi (nunca por el navegador).
-- ============================================================

alter table configuracion
  add column if not exists culqi_activo boolean not null default false;

create table if not exists pagos_digitales (
  id uuid primary key default gen_random_uuid(),
  culqi_order_id text unique,
  monto numeric not null check (monto > 0),
  metodo text not null check (metodo in ('yape', 'plin')),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'pagado', 'expirado', 'fallido')),
  sale_id uuid references sales(id),
  cajero_id uuid,
  location_id uuid,
  respuesta_culqi jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table pagos_digitales enable row level security;

drop policy if exists "pagos_digitales_lectura" on pagos_digitales;
create policy "pagos_digitales_lectura" on pagos_digitales
  for select using (auth.role() = 'authenticated');

drop policy if exists "pagos_digitales_service_role" on pagos_digitales;
create policy "pagos_digitales_service_role" on pagos_digitales
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create index if not exists idx_pagos_digitales_estado on pagos_digitales(estado);
create index if not exists idx_pagos_digitales_sale on pagos_digitales(sale_id);

-- ============================================================
-- registrar_venta: cuando culqi_activo y el pago es yape/plin, ya no basta
-- con el "referencia" tecleado a mano — debe traer el id de un
-- pagos_digitales que Culqi (vía webhook, nunca el frontend) ya marcó como
-- 'pagado', por exactamente ese monto y sin usar en otra venta. Si no
-- califica, la venta se rechaza — así un frontend comprometido no puede
-- fabricar un "pago confirmado" falso.
-- Misma firma de 16 parámetros que la migración anterior: solo cambia el
-- cuerpo, así que CREATE OR REPLACE reemplaza en el lugar sin crear una
-- sobrecarga nueva (a diferencia de cuando se agregaron parámetros).
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
  p_cash_session_id uuid default null,
  p_tipo_comprobante text default 'boleta',
  p_comprobante_cliente_tipo_doc text default null,
  p_comprobante_cliente_num_doc text default null,
  p_comprobante_cliente_denominacion text default null,
  p_comprobante_cliente_direccion text default null
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
  v_serie text;
  v_correlativo integer;
  v_nubefact_activo boolean;
  v_culqi_activo boolean;
  v_pago_digital_id uuid;
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
  if p_tipo_comprobante not in ('boleta', 'factura') then
    raise exception 'Tipo de comprobante inválido' using errcode = 'P0001';
  end if;

  select coalesce(nubefact_activo, false), coalesce(culqi_activo, false)
    into v_nubefact_activo, v_culqi_activo
    from configuracion where id = 1;

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
    if v_culqi_activo and (v_pago->>'metodo') in ('yape', 'plin') then
      if nullif(v_pago->>'pago_digital_id', '') is null then
        raise exception 'Pago digital sin confirmar' using errcode = 'P0001';
      end if;

      update pagos_digitales
      set sale_id = v_sale.id, updated_at = now()
      where id = (v_pago->>'pago_digital_id')::uuid
        and estado = 'pagado'
        and sale_id is null
        and metodo = (v_pago->>'metodo')
        and monto = (v_pago->>'monto')::numeric
      returning id into v_pago_digital_id;

      if v_pago_digital_id is null then
        raise exception 'No se pudo verificar el pago digital (Yape/Plin): no está confirmado, ya fue usado, o el monto no coincide' using errcode = 'P0001';
      end if;

      insert into payments (sale_id, metodo, monto, referencia)
      values (v_sale.id, v_pago->>'metodo', (v_pago->>'monto')::numeric, 'culqi:' || (v_pago->>'pago_digital_id'));
    else
      insert into payments (sale_id, metodo, monto, referencia)
      values (v_sale.id, v_pago->>'metodo', (v_pago->>'monto')::numeric, nullif(v_pago->>'referencia', ''));
    end if;
  end loop;

  if v_nubefact_activo then
    if p_tipo_comprobante = 'factura' then
      select nubefact_serie_factura into v_serie from configuracion where id = 1;
      v_correlativo := nextval('factura_correlativo_seq');
    else
      select nubefact_serie_boleta into v_serie from configuracion where id = 1;
      v_correlativo := nextval('boleta_correlativo_seq');
    end if;

    update sales set
      tipo_comprobante = p_tipo_comprobante,
      comprobante_serie = v_serie,
      comprobante_correlativo = v_correlativo,
      comprobante_cliente_tipo_doc = p_comprobante_cliente_tipo_doc,
      comprobante_cliente_num_doc = p_comprobante_cliente_num_doc,
      comprobante_cliente_denominacion = p_comprobante_cliente_denominacion,
      comprobante_cliente_direccion = p_comprobante_cliente_direccion
    where id = v_sale.id
    returning * into v_sale;

    insert into comprobantes_electronicos (sale_id, estado, tipo_comprobante, serie, numero)
    values (v_sale.id, 'pendiente', p_tipo_comprobante, v_serie, v_correlativo);
  end if;

  return v_sale;
end;
$$;

revoke all on function registrar_venta(jsonb, jsonb, numeric, numeric, numeric, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text) from public;
revoke execute on function registrar_venta(jsonb, jsonb, numeric, numeric, numeric, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text) from anon;
grant execute on function registrar_venta(jsonb, jsonb, numeric, numeric, numeric, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text) to authenticated;
