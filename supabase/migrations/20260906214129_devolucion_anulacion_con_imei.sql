-- ============================================================================
-- Fase 10 del hardening: devoluciones de productos con IMEI/serie.
--
-- Hoy ejecutar_devolucion trata toda línea igual: suma `cantidad` directo a
-- `inventory` y la da por inmediatamente vendible, SIN mirar `product_serials`
-- ni `sale_item_serials` en absoluto. Para un producto serializado eso es
-- doblemente incorrecto: (a) nunca se pregunta CUÁL unidad física regresa
-- (podría "devolverse" cualquier cantidad sin decir el IMEI), y (b) el
-- product_serials de la unidad real sigue marcado 'vendido' para siempre,
-- mientras `inventory.cantidad` sube igual — stock e IMEI quedan
-- permanentemente desincronizados (el invariante de Fase 7).
--
-- Ahora una devolución de un producto serializado exige el/los IMEI exactos
-- devueltos, valida que de verdad pertenezcan a ESA línea de venta (contra
-- sale_item_serials) y los deja en 'cuarentena' — NO disponibles para la
-- venta hasta que alguien los inspeccione — en vez de asumir que devuelto =
-- disponible. `inventory.cantidad` no sube hasta esa resolución explícita.
-- ============================================================================

alter table public.product_serials drop constraint if exists product_serials_estado_check;
alter table public.product_serials add constraint product_serials_estado_check
  check (estado = any (array['disponible','vendido','en_transito','servicio','baja','cuarentena']));

create or replace function private.ejecutar_devolucion(p_sale_id uuid, p_items jsonb, p_motivo text, p_actor_id uuid)
returns devoluciones
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_sale public.sales; v_dev public.devoluciones; v_json jsonb; v_item public.sale_items;
  v_cantidad integer; v_devuelta integer; v_monto_linea numeric; v_monto_total numeric := 0;
  v_total_vendido integer; v_total_devuelto integer;
  v_control_serial boolean; v_serial_ids jsonb; v_serial_id_text text;
begin
  if p_motivo is null or length(trim(p_motivo))<5 then raise exception 'Debes indicar un motivo válido'; end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'La devolución no tiene productos'; end if;
  select * into v_sale from public.sales where id=p_sale_id for update;
  if v_sale.id is null then raise exception 'Venta no encontrada'; end if;
  if v_sale.estado<>'completada' then raise exception 'Solo se admiten devoluciones sobre ventas completadas'; end if;
  insert into public.devoluciones(sale_id,location_id,motivo,creado_por) values(v_sale.id,v_sale.location_id,trim(p_motivo),p_actor_id) returning * into v_dev;
  for v_json in select * from jsonb_array_elements(p_items) loop
    v_cantidad:=coalesce((v_json->>'cantidad')::integer,0); if v_cantidad<=0 then raise exception 'Cantidad de devolución inválida'; end if;
    select * into v_item from public.sale_items where id=(v_json->>'sale_item_id')::uuid and sale_id=v_sale.id for update; if v_item.id is null then raise exception 'Línea de venta inválida'; end if;
    select coalesce(sum(di.cantidad),0)::integer into v_devuelta from public.devolucion_items di join public.devoluciones d on d.id=di.devolucion_id where di.sale_item_id=v_item.id and d.estado='completada';
    if v_devuelta+v_cantidad>v_item.cantidad then raise exception 'La cantidad devuelta supera la cantidad vendida'; end if;
    v_monto_linea:=round((v_item.subtotal/nullif(v_item.cantidad,0))*v_cantidad,2); v_monto_total:=v_monto_total+v_monto_linea;
    insert into public.devolucion_items(devolucion_id,sale_item_id,variant_id,cantidad,monto) values(v_dev.id,v_item.id,v_item.variant_id,v_cantidad,v_monto_linea);

    select p.control_serial into v_control_serial from public.product_variants pv join public.products p on p.id=pv.product_id where pv.id=v_item.variant_id;

    if coalesce(v_control_serial, false) then
      v_serial_ids := coalesce(v_json->'serial_ids', '[]'::jsonb);
      if jsonb_array_length(v_serial_ids) <> v_cantidad then
        raise exception 'Indica exactamente % IMEI/serie a devolver para "%"', v_cantidad, coalesce(v_item.producto_nombre_snapshot, 'este producto');
      end if;
      for v_serial_id_text in select jsonb_array_elements_text(v_serial_ids) loop
        if not exists (select 1 from public.sale_item_serials where sale_item_id = v_item.id and serial_id = v_serial_id_text::uuid) then
          raise exception 'El IMEI/serie indicado no corresponde a lo vendido en esta línea';
        end if;
        update public.product_serials set estado = 'cuarentena', updated_at = now()
        where id = v_serial_id_text::uuid and estado = 'vendido';
        if not found then
          raise exception 'Ese IMEI/serie ya no está vendido (¿ya fue devuelto antes?)';
        end if;
      end loop;
      -- Sin insert a inventory/inventory_movements aquí a propósito: una
      -- unidad serializada devuelta queda en cuarentena, no disponible para
      -- la venta, hasta que alguien la inspeccione (ver
      -- resolver_cuarentena_serial más abajo).
    else
      insert into public.inventory(variant_id,location_id,cantidad,updated_at) values(v_item.variant_id,v_sale.location_id,v_cantidad,now()) on conflict(variant_id,location_id) do update set cantidad=public.inventory.cantidad+excluded.cantidad,updated_at=now();
      insert into public.inventory_movements(variant_id,location_id,cantidad_delta,motivo,staff_id) values(v_item.variant_id,v_sale.location_id,v_cantidad,'Devolución venta #'||v_sale.numero||': '||left(trim(p_motivo),220),p_actor_id);
    end if;
  end loop;
  select coalesce(sum(si.cantidad),0)::integer into v_total_vendido from public.sale_items si where si.sale_id=v_sale.id;
  select coalesce(sum(di.cantidad),0)::integer into v_total_devuelto from public.devolucion_items di join public.devoluciones d on d.id=di.devolucion_id join public.sale_items si on si.id=di.sale_item_id where si.sale_id=v_sale.id and d.estado='completada';
  update public.devoluciones set monto=round(v_monto_total,2),tipo=case when v_total_devuelto>=v_total_vendido then 'total' else 'parcial' end where id=v_dev.id returning * into v_dev;
  return v_dev;
end $function$;

-- ----------------------------------------------------------------------------
-- Resuelve una unidad en cuarentena tras inspeccionarla: si está en buen
-- estado, recién ahí vuelve a inventory (+1) como 'disponible'; si no, pasa
-- a 'servicio' (reparación) o 'baja' (no vendible / se gestiona con el
-- proveedor) sin tocar inventory (nunca estuvo contada como disponible).
-- ----------------------------------------------------------------------------
create or replace function public.resolver_cuarentena_serial(p_serial_id uuid, p_decision text, p_observacion text default null)
returns product_serials
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_staff public.staff;
  v_serial public.product_serials;
begin
  select * into v_staff from public.staff where user_id = auth.uid() and activo = true limit 1;
  if v_staff.id is null or not (v_staff.rol = 'administrador' or coalesce(v_staff.puesto, '') in ('encargado', 'jefa')) then
    raise exception 'Solo administración, encargado o jefa pueden resolver una cuarentena de IMEI/serie';
  end if;
  if p_decision not in ('disponible', 'servicio', 'baja') then
    raise exception 'Decisión inválida';
  end if;

  select * into v_serial from public.product_serials where id = p_serial_id and estado = 'cuarentena' for update;
  if v_serial.id is null then
    raise exception 'Ese IMEI/serie no está en cuarentena';
  end if;

  update public.product_serials set estado = p_decision, updated_at = now() where id = v_serial.id returning * into v_serial;

  if p_decision = 'disponible' then
    insert into public.inventory(variant_id, location_id, cantidad, updated_at)
    values (v_serial.variant_id, v_serial.location_id, 1, now())
    on conflict (variant_id, location_id) do update set cantidad = public.inventory.cantidad + 1, updated_at = now();
    insert into public.inventory_movements(variant_id, location_id, cantidad_delta, motivo, staff_id)
    values (v_serial.variant_id, v_serial.location_id, 1, 'Cuarentena resuelta: disponible de nuevo (' || v_serial.serial_number || ')' || coalesce(' — ' || p_observacion, ''), v_staff.id);
  end if;

  return v_serial;
end;
$$;

revoke all on function public.resolver_cuarentena_serial(uuid, text, text) from public, anon;
grant execute on function public.resolver_cuarentena_serial(uuid, text, text) to authenticated;

-- ============================================================================
-- Fase 11 del hardening: anulaciones de ventas con IMEI/serie.
--
-- Mismo hallazgo que en devoluciones: ejecutar_anulacion_venta reponía stock
-- sumando cantidad_vendida directo a `inventory` sin mirar product_serials/
-- sale_item_serials — el IMEI real seguía "vendido" para siempre mientras el
-- conteo agregado subía igual. Además, anular una venta que ya tenía una
-- devolución completada habría duplicado la reposición (ya se había repuesto
-- por la devolución, y ahora se repondría otra vez por la cantidad original
-- completa). Y el efectivo cobrado nunca se reflejaba de vuelta en el libro
-- de caja: la caja seguía "esperando" ese dinero aunque la venta ya no
-- existiera.
--
-- Ahora: los IMEI vendidos en la venta anulada vuelven directo a
-- 'disponible' (a diferencia de una devolución de cliente, aquí el celular
-- nunca salió físicamente de la tienda, así que no necesita cuarentena);
-- se bloquea anular una venta que ya tiene una devolución completada; y un
-- pago en efectivo genera su reversión en cash_movements.
-- ============================================================================

create or replace function private.ejecutar_anulacion_venta(p_sale_id uuid, p_motivo text, p_actor_id uuid)
returns sales
language plpgsql
security definer
set search_path = public, private
as $function$
declare
  v_sale public.sales;
  v_item record;
  v_pago record;
  v_control_serial boolean;
  v_serial_id uuid;
  v_repuestas integer;
begin
  if p_motivo is null or length(trim(p_motivo))<5 then raise exception 'Debes indicar un motivo de anulación válido'; end if;
  select * into v_sale from public.sales where id=p_sale_id for update;
  if v_sale.id is null then raise exception 'Venta no encontrada'; end if;
  if v_sale.estado='anulada' then return v_sale; end if;
  if v_sale.estado<>'completada' then raise exception 'Solo se pueden anular ventas completadas'; end if;
  if exists(select 1 from public.comprobantes_electronicos ce where ce.sale_id=v_sale.id) then raise exception 'La venta tiene comprobante electrónico; requiere flujo de nota de crédito'; end if;
  if exists(select 1 from public.pagos_digitales pd where pd.sale_id=v_sale.id and pd.estado='pagado') then raise exception 'La venta tiene pago digital confirmado; requiere flujo de reembolso'; end if;
  if exists(select 1 from public.devoluciones d where d.sale_id=v_sale.id and d.estado='completada') then raise exception 'Esta venta ya tiene una devolución registrada; anula lo restante desde el flujo de devolución, no como anulación completa'; end if;

  for v_item in select si.id, si.variant_id, si.cantidad from public.sale_items si where si.sale_id=v_sale.id loop
    select p.control_serial into v_control_serial from public.product_variants pv join public.products p on p.id=pv.product_id where pv.id=v_item.variant_id;

    if coalesce(v_control_serial, false) then
      v_repuestas := 0;
      for v_serial_id in select serial_id from public.sale_item_serials where sale_item_id = v_item.id loop
        update public.product_serials set estado='disponible', sale_id=null, sold_at=null, updated_at=now()
        where id = v_serial_id and estado = 'vendido';
        if found then v_repuestas := v_repuestas + 1; end if;
      end loop;
      if v_repuestas > 0 then
        insert into public.inventory(variant_id,location_id,cantidad,updated_at) values(v_item.variant_id,v_sale.location_id,v_repuestas,now())
        on conflict(variant_id,location_id) do update set cantidad=public.inventory.cantidad+excluded.cantidad,updated_at=now();
        insert into public.inventory_movements(variant_id,location_id,cantidad_delta,motivo,staff_id)
        values(v_item.variant_id,v_sale.location_id,v_repuestas,'Anulación venta #'||v_sale.numero||': '||left(trim(p_motivo),220),p_actor_id);
      end if;
    else
      insert into public.inventory(variant_id,location_id,cantidad,updated_at) values(v_item.variant_id,v_sale.location_id,v_item.cantidad,now())
      on conflict(variant_id,location_id) do update set cantidad=public.inventory.cantidad+excluded.cantidad,updated_at=now();
      insert into public.inventory_movements(variant_id,location_id,cantidad_delta,motivo,staff_id)
      values(v_item.variant_id,v_sale.location_id,v_item.cantidad,'Anulación venta #'||v_sale.numero||': '||left(trim(p_motivo),220),p_actor_id);
    end if;
  end loop;

  if v_sale.cash_session_id is not null then
    for v_pago in select * from public.payments where sale_id = v_sale.id and metodo = 'efectivo' loop
      perform private.insertar_movimiento_caja(
        v_sale.cash_session_id, 'venta_efectivo', -v_pago.monto,
        'Reversión por anulación de venta #' || v_sale.numero, p_actor_id, 'sale', v_sale.id
      );
    end loop;
  end if;

  update public.ordenes_servicio set venta_id=null where venta_id=v_sale.id;
  update public.sales set estado='anulada',anulada_at=now(),anulada_por=p_actor_id,anulacion_motivo=trim(p_motivo) where id=v_sale.id returning * into v_sale;
  return v_sale;
end;
$function$;
