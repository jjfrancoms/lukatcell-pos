-- ============================================================================
-- Bug de seguridad sistémico encontrado durante hardening: `staff.puesto in
-- (...)` da NULL (no false) en SQL cuando puesto es NULL, y `not(false or
-- null)` también da NULL — que PL/pgSQL trata como "no lanzar la excepción".
-- Resultado: cualquier cajero SIN puesto asignado (el caso más común) se
-- saltaba por completo el control de permisos en estas 11 funciones
-- operativas. Se corrige envolviendo cada comparación en coalesce(..., '')
-- para que sea siempre estrictamente true/false. No se cambia ninguna otra
-- lógica de negocio de estas funciones.
-- ============================================================================

create or replace function public.actualizar_orden_servicio_tecnica(p_orden_id uuid, p_patch jsonb)
 RETURNS ordenes_servicio
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare s public.staff;o public.ordenes_servicio;v_tec public.staff;v_estado text;
begin
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  if s.id is null or not(s.rol='administrador' or coalesce(s.puesto,'') in('tecnico','encargado','jefa')) then raise exception 'Sin permiso técnico'; end if;
  select * into o from public.ordenes_servicio where id=p_orden_id for update;
  if o.id is null or (s.rol<>'administrador' and o.location_id<>s.location_id) then raise exception 'Orden inválida o de otra sucursal'; end if;
  if s.puesto='tecnico' and s.rol<>'administrador' and o.tecnico_id is not null and o.tecnico_id<>s.id then raise exception 'La orden está asignada a otro técnico'; end if;
  if p_patch ? 'tecnico_id' then
    if s.rol<>'administrador' and coalesce(s.puesto,'') not in('encargado','jefa') then raise exception 'Solo jefa/encargado/admin asigna técnicos'; end if;
    if p_patch->>'tecnico_id' is not null then select * into v_tec from public.staff where id=(p_patch->>'tecnico_id')::uuid and activo and puesto='tecnico' and location_id=o.location_id; if v_tec.id is null then raise exception 'Técnico inválido'; end if; end if;
  end if;
  if p_patch ? 'estado' then v_estado:=p_patch->>'estado'; if v_estado not in('recibido','diagnosticado','en_reparacion','listo','entregado','cancelado') then raise exception 'Estado inválido'; end if; end if;
  update public.ordenes_servicio set
    tecnico_id=case when p_patch?'tecnico_id' then nullif(p_patch->>'tecnico_id','')::uuid else tecnico_id end,
    diagnostico=case when p_patch?'diagnostico' then nullif(btrim(p_patch->>'diagnostico'),'') else diagnostico end,
    estado=case when p_patch?'estado' then v_estado else estado end,
    mano_obra=case when p_patch?'mano_obra' then greatest(0,coalesce((p_patch->>'mano_obra')::numeric,0)) else mano_obra end,
    fecha_prometida=case when p_patch?'fecha_prometida' then nullif(p_patch->>'fecha_prometida','')::timestamptz else fecha_prometida end,
    garantia_dias=case when p_patch?'garantia_dias' then greatest(0,coalesce((p_patch->>'garantia_dias')::int,0)) else garantia_dias end,
    equipo_serial=case when p_patch?'equipo_serial' then nullif(btrim(p_patch->>'equipo_serial'),'') else equipo_serial end,
    equipo_imei=case when p_patch?'equipo_imei' then nullif(btrim(p_patch->>'equipo_imei'),'') else equipo_imei end,
    notas=case when p_patch?'notas' then nullif(btrim(p_patch->>'notas'),'') else notas end
  where id=o.id returning * into o;
  perform private.recalcular_total_orden_servicio(o.id);
  select * into o from public.ordenes_servicio where id=o.id;
  return o;
end$function$;

create or replace function public.agregar_repuesto_orden(p_orden_id uuid, p_variant_id uuid, p_cantidad integer)
 RETURNS orden_servicio_repuestos
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare s public.staff;o public.ordenes_servicio;r public.orden_servicio_repuestos;v_precio numeric;v_costo numeric;
begin
  if p_cantidad<=0 then raise exception 'Cantidad inválida'; end if;
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  if s.id is null or not(s.rol='administrador' or coalesce(s.puesto,'') in('tecnico','encargado','jefa')) then raise exception 'Sin permiso'; end if;
  select * into o from public.ordenes_servicio where id=p_orden_id for update;
  if o.id is null or (s.rol<>'administrador' and o.location_id<>s.location_id) then raise exception 'Orden inválida'; end if;
  if s.puesto='tecnico' and s.rol<>'administrador' and o.tecnico_id is not null and o.tecnico_id<>s.id then raise exception 'Orden asignada a otro técnico'; end if;
  select coalesce(pv.precio_override,p.precio_base,0),coalesce(p.costo,0) into v_precio,v_costo from public.product_variants pv join public.products p on p.id=pv.product_id where pv.id=p_variant_id and p.activo;
  if v_precio is null then raise exception 'Producto inválido'; end if;
  update public.inventory set cantidad=cantidad-p_cantidad,updated_at=now() where variant_id=p_variant_id and location_id=o.location_id and cantidad>=p_cantidad;
  if not found then raise exception 'Stock insuficiente'; end if;
  insert into public.inventory_movements(variant_id,location_id,cantidad_delta,motivo,staff_id) values(p_variant_id,o.location_id,-p_cantidad,'Repuesto orden #'||o.numero,s.id);
  insert into public.orden_servicio_repuestos(orden_id,variant_id,cantidad,precio_unitario,costo_unitario,agregado_por) values(o.id,p_variant_id,p_cantidad,v_precio,v_costo,s.id)
  on conflict(orden_id,variant_id) do update set cantidad=public.orden_servicio_repuestos.cantidad+excluded.cantidad,updated_at=now() returning * into r;
  insert into public.orden_servicio_historial(orden_id,tipo,descripcion,actor_id) values(o.id,'repuesto','Repuesto agregado x'||p_cantidad,s.id);
  perform private.recalcular_total_orden_servicio(o.id);
  return r;
end$function$;

create or replace function public.cerrar_inventario_fisico(p_inventario_id uuid)
 RETURNS inventarios_fisicos
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$declare s public.staff;f public.inventarios_fisicos;i public.inventario_fisico_items;v_control boolean;begin select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;if s.id is null or not(s.rol='administrador' or coalesce(s.puesto,'') in('encargado','jefa')) then raise exception 'Solo administración/encargado puede cerrar conteo';end if;select * into f from public.inventarios_fisicos where id=p_inventario_id for update;if f.id is null or f.location_id<>s.location_id or f.estado<>'abierto' then raise exception 'Conteo no cerrable';end if;if exists(select 1 from public.inventario_fisico_items where inventario_id=f.id and cantidad_contada is null) then raise exception 'Faltan productos por contar';end if;for i in select * from public.inventario_fisico_items where inventario_id=f.id and diferencia<>0 loop select p.control_serial into v_control from public.product_variants pv join public.products p on p.id=pv.product_id where pv.id=i.variant_id;if coalesce(v_control,false) then raise exception 'Producto serializado con diferencia: reconcilia IMEI/series antes de cerrar';end if;insert into public.inventory(variant_id,location_id,cantidad) values(i.variant_id,f.location_id,i.cantidad_contada) on conflict(variant_id,location_id) do update set cantidad=excluded.cantidad,updated_at=now();insert into public.inventory_movements(variant_id,location_id,cantidad_delta,motivo,staff_id) values(i.variant_id,f.location_id,i.diferencia,'Ajuste conteo físico',s.id);end loop;update public.inventarios_fisicos set estado='cerrado',cerrado_por=s.id,fecha_cierre=now() where id=f.id returning * into f;return f;end$function$;

create or replace function public.despachar_transferencia_stock(p_transferencia_id uuid)
 RETURNS transferencias_stock
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$declare s public.staff;t public.transferencias_stock;i public.transferencia_stock_items;begin select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;if s.id is null or not(s.rol='administrador' or coalesce(s.puesto,'') in('tecnico','encargado','jefa')) then raise exception 'Sin permiso';end if;select * into t from public.transferencias_stock where id=p_transferencia_id for update;if t.id is null or t.origen_id<>s.location_id or t.estado<>'borrador' then raise exception 'Transferencia no despachable';end if;for i in select * from public.transferencia_stock_items where transferencia_id=t.id loop update public.inventory set cantidad=cantidad-i.cantidad,updated_at=now() where variant_id=i.variant_id and location_id=t.origen_id and cantidad>=i.cantidad;if not found then raise exception 'Stock insuficiente para transferencia';end if;insert into public.inventory_movements(variant_id,location_id,cantidad_delta,motivo,staff_id) values(i.variant_id,t.origen_id,-i.cantidad,'Transferencia # '||t.numero||' despachada',s.id);end loop;update public.product_serials ps set estado='en_transito',updated_at=now() from public.transferencia_stock_serials ts where ts.transferencia_id=t.id and ts.serial_id=ps.id and ps.location_id=t.origen_id and ps.estado='disponible';update public.transferencias_stock set estado='en_transito',despachado_por=s.id,fecha_despacho=now() where id=t.id returning * into t;return t;end$function$;

create or replace function public.iniciar_inventario_fisico(p_observacion text DEFAULT NULL::text)
 RETURNS inventarios_fisicos
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$declare s public.staff;f public.inventarios_fisicos;begin select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;if s.id is null or not(s.rol='administrador' or coalesce(s.puesto,'') in('tecnico','encargado','jefa')) then raise exception 'Sin permiso';end if;if exists(select 1 from public.inventarios_fisicos where location_id=s.location_id and estado='abierto') then raise exception 'Ya existe un conteo abierto';end if;insert into public.inventarios_fisicos(location_id,creado_por,observacion) values(s.location_id,s.id,nullif(btrim(p_observacion),'')) returning * into f;insert into public.inventario_fisico_items(inventario_id,variant_id,cantidad_sistema) select f.id,i.variant_id,i.cantidad from public.inventory i where i.location_id=s.location_id;return f;end$function$;

create or replace function public.recibir_orden_compra(p_orden_id uuid, p_items jsonb, p_observacion text DEFAULT NULL::text)
 RETURNS recepciones_compra
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$ declare v_staff public.staff;v_orden public.ordenes_compra;v_rec public.recepciones_compra;x jsonb;v_item public.orden_compra_items;v_qty int;v_pend int;v_control boolean;v_seriales jsonb;sx jsonb;v_ri uuid;begin select * into v_staff from public.staff where user_id=auth.uid() and activo=true limit 1;if v_staff.id is null or not(v_staff.rol='administrador' or coalesce(v_staff.puesto,'') in('tecnico','encargado','jefa')) then raise exception 'Sin permiso para recibir compras';end if;select * into v_orden from public.ordenes_compra where id=p_orden_id for update;if v_orden.id is null or v_orden.location_id<>v_staff.location_id then raise exception 'Orden inválida o de otra sucursal';end if;if v_orden.estado in('recibida','cancelada') then raise exception 'Orden no recepcionable';end if;if p_items is null or jsonb_array_length(p_items)=0 then raise exception 'Recepción vacía';end if;insert into public.recepciones_compra(orden_id,recibido_por,observacion) values(v_orden.id,v_staff.id,nullif(btrim(p_observacion),'')) returning * into v_rec;for x in select * from jsonb_array_elements(p_items) loop select * into v_item from public.orden_compra_items where id=(x->>'orden_item_id')::uuid and orden_id=v_orden.id for update;if v_item.id is null then raise exception 'Línea inválida';end if;v_qty:=(x->>'cantidad')::int;if v_qty<=0 or v_item.cantidad_recibida+v_qty>v_item.cantidad_pedida then raise exception 'Cantidad excede pendiente';end if;select p.control_serial into v_control from public.product_variants pv join public.products p on p.id=pv.product_id where pv.id=v_item.variant_id;v_seriales:=coalesce(x->'seriales','[]'::jsonb);if coalesce(v_control,false) and jsonb_array_length(v_seriales)<>v_qty then raise exception 'La recepción requiere % serial(es)',v_qty;end if;insert into public.recepcion_compra_items(recepcion_id,orden_item_id,cantidad,costo_unitario) values(v_rec.id,v_item.id,v_qty,v_item.costo_unitario) returning id into v_ri;update public.orden_compra_items set cantidad_recibida=cantidad_recibida+v_qty where id=v_item.id;insert into public.inventory(variant_id,location_id,cantidad) values(v_item.variant_id,v_orden.location_id,v_qty) on conflict(variant_id,location_id) do update set cantidad=public.inventory.cantidad+excluded.cantidad,updated_at=now();insert into public.inventory_movements(variant_id,location_id,cantidad_delta,motivo,staff_id) values(v_item.variant_id,v_orden.location_id,v_qty,'Recepción compra #'||v_orden.numero,v_staff.id);if coalesce(v_control,false) then for sx in select * from jsonb_array_elements(v_seriales) loop insert into public.product_serials(variant_id,location_id,serial_number,imei2,recepcion_item_id) values(v_item.variant_id,v_orden.location_id,btrim(sx->>'serial_number'),nullif(btrim(sx->>'imei2'),''),v_ri);end loop;end if;end loop;select count(*) into v_pend from public.orden_compra_items where orden_id=v_orden.id and cantidad_recibida<cantidad_pedida;update public.ordenes_compra set estado=case when v_pend=0 then 'recibida' else 'parcial' end,updated_at=now() where id=v_orden.id;return v_rec;end$function$;

create or replace function public.recibir_transferencia_stock(p_transferencia_id uuid)
 RETURNS transferencias_stock
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$declare s public.staff;t public.transferencias_stock;i public.transferencia_stock_items;begin select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;if s.id is null or not(s.rol='administrador' or coalesce(s.puesto,'') in('tecnico','encargado','jefa')) then raise exception 'Sin permiso';end if;select * into t from public.transferencias_stock where id=p_transferencia_id for update;if t.id is null or t.destino_id<>s.location_id or t.estado<>'en_transito' then raise exception 'Transferencia no recibible';end if;for i in select * from public.transferencia_stock_items where transferencia_id=t.id loop insert into public.inventory(variant_id,location_id,cantidad) values(i.variant_id,t.destino_id,i.cantidad) on conflict(variant_id,location_id) do update set cantidad=public.inventory.cantidad+excluded.cantidad,updated_at=now();insert into public.inventory_movements(variant_id,location_id,cantidad_delta,motivo,staff_id) values(i.variant_id,t.destino_id,i.cantidad,'Transferencia # '||t.numero||' recibida',s.id);end loop;update public.product_serials ps set estado='disponible',location_id=t.destino_id,updated_at=now() from public.transferencia_stock_serials ts where ts.transferencia_id=t.id and ts.serial_id=ps.id and ps.estado='en_transito';update public.transferencias_stock set estado='recibida',recibido_por=s.id,fecha_recepcion=now() where id=t.id returning * into t;return t;end$function$;

create or replace function public.registrar_conteo_fisico(p_inventario_id uuid, p_variant_id uuid, p_cantidad integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$declare s public.staff;f public.inventarios_fisicos;begin select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;if s.id is null or not(s.rol='administrador' or coalesce(s.puesto,'') in('tecnico','encargado','jefa')) then raise exception 'Sin permiso';end if;if p_cantidad<0 then raise exception 'Cantidad inválida';end if;select * into f from public.inventarios_fisicos where id=p_inventario_id;if f.id is null or f.location_id<>s.location_id or f.estado<>'abierto' then raise exception 'Conteo no editable';end if;update public.inventario_fisico_items set cantidad_contada=p_cantidad where inventario_id=f.id and variant_id=p_variant_id;if not found then insert into public.inventario_fisico_items(inventario_id,variant_id,cantidad_sistema,cantidad_contada) values(f.id,p_variant_id,0,p_cantidad);end if;return true;end$function$;

create or replace function public.registrar_foto_orden(p_orden_id uuid, p_tipo text, p_storage_path text, p_descripcion text DEFAULT NULL::text)
 RETURNS orden_servicio_fotos
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare s public.staff;o public.ordenes_servicio;f public.orden_servicio_fotos;
begin
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  if s.id is null or not(s.rol='administrador' or coalesce(s.puesto,'') in('tecnico','encargado','jefa')) then raise exception 'Sin permiso'; end if;
  select * into o from public.ordenes_servicio where id=p_orden_id;
  if o.id is null or (s.rol<>'administrador' and o.location_id<>s.location_id) then raise exception 'Orden inválida'; end if;
  if p_tipo not in('antes','despues','diagnostico','otro') then raise exception 'Tipo inválido'; end if;
  if split_part(p_storage_path,'/',1)<>o.location_id::text or split_part(p_storage_path,'/',2)<>o.id::text then raise exception 'Ruta de foto inválida'; end if;
  insert into public.orden_servicio_fotos(orden_id,tipo,storage_path,descripcion,subido_por) values(o.id,p_tipo,p_storage_path,nullif(btrim(p_descripcion),''),s.id) returning * into f;
  insert into public.orden_servicio_historial(orden_id,tipo,descripcion,actor_id) values(o.id,'foto','Foto '||p_tipo||' agregada',s.id);
  return f;
end$function$;

create or replace function public.registrar_seriales(p_variant_id uuid, p_seriales jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$declare s public.staff;x jsonb;v_count int:=0;v_stock int;v_control boolean;begin select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;if s.id is null or not(s.rol='administrador' or coalesce(s.puesto,'') in('tecnico','encargado','jefa')) then raise exception 'Sin permiso';end if;select p.control_serial into v_control from public.product_variants pv join public.products p on p.id=pv.product_id where pv.id=p_variant_id;if not coalesce(v_control,false) then raise exception 'El producto no usa control por serie';end if;select coalesce(cantidad,0) into v_stock from public.inventory where variant_id=p_variant_id and location_id=s.location_id;for x in select * from jsonb_array_elements(p_seriales) loop insert into public.product_serials(variant_id,location_id,serial_number,imei2) values(p_variant_id,s.location_id,btrim(x->>'serial_number'),nullif(btrim(x->>'imei2'),''));v_count:=v_count+1;end loop;if (select count(*) from public.product_serials where variant_id=p_variant_id and location_id=s.location_id and estado='disponible')>v_stock then raise exception 'Hay más seriales disponibles que stock físico';end if;return v_count;end$function$;

create or replace function public.retirar_repuesto_orden(p_repuesto_id uuid, p_cantidad integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare s public.staff;r public.orden_servicio_repuestos;o public.ordenes_servicio;
begin
  if p_cantidad<=0 then raise exception 'Cantidad inválida'; end if;
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  if s.id is null or not(s.rol='administrador' or coalesce(s.puesto,'') in('tecnico','encargado','jefa')) then raise exception 'Sin permiso'; end if;
  select * into r from public.orden_servicio_repuestos where id=p_repuesto_id for update;
  select * into o from public.ordenes_servicio where id=r.orden_id;
  if r.id is null or o.id is null or (s.rol<>'administrador' and o.location_id<>s.location_id) or p_cantidad>r.cantidad then raise exception 'Repuesto inválido'; end if;
  insert into public.inventory(variant_id,location_id,cantidad) values(r.variant_id,o.location_id,p_cantidad) on conflict(variant_id,location_id) do update set cantidad=public.inventory.cantidad+excluded.cantidad,updated_at=now();
  insert into public.inventory_movements(variant_id,location_id,cantidad_delta,motivo,staff_id) values(r.variant_id,o.location_id,p_cantidad,'Retiro repuesto orden #'||o.numero,s.id);
  if p_cantidad=r.cantidad then delete from public.orden_servicio_repuestos where id=r.id; else update public.orden_servicio_repuestos set cantidad=cantidad-p_cantidad,updated_at=now() where id=r.id; end if;
  insert into public.orden_servicio_historial(orden_id,tipo,descripcion,actor_id) values(o.id,'repuesto','Repuesto retirado x'||p_cantidad,s.id);
  perform private.recalcular_total_orden_servicio(o.id);
end$function$;
