-- Boleta/Factura electrónica vía Nubefact
-- ============================================================
-- Configuración: series asignadas por Nubefact a esta cuenta
-- ============================================================
alter table configuracion
  add column if not exists nubefact_serie_boleta text not null default 'BBB1',
  add column if not exists nubefact_serie_factura text not null default 'FFF1',
  add column if not exists nubefact_activo boolean not null default false;

-- ============================================================
-- sales: qué tipo de comprobante y con qué datos de cliente
-- ============================================================
alter table sales
  add column if not exists tipo_comprobante text not null default 'boleta',
  add column if not exists comprobante_serie text,
  add column if not exists comprobante_correlativo integer,
  add column if not exists comprobante_cliente_tipo_doc text,
  add column if not exists comprobante_cliente_num_doc text,
  add column if not exists comprobante_cliente_denominacion text,
  add column if not exists comprobante_cliente_direccion text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sales_tipo_comprobante_check') then
    alter table sales add constraint sales_tipo_comprobante_check check (tipo_comprobante in ('boleta', 'factura'));
  end if;
end $$;

create sequence if not exists boleta_correlativo_seq;
create sequence if not exists factura_correlativo_seq;

-- ============================================================
-- comprobantes_electronicos: 1 fila por venta, con el resultado de Nubefact
-- ============================================================
create table if not exists comprobantes_electronicos (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null unique references sales(id),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'emitido', 'error')),
  tipo_comprobante text not null,
  serie text not null,
  numero integer not null,
  enlace_pdf text,
  enlace_xml text,
  enlace_cdr text,
  codigo_qr text,
  aceptada_por_sunat boolean,
  sunat_description text,
  respuesta_error text,
  intentos integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table comprobantes_electronicos enable row level security;

drop policy if exists "comprobantes_lectura" on comprobantes_electronicos;
create policy "comprobantes_lectura" on comprobantes_electronicos
  for select using (auth.role() = 'authenticated');

drop policy if exists "comprobantes_service_role" on comprobantes_electronicos;
create policy "comprobantes_service_role" on comprobantes_electronicos
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create index if not exists idx_comprobantes_sale on comprobantes_electronicos(sale_id);
create index if not exists idx_comprobantes_estado on comprobantes_electronicos(estado);

-- ============================================================
-- registrar_venta: ahora también reserva serie/correlativo y crea
-- el comprobante en estado 'pendiente' (la emisión real es asíncrona,
-- vía trigger -> Edge Function, para nunca bloquear/cancelar la venta)
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

  select coalesce(nubefact_activo, false) into v_nubefact_activo from configuracion where id = 1;

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

-- ============================================================
-- Trigger: al crear un comprobante 'pendiente', invocar la Edge Function
-- que llama a Nubefact (mismo patrón que notificar_cambio_estado)
-- ============================================================
create or replace function emitir_comprobante_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supabase_url text;
  v_service_role_key text;
begin
  v_supabase_url := current_setting('app.settings.supabase_url', true);
  v_service_role_key := current_setting('app.settings.service_role_key', true);

  if v_supabase_url is null or v_service_role_key is null then
    raise warning 'emitir_comprobante_trigger: app.settings.supabase_url / service_role_key no configurados; se omite la emisión';
    return new;
  end if;

  perform net.http_post(
    url := v_supabase_url || '/functions/v1/emitir-comprobante',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_role_key
    ),
    body := jsonb_build_object('comprobante_id', new.id)
  );

  return new;
end;
$$;

drop trigger if exists on_comprobante_pendiente on comprobantes_electronicos;
create trigger on_comprobante_pendiente
  after insert on comprobantes_electronicos
  for each row
  when (new.estado = 'pendiente')
  execute function emitir_comprobante_trigger();
