-- ============================================================================
-- P0.3 bloques 1 y 2.
--
-- BLOQUE 1 — BUG CRÍTICO: el BEFORE INSERT escribía sale_item_id.
--   validar_linea_venta_catalogo corre BEFORE INSERT ON sale_items y hacía:
--       update autorizaciones_operativas set ..., sale_item_id = new.id
--   pero autorizaciones_operativas_sale_item_id_fkey -> sale_items(id) NO es
--   DEFERRABLE. En un BEFORE INSERT el NEW.id ya tiene UUID pero la fila de
--   sale_items todavía NO existe, así que la FK se valida de inmediato y
--   falla. Verificado empíricamente contra producción (con rollback):
--   "FK VIOLATION CONFIRMADA".
--
--   Impacto real: con descuento_vendedor_max_pct = 0.00, CUALQUIER descuento
--   de un cajero no-admin requiere autorización, así que este era el único
--   camino posible para descontar y estaba 100% roto. No explotó en vivo
--   sólo porque autorizaciones_operativas está vacía: nadie ha usado todavía
--   el flujo de autorización en producción.
--
--   Corrección: el BEFORE INSERT valida y consume (estado/consumed_at) pero
--   NO toca sale_item_id. El vínculo lo hace el trigger AFTER INSERT que ya
--   existía para eso (private.vincular_autorizacion_descuento), cuando la
--   fila de sale_items ya existe y la FK puede satisfacerse. Todo sigue en la
--   MISMA transacción: si algo posterior falla, el ROLLBACK revierte estado,
--   consumed_at y sale_item_id juntos.
--
-- BLOQUE 2 — Promoción no acumulable admitía descuento manual extra.
--   La fórmula era:
--       greatest(promo, manual) + (manual si hay promocion_id)
--   Con promoción no acumulable de 10% y límite de vendedor 5%, eso aceptaba
--   ~15%. Hoy está latente porque el límite es 0%, pero se activa el día que
--   alguien lo suba. La regla correcta, que es además la que YA aplica el
--   frontend en Venta.tsx, es:
--       acumulable      -> promo + manual
--       no acumulable   -> max(promo, manual)
--
--   `acumulable` se lee de promociones por PK usando el promocion_id que ya
--   fue validado contra el techo canónico del carrito. Se prefirió esto antes
--   que agregar la columna a venta_promo_ceiling porque eso obligaba a
--   regenerar registrar_venta entera — y regenerar esa función es justamente
--   lo que introdujo la sobrecarga ambigua que rompió las ventas con
--   promoción en P0.2. El valor es idéntico (misma transacción, misma fila) y
--   se evita volver a tocar la función más peligrosa del sistema.
-- ============================================================================

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
  v_acumulable boolean;
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
    new.autorizacion_id := null;
    return new;
  end if;

  select s.cajero_id, s.location_id into v_cajero, v_location from public.sales s where s.id = new.sale_id;
  select exists(select 1 from public.staff st where st.id = v_cajero and st.rol = 'administrador') into v_es_admin;

  if v_es_admin then
    -- Un administrador no consume autorizaciones: su descuento no tiene tope.
    -- Se limpia cualquier autorizacion_id que haya mandado el cliente, para
    -- que el trigger AFTER INSERT no intente vincular una autorización que
    -- nunca fue validada ni consumida por este camino.
    new.autorizacion_id := null;
    new.descuento_origen := case when new.promocion_id is not null then 'promocion' else 'manual' end;
    return new;
  end if;

  select coalesce(descuento_vendedor_max_pct, 0) into v_limite_pct from public.configuracion where id = 1;
  v_pct := (new.descuento / nullif(new.precio_unitario, 0)) * 100;
  v_manual_libre := (v_limite_pct / 100.0) * new.precio_unitario;

  if to_regclass('pg_temp.venta_promo_ceiling') is not null then
    select promocion_id, descuento_max into v_promo_id_esperado, v_promo_bound
    from venta_promo_ceiling where variant_id = new.variant_id;
  end if;
  v_promo_bound := coalesce(v_promo_bound, 0);

  if new.promocion_id is not null and new.promocion_id is distinct from v_promo_id_esperado then
    raise exception 'La promoción indicada no es válida para este producto en esta venta' using errcode = 'P0001';
  end if;

  -- P0.3 bloque 2: la acumulabilidad decide si el descuento manual del
  -- vendedor puede SUMARSE al de la promoción o si sólo se toma el mayor.
  if v_promo_bound > 0 and v_promo_id_esperado is not null then
    select p.acumulable into v_acumulable from public.promociones p where p.id = v_promo_id_esperado;
  end if;
  v_acumulable := coalesce(v_acumulable, false);

  if v_promo_bound > 0 and v_acumulable then
    v_permitido_sin_auth := v_promo_bound + v_manual_libre;
  else
    v_permitido_sin_auth := greatest(v_promo_bound, v_manual_libre);
  end if;

  if new.descuento <= v_permitido_sin_auth + 0.01 then
    new.descuento_origen := case when new.promocion_id is not null then 'promocion' else 'manual' end;
    new.autorizacion_id := null;
    return new;
  end if;

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

  -- Se consume, pero NO se escribe sale_item_id: la fila de sale_items aún no
  -- existe y la FK no es deferrable. El vínculo lo hace el AFTER INSERT.
  update public.autorizaciones_operativas
  set estado = 'consumida', consumed_at = now()
  where id = v_auth_id;

  new.autorizacion_id := v_auth_id;
  new.descuento_origen := 'autorizacion';
  return new;
end;
$function$;

-- ----------------------------------------------------------------------------
-- AFTER INSERT: ahora la fila de sale_items sí existe, así que la FK puede
-- satisfacerse. Falla ruidosamente si no logra vincular: una autorización
-- consumida que no queda atada a su línea de venta es exactamente el estado
-- inconsistente que este bloque busca impedir, y al fallar aquí el ROLLBACK
-- deshace también el consumo.
-- ----------------------------------------------------------------------------
create or replace function private.vincular_autorizacion_descuento()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_filas int;
begin
  if new.descuento_origen = 'autorizacion' and new.autorizacion_id is not null then
    update public.autorizaciones_operativas
    set sale_item_id = new.id
    where id = new.autorizacion_id
      and estado = 'consumida'
      and sale_item_id is null;

    get diagnostics v_filas = row_count;
    if v_filas <> 1 then
      raise exception 'No se pudo vincular la autorización % a la línea de venta (¿ya estaba vinculada o no quedó consumida?)',
        new.autorizacion_id using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$function$;
