-- ============================================================================
-- HARDENING P0 — Parte 1: fecha operativa (America/Lima), venta offline real,
-- descuento server-side, y cobro de taller atómico dentro de registrar_venta.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Fecha operativa en sales: separar "cuándo ocurrió" de "cuándo llegó".
--    `fecha` sigue siendo el instante real de la operación (occurred_at) —
--    se reutiliza la columna existente en vez de duplicarla, ya que todo el
--    código de reportes/cierre ya lee `sales.fecha`. Se agregan:
--    business_date  = día operativo en Lima, derivado siempre server-side de `fecha`.
--    synced_at      = cuándo quedó persistida en el servidor (now() al INSERT).
--    offline_origin = si la venta se generó en la cola offline del cliente.
-- ---------------------------------------------------------------------------
alter table public.sales
  add column if not exists business_date date,
  add column if not exists synced_at timestamptz not null default now(),
  add column if not exists offline_origin boolean not null default false;

-- Backfill seguro: para ventas ya existentes, occurred_at siempre fue `fecha`
-- (no había otro dato), así que no se inventa nada nuevo.
update public.sales set business_date = (fecha at time zone 'America/Lima')::date
where business_date is null;

alter table public.sales alter column business_date set not null;

create or replace function private.calcular_business_date_lima()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.business_date := (new.fecha at time zone 'America/Lima')::date;
  return new;
end;
$$;

drop trigger if exists trg_business_date_sales on public.sales;
create trigger trg_business_date_sales
  before insert or update of fecha on public.sales
  for each row execute function private.calcular_business_date_lima();

create index if not exists idx_sales_business_date on public.sales(business_date);

-- ---------------------------------------------------------------------------
-- 2) Origen del descuento en sale_items — para que registrar_venta pueda
--    validar server-side que un descuento por encima del límite del vendedor
--    realmente viene de una autorización consumida o de una promoción real,
--    en vez de confiar en que el frontend ya lo validó.
-- ---------------------------------------------------------------------------
alter table public.sale_items
  add column if not exists descuento_origen text not null default 'ninguno'
    check (descuento_origen in ('ninguno','manual','autorizacion','promocion')),
  add column if not exists autorizacion_id uuid references public.autorizaciones_operativas(id),
  add column if not exists promocion_id uuid references public.promociones(id);

alter table public.autorizaciones_operativas
  add column if not exists sale_item_id uuid references public.sale_items(id);

-- ---------------------------------------------------------------------------
-- 3) validar_linea_venta_catalogo: además de precio/subtotal (sin cambios),
--    ahora exige respaldo real para descuentos que excedan el límite libre.
-- ---------------------------------------------------------------------------
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
  v_cajero uuid;
  v_es_admin boolean;
  v_limite_pct numeric;
  v_pct numeric;
  v_manual_libre numeric;
  v_promo_bound numeric := 0;
  v_promo record;
  v_permitido_sin_auth numeric;
  v_auth_id uuid;
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

  -- Sin descuento: nada más que validar.
  if coalesce(new.descuento, 0) <= 0.001 then
    new.descuento_origen := 'ninguno';
    return new;
  end if;

  select s.cajero_id into v_cajero from public.sales s where s.id = new.sale_id;
  select exists(select 1 from public.staff st where st.id = v_cajero and st.rol = 'administrador') into v_es_admin;

  if v_es_admin then
    new.descuento_origen := coalesce(new.descuento_origen, 'manual');
    return new;
  end if;

  select coalesce(descuento_vendedor_max_pct, 0) into v_limite_pct from public.configuracion where id = 1;
  v_pct := (new.descuento / nullif(new.precio_unitario, 0)) * 100;
  v_manual_libre := (v_limite_pct / 100.0) * new.precio_unitario;

  -- Si hay una promoción real, activa y aplicable a esta variante, se admite
  -- como cota conservadora el propio valor/tipo de la promoción (misma fórmula
  -- que resolver_promociones_carrito, para una unidad a este precio).
  if new.promocion_id is not null then
    select p.tipo, p.valor, p.compra_cantidad, p.paga_cantidad
      into v_promo
    from public.promociones p
    join public.promocion_items pi on pi.promocion_id = p.id and pi.variant_id = new.variant_id
    where p.id = new.promocion_id
      and p.activo = true
      and now() between p.fecha_inicio and p.fecha_fin;

    if v_promo.tipo is not null then
      v_promo_bound := case
        when v_promo.tipo = 'porcentaje' then least(new.precio_unitario, new.precio_unitario * v_promo.valor / 100)
        when v_promo.tipo = 'precio_especial' then greatest(0, new.precio_unitario - v_promo.valor)
        when v_promo.tipo = '2x1' and coalesce(v_promo.compra_cantidad,0) > 0 then new.precio_unitario
        else new.precio_unitario -- monto_fijo/combo: no se puede acotar por línea sin el carrito completo, se confía en el id real + vigente
      end;
    end if;
  end if;

  v_permitido_sin_auth := greatest(v_promo_bound, v_manual_libre) + case when new.promocion_id is not null then v_manual_libre else 0 end;

  if new.descuento <= v_permitido_sin_auth + 0.01 then
    new.descuento_origen := case when new.promocion_id is not null then 'promocion' else 'manual' end;
    return new;
  end if;

  -- Excede lo explicable por promoción + margen libre: exige una autorización
  -- ya aprobada y consumida para esta variante/vendedor, y la vincula para que
  -- no pueda reutilizarse en otra línea.
  if new.autorizacion_id is not null then
    select a.id into v_auth_id
    from public.autorizaciones_operativas a
    where a.id = new.autorizacion_id
      and a.tipo = 'descuento'
      and a.solicitado_por = v_cajero
      and a.recurso_tipo = 'variant'
      and a.recurso_id = new.variant_id::text
      and a.estado = 'aprobada'
      and a.consumed_at is not null
      and a.sale_item_id is null
      and coalesce((a.payload->>'porcentaje')::numeric, 0) >= v_pct - 0.01
      and coalesce((a.payload->>'descuento_unitario')::numeric, 0) >= new.descuento - 0.01
    for update;
  end if;

  if v_auth_id is null then
    raise exception 'Descuento de % por ciento supera el límite permitido (% por ciento) y no tiene autorización válida ni promoción aplicable',
      round(v_pct,1)::text, round(v_limite_pct,1)::text using errcode = 'P0001';
  end if;

  update public.autorizaciones_operativas set sale_item_id = new.id where id = v_auth_id;
  new.descuento_origen := 'autorizacion';
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) validar_contexto_venta_autenticada: además de cajero/sucursal/caja
--    (sin cambios), ahora exige que la fecha real de la venta caiga dentro
--    del periodo de esa caja (apertura..cierre), con 2 min de tolerancia por
--    reloj. Esto es lo que permite aceptar una venta offline sincronizada
--    horas/días después SIN permitir insertar fechas arbitrarias: la fecha
--    debe corresponder a una caja real que estuvo abierta en ese momento.
-- ---------------------------------------------------------------------------
create or replace function public.validar_contexto_venta_autenticada()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff public.staff;
  v_session public.cash_sessions;
begin
  if auth.role() = 'service_role' then
    return new;
  end if;

  if auth.uid() is null then
    raise exception 'Venta rechazada: sesión no autenticada' using errcode = '42501';
  end if;

  select * into v_staff
  from public.staff
  where user_id = auth.uid()
    and activo = true
  limit 1;

  if v_staff.id is null then
    raise exception 'Venta rechazada: personal no válido o inactivo' using errcode = '42501';
  end if;

  if new.cajero_id is distinct from v_staff.id then
    raise exception 'Venta rechazada: cajero no corresponde a la sesión' using errcode = '42501';
  end if;

  if new.location_id is distinct from v_staff.location_id then
    raise exception 'Venta rechazada: sucursal no corresponde al personal' using errcode = '42501';
  end if;

  if new.cash_session_id is null then
    raise exception 'Venta rechazada: se requiere una caja asociada' using errcode = '42501';
  end if;

  select * into v_session
  from public.cash_sessions cs
  where cs.id = new.cash_session_id
    and cs.cajero_id = v_staff.id
    and cs.location_id = v_staff.location_id;

  if v_session.id is null then
    raise exception 'Venta rechazada: la caja no pertenece al cajero o sucursal' using errcode = '42501';
  end if;

  if new.fecha < v_session.apertura - interval '2 minutes'
     or (v_session.cierre is not null and new.fecha > v_session.cierre + interval '2 minutes') then
    raise exception 'Venta rechazada: la fecha de la venta (%) no corresponde al periodo en que esa caja estuvo abierta (% – %)',
      new.fecha, v_session.apertura, coalesce(v_session.cierre::text, 'abierta') using errcode = '42501';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) registrar_venta: agrega occurred_at/offline_origin (fecha real de la
--    venta), vínculo atómico opcional con una orden de servicio de taller
--    (cobro de orden = venta + vínculo en UNA sola transacción), y guardarraíles
--    contra insertar ventas offline arbitrariamente antiguas o futuras.
-- ---------------------------------------------------------------------------
create or replace function public.registrar_venta(
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
  p_comprobante_cliente_direccion text default null,
  p_occurred_at timestamptz default null,
  p_offline_origin boolean default false,
  p_orden_servicio_id uuid default null
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
  v_fecha timestamptz;
  v_orden ordenes_servicio;
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

  v_fecha := coalesce(p_occurred_at, now());
  if v_fecha > now() + interval '5 minutes' then
    raise exception 'La fecha de la venta no puede ser futura' using errcode = 'P0001';
  end if;
  if v_fecha < now() - interval '30 days' then
    raise exception 'Esta venta ocurrió hace más de 30 días; no puede sincronizarse automáticamente. Contacta a un administrador.' using errcode = 'P0001';
  end if;
  if p_offline_origin and p_client_transaction_id is null then
    raise exception 'Las ventas offline requieren un identificador de transacción válido' using errcode = 'P0001';
  end if;

  if p_orden_servicio_id is not null then
    select * into v_orden from ordenes_servicio where id = p_orden_servicio_id for update;
    if v_orden.id is null then
      raise exception 'La orden de servicio no existe' using errcode = 'P0001';
    end if;
    if v_orden.venta_id is not null then
      raise exception 'Esta orden de servicio ya fue cobrada' using errcode = 'P0001';
    end if;
  end if;

  select coalesce(nubefact_activo, false), coalesce(culqi_activo, false)
    into v_nubefact_activo, v_culqi_activo
    from configuracion where id = 1;

  begin
    insert into sales (subtotal, impuesto, total, estado, cliente_id, cliente_doc, location_id, cajero_id, cash_session_id, client_transaction_id, fecha, synced_at, offline_origin)
    values (p_subtotal, p_impuesto, p_total, 'completada', p_cliente_id, p_cliente_doc, p_location_id, p_cajero_id, p_cash_session_id, p_client_transaction_id, v_fecha, now(), p_offline_origin)
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
    insert into sale_items (sale_id, variant_id, cantidad, precio_unitario, subtotal, descuento, producto_nombre_snapshot, costo_snapshot, promocion_id, autorizacion_id)
    select
      v_sale.id,
      (v_item->>'variant_id')::uuid,
      (v_item->>'cantidad')::integer,
      (v_item->>'precio_unitario')::numeric,
      (v_item->>'subtotal')::numeric,
      coalesce((v_item->>'descuento')::numeric, 0),
      p.nombre,
      p.costo,
      nullif(v_item->>'promocion_id','')::uuid,
      nullif(v_item->>'autorizacion_id','')::uuid
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

  -- Cobro de orden de taller: vínculo dentro de la MISMA transacción — si esto
  -- falla (orden ya cobrada por otra pestaña, borrada, etc.) toda la venta
  -- se revierte también, nunca queda dinero cobrado sin la orden vinculada.
  if p_orden_servicio_id is not null then
    update ordenes_servicio
    set venta_id = v_sale.id
    where id = p_orden_servicio_id and venta_id is null;

    if not found then
      raise exception 'La orden de servicio ya fue cobrada por otra operación' using errcode = 'P0001';
    end if;
  end if;

  return v_sale;
end;
$$;

revoke all on function public.registrar_venta(jsonb, jsonb, numeric, numeric, numeric, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text, timestamptz, boolean, uuid) from public;
revoke execute on function public.registrar_venta(jsonb, jsonb, numeric, numeric, numeric, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text, timestamptz, boolean, uuid) from anon;
grant execute on function public.registrar_venta(jsonb, jsonb, numeric, numeric, numeric, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text, timestamptz, boolean, uuid) to authenticated;

-- La firma anterior (16 parámetros, sin occurred_at/offline_origin/orden) queda
-- reemplazada — se elimina explícitamente para no dejar dos overloads activos
-- (mismo problema ya resuelto una vez en 20260819170512_drop_old_registrar_venta_overload.sql).
drop function if exists public.registrar_venta(jsonb, jsonb, numeric, numeric, numeric, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text);
