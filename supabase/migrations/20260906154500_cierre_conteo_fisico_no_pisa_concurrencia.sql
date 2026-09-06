-- ============================================================================
-- Fase 12 del hardening: "se realiza un conteo mientras otra persona vende".
--
-- cerrar_inventario_fisico hoy hace
--   insert into inventory(...) on conflict(...) do update set cantidad=excluded.cantidad
-- es decir, SOBRESCRIBE inventory.cantidad con el valor contado al iniciar el
-- conteo. Si entre que se abrió el conteo (snapshot de cantidad_sistema) y
-- que se cierra alguien vendió, recibió una compra o hizo una transferencia
-- de ese mismo SKU, ese movimiento real se BORRA silenciosamente al cerrar
-- — inventory vuelve a un número que ya no es cierto ni el contado ni el
-- que reflejaba las ventas de por medio.
--
-- `diferencia` (columna generada = cantidad_contada - cantidad_sistema, no
-- editable por el cliente) es exactamente el ajuste que el conteo físico
-- descubrió, independiente de lo que haya pasado con inventory mientras
-- tanto. Aplicar esa diferencia como un DELTA relativo sobre el
-- inventory.cantidad ACTUAL (snapshot + movimientos posteriores, la opción
-- preferida) en vez de un valor absoluto es lo que evita pisar ventas
-- concurrentes.
-- ============================================================================

create or replace function public.cerrar_inventario_fisico(p_inventario_id uuid)
returns inventarios_fisicos
language plpgsql
security definer
set search_path = public, private
as $function$
declare
  s public.staff;
  f public.inventarios_fisicos;
  i public.inventario_fisico_items;
  v_control boolean;
  v_actual integer;
  v_nuevo integer;
  v_motivo text;
begin
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  if s.id is null or not(s.rol='administrador' or coalesce(s.puesto,'') in('encargado','jefa')) then
    raise exception 'Solo administración/encargado puede cerrar conteo';
  end if;
  select * into f from public.inventarios_fisicos where id=p_inventario_id for update;
  if f.id is null or f.location_id<>s.location_id or f.estado<>'abierto' then
    raise exception 'Conteo no cerrable';
  end if;
  if exists(select 1 from public.inventario_fisico_items where inventario_id=f.id and cantidad_contada is null) then
    raise exception 'Faltan productos por contar';
  end if;

  for i in select * from public.inventario_fisico_items where inventario_id=f.id and diferencia<>0 loop
    select p.control_serial into v_control from public.product_variants pv join public.products p on p.id=pv.product_id where pv.id=i.variant_id;
    if coalesce(v_control,false) then
      raise exception 'Producto serializado con diferencia: reconcilia IMEI/series antes de cerrar';
    end if;

    select cantidad into v_actual from public.inventory where variant_id=i.variant_id and location_id=f.location_id for update;
    v_actual := coalesce(v_actual, 0);
    v_nuevo := v_actual + i.diferencia;
    v_motivo := 'Ajuste conteo físico';
    if v_nuevo < 0 then
      -- No se crea stock negativo: probablemente hubo ventas entre el conteo
      -- y el cierre que ya redujeron más de lo que el conteo esperaba. Se
      -- deja en 0 (nunca negativo) y queda visible en el motivo para revisar.
      v_motivo := v_motivo || ' (ajustado a 0: el conteo esperaba menos de lo que ya se vendió después de iniciarlo)';
      v_nuevo := 0;
    end if;

    insert into public.inventory(variant_id,location_id,cantidad,updated_at) values(i.variant_id,f.location_id,v_nuevo,now())
    on conflict(variant_id,location_id) do update set cantidad=v_nuevo,updated_at=now();
    insert into public.inventory_movements(variant_id,location_id,cantidad_delta,motivo,staff_id) values(i.variant_id,f.location_id,v_nuevo-v_actual,v_motivo,s.id);
  end loop;

  update public.inventarios_fisicos set estado='cerrado',cerrado_por=s.id,fecha_cierre=now() where id=f.id returning * into f;
  return f;
end$function$;
