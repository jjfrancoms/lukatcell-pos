create or replace function private.ejecutar_anulacion_venta(p_sale_id uuid,p_motivo text,p_actor_id uuid)
returns public.sales language plpgsql security definer set search_path='public'
as $$
declare v_sale public.sales; v_item record;
begin
 if p_motivo is null or length(trim(p_motivo))<5 then raise exception 'Debes indicar un motivo de anulación válido'; end if;
 select * into v_sale from public.sales where id=p_sale_id for update;
 if v_sale.id is null then raise exception 'Venta no encontrada'; end if;
 if v_sale.estado='anulada' then return v_sale; end if;
 if v_sale.estado<>'completada' then raise exception 'Solo se pueden anular ventas completadas'; end if;
 if exists(select 1 from public.comprobantes_electronicos ce where ce.sale_id=v_sale.id) then raise exception 'La venta tiene comprobante electrónico; requiere flujo de nota de crédito'; end if;
 if exists(select 1 from public.pagos_digitales pd where pd.sale_id=v_sale.id and pd.estado='pagado') then raise exception 'La venta tiene pago digital confirmado; requiere flujo de reembolso'; end if;
 for v_item in select si.variant_id,sum(si.cantidad)::integer cantidad from public.sale_items si where si.sale_id=v_sale.id group by si.variant_id loop
  insert into public.inventory(variant_id,location_id,cantidad,updated_at) values(v_item.variant_id,v_sale.location_id,v_item.cantidad,now()) on conflict(variant_id,location_id) do update set cantidad=public.inventory.cantidad+excluded.cantidad,updated_at=now();
  insert into public.inventory_movements(variant_id,location_id,cantidad_delta,motivo,staff_id) values(v_item.variant_id,v_sale.location_id,v_item.cantidad,'Anulación venta #'||v_sale.numero||': '||left(trim(p_motivo),220),p_actor_id);
 end loop;
 update public.ordenes_servicio set venta_id=null where venta_id=v_sale.id;
 update public.sales set estado='anulada',anulada_at=now(),anulada_por=p_actor_id,anulacion_motivo=trim(p_motivo) where id=v_sale.id returning * into v_sale;
 return v_sale;
end $$;

create or replace function public.anular_venta(p_sale_id uuid,p_motivo text)
returns public.sales language plpgsql security definer set search_path='public','private'
as $$ declare v_actor public.staff; begin
 select * into v_actor from public.staff where user_id=auth.uid() and activo=true limit 1;
 if v_actor.id is null or v_actor.rol<>'administrador' then raise exception 'Solo un administrador activo puede anular ventas'; end if;
 return private.ejecutar_anulacion_venta(p_sale_id,p_motivo,v_actor.id);
end $$;

create or replace function public.anular_venta_autorizada(p_sale_id uuid,p_motivo text,p_autorizacion_id uuid)
returns public.sales language plpgsql security definer set search_path='public','private'
as $$ declare v_actor public.staff; begin
 select * into v_actor from public.staff where user_id=auth.uid() and activo=true limit 1;
 if v_actor.id is null then raise exception 'Personal no válido o inactivo'; end if;
 if v_actor.rol='administrador' then return private.ejecutar_anulacion_venta(p_sale_id,p_motivo,v_actor.id); end if;
 if not private.consumir_autorizacion(p_autorizacion_id,'anulacion',v_actor.id,'venta',p_sale_id::text) then raise exception 'La autorización no es válida, no está aprobada o ya fue utilizada'; end if;
 return private.ejecutar_anulacion_venta(p_sale_id,p_motivo,v_actor.id);
end $$;

create or replace function private.ejecutar_devolucion(p_sale_id uuid,p_items jsonb,p_motivo text,p_actor_id uuid)
returns public.devoluciones language plpgsql security definer set search_path='public'
as $$
declare v_sale public.sales; v_dev public.devoluciones; v_json jsonb; v_item public.sale_items; v_cantidad integer; v_devuelta integer; v_monto_linea numeric; v_monto_total numeric:=0; v_total_vendido integer; v_total_devuelto integer;
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
  insert into public.inventory(variant_id,location_id,cantidad,updated_at) values(v_item.variant_id,v_sale.location_id,v_cantidad,now()) on conflict(variant_id,location_id) do update set cantidad=public.inventory.cantidad+excluded.cantidad,updated_at=now();
  insert into public.inventory_movements(variant_id,location_id,cantidad_delta,motivo,staff_id) values(v_item.variant_id,v_sale.location_id,v_cantidad,'Devolución venta #'||v_sale.numero||': '||left(trim(p_motivo),220),p_actor_id);
 end loop;
 select coalesce(sum(si.cantidad),0)::integer into v_total_vendido from public.sale_items si where si.sale_id=v_sale.id;
 select coalesce(sum(di.cantidad),0)::integer into v_total_devuelto from public.devolucion_items di join public.devoluciones d on d.id=di.devolucion_id join public.sale_items si on si.id=di.sale_item_id where si.sale_id=v_sale.id and d.estado='completada';
 update public.devoluciones set monto=round(v_monto_total,2),tipo=case when v_total_devuelto>=v_total_vendido then 'total' else 'parcial' end where id=v_dev.id returning * into v_dev;
 return v_dev;
end $$;

create or replace function public.registrar_devolucion(p_sale_id uuid,p_items jsonb,p_motivo text)
returns public.devoluciones language plpgsql security definer set search_path='public','private'
as $$ declare v_actor public.staff; begin
 select * into v_actor from public.staff where user_id=auth.uid() and activo=true limit 1;
 if v_actor.id is null or v_actor.rol<>'administrador' then raise exception 'Solo un administrador activo puede registrar devoluciones'; end if;
 return private.ejecutar_devolucion(p_sale_id,p_items,p_motivo,v_actor.id);
end $$;

create or replace function public.registrar_devolucion_autorizada(p_sale_id uuid,p_items jsonb,p_motivo text,p_autorizacion_id uuid)
returns public.devoluciones language plpgsql security definer set search_path='public','private'
as $$ declare v_actor public.staff; begin
 select * into v_actor from public.staff where user_id=auth.uid() and activo=true limit 1;
 if v_actor.id is null then raise exception 'Personal no válido o inactivo'; end if;
 if v_actor.rol='administrador' then return private.ejecutar_devolucion(p_sale_id,p_items,p_motivo,v_actor.id); end if;
 if not private.consumir_autorizacion(p_autorizacion_id,'devolucion',v_actor.id,'venta',p_sale_id::text) then raise exception 'La autorización no es válida, no está aprobada o ya fue utilizada'; end if;
 return private.ejecutar_devolucion(p_sale_id,p_items,p_motivo,v_actor.id);
end $$;

revoke all on function private.ejecutar_anulacion_venta(uuid,text,uuid) from public,anon,authenticated;
revoke all on function private.ejecutar_devolucion(uuid,jsonb,text,uuid) from public,anon,authenticated;
revoke all on function public.anular_venta_autorizada(uuid,text,uuid) from public,anon;
revoke all on function public.registrar_devolucion_autorizada(uuid,jsonb,text,uuid) from public,anon;
grant execute on function public.anular_venta_autorizada(uuid,text,uuid) to authenticated;
grant execute on function public.registrar_devolucion_autorizada(uuid,jsonb,text,uuid) to authenticated;
