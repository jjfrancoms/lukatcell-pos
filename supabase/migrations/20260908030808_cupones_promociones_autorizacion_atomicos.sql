-- ============================================================================
-- P0.2 bloque 1+2: cupones/promociones y autorización de descuento se
-- resuelven y CONSUMEN dentro de la misma transacción que registrar_venta,
-- nunca antes ni en una llamada separada.
--
-- Bloque 1 (cupones/promociones):
--   - registrar_uso_cupon se llamaba DESPUÉS de la venta, de forma asíncrona
--     y best-effort desde el frontend (Venta.tsx) — si fallaba (red, cierre
--     de pestaña, venta offline) el cupón nunca contabilizaba su uso, y
--     max_usos era trivialmente evadible repitiendo el mismo código.
--   - validar_linea_venta_catalogo aproximaba el tope de descuento por
--     promoción con fórmulas simplificadas (2x1 -> precio completo) en vez
--     del descuento EXACTO que calcula resolver_promociones_carrito — un
--     cliente podía enviar un promocion_id real con un descuento mayor al
--     que esa promoción realmente produce para esa cantidad.
--   - Solución: se extrae el cálculo de resolver_promociones_carrito a
--     private.calcular_promocion_carrito (misma matemática, una sola
--     implementación), y registrar_venta la invoca UNA vez por venta con el
--     carrito completo real, bloqueando el cupón (FOR UPDATE) y dejando el
--     resultado exacto por variante en una tabla temporal de sesión que el
--     trigger de sale_items usa como techo — nunca una aproximación.
--
-- Bloque 2 (autorización de descuento):
--   - consumir_autorizacion_descuento marcaba la autorización 'consumida'
--     en el momento en que el cajero aplicaba el descuento en el carrito,
--     ANTES de que existiera la venta. Si la venta luego fallaba (stock,
--     precio) o el cajero abandonaba el cobro, la autorización quedaba
--     quemada sin que ninguna venta la respaldara.
--   - Solución: se reemplaza por consultar_autorizacion_descuento (misma
--     lógica, pero de solo lectura — NUNCA marca 'consumida'). El consumo
--     real ahora ocurre dentro de validar_linea_venta_catalogo (que corre
--     DENTRO de la transacción de registrar_venta, con FOR UPDATE sobre la
--     autorización) — si la venta falla por cualquier motivo, todo el
--     ROLLBACK incluye deshacer ese consumo automáticamente porque nunca se
--     hizo en una transacción aparte.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Cálculo de promociones centralizado — una sola implementación real,
--    reutilizada tanto por el preview (resolver_promociones_carrito) como
--    por la venta real (registrar_venta).
-- ----------------------------------------------------------------------------
create or replace function private.calcular_promocion_carrito(p_items jsonb, p_codigo_cupon text default null)
returns table(variant_id uuid, descuento_promocion_unitario numeric, promocion_id uuid, promocion_nombre text, acumulable boolean)
language plpgsql
stable
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_pid uuid; v_nombre text; v_tipo text; v_total numeric;
  v_valor numeric; v_compra int; v_paga int; v_acum boolean; v_base numeric;
begin
  select e.promocion_id, e.nombre, e.tipo, e.descuento into v_pid, v_nombre, v_tipo, v_total
  from public.evaluar_promociones_carrito(p_items, p_codigo_cupon) e limit 1;
  if v_pid is null or coalesce(v_total, 0) <= 0 then return; end if;

  select p.valor, p.compra_cantidad, p.paga_cantidad, p.acumulable
    into v_valor, v_compra, v_paga, v_acum
  from public.promociones p where p.id = v_pid;

  select coalesce(sum(greatest(0, (x->>'cantidad')::int) * greatest(0, (x->>'precio_unitario')::numeric)), 0) into v_base
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
  join public.promocion_items pi on pi.promocion_id = v_pid and pi.variant_id = (x->>'variant_id')::uuid;

  return query
  with cart as (
    select (x->>'variant_id')::uuid vid, greatest(0, (x->>'cantidad')::int) qty, greatest(0, (x->>'precio_unitario')::numeric) price
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
  ), eleg as (
    select c.* from cart c join public.promocion_items pi on pi.promocion_id = v_pid and pi.variant_id = c.vid
  )
  select e.vid,
    round(case
      when e.qty <= 0 or e.price <= 0 then 0
      when v_tipo = 'porcentaje' then least(e.price, e.price * v_valor / 100)
      when v_tipo = 'precio_especial' then greatest(0, e.price - v_valor)
      when v_tipo = '2x1' then least(e.price, (floor(e.qty::numeric / v_compra) * (v_compra - v_paga) * e.price) / e.qty)
      when v_tipo in ('monto_fijo', 'combo') and v_base > 0 then least(e.price, (v_total * (e.qty * e.price / v_base)) / e.qty)
      else 0 end, 2),
    v_pid, v_nombre, v_acum
  from eleg e;
end$function$;

-- resolver_promociones_carrito pasa a ser un envoltorio delgado sobre la
-- misma función que usará registrar_venta — ya no hay dos implementaciones
-- que puedan divergir.
create or replace function public.resolver_promociones_carrito(p_items jsonb, p_codigo_cupon text default null)
returns table(variant_id uuid, descuento_promocion_unitario numeric, promocion_id uuid, promocion_nombre text, acumulable boolean)
language plpgsql
stable
security definer
set search_path to 'public', 'private'
as $function$
begin
  if private.auth_staff_id() is null then raise exception 'Usuario no vinculado'; end if;
  return query select * from private.calcular_promocion_carrito(p_items, p_codigo_cupon);
end$function$;

-- ----------------------------------------------------------------------------
-- 2. registrar_uso_cupon deja de ser invocable por separado desde el
--    frontend — su lógica (bloqueo + validación + incremento) se mueve
--    dentro de registrar_venta. Se conserva la función (no se elimina, por
--    si hay integraciones externas desconocidas) pero se revoca su
--    ejecución pública, igual que se hizo con registrar_venta_serializada
--    en P0.1 bloque 9.
-- ----------------------------------------------------------------------------
revoke all on function public.registrar_uso_cupon(text, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. consumir_autorizacion_descuento (mutante, consumía al aplicar el
--    descuento en el carrito) se reemplaza por una versión de SOLO LECTURA:
--    consultar_autorizacion_descuento. Nunca marca 'consumida' — solo
--    informa si existe una autorización aprobada y utilizable. El consumo
--    real ahora vive exclusivamente en validar_linea_venta_catalogo, dentro
--    de la transacción de la venta.
-- ----------------------------------------------------------------------------
create or replace function public.consultar_autorizacion_descuento(p_variant_id uuid, p_porcentaje numeric, p_descuento_unitario numeric)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_staff public.staff;
  v_limite numeric;
  v_auth_id uuid;
begin
  select * into v_staff from public.staff where user_id = auth.uid() and activo = true limit 1;
  if v_staff.id is null then raise exception 'Personal no válido'; end if;
  if p_porcentaje is null or p_porcentaje < 0 or p_porcentaje > 100 then raise exception 'Porcentaje inválido'; end if;
  if p_descuento_unitario is null or p_descuento_unitario < 0 then raise exception 'Descuento inválido'; end if;
  if private.auth_is_admin() then return jsonb_build_object('autorizada', true, 'autorizacion_id', null); end if;

  select coalesce(descuento_vendedor_max_pct, 0) into v_limite from public.configuracion where id = 1;
  if p_porcentaje <= coalesce(v_limite, 0) + 0.0001 then return jsonb_build_object('autorizada', true, 'autorizacion_id', null); end if;

  select a.id into v_auth_id
  from public.autorizaciones_operativas a
  where a.tipo = 'descuento'
    and a.solicitado_por = v_staff.id
    and a.location_id = private.auth_location_id()
    and a.recurso_tipo = 'variant'
    and a.recurso_id = p_variant_id::text
    and a.estado = 'aprobada'
    and a.consumed_at is null
    and coalesce((a.payload->>'porcentaje')::numeric, 0) >= p_porcentaje - 0.0001
    and coalesce((a.payload->>'descuento_unitario')::numeric, 0) >= p_descuento_unitario - 0.01
  order by a.resolved_at desc nulls last, a.created_at desc
  limit 1;

  if v_auth_id is null then return jsonb_build_object('autorizada', false, 'autorizacion_id', null); end if;
  return jsonb_build_object('autorizada', true, 'autorizacion_id', v_auth_id);
end$function$;

grant execute on function public.consultar_autorizacion_descuento(uuid, numeric, numeric) to authenticated;

-- La antigua consumir_autorizacion_descuento se conserva (no se elimina, por
-- si hay integraciones externas) pero se revoca: dejarla invocable
-- permitiría a un cliente seguir "quemando" autorizaciones fuera del ciclo
-- transaccional nuevo.
revoke all on function public.consumir_autorizacion_descuento(uuid, numeric, numeric) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. registrar_venta: cupón + promociones resueltos y bloqueados DENTRO de
--    la transacción; autorización de descuento ya no se recibe pre-consumida
--    (ver trigger más abajo).
-- ----------------------------------------------------------------------------
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
  p_orden_servicio_id uuid default null,
  p_codigo_cupon text default null
)
returns sales
language plpgsql
security definer
set search_path to 'public'
as $function$
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
  v_cupon cupones;
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

  -- ------------------------------------------------------------------------
  -- P0.2 bloque 1: cupón + promociones, resueltos y bloqueados AQUÍ, dentro
  -- de la misma transacción que la venta que están descontando. Si algo
  -- falla más abajo (stock, un pago, un item inválido), todo esto se
  -- revierte junto con la venta — nunca queda un cupón "gastado" sin venta.
  -- ------------------------------------------------------------------------
  if p_codigo_cupon is not null and trim(p_codigo_cupon) <> '' then
    select * into v_cupon from cupones c where c.codigo = upper(trim(p_codigo_cupon)) for update;
    if v_cupon.id is null then
      raise exception 'Cupón inválido' using errcode = 'P0001';
    end if;
    if not v_cupon.activo then
      raise exception 'Cupón inactivo' using errcode = 'P0001';
    end if;
    if v_cupon.fecha_inicio > now() or (v_cupon.fecha_fin is not null and v_cupon.fecha_fin <= now()) then
      raise exception 'Cupón fuera de vigencia' using errcode = 'P0001';
    end if;
    if v_cupon.max_usos is not null and v_cupon.usos >= v_cupon.max_usos then
      raise exception 'Cupón sin usos disponibles' using errcode = 'P0001';
    end if;
  end if;

  -- Mapa canónico de promociones para TODO el carrito real, calculado una
  -- sola vez con la misma matemática que el preview — nunca se recalcula
  -- de forma distinta ni se confía en lo que mande el cliente por línea.
  -- Vive en una tabla temporal de sesión: es lo único con visibilidad al
  -- carrito COMPLETO (necesario para 2x1/combo, que dependen de cantidades
  -- agregadas), algo que el trigger de sale_items no puede reconstruir de
  -- forma confiable fila por fila.
  create temp table if not exists venta_promo_ceiling (
    variant_id uuid primary key,
    promocion_id uuid,
    descuento_max numeric
  ) on commit drop;
  truncate venta_promo_ceiling;
  insert into venta_promo_ceiling(variant_id, promocion_id, descuento_max)
  select variant_id, promocion_id, descuento_promocion_unitario
  from private.calcular_promocion_carrito(p_items, p_codigo_cupon);

  if v_cupon.id is not null then
    if not exists (select 1 from venta_promo_ceiling where promocion_id = v_cupon.promocion_id) then
      raise exception 'El cupón no aplica a los productos de este carrito' using errcode = 'P0001';
    end if;
    insert into cupon_usos (cupon_id, sale_id, usado_por)
    values (v_cupon.id, v_sale.id, coalesce(p_cajero_id, v_sale.cajero_id))
    on conflict (cupon_id, sale_id) do nothing;
    update cupones set usos = usos + 1 where id = v_cupon.id;
  end if;

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

    if lower(trim(v_pago->>'metodo')) = 'efectivo' and v_sale.cash_session_id is not null then
      perform private.insertar_movimiento_caja(
        v_sale.cash_session_id, 'venta_efectivo', (v_pago->>'monto')::numeric,
        'Venta en efectivo', v_sale.cajero_id, 'sale', v_sale.id
      );
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
$function$;

-- ----------------------------------------------------------------------------
-- 5. validar_linea_venta_catalogo: el tope de descuento por promoción ahora
--    viene EXACTO de venta_promo_ceiling (calculado arriba con el carrito
--    real completo) en vez de una aproximación local; y la autorización de
--    descuento se CONSUME aquí mismo (FOR UPDATE, estado 'aprobada' ->
--    'consumida'), dentro de la transacción de la venta — no antes.
-- ----------------------------------------------------------------------------
create or replace function public.validar_linea_venta_catalogo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_precio numeric;
  v_esperado_centavos bigint;
  v_subtotal_centavos bigint;
  v_cajero uuid;
  v_location uuid;
  v_es_admin boolean;
  v_limite_pct numeric;
  v_pct numeric;
  v_manual_libre numeric;
  v_promo_bound numeric := 0;
  v_promo_id_esperado uuid;
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

  if coalesce(new.descuento, 0) <= 0.001 then
    new.descuento_origen := 'ninguno';
    new.promocion_id := null;
    return new;
  end if;

  select s.cajero_id, s.location_id into v_cajero, v_location from public.sales s where s.id = new.sale_id;
  select exists(select 1 from public.staff st where st.id = v_cajero and st.rol = 'administrador') into v_es_admin;

  if v_es_admin then
    new.descuento_origen := coalesce(new.descuento_origen, 'manual');
    return new;
  end if;

  select coalesce(descuento_vendedor_max_pct, 0) into v_limite_pct from public.configuracion where id = 1;
  v_pct := (new.descuento / nullif(new.precio_unitario, 0)) * 100;
  v_manual_libre := (v_limite_pct / 100.0) * new.precio_unitario;

  -- Tope EXACTO de promoción: viene de venta_promo_ceiling, calculado por
  -- registrar_venta con el carrito real completo y la misma fórmula que el
  -- preview (private.calcular_promocion_carrito) — nunca una aproximación
  -- distinta. Si esta tabla temporal no existe (sale_items se está
  -- insertando fuera de un registrar_venta real, lo cual no debería ser
  -- posible por RLS), el tope es 0: ninguna promoción se acepta sin poder
  -- verificarla, el default seguro.
  if to_regclass('pg_temp.venta_promo_ceiling') is not null then
    select promocion_id, descuento_max into v_promo_id_esperado, v_promo_bound
    from venta_promo_ceiling where variant_id = new.variant_id;
  end if;
  v_promo_bound := coalesce(v_promo_bound, 0);

  if new.promocion_id is not null and new.promocion_id is distinct from v_promo_id_esperado then
    raise exception 'La promoción indicada no es válida para este producto en esta venta' using errcode = 'P0001';
  end if;

  v_permitido_sin_auth := greatest(v_promo_bound, v_manual_libre) + case when new.promocion_id is not null then v_manual_libre else 0 end;

  if new.descuento <= v_permitido_sin_auth + 0.01 then
    new.descuento_origen := case when new.promocion_id is not null then 'promocion' else 'manual' end;
    return new;
  end if;

  -- Autorización de descuento: se CONSUME aquí, no antes. FOR UPDATE evita
  -- que dos ventas concurrentes usen la misma autorización aprobada; si esta
  -- venta falla más adelante (otro item, stock, un pago), el UPDATE de abajo
  -- se revierte junto con todo lo demás — la autorización vuelve a quedar
  -- 'aprobada' y disponible, no "quemada" sin venta real detrás.
  if new.autorizacion_id is not null then
    select a.id into v_auth_id
    from public.autorizaciones_operativas a
    where a.id = new.autorizacion_id
      and a.tipo = 'descuento'
      and a.solicitado_por = v_cajero
      and a.location_id = v_location
      and a.recurso_tipo = 'variant'
      and a.recurso_id = new.variant_id::text
      and a.estado = 'aprobada'
      and a.consumed_at is null
      and coalesce((a.payload->>'porcentaje')::numeric, 0) >= v_pct - 0.01
      and coalesce((a.payload->>'descuento_unitario')::numeric, 0) >= new.descuento - 0.01
    for update;
  end if;

  if v_auth_id is null then
    select a.id into v_auth_id
    from public.autorizaciones_operativas a
    where a.tipo = 'descuento'
      and a.solicitado_por = v_cajero
      and a.location_id = v_location
      and a.recurso_tipo = 'variant'
      and a.recurso_id = new.variant_id::text
      and a.estado = 'aprobada'
      and a.consumed_at is null
      and coalesce((a.payload->>'porcentaje')::numeric, 0) >= v_pct - 0.01
      and coalesce((a.payload->>'descuento_unitario')::numeric, 0) >= new.descuento - 0.01
    order by a.resolved_at desc nulls last, a.created_at desc
    for update;
  end if;

  if v_auth_id is null then
    raise exception 'Descuento de % por ciento supera el límite permitido (% por ciento) y no tiene autorización válida ni promoción aplicable',
      round(v_pct,1)::text, round(v_limite_pct,1)::text using errcode = 'P0001';
  end if;

  update public.autorizaciones_operativas
  set estado = 'consumida', consumed_at = now(), sale_item_id = new.id
  where id = v_auth_id;

  new.autorizacion_id := v_auth_id;
  new.descuento_origen := 'autorizacion';
  return new;
end;
$function$;
