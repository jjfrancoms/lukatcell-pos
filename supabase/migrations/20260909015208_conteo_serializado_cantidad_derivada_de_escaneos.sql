-- ============================================================================
-- P0.3 (continuación del bloque 8): un producto serializado no puede quedar
-- bloqueando el cierre por "falta contarlo".
--
-- Detectado al probar el flujo completo: para una variante serializada la
-- cantidad NO se escribe a mano (registrar_conteo_fisico la rechaza) — se
-- deriva de los escaneos. Pero si nadie escanea nada, cantidad_contada se
-- queda en NULL y cerrar_inventario_fisico aborta con "Faltan productos por
-- contar", sin forma de destrabarlo: un producto serializado con 0 unidades
-- dejaba el conteo imposible de cerrar.
--
-- Corrección: para variantes serializadas la cantidad arranca en 0 (0
-- escaneos = 0 unidades) y el chequeo de "faltan por contar" sólo mira las
-- variantes NO serializadas. Esto no relaja nada: las serializadas siguen
-- protegidas por el gate por unidad (ningún serial esperado puede quedar sin
-- reconciliar), que es estrictamente más fuerte que exigir un número.
-- ============================================================================

create or replace function public.iniciar_inventario_fisico(p_observacion text default null)
returns inventarios_fisicos
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare s public.staff; f public.inventarios_fisicos;
begin
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  if s.id is null or not(s.rol='administrador' or coalesce(s.puesto,'') in('tecnico','encargado','jefa')) then
    raise exception 'Sin permiso';
  end if;
  if exists(select 1 from public.inventarios_fisicos where location_id=s.location_id and estado='abierto') then
    raise exception 'Ya existe un conteo abierto';
  end if;
  insert into public.inventarios_fisicos(location_id,creado_por,observacion) values(s.location_id,s.id,nullif(btrim(p_observacion),'')) returning * into f;

  -- Las serializadas arrancan en 0: su cantidad se deriva de los escaneos.
  insert into public.inventario_fisico_items(inventario_id,variant_id,cantidad_sistema,cantidad_contada)
    select f.id, i.variant_id, i.cantidad,
           case when coalesce(p.control_serial,false) then 0 else null end
    from public.inventory i
    join public.product_variants pv on pv.id = i.variant_id
    join public.products p on p.id = pv.product_id
    where i.location_id = s.location_id;

  insert into public.inventario_fisico_seriales(inventario_id, variant_id, serial_id, serial_number, esperado)
  select f.id, ps.variant_id, ps.id, ps.serial_number, true
  from public.product_serials ps
  join public.product_variants pv on pv.id = ps.variant_id
  join public.products p on p.id = pv.product_id
  where p.control_serial and ps.location_id = s.location_id and ps.estado = 'disponible';

  return f;
end$function$;

create or replace function public.cerrar_inventario_fisico(p_inventario_id uuid)
returns inventarios_fisicos
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
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
  v_disponibles int;
begin
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  if s.id is null or not(s.rol='administrador' or coalesce(s.puesto,'') in('encargado','jefa')) then
    raise exception 'Solo administración/encargado puede cerrar conteo';
  end if;
  select * into f from public.inventarios_fisicos where id=p_inventario_id for update;
  if f.id is null or f.location_id<>s.location_id or f.estado<>'abierto' then
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

  for i in select * from public.inventario_fisico_items where inventario_id=f.id loop
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

      select count(*) into v_disponibles from public.product_serials
      where variant_id=i.variant_id and location_id=f.location_id and estado='disponible';
      select cantidad into v_actual from public.inventory where variant_id=i.variant_id and location_id=f.location_id for update;
      v_actual := coalesce(v_actual,0);
      if v_disponibles <> v_actual then
        insert into public.inventory(variant_id,location_id,cantidad,updated_at) values(i.variant_id,f.location_id,v_disponibles,now())
        on conflict(variant_id,location_id) do update set cantidad=v_disponibles,updated_at=now();
        insert into public.inventory_movements(variant_id,location_id,cantidad_delta,motivo,staff_id)
        values(i.variant_id,f.location_id,v_disponibles-v_actual,'Conteo físico: stock alineado a los IMEI/serie realmente disponibles',s.id);
      end if;
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
end$function$;
