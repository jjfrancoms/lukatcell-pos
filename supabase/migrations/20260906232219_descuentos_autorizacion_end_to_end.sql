-- ============================================================================
-- P0.1 bloque 3: descuentos/promociones/autorizaciones end-to-end.
--
-- Bug crítico encontrado en auditoría (no reportado por el usuario, hallado
-- al releer el propio código del hardening): private.consumir_autorizacion
-- marca la fila con estado='consumida' al usarla, pero validar_linea_venta_
-- catalogo buscaba una autorización con estado='aprobada' AND consumed_at IS
-- NOT NULL — una combinación IMPOSIBLE, porque el momento en que consumed_at
-- se setea es EXACTAMENTE el mismo en que estado pasa a 'consumida'. Es decir:
-- NINGÚN descuento que requiriera autorización podía completarse jamás,
-- incluso si el frontend hubiera enviado el autorizacion_id correctamente
-- (que tampoco lo hacía — ver el segundo problema abajo).
--
-- Segundo problema: el frontend (Venta.tsx) nunca enviaba promocion_id ni
-- autorizacion_id en los items de la venta — consumir_autorizacion_descuento
-- solo devolvía boolean, sin exponer el ID real consumido para que el
-- frontend pudiera reenviarlo. Sin esto, todo el hardening de descuentos del
-- backend era inalcanzable desde el flujo real de venta.
-- ============================================================================

-- (a) consumir_autorizacion_descuento ahora expone el autorizacion_id real
-- consumido (jsonb: {autorizada, autorizacion_id}), no solo un boolean.
-- Único caller es Venta.tsx (ya se actualiza en este mismo cambio).
drop function if exists public.consumir_autorizacion_descuento(uuid, numeric, numeric);

create function public.consumir_autorizacion_descuento(p_variant_id uuid, p_porcentaje numeric, p_descuento_unitario numeric)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_staff public.staff;
  v_limite numeric;
  v_auth_id uuid;
begin
  select * into v_staff from public.staff where user_id=auth.uid() and activo=true limit 1;
  if v_staff.id is null then raise exception 'Personal no válido'; end if;
  if p_porcentaje is null or p_porcentaje<0 or p_porcentaje>100 then raise exception 'Porcentaje inválido'; end if;
  if p_descuento_unitario is null or p_descuento_unitario<0 then raise exception 'Descuento inválido'; end if;
  if private.auth_is_admin() then return jsonb_build_object('autorizada', true, 'autorizacion_id', null); end if;
  select coalesce(descuento_vendedor_max_pct,0) into v_limite from public.configuracion where id=1;
  if p_porcentaje<=coalesce(v_limite,0)+0.0001 then return jsonb_build_object('autorizada', true, 'autorizacion_id', null); end if;
  select a.id into v_auth_id
  from public.autorizaciones_operativas a
  where a.tipo='descuento'
    and a.solicitado_por=v_staff.id
    and a.location_id=private.auth_location_id()
    and a.recurso_tipo='variant'
    and a.recurso_id=p_variant_id::text
    and a.estado='aprobada'
    and a.consumed_at is null
    and coalesce((a.payload->>'porcentaje')::numeric,0)>=p_porcentaje-0.0001
    and coalesce((a.payload->>'descuento_unitario')::numeric,0)>=p_descuento_unitario-0.01
  order by a.resolved_at desc nulls last,a.created_at desc
  limit 1;
  if v_auth_id is null then return jsonb_build_object('autorizada', false, 'autorizacion_id', null); end if;
  if not private.consumir_autorizacion(v_auth_id,'descuento',v_staff.id,'variant',p_variant_id::text) then
    return jsonb_build_object('autorizada', false, 'autorizacion_id', null);
  end if;
  return jsonb_build_object('autorizada', true, 'autorizacion_id', v_auth_id);
end$$;

revoke all on function public.consumir_autorizacion_descuento(uuid, numeric, numeric) from public, anon;
grant execute on function public.consumir_autorizacion_descuento(uuid, numeric, numeric) to authenticated;

-- (b) validar_linea_venta_catalogo: corrige estado='aprobada' → 'consumida'
-- (el bug que hacía imposible cualquier venta con descuento autorizado), y
-- agrega un fallback sin exigir que el cliente reenvíe el autorizacion_id
-- explícito (busca la autorización ya consumida y aún no vinculada del mismo
-- cajero+variante+monto) — defensa en profundidad si algún caller no lo
-- envía. El resto de la lógica (límite, promociones, recompute server-side)
-- se conserva exactamente igual.
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
        else new.precio_unitario
      end;
    end if;
  end if;

  v_permitido_sin_auth := greatest(v_promo_bound, v_manual_libre) + case when new.promocion_id is not null then v_manual_libre else 0 end;

  if new.descuento <= v_permitido_sin_auth + 0.01 then
    new.descuento_origen := case when new.promocion_id is not null then 'promocion' else 'manual' end;
    return new;
  end if;

  if new.autorizacion_id is not null then
    select a.id into v_auth_id
    from public.autorizaciones_operativas a
    where a.id = new.autorizacion_id
      and a.tipo = 'descuento'
      and a.solicitado_por = v_cajero
      and a.recurso_tipo = 'variant'
      and a.recurso_id = new.variant_id::text
      and a.estado = 'consumida'
      and a.consumed_at is not null
      and a.sale_item_id is null
      and coalesce((a.payload->>'porcentaje')::numeric, 0) >= v_pct - 0.01
      and coalesce((a.payload->>'descuento_unitario')::numeric, 0) >= new.descuento - 0.01
    for update;
  end if;

  if v_auth_id is null then
    -- Defensa en profundidad: si el caller no reenvió el autorizacion_id
    -- explícito, busca la autorización ya consumida (por
    -- consumir_autorizacion_descuento, en el mismo carrito) del mismo
    -- cajero+variante+monto que aún no fue vinculada a ninguna línea.
    select a.id into v_auth_id
    from public.autorizaciones_operativas a
    where a.tipo = 'descuento'
      and a.solicitado_por = v_cajero
      and a.recurso_tipo = 'variant'
      and a.recurso_id = new.variant_id::text
      and a.estado = 'consumida'
      and a.consumed_at is not null
      and a.sale_item_id is null
      and coalesce((a.payload->>'porcentaje')::numeric, 0) >= v_pct - 0.01
      and coalesce((a.payload->>'descuento_unitario')::numeric, 0) >= new.descuento - 0.01
    order by a.consumed_at desc
    for update;
  end if;

  if v_auth_id is null then
    raise exception 'Descuento de % por ciento supera el límite permitido (% por ciento) y no tiene autorización válida ni promoción aplicable',
      round(v_pct,1)::text, round(v_limite_pct,1)::text using errcode = 'P0001';
  end if;

  new.autorizacion_id := v_auth_id;
  new.descuento_origen := 'autorizacion';
  return new;
end;
$$;
