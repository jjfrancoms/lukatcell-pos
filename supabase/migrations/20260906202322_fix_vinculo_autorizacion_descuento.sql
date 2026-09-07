-- Corrige un bug real detectado en pruebas: validar_linea_venta_catalogo corre
-- BEFORE INSERT, así que intentar vincular autorizaciones_operativas.sale_item_id
-- = new.id ahí mismo viola la FK (la fila de sale_items todavía no existe
-- físicamente en ese momento). El vínculo se mueve a un trigger AFTER INSERT
-- separado; la validación/rechazo sigue ocurriendo en el BEFORE (sin cambios
-- en esa lógica), solo se retira el UPDATE prematuro.

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

  -- No se vincula aquí (BEFORE INSERT: new.id todavía no existe en sale_items).
  -- Queda registrado el autorizacion_id para que el trigger AFTER haga el vínculo.
  new.descuento_origen := 'autorizacion';
  return new;
end;
$$;

create or replace function private.vincular_autorizacion_descuento()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.descuento_origen = 'autorizacion' and new.autorizacion_id is not null then
    update public.autorizaciones_operativas
    set sale_item_id = new.id
    where id = new.autorizacion_id
      and sale_item_id is null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_vincular_autorizacion_descuento on public.sale_items;
create trigger trg_vincular_autorizacion_descuento
  after insert on public.sale_items
  for each row execute function private.vincular_autorizacion_descuento();
