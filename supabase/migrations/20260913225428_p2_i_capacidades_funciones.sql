-- ============================================================================
-- P2.I — FASE 24 · Funciones con capacidades centralizadas
-- ============================================================================
-- GENERADO por scripts/generar-p2i.mjs con la regla de scripts/lib/capacidades.mjs.
-- NO editar a mano: regenerar.
--
-- Cada autorización por lista literal de puestos se sustituye por
-- private.tiene_capacidad(...) (_p2_h). Misma firma y atributos: CREATE OR
-- REPLACE conserva los privilegios. Para el personal de producción actual el
-- resultado es idéntico (ver _p2_h); además, puede_inventario y puede_taller de
-- la sucursal activa pasan a aplicarse de verdad.
--
-- Incluye funciones que P0 declaró intocables; el ensayo verifica que su cuerpo
-- final es exactamente el anterior con esta sustitución (y la de _p2_b).
--
-- Funciones (17):
--   public.actualizar_orden_servicio_tecnica(p_orden_id uuid, p_patch jsonb)  [operar_taller, supervisar × 2]
--   public.agregar_repuesto_orden(p_orden_id uuid, p_variant_id uuid, p_cantidad integer)  [operar_taller × 1]
--   public.ajustar_stock(p_variant_id uuid, p_location_id uuid, p_cantidad_delta integer, p_motivo text)  [operar_inventario × 1]
--   public.cerrar_inventario_fisico(p_inventario_id uuid)  [supervisar × 1]
--   public.despachar_transferencia_stock(p_transferencia_id uuid)  [operar_inventario × 1]
--   public.iniciar_inventario_fisico(p_observacion text DEFAULT NULL::text)  [operar_inventario × 1]
--   public.marcar_dispositivo_fuera_de_servicio(p_device_id text, p_motivo text)  [supervisar × 1]
--   public.recibir_orden_compra(p_orden_id uuid, p_client_transaction_id uuid, p_items jsonb, p_observacion text DEFAULT NULL::text, p_corrige_recepcion_id uuid DEFAULT NULL::uuid)  [operar_inventario × 1]
--   public.recibir_transferencia_parcial(p_transferencia_id uuid, p_client_transaction_id uuid, p_items jsonb DEFAULT NULL::jsonb, p_observacion text DEFAULT NULL::text, p_cerrar boolean DEFAULT false)  [operar_inventario × 1]
--   public.registrar_conteo_fisico(p_inventario_id uuid, p_variant_id uuid, p_cantidad integer)  [operar_inventario × 1]
--   public.registrar_foto_orden(p_orden_id uuid, p_tipo text, p_storage_path text, p_descripcion text DEFAULT NULL::text)  [operar_taller × 1]
--   public.registrar_movimiento_caja(p_cash_session_id uuid, p_tipo text, p_monto numeric, p_motivo text, p_client_transaction_id uuid DEFAULT NULL::uuid, p_autorizacion_id uuid DEFAULT NULL::uuid)  [supervisar × 1]
--   public.registrar_serial_contado(p_inventario_id uuid, p_variant_id uuid, p_serial_number text)  [operar_inventario × 1]
--   public.registrar_seriales(p_variant_id uuid, p_seriales jsonb)  [operar_inventario × 1]
--   public.resolver_cuarentena_serial(p_serial_id uuid, p_decision text, p_observacion text DEFAULT NULL::text)  [supervisar × 1]
--   public.resolver_reconciliacion_serial(p_item_id uuid, p_tipo text, p_nota text DEFAULT NULL::text)  [supervisar × 1]
--   public.retirar_repuesto_orden(p_repuesto_id uuid, p_cantidad integer)  [operar_taller × 1]
-- ============================================================================

-- public.actualizar_orden_servicio_tecnica
CREATE OR REPLACE FUNCTION public.actualizar_orden_servicio_tecnica(p_orden_id uuid, p_patch jsonb)
 RETURNS ordenes_servicio
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare s public.staff;o public.ordenes_servicio;v_tec public.staff;v_estado text;
begin
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  if s.id is null or not(private.tiene_capacidad('operar_taller')) then raise exception 'Sin permiso técnico'; end if;
  select * into o from public.ordenes_servicio where id=p_orden_id for update;
  if o.id is null or (s.rol<>'administrador' and o.location_id<>private.auth_location_id()) then raise exception 'Orden inválida o de otra sucursal'; end if;
  if s.puesto='tecnico' and s.rol<>'administrador' and o.tecnico_id is not null and o.tecnico_id<>s.id then raise exception 'La orden está asignada a otro técnico'; end if;
  if p_patch ? 'tecnico_id' then
    if not private.tiene_capacidad('supervisar') then raise exception 'Solo jefa/encargado/admin asigna técnicos'; end if;
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
end$function$
;

-- public.agregar_repuesto_orden
CREATE OR REPLACE FUNCTION public.agregar_repuesto_orden(p_orden_id uuid, p_variant_id uuid, p_cantidad integer)
 RETURNS orden_servicio_repuestos
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare s public.staff;o public.ordenes_servicio;r public.orden_servicio_repuestos;v_precio numeric;v_costo numeric;
begin
  if p_cantidad<=0 then raise exception 'Cantidad inválida'; end if;
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  if s.id is null or not(private.tiene_capacidad('operar_taller')) then raise exception 'Sin permiso'; end if;
  select * into o from public.ordenes_servicio where id=p_orden_id for update;
  if o.id is null or (s.rol<>'administrador' and o.location_id<>private.auth_location_id()) then raise exception 'Orden inválida'; end if;
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
end$function$
;

-- public.ajustar_stock
CREATE OR REPLACE FUNCTION public.ajustar_stock(p_variant_id uuid, p_location_id uuid, p_cantidad_delta integer, p_motivo text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_staff public.staff;
  v_location uuid;
  v_control_serial boolean;
  v_actual integer;
begin
  select * into v_staff from public.staff where user_id = auth.uid() and activo = true limit 1;
  if v_staff.id is null then
    raise exception 'Personal no válido o inactivo' using errcode = 'P0001';
  end if;
  -- OJO: con puesto IS NULL, `puesto in (...)` da NULL (no false) en SQL, y
  -- `not (false or null)` también da NULL, que plpgsql trata como "no lanzar".
  if not (private.tiene_capacidad('operar_inventario')) then
    raise exception 'No tienes permiso para ajustar inventario' using errcode = 'P0001';
  end if;

  if p_location_id is null then
    v_location := private.auth_location_id();
  elsif v_staff.rol = 'administrador' then
    v_location := p_location_id;
  elsif p_location_id = private.auth_location_id() then
    v_location := p_location_id;
  elsif exists (
    select 1 from public.staff_locations sl
    where sl.staff_id = v_staff.id and sl.location_id = p_location_id and sl.puede_inventario
  ) then
    v_location := p_location_id;
  else
    raise exception 'No tienes autorización para ajustar inventario en esa sucursal' using errcode = 'P0001';
  end if;

  select p.control_serial into v_control_serial
  from public.product_variants pv
  join public.products p on p.id = pv.product_id
  where pv.id = p_variant_id;

  if coalesce(v_control_serial, false) then
    raise exception 'Este producto se controla por IMEI/serie — usa el flujo de seriales, no el ajuste genérico de stock' using errcode = 'P0001';
  end if;

  select cantidad into v_actual from public.inventory where variant_id = p_variant_id and location_id = v_location for update;
  v_actual := coalesce(v_actual, 0);

  if v_actual + p_cantidad_delta < 0 then
    raise exception 'Stock insuficiente. Disponible: %. Intentaste retirar: %.', v_actual, abs(p_cantidad_delta) using errcode = 'P0001';
  end if;

  insert into public.inventory (variant_id, location_id, cantidad, updated_at)
  values (p_variant_id, v_location, v_actual + p_cantidad_delta, now())
  on conflict (variant_id, location_id) do update set cantidad = excluded.cantidad, updated_at = now();

  -- staff_id siempre es el actor autenticado real: nunca un parámetro del cliente.
  insert into public.inventory_movements (variant_id, location_id, cantidad_delta, motivo, staff_id)
  values (p_variant_id, v_location, p_cantidad_delta, p_motivo, v_staff.id);
end;
$function$
;

-- public.cerrar_inventario_fisico
CREATE OR REPLACE FUNCTION public.cerrar_inventario_fisico(p_inventario_id uuid)
 RETURNS inventarios_fisicos
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare
  s public.staff;
  f public.inventarios_fisicos;
  i public.inventario_fisico_items;
  v_control boolean;
  v_movimientos_hasta_conteo integer;
  v_esperado_al_contar integer;
  v_real_diff integer;
  v_actual integer;
  v_nuevo integer;
  v_motivo text;
  v_pendientes int;
  v_bloqueantes int;
begin
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  if s.id is null or not(private.tiene_capacidad('supervisar')) then
    raise exception 'Solo administración/encargado puede cerrar conteo';
  end if;
  select * into f from public.inventarios_fisicos where id=p_inventario_id for update;
  if f.id is null or f.location_id<>private.auth_location_id() or f.estado<>'abierto' then
    raise exception 'Conteo no cerrable';
  end if;

  -- Sólo las NO serializadas requieren una cantidad escrita: las
  -- serializadas se rigen por la reconciliación unidad por unidad.
  if exists(
    select 1 from public.inventario_fisico_items ifi
    join public.product_variants pv on pv.id = ifi.variant_id
    join public.products p on p.id = pv.product_id
    where ifi.inventario_id=f.id and ifi.cantidad_contada is null and not coalesce(p.control_serial,false)
  ) then
    raise exception 'Faltan productos por contar';
  end if;

  for i in select * from public.inventario_fisico_items where inventario_id=f.id order by variant_id loop
    select p.control_serial into v_control from public.product_variants pv join public.products p on p.id=pv.product_id where pv.id=i.variant_id;

    select coalesce(sum(im.cantidad_delta),0) into v_movimientos_hasta_conteo
    from public.inventory_movements im
    where im.variant_id=i.variant_id and im.location_id=f.location_id
      and im.created_at > f.fecha_inicio and im.created_at <= coalesce(i.counted_at, now());
    v_esperado_al_contar := i.cantidad_sistema + v_movimientos_hasta_conteo;

    if coalesce(v_control,false) then
      select count(*) into v_pendientes from public.inventario_fisico_seriales
      where inventario_id=f.id and variant_id=i.variant_id
        and estado_reconciliacion not in ('coincide','resuelto');
      if v_pendientes > 0 then
        raise exception 'Quedan % serial(es) sin reconciliar en un producto serializado', v_pendientes using errcode = 'P0001';
      end if;

      select count(*) into v_bloqueantes from public.inventario_fisico_seriales
      where inventario_id=f.id and variant_id=i.variant_id
        and estado_reconciliacion='resuelto'
        and coalesce(tipo_resolucion,'') in ('investigacion','recepcion_omitida');
      if v_bloqueantes > 0 then
        raise exception 'Hay % serial(es) en investigación o pendientes de una recepción real: resuélvelos con un tipo definitivo antes de cerrar', v_bloqueantes using errcode = 'P0001';
      end if;

      -- R7: el bloque que había aquí contaba los seriales ANTES de bloquear
      -- inventory. Esta función hace lo contrario, que es lo correcto.
      perform private.sincronizar_stock_serializado(
        i.variant_id, f.location_id, s.id,
        'Conteo físico: stock alineado a los IMEI/serie realmente disponibles');
      continue;
    end if;

    v_real_diff := i.cantidad_contada - v_esperado_al_contar;

    if v_real_diff <> 0 then
      select cantidad into v_actual from public.inventory where variant_id=i.variant_id and location_id=f.location_id for update;
      v_actual := coalesce(v_actual, 0);
      v_nuevo := v_actual + v_real_diff;
      v_motivo := 'Ajuste conteo físico';
      if v_nuevo < 0 then
        v_motivo := v_motivo || ' (ajustado a 0: movimientos posteriores ya redujeron más de lo esperado)';
        v_nuevo := 0;
      end if;

      insert into public.inventory(variant_id,location_id,cantidad,updated_at) values(i.variant_id,f.location_id,v_nuevo,now())
      on conflict(variant_id,location_id) do update set cantidad=v_nuevo,updated_at=now();
      insert into public.inventory_movements(variant_id,location_id,cantidad_delta,motivo,staff_id) values(i.variant_id,f.location_id,v_nuevo-v_actual,v_motivo,s.id);
    end if;
  end loop;

  update public.inventarios_fisicos set estado='cerrado',cerrado_por=s.id,fecha_cierre=now() where id=f.id returning * into f;
  return f;
end$function$
;

-- public.despachar_transferencia_stock
CREATE OR REPLACE FUNCTION public.despachar_transferencia_stock(p_transferencia_id uuid)
 RETURNS transferencias_stock
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare
  s public.staff;
  t public.transferencias_stock;
  i public.transferencia_stock_items;
  v_loc uuid;
  v_control boolean;
  v_movidos int;
  v_manifiesto int;
begin
  select * into s from public.staff where user_id = auth.uid() and activo = true limit 1;
  if s.id is null or not(private.tiene_capacidad('operar_inventario')) then
    raise exception 'Sin permiso' using errcode = '42501';
  end if;
  v_loc := coalesce(private.auth_location_id(), private.auth_location_id());

  -- Punto de serialización. Todo lo demás ocurre con la cabecera bloqueada.
  select * into t from public.transferencias_stock where id = p_transferencia_id for update;
  if t.id is null then
    raise exception 'Transferencia inexistente' using errcode = 'P0001';
  end if;

  -- PERMISO POR SUCURSAL EN SERVIDOR: despacha el ORIGEN.
  -- Fallo CERRADO. `<>` con v_loc NULL da NULL, el IF no salta y un operativo
  -- sin sucursal despacharía cualquier transferencia (T1).
  if v_loc is null or t.origen_id is distinct from v_loc then
    raise exception 'Solo la sucursal de origen puede despachar la transferencia #%', t.numero
      using errcode = '42501';
  end if;

  -- IDEMPOTENCIA del despacho: un segundo clic no vuelve a descontar stock.
  if t.estado in ('en_transito','recibida_parcial','recibida') then
    return t;
  end if;
  if t.estado <> 'borrador' then
    raise exception 'Transferencia no despachable (estado %)', t.estado using errcode = 'P0001';
  end if;

  for i in select * from public.transferencia_stock_items where transferencia_id = t.id order by id loop
    select coalesce(p.control_serial, false) into v_control
    from public.product_variants pv join public.products p on p.id = pv.product_id
    where pv.id = i.variant_id;

    if v_control then
      select count(*)::int into v_manifiesto
      from public.transferencia_stock_serials ts
      join public.product_serials ps on ps.id = ts.serial_id
      where ts.transferencia_id = t.id and ps.variant_id = i.variant_id;

      -- Se mueven las unidades EXACTAS del manifiesto y se cuenta cuántas se
      -- movieron de verdad. Sin este conteo vivía D1.
      with movidos as (
        update public.product_serials ps
           set estado = 'en_transito', updated_at = now()
          from public.transferencia_stock_serials ts
         where ts.transferencia_id = t.id
           and ts.serial_id = ps.id
           and ts.resultado is null
           and ps.variant_id = i.variant_id
           and ps.location_id = t.origen_id
           and ps.estado = 'disponible'     -- estado anterior en el WHERE (matriz P0.3)
        returning ps.id
      )
      select count(*)::int into v_movidos from movidos;

      if v_manifiesto <> i.cantidad or v_movidos <> i.cantidad then
        raise exception
          'Transferencia #%: la línea pide % unidad(es) con IMEI, el manifiesto tiene % y sólo % siguen disponibles en el origen. Se aborta para no desincronizar inventory de product_serials.',
          t.numero, i.cantidad, v_manifiesto, v_movidos using errcode = 'P0001';
      end if;

      -- El stock serializado se DERIVA de product_serials, nunca de un delta
      -- fijo. Esta función bloquea inventory ANTES de contar (invariante P0.4)
      -- y registra el delta REAL.
      perform private.sincronizar_stock_serializado(
        i.variant_id, t.origen_id, s.id, 'Transferencia # ' || t.numero || ' despachada');
    else
      update public.inventory
         set cantidad = cantidad - i.cantidad, updated_at = now()
       where variant_id = i.variant_id and location_id = t.origen_id and cantidad >= i.cantidad;
      if not found then
        raise exception 'Stock insuficiente para la transferencia #% (variante %)', t.numero, i.variant_id
          using errcode = 'P0001';
      end if;
      insert into public.inventory_movements(variant_id, location_id, cantidad_delta, motivo, staff_id)
      values (i.variant_id, t.origen_id, -i.cantidad,
              'Transferencia # ' || t.numero || ' despachada', s.id);
    end if;
  end loop;

  update public.transferencias_stock
     set estado = 'en_transito', despachado_por = s.id, fecha_despacho = now()
   where id = t.id
  returning * into t;
  return t;
end
$function$
;

-- public.iniciar_inventario_fisico
CREATE OR REPLACE FUNCTION public.iniciar_inventario_fisico(p_observacion text DEFAULT NULL::text)
 RETURNS inventarios_fisicos
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare s public.staff; f public.inventarios_fisicos;
begin
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  if s.id is null or not(private.tiene_capacidad('operar_inventario')) then
    raise exception 'Sin permiso';
  end if;
  if exists(select 1 from public.inventarios_fisicos where location_id=private.auth_location_id() and estado='abierto') then
    raise exception 'Ya existe un conteo abierto';
  end if;
  insert into public.inventarios_fisicos(location_id,creado_por,observacion) values(private.auth_location_id(),s.id,nullif(btrim(p_observacion),'')) returning * into f;

  -- Las serializadas arrancan en 0: su cantidad se deriva de los escaneos.
  -- Los productos de prueba no entran: no existen físicamente.
  insert into public.inventario_fisico_items(inventario_id,variant_id,cantidad_sistema,cantidad_contada)
    select f.id, i.variant_id, i.cantidad,
           case when coalesce(p.control_serial,false) then 0 else null end
    from public.inventory i
    join public.product_variants pv on pv.id = i.variant_id
    join public.products p on p.id = pv.product_id
    where i.location_id = private.auth_location_id() and not p.is_test;

  insert into public.inventario_fisico_seriales(inventario_id, variant_id, serial_id, serial_number, esperado)
  select f.id, ps.variant_id, ps.id, ps.serial_number, true
  from public.product_serials ps
  join public.product_variants pv on pv.id = ps.variant_id
  join public.products p on p.id = pv.product_id
  where p.control_serial and not p.is_test and ps.location_id = private.auth_location_id() and ps.estado = 'disponible';

  return f;
end$function$
;

-- public.marcar_dispositivo_fuera_de_servicio
CREATE OR REPLACE FUNCTION public.marcar_dispositivo_fuera_de_servicio(p_device_id text, p_motivo text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare
  s public.staff;
  d public.pos_devices;
begin
  select * into s from public.staff where user_id = auth.uid() and activo = true limit 1;
  if s.id is null or not (private.tiene_capacidad('supervisar')) then
    raise exception 'Sin permiso';
  end if;
  if p_motivo is null or length(btrim(p_motivo)) < 5 then
    raise exception 'Indica por qué este terminal queda fuera de servicio';
  end if;
  select * into d from public.pos_devices where device_id = p_device_id for update;
  if d.id is null then raise exception 'Terminal no encontrado'; end if;
  if not private.auth_is_admin() and d.location_id <> private.auth_location_id() then
    raise exception 'Ese terminal es de otra sucursal';
  end if;

  update public.pos_devices set
    fuera_de_servicio = true,
    fuera_de_servicio_motivo = btrim(p_motivo),
    fuera_de_servicio_por = s.id,
    fuera_de_servicio_at = now(),
    activo = false,
    updated_at = now()
  where id = d.id;
end$function$
;

-- public.recibir_orden_compra
CREATE OR REPLACE FUNCTION public.recibir_orden_compra(p_orden_id uuid, p_client_transaction_id uuid, p_items jsonb, p_observacion text DEFAULT NULL::text, p_corrige_recepcion_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare
  v_staff         public.staff;
  v_orden         public.ordenes_compra;
  v_rec           public.recepciones_compra;
  v_item          public.orden_compra_items;
  v_hash          text;
  v_gano          boolean := false;
  e               jsonb;
  s               jsonb;
  v_pend          int;
  v_buenas        int;
  v_danadas       int;
  v_faltante      int;
  v_equiv         int;
  v_sobrante      int;
  v_aplicado      int;
  v_fisicas       int;
  v_control       boolean;
  v_is_test       boolean;
  v_product       uuid;
  v_seriales      jsonb;
  v_n_ser         int;
  v_n_dan         int;
  v_ri            uuid;
  v_variant_eq    uuid;
  v_delta         int;
  v_vistos        uuid[] := '{}';
  v_pendientes    int;
  v_serial        text;
begin
  ------------------------------------------------------------------------
  -- 5.1 Clave de idempotencia: obligatoria y primero que nada.
  ------------------------------------------------------------------------
  if p_client_transaction_id is null then
    raise exception 'La recepción requiere client_transaction_id: sin clave de idempotencia un reintento duplicaría stock, costo, documento, serial y movimiento'
      using errcode = 'P0001';
  end if;
  if p_orden_id is null then
    raise exception 'Orden inválida' using errcode = 'P0001';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Recepción vacía' using errcode = 'P0001';
  end if;

  ------------------------------------------------------------------------
  -- 5.2 Identidad y permiso. Se mantiene EXACTAMENTE la regla que ya estaba
  -- en producción: mismo conjunto de roles y misma restricción de sucursal.
  -- Esta migración no relaja ni amplía permisos.
  ------------------------------------------------------------------------
  select * into v_staff from public.staff where user_id = auth.uid() and activo = true limit 1;
  if v_staff.id is null
     or not (private.tiene_capacidad('operar_inventario')) then
    raise exception 'Sin permiso para recibir compras' using errcode = 'P0001';
  end if;

  -- Huella del envío COMPLETO, calculada ya con identidad y permiso comprobados:
  -- antes se evaluaba la entrada de cualquiera, autorizado o no (B5). El helper
  -- cubre las líneas; aquí se añaden los campos de cabecera, que también forman
  -- parte de la identidad del envío (B1): la misma clave con otra observación
  -- general, o marcada ahora como corrección, no es un reintento. Se combina en
  -- jsonb y no concatenando, para que ningún texto libre pueda hacer que dos
  -- envíos distintos compartan huella.
  v_hash := md5(jsonb_build_object(
    'lineas',               private.hash_recepcion(p_orden_id, p_items),
    'observacion',          nullif(btrim(coalesce(p_observacion, '')), ''),
    'corrige_recepcion_id', p_corrige_recepcion_id
  )::text);

  ------------------------------------------------------------------------
  -- 5.3 CAMINO RÁPIDO DEL REINTENTO.
  -- El caso que hoy duplica en producción: la transacción hizo commit, la
  -- respuesta se perdió y el usuario reintenta. Aquí se resuelve sin tocar
  -- NADA y sin tomar ningún lock.
  ------------------------------------------------------------------------
  select * into v_rec from public.recepciones_compra
   where client_transaction_id = p_client_transaction_id;
  if v_rec.id is not null then
    return private.recepcion_replay(v_rec, p_orden_id, v_hash, v_staff.id);
  end if;

  ------------------------------------------------------------------------
  -- 5.4 Punto de serialización: la cabecera de la orden.
  ------------------------------------------------------------------------
  select * into v_orden from public.ordenes_compra where id = p_orden_id for update;
  -- Fallo CERRADO. `<>` con la sucursal del operador NULL da NULL, el IF no
  -- salta y cualquiera sin sucursal recibiría órdenes de cualquier sucursal (T1).
  if v_orden.id is null or private.auth_location_id() is null
     or v_orden.location_id is distinct from private.auth_location_id() then
    raise exception 'Orden inválida o de otra sucursal' using errcode = 'P0001';
  end if;

  -- Relectura BAJO el lock. Bajo READ COMMITTED cada sentencia toma su propio
  -- snapshot, así que si una sesión concurrente con la MISMA clave hizo commit
  -- mientras esperábamos el lock, aquí sí la vemos. Es la misma clase de
  -- carrera que R6, resuelta bloqueando antes de decidir.
  select * into v_rec from public.recepciones_compra
   where client_transaction_id = p_client_transaction_id;
  if v_rec.id is not null then
    return private.recepcion_replay(v_rec, p_orden_id, v_hash, v_staff.id);
  end if;

  if v_orden.estado in ('recibida','cancelada') then
    raise exception 'Orden no recepcionable (estado %)', v_orden.estado using errcode = 'P0001';
  end if;

  if p_corrige_recepcion_id is not null
     and not exists (select 1 from public.recepciones_compra
                      where id = p_corrige_recepcion_id and orden_id = v_orden.id) then
    raise exception 'La recepción que se pretende corregir no pertenece a esta orden' using errcode = 'P0001';
  end if;

  ------------------------------------------------------------------------
  -- 5.5 Inserción de la cabecera con la clave única.
  -- Si dos sesiones llegan aquí a la vez (sólo posible si el lock de la orden
  -- no las serializó), la segunda se queda esperando el insert especulativo de
  -- la primera y recibe 23505 al hacer ésta commit. El bloque EXCEPTION crea
  -- un savepoint implícito: al capturarla se deshace SÓLO este insert, el lock
  -- de fila sobre la orden sigue en pie, y se devuelve la recepción ganadora.
  -- El índice único es la garantía real; el chequeo previo es sólo el camino
  -- rápido.
  ------------------------------------------------------------------------
  begin
    insert into public.recepciones_compra
      (orden_id, recibido_por, observacion, client_transaction_id, payload_hash, corrige_recepcion_id)
    values
      (v_orden.id, v_staff.id, nullif(btrim(p_observacion), ''), p_client_transaction_id, v_hash, p_corrige_recepcion_id)
    returning * into v_rec;
    v_gano := true;
  exception when unique_violation then
    v_gano := false;
  end;

  if not v_gano then
    select * into v_rec from public.recepciones_compra
     where client_transaction_id = p_client_transaction_id;
    if v_rec.id is null then
      -- Unique violation que no viene de la clave de idempotencia: no la
      -- tragamos.
      raise exception 'Conflicto de unicidad al registrar la recepción' using errcode = 'P0001';
    end if;
    return private.recepcion_replay(v_rec, p_orden_id, v_hash, v_staff.id);
  end if;

  ------------------------------------------------------------------------
  -- 5.6 Líneas.
  ------------------------------------------------------------------------
  for e in select * from jsonb_array_elements(p_items) loop

    select * into v_item from public.orden_compra_items
     where id = (e->>'orden_item_id')::uuid and orden_id = v_orden.id
     for update;
    if v_item.id is null then
      raise exception 'Línea inválida o de otra orden: %', coalesce(e->>'orden_item_id','(null)') using errcode = 'P0001';
    end if;

    -- Una línea repetida dentro del mismo payload sumaría dos veces bajo el
    -- mismo hash: se rechaza.
    if v_item.id = any (v_vistos) then
      raise exception 'La línea % aparece dos veces en la misma recepción', v_item.id using errcode = 'P0001';
    end if;
    v_vistos := v_vistos || v_item.id;

    v_buenas   := greatest(coalesce((e->>'cantidad')::int, 0), 0);
    v_danadas  := greatest(coalesce((e->>'cantidad_danada')::int, 0), 0);
    v_faltante := greatest(coalesce((e->>'cantidad_faltante')::int, 0), 0);
    v_equiv    := greatest(coalesce((e->>'cantidad_producto_equivocado')::int, 0), 0);
    v_variant_eq := nullif(e->>'variant_id_recibido','')::uuid;

    if v_buenas + v_danadas + v_faltante + v_equiv = 0 then
      raise exception 'La línea % no declara ninguna cantidad', v_item.id using errcode = 'P0001';
    end if;
    if (v_equiv > 0) <> (v_variant_eq is not null) then
      raise exception 'Producto equivocado: hay que declarar a la vez la cantidad y la variante que llegó (línea %)', v_item.id
        using errcode = 'P0001';
    end if;
    if v_variant_eq is not null then
      if v_variant_eq = v_item.variant_id then
        raise exception 'La variante declarada como equivocada es la misma que se pidió (línea %)', v_item.id using errcode = 'P0001';
      end if;
      if not exists (select 1 from public.product_variants where id = v_variant_eq) then
        raise exception 'La variante recibida por equivocación no existe: %', v_variant_eq using errcode = 'P0001';
      end if;
    end if;

    -- P0.4: el catálogo de prueba no entra en ningún consumidor operativo, y
    -- una recepción escribe inventario, movimientos e historial de costo.
    select p.control_serial, p.is_test, p.id
      into v_control, v_is_test, v_product
      from public.product_variants pv
      join public.products p on p.id = pv.product_id
     where pv.id = v_item.variant_id;
    if coalesce(v_is_test, false) then
      raise exception 'No se puede recibir mercadería contra un producto marcado como de prueba (is_test)' using errcode = 'P0001';
    end if;

    v_pend    := greatest(v_item.cantidad_pedida - v_item.cantidad_recibida, 0);
    v_fisicas := v_buenas + v_danadas;

    -- SOBRANTE. Derivado por el servidor; el cliente no lo declara y por tanto
    -- no lo puede falsear. Si hay exceso, hace falta aceptación explícita: un
    -- dedazo (100 en vez de 10) no puede inflar stock en silencio, que es
    -- justo lo que la versión vieja convertía en un error duro sin matices.
    v_sobrante := greatest(v_fisicas - v_pend, 0);
    if v_sobrante > 0 and not coalesce((e->>'acepta_sobrante')::boolean, false) then
      raise exception 'Llegaron % unidades y sólo quedaban % pendientes en la línea %. Si el sobrante es real, reenvía la línea con acepta_sobrante = true.',
        v_fisicas, v_pend, v_item.id using errcode = 'P0001';
    end if;

    -- Lo que AVANZA la orden son únicamente las unidades buenas, y nunca por
    -- encima de lo pendiente: orden_compra_items tiene el CHECK
    -- cantidad_recibida <= cantidad_pedida y no se toca. Lo dañado, lo
    -- faltante y lo equivocado dejan la línea pendiente a propósito: son
    -- reclamos al proveedor, no mercadería recibida.
    v_aplicado := least(v_buenas, v_pend);

    ----------------------------------------------------------------
    -- Seriales / IMEI exactos.
    ----------------------------------------------------------------
    v_seriales := coalesce(e->'seriales', '[]'::jsonb);
    if jsonb_typeof(v_seriales) <> 'array' then
      raise exception 'El campo seriales de la línea % no es una lista', v_item.id using errcode = 'P0001';
    end if;
    select count(*)::int,
           count(*) filter (where coalesce((s2->>'danado')::boolean, false))::int
      into v_n_ser, v_n_dan
      from jsonb_array_elements(v_seriales) s2;

    if coalesce(v_control, false) then
      -- Exactitud: un IMEI por unidad que LLEGÓ (buena o dañada). Ni lo
      -- faltante ni lo equivocado aportan seriales de esta variante.
      if v_n_ser <> v_fisicas then
        raise exception 'La línea % requiere exactamente % IMEI/serie (% buenas + % dañadas) y llegaron %',
          v_item.id, v_fisicas, v_buenas, v_danadas, v_n_ser using errcode = 'P0001';
      end if;
      if v_n_dan <> v_danadas then
        raise exception 'La línea % declara % unidades dañadas pero marca % IMEI como dañados',
          v_item.id, v_danadas, v_n_dan using errcode = 'P0001';
      end if;
      if exists (
        select 1 from jsonb_array_elements(v_seriales) s2
        group by btrim(s2->>'serial_number') having count(*) > 1) then
        raise exception 'Hay IMEI/serie repetidos dentro de la línea %', v_item.id using errcode = 'P0001';
      end if;
    elsif v_n_ser > 0 then
      raise exception 'La línea % no es de un producto con IMEI/serie y trae seriales', v_item.id using errcode = 'P0001';
    end if;

    ----------------------------------------------------------------
    -- Documento de la línea. Append-only: se inserta, nunca se reescribe.
    ----------------------------------------------------------------
    insert into public.recepcion_compra_items
      (recepcion_id, orden_item_id, cantidad, costo_unitario,
       cantidad_danada, cantidad_faltante, cantidad_sobrante,
       cantidad_producto_equivocado, variant_id_recibido, observacion)
    values
      (v_rec.id, v_item.id, v_buenas, v_item.costo_unitario,
       v_danadas, v_faltante, v_sobrante,
       v_equiv, v_variant_eq, nullif(btrim(e->>'observacion'), ''))
    returning id into v_ri;

    if v_aplicado > 0 then
      update public.orden_compra_items
         set cantidad_recibida = cantidad_recibida + v_aplicado
       where id = v_item.id;
    end if;

    ----------------------------------------------------------------
    -- Inventario.
    ----------------------------------------------------------------
    if coalesce(v_control, false) then
      -- INVARIANTE P0.2/P0.4. No se toca `inventory` ni se escribe el
      -- movimiento a mano: se insertan los seriales y se DERIVA el stock de
      -- product_serials. sincronizar_stock_serializado bloquea la fila
      -- agregada, cuenta los 'disponible' y registra el delta REAL.
      -- Las unidades dañadas entran como 'cuarentena', así que existen,
      -- quedan trazadas contra el proveedor y NO cuentan como stock vendible.
      for s in select * from jsonb_array_elements(v_seriales) loop
        v_serial := btrim(s->>'serial_number');
        if v_serial is null or v_serial = '' then
          raise exception 'IMEI/serie vacío en la línea %', v_item.id using errcode = 'P0001';
        end if;
        if exists (select 1 from public.product_serials where serial_number = v_serial) then
          raise exception 'El IMEI/serie % ya está registrado', v_serial using errcode = 'P0001';
        end if;
        insert into public.product_serials
          (variant_id, location_id, serial_number, imei2, estado, recepcion_item_id)
        values
          (v_item.variant_id, v_orden.location_id, v_serial,
           nullif(btrim(s->>'imei2'), ''),
           case when coalesce((s->>'danado')::boolean, false) then 'cuarentena' else 'disponible' end,
           v_ri);
      end loop;

      if v_fisicas > 0 then
        v_delta := private.sincronizar_stock_serializado(
                     v_item.variant_id, v_orden.location_id, v_staff.id,
                     'Recepción compra #' || v_orden.numero);
      end if;
    else
      if v_buenas > 0 then
        insert into public.inventory (variant_id, location_id, cantidad, updated_at)
        values (v_item.variant_id, v_orden.location_id, v_buenas, now())
        on conflict (variant_id, location_id)
          do update set cantidad = public.inventory.cantidad + excluded.cantidad, updated_at = now();

        -- Delta REAL de esta recepción: las unidades buenas. Lo dañado, lo
        -- faltante y lo equivocado no mueven stock y por tanto no generan
        -- movimiento: un movimiento por cantidad "recibida" incluyendo lo que
        -- no entró sería exactamente el delta fijo que P0.2 prohibió.
        insert into public.inventory_movements
          (variant_id, location_id, cantidad_delta, motivo, staff_id)
        values
          (v_item.variant_id, v_orden.location_id, v_buenas,
           left('Recepción compra #' || v_orden.numero, 250), v_staff.id);
      end if;
    end if;

    ----------------------------------------------------------------
    -- Historial de costo de compra. Append-only y atado a la recepción:
    -- como la recepción es única por client_transaction_id, estas filas se
    -- escriben exactamente una vez por envío. El costo es SIEMPRE el de la
    -- orden; el cliente no puede inyectar uno.
    ----------------------------------------------------------------
    if v_buenas > 0 then
      insert into public.historial_costos_compra
        (product_id, variant_id, proveedor_id, orden_id, recepcion_id, costo_unitario, cantidad)
      values
        (v_product, v_item.variant_id, v_orden.proveedor_id, v_orden.id, v_rec.id,
         v_item.costo_unitario, v_buenas);
    end if;

  end loop;

  ------------------------------------------------------------------------
  -- 5.7 Estado de la orden.
  ------------------------------------------------------------------------
  select count(*) into v_pendientes
    from public.orden_compra_items
   where orden_id = v_orden.id and cantidad_recibida < cantidad_pedida;

  update public.ordenes_compra
     set estado = case when v_pendientes = 0 then 'recibida' else 'parcial' end,
         updated_at = now()
   where id = v_orden.id;

  return private.recepcion_resultado(v_rec.id) || jsonb_build_object('reintento', false);
end
$function$
;

-- public.recibir_transferencia_parcial
CREATE OR REPLACE FUNCTION public.recibir_transferencia_parcial(p_transferencia_id uuid, p_client_transaction_id uuid, p_items jsonb DEFAULT NULL::jsonb, p_observacion text DEFAULT NULL::text, p_cerrar boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare
  s public.staff;
  t public.transferencias_stock;
  v_loc uuid;
  v_rec uuid;
  x jsonb;
  sj jsonb;
  i public.transferencia_stock_items;
  v_control boolean;
  v_ok int;
  v_dan int;
  v_sid uuid;
  v_res text;
  v_pendientes int;
  v_items jsonb;
  v_hash text;
  v_prev_hash text;
begin
  if p_client_transaction_id is null then
    raise exception 'La recepción exige client_transaction_id (idempotencia)' using errcode = 'P0001';
  end if;

  select * into s from public.staff where user_id = auth.uid() and activo = true limit 1;
  if s.id is null or not(private.tiene_capacidad('operar_inventario')) then
    raise exception 'Sin permiso' using errcode = '42501';
  end if;
  v_loc := coalesce(private.auth_location_id(), private.auth_location_id());

  -- PUNTO DE SERIALIZACIÓN. Dos recepciones simultáneas de esta transferencia
  -- se ponen en fila aquí; la segunda continúa viendo ya el commit de la
  -- primera. Sin este FOR UPDATE la idempotencia por clave no bastaría: dos
  -- transacciones podrían insertar la misma clave a la vez y una de ellas
  -- descubriría el conflicto DESPUÉS de haber tocado inventory.
  select * into t from public.transferencias_stock where id = p_transferencia_id for update;
  if t.id is null then
    raise exception 'Transferencia inexistente' using errcode = 'P0001';
  end if;

  -- PERMISO POR SUCURSAL EN SERVIDOR: recibe el DESTINO.
  -- Fallo CERRADO (T1): con `<>`, un v_loc NULL daba NULL, el IF no saltaba y un
  -- operativo sin sucursal recibía cualquier transferencia.
  if v_loc is null or t.destino_id is distinct from v_loc then
    raise exception 'Solo la sucursal de destino puede recibir la transferencia #%', t.numero
      using errcode = '42501';
  end if;

  -- T2 · huella de la PETICIÓN tal como llegó, calculada ya con identidad y
  -- permiso comprobados. Se hashea lo recibido y no las líneas que el servidor
  -- deriva: con p_items NULL ("recibir todo lo pendiente") lo pendiente sale del
  -- estado actual, y el reintento de un "recibir todo" ya aplicado vería otra
  -- cosa y se rechazaría por error. cerrar_transferencia_stock delega aquí, así
  -- que esto cubre también el cierre.
  v_hash := private.hash_transferencia_recepcion(p_items, p_cerrar, p_observacion);

  if t.estado not in ('en_transito','recibida_parcial') then
    -- Con la transferencia ya cerrada, la misma clave es un reintento legítimo
    -- SÓLO si el contenido coincide.
    select payload_hash into v_prev_hash from public.transferencia_recepciones
     where transferencia_id = t.id and client_transaction_id = p_client_transaction_id;
    if found then
      if v_prev_hash is distinct from v_hash then
        raise exception 'Ese client_transaction_id ya se usó con un contenido distinto. Genera una clave nueva para una recepción distinta.' using errcode = 'P0001';
      end if;
      return public.transferencia_detalle(t.id);
    end if;
    raise exception 'Transferencia #% no recibible (estado %)', t.numero, t.estado using errcode = 'P0001';
  end if;

  -- IDEMPOTENCIA. Si la clave ya existe no se aplica NADA, y sólo se acepta como
  -- reintento si el contenido coincide (T2): si no, la recepción nueva se perdería
  -- en silencio mientras el cliente recibe el detalle como si hubiera entrado.
  insert into public.transferencia_recepciones(
    transferencia_id, client_transaction_id, recibido_por, observacion, es_cierre, payload_hash)
  values (t.id, p_client_transaction_id, s.id, nullif(btrim(p_observacion), ''), p_cerrar, v_hash)
  on conflict (transferencia_id, client_transaction_id) do nothing
  returning id into v_rec;

  if v_rec is null then
    select payload_hash into v_prev_hash from public.transferencia_recepciones
     where transferencia_id = t.id and client_transaction_id = p_client_transaction_id;
    if v_prev_hash is distinct from v_hash then
      raise exception 'Ese client_transaction_id ya se usó con un contenido distinto. Genera una clave nueva para una recepción distinta.' using errcode = 'P0001';
    end if;
    return public.transferencia_detalle(t.id);
  end if;

  -- p_items NULL = todo lo pendiente, correcto. Para las líneas con IMEI se
  -- rellenan los seriales que siguen en vuelo.
  if p_items is null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'item_id', it.id,
      'cantidad_ok', it.cantidad - it.cantidad_recibida - it.cantidad_danada,
      'cantidad_danada', 0,
      'serials', coalesce((
        select jsonb_agg(jsonb_build_object('serial_id', ts.serial_id, 'resultado', 'ok'))
        from public.transferencia_stock_serials ts
        join public.product_serials ps on ps.id = ts.serial_id
        where ts.transferencia_id = t.id and ts.resultado is null and ps.variant_id = it.variant_id
      ), '[]'::jsonb))), '[]'::jsonb)
    into v_items
    from public.transferencia_stock_items it
    where it.transferencia_id = t.id
      and it.cantidad > it.cantidad_recibida + it.cantidad_danada;
  else
    v_items := p_items;
  end if;

  for x in select * from jsonb_array_elements(v_items) loop
    select * into i from public.transferencia_stock_items
     where id = (x->>'item_id')::uuid and transferencia_id = t.id
     for update;
    if i.id is null then
      raise exception 'La línea % no pertenece a la transferencia #%', x->>'item_id', t.numero
        using errcode = 'P0001';
    end if;

    select coalesce(p.control_serial, false) into v_control
    from public.product_variants pv join public.products p on p.id = pv.product_id
    where pv.id = i.variant_id;

    v_ok := 0;
    v_dan := 0;

    if v_control then
      -- ------------------------------------------------------------------
      -- Serializado: se concilian UNIDADES EXACTAS, nunca números sueltos.
      -- ------------------------------------------------------------------
      for sj in select * from jsonb_array_elements(coalesce(x->'serials', '[]'::jsonb)) loop
        v_sid := (sj->>'serial_id')::uuid;
        v_res := coalesce(sj->>'resultado', 'ok');
        if v_res not in ('ok','danado','faltante') then
          raise exception 'Resultado de IMEI inválido: %', v_res using errcode = 'P0001';
        end if;

        -- El serial tiene que pertenecer a ESTA transferencia y seguir EN
        -- VUELO. Un IMEI ajeno, o ya conciliado, se rechaza: es la barrera
        -- contra recibir en el destino B una unidad que viaja hacia C.
        update public.transferencia_stock_serials
           set resultado = v_res
         where transferencia_id = t.id and serial_id = v_sid and resultado is null;
        if not found then
          raise exception 'El IMEI % no está en vuelo en la transferencia #%: no puede recibirse aquí', v_sid, t.numero
            using errcode = 'P0001';
        end if;

        -- Transición con el estado ANTERIOR en el WHERE (matriz P0.3).
        if v_res = 'ok' then
          update public.product_serials
             set estado = 'disponible', location_id = t.destino_id, updated_at = now()
           where id = v_sid and estado = 'en_transito';
        elsif v_res = 'danado' then
          -- No existe estado 'dañado' en product_serials y no se inventa uno:
          -- cuarentena ya es el estado de "llegó, no se vende, hay que
          -- resolverlo", y su única salida es resolver_cuarentena_serial.
          update public.product_serials
             set estado = 'cuarentena', location_id = t.destino_id, updated_at = now()
           where id = v_sid and estado = 'en_transito';
        else
          -- No llegó. Se queda contablemente en el ORIGEN, que es de donde se
          -- descontó, y en un estado que NO cuenta como disponible: así el
          -- faltante no resucita stock en ninguna de las dos sucursales.
          update public.product_serials
             set estado = 'faltante', updated_at = now()
           where id = v_sid and estado = 'en_transito';
        end if;
        if not found then
          raise exception 'El IMEI % no estaba en tránsito; no se concilia', v_sid using errcode = 'P0001';
        end if;

        insert into public.transferencia_recepcion_serials(recepcion_id, serial_id, resultado)
        values (v_rec, v_sid, v_res);

        if v_res = 'ok' then v_ok := v_ok + 1;
        elsif v_res = 'danado' then v_dan := v_dan + 1;
        end if;
      end loop;

      if v_ok > 0 or v_dan > 0 then
        -- Igual que en el origen: el stock del destino se DERIVA de
        -- product_serials. La cuarentena no cuenta como disponible, así que un
        -- dañado no infla el inventario.
        perform private.sincronizar_stock_serializado(
          i.variant_id, t.destino_id, s.id, 'Transferencia # ' || t.numero || ' recibida');
      end if;
    else
      -- ------------------------------------------------------------------
      -- Sin IMEI: mandan las cantidades.
      -- ------------------------------------------------------------------
      v_ok  := coalesce((x->>'cantidad_ok')::int, 0);
      v_dan := coalesce((x->>'cantidad_danada')::int, 0);
      if v_ok < 0 or v_dan < 0 then
        raise exception 'Cantidades negativas en la línea %', i.id using errcode = 'P0001';
      end if;

      if v_ok > 0 then
        insert into public.inventory(variant_id, location_id, cantidad)
        values (i.variant_id, t.destino_id, v_ok)
        on conflict (variant_id, location_id)
        do update set cantidad = public.inventory.cantidad + excluded.cantidad, updated_at = now();

        -- Delta REAL: lo que de verdad entró, no lo que se había enviado.
        insert into public.inventory_movements(variant_id, location_id, cantidad_delta, motivo, staff_id)
        values (i.variant_id, t.destino_id, v_ok,
                'Transferencia # ' || t.numero || ' recibida', s.id);
      end if;
      -- Las dañadas NO entran a inventory: nunca fueron stock vendible. Su
      -- rastro queda en la línea y en la auditoría, no en un movimiento falso.
    end if;

    insert into public.transferencia_recepcion_items(recepcion_id, item_id, cantidad_ok, cantidad_danada)
    values (v_rec, i.id, v_ok, v_dan)
    on conflict (recepcion_id, item_id) do update
      set cantidad_ok = public.transferencia_recepcion_items.cantidad_ok + excluded.cantidad_ok,
          cantidad_danada = public.transferencia_recepcion_items.cantidad_danada + excluded.cantidad_danada;

    -- UNA SOLA sentencia: acumula y recalcula el derivado a la vez. Partirla en
    -- dos violaría tsi_sobrante_derivado a mitad de camino y, sobre todo,
    -- abriría un hueco de lost update entre ambas.
    update public.transferencia_stock_items it
       set cantidad_recibida = it.cantidad_recibida + v_ok,
           cantidad_danada   = it.cantidad_danada + v_dan,
           cantidad_sobrante = greatest(0, it.cantidad_recibida + v_ok + it.cantidad_danada + v_dan - it.cantidad),
           estado_linea = case
             when it.cantidad_recibida + v_ok + it.cantidad_danada + v_dan = 0 then 'pendiente'
             when it.cantidad_recibida + v_ok + it.cantidad_danada + v_dan > it.cantidad then 'con_diferencia'
             when it.cantidad_danada + v_dan > 0 then
               case when it.cantidad_recibida + v_ok + it.cantidad_danada + v_dan = it.cantidad
                    then 'con_diferencia' else 'parcial' end
             when it.cantidad_recibida + v_ok = it.cantidad then 'completa'
             else 'parcial' end
     where it.id = i.id;
  end loop;

  -- ---------------------------------------------------------------------
  -- CIERRE CONSISTENTE
  -- ---------------------------------------------------------------------
  select count(*)::int into v_pendientes
  from public.transferencia_stock_items
  where transferencia_id = t.id and cantidad_recibida + cantidad_danada < cantidad;

  if p_cerrar or v_pendientes = 0 then
    -- Lo que no llegó es faltante, y se deja escrito.
    update public.transferencia_stock_items
       set cantidad_faltante = greatest(0, cantidad - cantidad_recibida - cantidad_danada),
           estado_linea = case
             when cantidad_recibida = cantidad and cantidad_danada = 0 and cantidad_sobrante = 0
               then 'completa' else 'con_diferencia' end
     where transferencia_id = t.id;

    -- Los IMEI del manifiesto que nadie concilió quedan FALTANTES, no vuelven
    -- a estar disponibles en ningún sitio.
    update public.product_serials ps
       set estado = 'faltante', updated_at = now()
      from public.transferencia_stock_serials ts
     where ts.transferencia_id = t.id and ts.serial_id = ps.id
       and ts.resultado is null and ps.estado = 'en_transito';

    update public.transferencia_stock_serials
       set resultado = 'faltante'
     where transferencia_id = t.id and resultado is null;

    update public.transferencias_stock
       set estado = 'recibida', recibido_por = s.id, fecha_recepcion = now(),
           tiene_diferencias = exists(
             select 1 from public.transferencia_stock_items
             where transferencia_id = t.id and estado_linea = 'con_diferencia')
     where id = t.id
    returning * into t;
  else
    update public.transferencias_stock
       set estado = 'recibida_parcial', recibido_por = s.id
     where id = t.id
    returning * into t;
  end if;

  return public.transferencia_detalle(t.id);
end
$function$
;

-- public.registrar_conteo_fisico
CREATE OR REPLACE FUNCTION public.registrar_conteo_fisico(p_inventario_id uuid, p_variant_id uuid, p_cantidad integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare
  s public.staff;
  f public.inventarios_fisicos;
  v_control boolean;
begin
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  if s.id is null or not(private.tiene_capacidad('operar_inventario')) then
    raise exception 'Sin permiso';
  end if;
  if p_cantidad<0 then raise exception 'Cantidad inválida'; end if;
  select * into f from public.inventarios_fisicos where id=p_inventario_id;
  if f.id is null or f.location_id<>private.auth_location_id() or f.estado<>'abierto' then
    raise exception 'Conteo no editable';
  end if;

  select p.control_serial into v_control
  from public.product_variants pv join public.products p on p.id=pv.product_id
  where pv.id=p_variant_id;
  if coalesce(v_control,false) then
    raise exception 'Este producto tiene IMEI/serie: escanea cada unidad en vez de escribir una cantidad' using errcode = 'P0001';
  end if;

  update public.inventario_fisico_items set cantidad_contada=p_cantidad, counted_at=now() where inventario_id=f.id and variant_id=p_variant_id;
  if not found then
    insert into public.inventario_fisico_items(inventario_id,variant_id,cantidad_sistema,cantidad_contada,counted_at) values(f.id,p_variant_id,0,p_cantidad,now());
  end if;
  return true;
end$function$
;

-- public.registrar_foto_orden
CREATE OR REPLACE FUNCTION public.registrar_foto_orden(p_orden_id uuid, p_tipo text, p_storage_path text, p_descripcion text DEFAULT NULL::text)
 RETURNS orden_servicio_fotos
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare s public.staff;o public.ordenes_servicio;f public.orden_servicio_fotos;
begin
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  if s.id is null or not(private.tiene_capacidad('operar_taller')) then raise exception 'Sin permiso'; end if;
  select * into o from public.ordenes_servicio where id=p_orden_id;
  if o.id is null or (s.rol<>'administrador' and o.location_id<>private.auth_location_id()) then raise exception 'Orden inválida'; end if;
  if p_tipo not in('antes','despues','diagnostico','otro') then raise exception 'Tipo inválido'; end if;
  if split_part(p_storage_path,'/',1)<>o.location_id::text or split_part(p_storage_path,'/',2)<>o.id::text then raise exception 'Ruta de foto inválida'; end if;
  insert into public.orden_servicio_fotos(orden_id,tipo,storage_path,descripcion,subido_por) values(o.id,p_tipo,p_storage_path,nullif(btrim(p_descripcion),''),s.id) returning * into f;
  insert into public.orden_servicio_historial(orden_id,tipo,descripcion,actor_id) values(o.id,'foto','Foto '||p_tipo||' agregada',s.id);
  return f;
end$function$
;

-- public.registrar_movimiento_caja
CREATE OR REPLACE FUNCTION public.registrar_movimiento_caja(p_cash_session_id uuid, p_tipo text, p_monto numeric, p_motivo text, p_client_transaction_id uuid DEFAULT NULL::uuid, p_autorizacion_id uuid DEFAULT NULL::uuid)
 RETURNS cash_movements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare
  v_staff public.staff;
  v_sesion public.cash_sessions;
  v_es_elevado boolean;
  v_signo numeric;
  v_monto_firmado numeric;
  v_monto_abs numeric;
  v_saldo_actual numeric;
  v_umbral numeric;
  v_requiere_auth boolean;
  v_auth public.autorizaciones_operativas;
  v_auth_monto numeric;
  v_auth_usada uuid;
  v_previo public.cash_movements;
begin
  -- El actor NO es un parámetro. Sin sesión autenticada no se registra nada.
  if auth.uid() is null then
    raise exception 'Un movimiento de caja sólo lo puede registrar un usuario autenticado' using errcode = 'P0001';
  end if;

  select * into v_staff from public.staff where user_id = auth.uid() and activo = true limit 1;
  if v_staff.id is null then
    raise exception 'Personal no válido o inactivo' using errcode = 'P0001';
  end if;

  -- C1 · compatibilidad hacia atrás. El frontend desplegado antes de P1 llama
  -- con 4 argumentos nombrados y no conoce la clave. Como el POS funciona
  -- offline, un bundle viejo en caché puede seguir haciéndolo durante días
  -- después del deploy: exigir la clave rompería Caja en esas terminales.
  -- Sin clave se genera una en el servidor y se pierde SÓLO la protección
  -- contra doble clic (el comportamiento previo a P1). El umbral, la
  -- autorización obligatoria, el actor y la sucursal se validan más abajo
  -- exactamente igual con o sin clave: omitirla nunca salta un control.
  if p_client_transaction_id is null then
    p_client_transaction_id := gen_random_uuid();
  end if;

  -- Idempotencia, vía rápida: reintento de algo ya registrado.
  select * into v_previo from public.cash_movements where client_transaction_id = p_client_transaction_id;
  if v_previo.id is not null then
    if v_previo.staff_id is distinct from v_staff.id or v_previo.cash_session_id is distinct from p_cash_session_id then
      raise exception 'Ese identificador de transacción ya se usó en otro movimiento de caja' using errcode = 'P0001';
    end if;
    -- Un reintento legítimo repite el contenido. Si la misma clave llega con otro
    -- tipo, importe o motivo es OTRA operación: devolver el movimiento anterior
    -- dejaría la nueva sin registrar mientras el cliente recibe éxito, una
    -- pérdida silenciosa en el libro. El importe se compara CON SIGNO (un ajuste
    -- de +20 y otro de -20 no son el mismo) y el motivo sin espacios de borde.
    -- La autorización NO se compara: tras consumirse deja de estar aprobada, y el
    -- reintento de un éxito cuya respuesta se perdió la manda nula con razón.
    if v_previo.tipo is distinct from p_tipo
       or v_previo.monto is distinct from (case
            when p_tipo = 'ajuste' then round(p_monto, 2)
            when p_tipo in ('ingreso', 'retiro_banco') then round(abs(p_monto), 2)
            else -round(abs(p_monto), 2) end)
       or btrim(coalesce(v_previo.motivo, '')) is distinct from btrim(coalesce(p_motivo, '')) then
      raise exception 'Ese identificador de transacción ya se usó con un contenido distinto. Genera una clave nueva para un movimiento distinto.' using errcode = 'P0001';
    end if;
    return v_previo;
  end if;

  v_es_elevado := private.tiene_capacidad('supervisar');

  if p_tipo not in ('ingreso', 'retiro', 'deposito_banco', 'retiro_banco', 'gasto', 'ajuste') then
    raise exception 'Tipo de movimiento inválido' using errcode = 'P0001';
  end if;

  if p_tipo in ('deposito_banco', 'retiro_banco', 'gasto', 'ajuste') and not v_es_elevado then
    raise exception 'Solo administración, encargado o jefa pueden registrar este tipo de movimiento' using errcode = 'P0001';
  end if;

  if nullif(btrim(coalesce(p_motivo, '')), '') is null then
    raise exception 'Debes indicar un motivo para el movimiento de caja' using errcode = 'P0001';
  end if;

  select * into v_sesion from public.cash_sessions where id = p_cash_session_id for update;
  if v_sesion.id is null or v_sesion.cierre is not null then
    raise exception 'La caja indicada no está abierta' using errcode = 'P0001';
  end if;

  -- Idempotencia, comprobación serializada: ya tenemos el lock de la caja, así
  -- que un doble POST simultáneo ve aquí lo que confirmó el primero.
  select * into v_previo from public.cash_movements where client_transaction_id = p_client_transaction_id;
  if v_previo.id is not null then
    if v_previo.staff_id is distinct from v_staff.id or v_previo.cash_session_id is distinct from p_cash_session_id then
      raise exception 'Ese identificador de transacción ya se usó en otro movimiento de caja' using errcode = 'P0001';
    end if;
    -- Un reintento legítimo repite el contenido. Si la misma clave llega con otro
    -- tipo, importe o motivo es OTRA operación: devolver el movimiento anterior
    -- dejaría la nueva sin registrar mientras el cliente recibe éxito, una
    -- pérdida silenciosa en el libro. El importe se compara CON SIGNO (un ajuste
    -- de +20 y otro de -20 no son el mismo) y el motivo sin espacios de borde.
    -- La autorización NO se compara: tras consumirse deja de estar aprobada, y el
    -- reintento de un éxito cuya respuesta se perdió la manda nula con razón.
    if v_previo.tipo is distinct from p_tipo
       or v_previo.monto is distinct from (case
            when p_tipo = 'ajuste' then round(p_monto, 2)
            when p_tipo in ('ingreso', 'retiro_banco') then round(abs(p_monto), 2)
            else -round(abs(p_monto), 2) end)
       or btrim(coalesce(v_previo.motivo, '')) is distinct from btrim(coalesce(p_motivo, '')) then
      raise exception 'Ese identificador de transacción ya se usó con un contenido distinto. Genera una clave nueva para un movimiento distinto.' using errcode = 'P0001';
    end if;
    return v_previo;
  end if;

  -- Sucursal: la del actor según el servidor, contra la de la caja.
  if not v_staff.rol = 'administrador' then
    if v_sesion.location_id is distinct from private.auth_location_id() then
      raise exception 'La caja no pertenece a tu sucursal' using errcode = 'P0001';
    end if;
    if p_tipo in ('ingreso', 'retiro') and v_sesion.cajero_id is distinct from v_staff.id then
      raise exception 'Solo puedes registrar ingresos/retiros en tu propia caja' using errcode = 'P0001';
    end if;
  end if;

  if p_tipo = 'ajuste' then
    if coalesce(p_monto, 0) = 0 then
      raise exception 'El monto del ajuste no puede ser cero' using errcode = 'P0001';
    end if;
    v_monto_firmado := round(p_monto, 2);
  else
    if coalesce(p_monto, 0) <= 0 then
      raise exception 'El monto debe ser mayor a cero' using errcode = 'P0001';
    end if;
    v_signo := case when p_tipo in ('ingreso', 'retiro_banco') then 1 else -1 end;
    v_monto_firmado := round(p_monto, 2) * v_signo;
  end if;
  v_monto_abs := round(abs(v_monto_firmado), 2);

  -- --- Umbral y autorización -------------------------------------------------
  select caja_egreso_max_sin_autorizacion into v_umbral from public.configuracion where id = 1;
  v_umbral := coalesce(v_umbral, 0);

  v_requiere_auth := (v_monto_firmado < 0 or p_tipo = 'ajuste') and v_monto_abs > v_umbral;

  if v_requiere_auth then
    if p_autorizacion_id is null then
      raise exception 'Este movimiento de S/ % supera el umbral de S/ % permitido sin autorización. Solicita autorización a un administrador y vuelve a intentarlo.', v_monto_abs, v_umbral using errcode = 'P0001';
    end if;

    select * into v_auth from public.autorizaciones_operativas where id = p_autorizacion_id for update;
    if v_auth.id is null then
      raise exception 'La autorización indicada no existe' using errcode = 'P0001';
    end if;
    if v_auth.location_id is distinct from v_sesion.location_id then
      raise exception 'La autorización pertenece a otra sucursal' using errcode = 'P0001';
    end if;
    if coalesce(v_auth.payload->>'tipo', '') is distinct from p_tipo then
      raise exception 'La autorización aprobada es para otro tipo de movimiento de caja' using errcode = 'P0001';
    end if;
    -- El payload lo escribe el cliente al solicitar, así que se exige un número
    -- JSON de verdad: cualquier otra cosa es una autorización que no dice
    -- cuánto se aprobó y no sirve para autorizar nada.
    v_auth_monto := case when jsonb_typeof(v_auth.payload->'monto') = 'number'
                         then round((v_auth.payload->>'monto')::numeric, 2) end;
    if v_auth_monto is null or v_auth_monto <= 0 then
      raise exception 'La autorización no indica el monto aprobado' using errcode = 'P0001';
    end if;
    if v_monto_abs > v_auth_monto then
      raise exception 'El movimiento de S/ % supera el monto autorizado de S/ %', v_monto_abs, v_auth_monto using errcode = 'P0001';
    end if;

    -- Motor existente. Comprueba en la MISMA transacción, con la fila ya
    -- bloqueada, que la autorización esté 'aprobada', sea del tipo pedido, la
    -- haya solicitado ESTE actor y apunte a ESTA caja; y la marca 'consumida'.
    -- Devuelve false —y aquí se aborta— si ya se usó.
    if not private.consumir_autorizacion(p_autorizacion_id, 'otro', v_staff.id, 'movimiento_caja', v_sesion.id::text) then
      raise exception 'La autorización no está aprobada, no es tuya, no corresponde a esta caja o ya fue usada' using errcode = 'P0001';
    end if;
    v_auth_usada := p_autorizacion_id;
  end if;
  -- Si el movimiento NO requiere autorización, una autorización que venga en la
  -- llamada se ignora: no se consume ni se vincula.

  if v_monto_firmado < 0 then
    select coalesce(v_sesion.monto_inicial, 0) + coalesce(sum(monto), 0) into v_saldo_actual
    from public.cash_movements where cash_session_id = v_sesion.id;

    if v_saldo_actual + v_monto_firmado < 0 then
      raise exception 'Fondo insuficiente en caja. Disponible: S/ %, intentaste retirar: S/ %', round(v_saldo_actual, 2), v_monto_abs using errcode = 'P0001';
    end if;
  end if;

  return private.insertar_movimiento_caja(
    v_sesion.id, p_tipo, v_monto_firmado, p_motivo, v_staff.id,
    null, null, null, p_client_transaction_id, v_auth_usada
  );
end;
$function$
;

-- public.registrar_serial_contado
CREATE OR REPLACE FUNCTION public.registrar_serial_contado(p_inventario_id uuid, p_variant_id uuid, p_serial_number text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare
  s public.staff;
  f public.inventarios_fisicos;
  v_norm text := upper(trim(coalesce(p_serial_number, '')));
  v_row public.inventario_fisico_seriales;
  v_serial public.product_serials;
  v_control boolean;
begin
  select * into s from public.staff where user_id = auth.uid() and activo = true limit 1;
  if s.id is null or not(private.tiene_capacidad('operar_inventario')) then
    raise exception 'Sin permiso';
  end if;
  select * into f from public.inventarios_fisicos where id = p_inventario_id;
  if f.id is null or f.location_id <> private.auth_location_id() or f.estado <> 'abierto' then
    raise exception 'Conteo no editable';
  end if;
  if v_norm = '' then raise exception 'Serial vacío'; end if;

  if not exists (
    select 1 from public.inventario_fisico_items
    where inventario_id = p_inventario_id and variant_id = p_variant_id
  ) then
    raise exception 'Esa variante no forma parte de este conteo' using errcode = 'P0001';
  end if;

  select p.control_serial into v_control
  from public.product_variants pv join public.products p on p.id = pv.product_id
  where pv.id = p_variant_id;
  if not coalesce(v_control, false) then
    raise exception 'Ese producto no maneja IMEI/serie: cuéntalo por cantidad' using errcode = 'P0001';
  end if;

  select * into v_row from public.inventario_fisico_seriales
  where inventario_id = p_inventario_id and variant_id = p_variant_id
    and upper(serial_number) = v_norm and esperado and not encontrado
  for update;

  if v_row.id is not null then
    update public.inventario_fisico_seriales
    set encontrado = true, estado_reconciliacion = 'coincide', counted_at = now(), counted_by = s.id
    where id = v_row.id;
  else
    if exists (
      select 1 from public.inventario_fisico_seriales
      where inventario_id = p_inventario_id and variant_id = p_variant_id
        and upper(serial_number) = v_norm and encontrado
    ) then
      raise exception 'Este serial ya fue escaneado en este conteo' using errcode = 'P0001';
    end if;

    select * into v_serial from public.product_serials where upper(serial_number) = v_norm limit 1;

    -- Un serial conocido pero de OTRA variante es un error de captura que se
    -- corrige en el momento, no una discrepancia que se arrastre: guardar
    -- variant_id=X con serial_id de Y dejaría la fila internamente
    -- inconsistente (las dos FK son independientes y no lo impedirían).
    if v_serial.id is not null and v_serial.variant_id <> p_variant_id then
      raise exception 'El IMEI/serie % pertenece a otro producto del catálogo: escanéalo en el producto correcto', v_norm using errcode = 'P0001';
    end if;

    insert into public.inventario_fisico_seriales(inventario_id, variant_id, serial_id, serial_number, esperado, encontrado, estado_reconciliacion, counted_at, counted_by)
    values (p_inventario_id, p_variant_id, v_serial.id, v_norm, false, true, 'inesperado', now(), s.id);
  end if;

  update public.inventario_fisico_items
  set cantidad_contada = (
        select count(*) from public.inventario_fisico_seriales
        where inventario_id = p_inventario_id and variant_id = p_variant_id and encontrado
      ),
      counted_at = now()
  where inventario_id = p_inventario_id and variant_id = p_variant_id;

  return jsonb_build_object('coincide', v_row.id is not null, 'serial_conocido', v_serial.id is not null);
end$function$
;

-- public.registrar_seriales
CREATE OR REPLACE FUNCTION public.registrar_seriales(p_variant_id uuid, p_seriales jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$declare s public.staff;x jsonb;v_count int:=0;v_stock int;v_control boolean;begin select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;if s.id is null or not(private.tiene_capacidad('operar_inventario')) then raise exception 'Sin permiso';end if;select p.control_serial into v_control from public.product_variants pv join public.products p on p.id=pv.product_id where pv.id=p_variant_id;if not coalesce(v_control,false) then raise exception 'El producto no usa control por serie';end if;select coalesce(cantidad,0) into v_stock from public.inventory where variant_id=p_variant_id and location_id=private.auth_location_id();for x in select * from jsonb_array_elements(p_seriales) loop insert into public.product_serials(variant_id,location_id,serial_number,imei2) values(p_variant_id,private.auth_location_id(),btrim(x->>'serial_number'),nullif(btrim(x->>'imei2'),''));v_count:=v_count+1;end loop;if (select count(*) from public.product_serials where variant_id=p_variant_id and location_id=private.auth_location_id() and estado='disponible')>v_stock then raise exception 'Hay más seriales disponibles que stock físico';end if;return v_count;end$function$
;

-- public.resolver_cuarentena_serial
CREATE OR REPLACE FUNCTION public.resolver_cuarentena_serial(p_serial_id uuid, p_decision text, p_observacion text DEFAULT NULL::text)
 RETURNS product_serials
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare
  v_staff public.staff;
  v_serial public.product_serials;
begin
  select * into v_staff from public.staff where user_id = auth.uid() and activo = true limit 1;
  if v_staff.id is null or not (private.tiene_capacidad('supervisar')) then
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

  -- El agregado se alinea al conteo real de seriales disponibles; el delta
  -- que quede registrado es el que realmente ocurrió.
  perform private.sincronizar_stock_serializado(
    v_serial.variant_id, v_serial.location_id, v_staff.id,
    'Cuarentena resuelta como '||p_decision||' ('||v_serial.serial_number||')'||coalesce(' — '||p_observacion, ''));

  return v_serial;
end$function$
;

-- public.resolver_reconciliacion_serial
CREATE OR REPLACE FUNCTION public.resolver_reconciliacion_serial(p_item_id uuid, p_tipo text, p_nota text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare
  s public.staff;
  r public.inventario_fisico_seriales;
  f public.inventarios_fisicos;
  v_serial public.product_serials;
  v_origen uuid;
  v_estado_nuevo text;
  v_efecto text;
  v_delta int;
begin
  select * into s from public.staff where user_id = auth.uid() and activo = true limit 1;
  if s.id is null or not(private.tiene_capacidad('supervisar')) then
    raise exception 'Sin permiso';
  end if;
  if p_tipo is null or p_tipo not in ('error_escaneo','corregir_ubicacion','cuarentena','faltante_confirmado','baja','recepcion_omitida','investigacion','movimiento_posterior') then
    raise exception 'Tipo de resolución inválido' using errcode = 'P0001';
  end if;
  if p_tipo = 'baja' and s.rol <> 'administrador' then
    raise exception 'Solo administración puede dar de baja una unidad' using errcode = 'P0001';
  end if;

  select * into r from public.inventario_fisico_seriales where id = p_item_id for update;
  if r.id is null then raise exception 'Registro no encontrado'; end if;
  if r.estado_reconciliacion = 'coincide' then
    raise exception 'Ese serial coincide, no requiere resolución' using errcode = 'P0001';
  end if;

  select * into f from public.inventarios_fisicos where id = r.inventario_id;
  if f.id is null or f.location_id <> private.auth_location_id() or f.estado <> 'abierto' then
    raise exception 'Conteo no editable';
  end if;

  if r.serial_id is not null then
    select * into v_serial from public.product_serials where id = r.serial_id for update;
  end if;

  -- ─── MATRIZ DE TRANSICIONES ────────────────────────────────────────────
  if v_serial.id is not null and p_tipo <> 'error_escaneo' then

    if p_tipo = 'recepcion_omitida' then
      raise exception 'Este IMEI ya existe en el catálogo; "recepción omitida" es sólo para unidades desconocidas' using errcode = 'P0001';
    end if;
    if p_tipo = 'faltante_confirmado' and not (r.esperado and not r.encontrado) then
      raise exception 'Sólo una unidad esperada que no apareció puede confirmarse como faltante' using errcode = 'P0001';
    end if;
    if p_tipo in ('corregir_ubicacion','cuarentena') and not r.encontrado then
      raise exception 'Esa resolución supone la unidad físicamente presente; si no apareció, usa faltante confirmado o investigación' using errcode = 'P0001';
    end if;

    if p_tipo = 'movimiento_posterior' then
      -- Escape para el serial que cambió de manos MIENTRAS contábamos: no es
      -- una discrepancia, está explicado por otra operación legítima.
      --
      -- R3 (hallazgo del red team): limitarlo a vendido/en_transito dejaba un
      -- callejón sin salida. Un serial esperado que pasa a 'servicio' (taller)
      -- durante el conteo no admitía NINGUNA resolución —faltante_confirmado
      -- lo rechaza la matriz, cuarentena exige encontrado, error_escaneo exige
      -- no-esperado— y el conteo quedaba imposible de cerrar para siempre.
      -- Se admite desde cualquier estado que ya NO sea 'disponible': si el
      -- catálogo todavía dice 'disponible', la unidad debería estar en vitrina
      -- y su ausencia es un faltante real, así que ahí sí se rechaza y hay que
      -- usar faltante_confirmado. Eso impide usar este tipo para tapar un
      -- faltante.
      if v_serial.estado = 'disponible' or not r.esperado then
        raise exception 'Ese tipo sólo aplica a una unidad esperada que otra operación (venta, transferencia, taller) movió durante el conteo' using errcode = 'P0001';
      end if;
    elsif not (case v_serial.estado
        when 'disponible'    then p_tipo in ('corregir_ubicacion','cuarentena','faltante_confirmado','baja','investigacion')
        when 'cuarentena'    then p_tipo in ('baja','investigacion')
        when 'faltante'      then p_tipo in ('cuarentena','baja','investigacion')
        when 'investigacion' then p_tipo in ('cuarentena','faltante_confirmado','baja')
        when 'servicio'      then p_tipo = 'cuarentena'
        else false
      end) then
      raise exception '%', case v_serial.estado
        when 'vendido' then 'Este IMEI figura como vendido; usa el flujo de devolución o de anulación de venta'
        when 'en_transito' then 'Este IMEI está en tránsito entre sucursales; regularízalo recibiendo o cancelando la transferencia'
        when 'baja' then 'Este IMEI fue dado de baja definitiva; si reapareció requiere un reingreso formal por recepción o ajuste de administración'
        when 'servicio' then 'Este IMEI está en taller/servicio; si volvió físicamente, envíalo a cuarentena para revisarlo antes de venderlo'
        when 'cuarentena' then 'Este IMEI ya está en cuarentena; resuélvelo desde el flujo de cuarentena'
        when 'faltante' then 'Este IMEI ya está registrado como faltante; si apareció, envíalo a cuarentena'
        when 'investigacion' then 'Este IMEI ya está en investigación; ciérrala con un desenlace definitivo'
        else 'Transición no permitida desde el estado "'||v_serial.estado||'"'
      end using errcode = 'P0001';
    end if;
  end if;

  -- ─── EFECTO REAL ───────────────────────────────────────────────────────
  if p_tipo = 'error_escaneo' then
    if r.esperado then
      raise exception 'error_escaneo sólo aplica a un serial inesperado; un esperado que no apareció es un faltante' using errcode = 'P0001';
    end if;
    update public.inventario_fisico_seriales set encontrado = false where id = r.id;
    v_efecto := 'Escaneo descartado; product_serials sin cambios';

  elsif p_tipo = 'movimiento_posterior' then
    v_efecto := 'Unidad movida por otra operación durante el conteo; sin cambios en el catálogo';

  elsif p_tipo = 'corregir_ubicacion' then
    if v_serial.id is null then
      raise exception 'corregir_ubicacion requiere un IMEI/serie ya registrado en el catálogo' using errcode = 'P0001';
    end if;
    if v_serial.location_id = f.location_id then
      raise exception 'Ese IMEI/serie ya está en esta sucursal' using errcode = 'P0001';
    end if;
    v_origen := v_serial.location_id;
    update public.product_serials set location_id = f.location_id, updated_at = now()
    where id = v_serial.id and estado = v_serial.estado;
    if not found then raise exception 'El estado del IMEI cambió mientras resolvías; vuelve a revisar la fila' using errcode = 'P0001'; end if;
    -- Ambos agregados se recalculan contra los seriales reales; nada de ±1.
    perform private.sincronizar_stock_serializado_par(v_serial.variant_id, v_origen, f.location_id, s.id,
      'Conteo físico: IMEI '||v_serial.serial_number||' reubicado');
    v_efecto := 'location_id corregido a la sucursal del conteo';

  elsif p_tipo in ('cuarentena','faltante_confirmado','baja','investigacion') then
    v_estado_nuevo := case p_tipo
      when 'cuarentena' then 'cuarentena'
      when 'faltante_confirmado' then 'faltante'
      when 'baja' then 'baja'
      when 'investigacion' then 'investigacion' end;
    if v_serial.id is null then
      raise exception 'Ese tipo de resolución requiere un IMEI/serie registrado en el catálogo; para una unidad desconocida usa recepcion_omitida' using errcode = 'P0001';
    end if;
    -- Si la unidad reapareció aquí viniendo de otra sucursal, la cuarentena
    -- debe quedar en la sucursal donde físicamente está.
    update public.product_serials
    set estado = v_estado_nuevo,
        location_id = case when p_tipo = 'cuarentena' and r.encontrado then f.location_id else location_id end,
        updated_at = now()
    where id = v_serial.id and estado = v_serial.estado;
    if not found then raise exception 'El estado del IMEI cambió mientras resolvías; vuelve a revisar la fila' using errcode = 'P0001'; end if;
    perform private.sincronizar_stock_serializado_par(v_serial.variant_id, v_serial.location_id, f.location_id, s.id,
      'Conteo físico: IMEI '||v_serial.serial_number||' pasa a '||v_estado_nuevo||coalesce(' — '||p_nota,''));
    v_efecto := 'product_serials.estado = '||v_estado_nuevo;

  else -- recepcion_omitida
    v_efecto := 'Sin efecto en inventario: requiere registrar la recepción real (BLOQUEA el cierre)';
  end if;

  update public.inventario_fisico_seriales
  set estado_reconciliacion = 'resuelto',
      tipo_resolucion = p_tipo,
      resolucion = nullif(btrim(coalesce(p_nota,'')),''),
      resuelto_por = s.id,
      resuelto_at = now()
  where id = r.id;

  update public.inventario_fisico_items
  set cantidad_contada = (
        select count(*) from public.inventario_fisico_seriales
        where inventario_id = r.inventario_id and variant_id = r.variant_id and encontrado
      )
  where inventario_id = r.inventario_id and variant_id = r.variant_id;

  return jsonb_build_object('tipo', p_tipo, 'efecto', v_efecto,
    'bloquea_cierre', p_tipo in ('recepcion_omitida','investigacion'));
end$function$
;

-- public.retirar_repuesto_orden
CREATE OR REPLACE FUNCTION public.retirar_repuesto_orden(p_repuesto_id uuid, p_cantidad integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare s public.staff;r public.orden_servicio_repuestos;o public.ordenes_servicio;
begin
  if p_cantidad<=0 then raise exception 'Cantidad inválida'; end if;
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  if s.id is null or not(private.tiene_capacidad('operar_taller')) then raise exception 'Sin permiso'; end if;
  select * into r from public.orden_servicio_repuestos where id=p_repuesto_id for update;
  select * into o from public.ordenes_servicio where id=r.orden_id;
  if r.id is null or o.id is null or (s.rol<>'administrador' and o.location_id<>private.auth_location_id()) or p_cantidad>r.cantidad then raise exception 'Repuesto inválido'; end if;
  insert into public.inventory(variant_id,location_id,cantidad) values(r.variant_id,o.location_id,p_cantidad) on conflict(variant_id,location_id) do update set cantidad=public.inventory.cantidad+excluded.cantidad,updated_at=now();
  insert into public.inventory_movements(variant_id,location_id,cantidad_delta,motivo,staff_id) values(r.variant_id,o.location_id,p_cantidad,'Retiro repuesto orden #'||o.numero,s.id);
  if p_cantidad=r.cantidad then delete from public.orden_servicio_repuestos where id=r.id; else update public.orden_servicio_repuestos set cantidad=cantidad-p_cantidad,updated_at=now() where id=r.id; end if;
  insert into public.orden_servicio_historial(orden_id,tipo,descripcion,actor_id) values(o.id,'repuesto','Repuesto retirado x'||p_cantidad,s.id);
  perform private.recalcular_total_orden_servicio(o.id);
end$function$
;
