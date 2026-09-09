-- ============================================================================
-- P0.3 bloques 6, 7, 8 y 9: la reconciliación de IMEI deja de ser un texto y
-- pasa a tener efecto real sobre product_serials.
--
-- BLOQUE 6/7 — Antes, resolver_reconciliacion_serial sólo escribía
--   estado_reconciliacion='resuelto' + una nota libre. Un IMEI físicamente
--   faltante podía quedar "resuelto" y seguir con estado='disponible', o sea
--   vendible. Trazabilidad falsa. Ahora cada resolución tiene un TIPO con
--   reglas y efecto real.
--
-- BLOQUE 8 — cerrar_inventario_fisico aceptaba ('coincide','resuelto'). Ahora
--   sólo cuenta como reconciliado 'coincide' o un 'resuelto' con un tipo
--   TERMINAL. 'investigacion' y 'recepcion_omitida' son BLOCKER explícitos
--   (no ambiguo): para cerrar hay que convertirlos a un tipo terminal.
--
--   Además se retira, SOLO para variantes serializadas, el chequeo agregado
--   cantidad_contada <> esperado_al_contar. No es un relajamiento: una vez
--   que cada unidad tiene estado terminal, la verdad física es la lista de
--   seriales, y las resoluciones (faltante, baja, cuarentena...) mueven el
--   agregado a propósito, así que exigir además la igualdad agregada
--   bloquearía para siempre un conteo legítimamente resuelto. En su lugar el
--   cierre ALINEA inventory.cantidad al número real de seriales disponibles,
--   dejando el delta como inventory_movements auditable.
--
-- BLOQUE 9 — registrar_serial_contado valida ahora que la variante pertenezca
--   al conteo, que el producto sea realmente serializado, y que un serial ya
--   conocido pertenezca a esa misma variante (antes se podía guardar
--   variant_id=X con serial_id de Y: las dos FK son independientes).
--
-- Dato de producción: los únicos productos serializados existentes son los 5
-- QA-INTEGRITY-imei de las corridas de P0.1, y estaban inconsistentes
-- (inventory=0 pero 2 seriales 'disponible' cada uno). Se dan de baja: nunca
-- existieron físicamente. Si se dejaran, cada conteo futuro los arrastraría
-- como faltantes y no podría cerrarse jamás.
-- ============================================================================

alter table public.product_serials drop constraint if exists product_serials_estado_check;
alter table public.product_serials add constraint product_serials_estado_check
  check (estado = any (array['disponible','vendido','en_transito','servicio','baja','cuarentena','faltante','investigacion']));

alter table public.inventario_fisico_seriales add column if not exists tipo_resolucion text;
alter table public.inventario_fisico_seriales drop constraint if exists invfis_seriales_tipo_resolucion_check;
alter table public.inventario_fisico_seriales add constraint invfis_seriales_tipo_resolucion_check
  check (tipo_resolucion is null or tipo_resolucion = any (array[
    'error_escaneo','corregir_ubicacion','cuarentena','faltante_confirmado','baja','recepcion_omitida','investigacion'
  ]));

comment on column public.inventario_fisico_seriales.tipo_resolucion is
  'Tipo de resolución con efecto real. TERMINALES (permiten cerrar): error_escaneo, corregir_ubicacion, cuarentena, faltante_confirmado, baja. BLOQUEANTES: recepcion_omitida, investigacion.';

update public.product_serials ps
set estado = 'baja', updated_at = now()
where ps.estado = 'disponible'
  and exists (
    select 1 from public.product_variants pv join public.products p on p.id = pv.product_id
    where pv.id = ps.variant_id and p.nombre ilike 'QA-INTEGRITY%'
  );

create or replace function public.registrar_serial_contado(p_inventario_id uuid, p_variant_id uuid, p_serial_number text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  s public.staff;
  f public.inventarios_fisicos;
  v_norm text := upper(trim(coalesce(p_serial_number, '')));
  v_row public.inventario_fisico_seriales;
  v_serial public.product_serials;
  v_control boolean;
begin
  select * into s from public.staff where user_id = auth.uid() and activo = true limit 1;
  if s.id is null or not(s.rol = 'administrador' or coalesce(s.puesto,'') in ('tecnico','encargado','jefa')) then
    raise exception 'Sin permiso';
  end if;
  select * into f from public.inventarios_fisicos where id = p_inventario_id;
  if f.id is null or f.location_id <> s.location_id or f.estado <> 'abierto' then
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
end$function$;

-- Se elimina la firma vieja de 2 argumentos: dejar ambas crearía una
-- sobrecarga ambigua y PostgREST podría resolver a la que no valida nada
-- (la lección de P0.2 con registrar_venta).
drop function if exists public.resolver_reconciliacion_serial(uuid, text);

create or replace function public.resolver_reconciliacion_serial(p_item_id uuid, p_tipo text, p_nota text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  s public.staff;
  r public.inventario_fisico_seriales;
  f public.inventarios_fisicos;
  v_serial public.product_serials;
  v_estado_nuevo text;
  v_efecto text;
begin
  select * into s from public.staff where user_id = auth.uid() and activo = true limit 1;
  if s.id is null or not(s.rol = 'administrador' or coalesce(s.puesto,'') in ('encargado','jefa')) then
    raise exception 'Sin permiso';
  end if;
  if p_tipo is null or p_tipo not in ('error_escaneo','corregir_ubicacion','cuarentena','faltante_confirmado','baja','recepcion_omitida','investigacion') then
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
  if f.id is null or f.location_id <> s.location_id or f.estado <> 'abierto' then
    raise exception 'Conteo no editable';
  end if;

  if r.serial_id is not null then
    select * into v_serial from public.product_serials where id = r.serial_id for update;
  end if;

  if p_tipo = 'error_escaneo' then
    if r.esperado then
      raise exception 'error_escaneo sólo aplica a un serial inesperado; un esperado que no apareció es un faltante' using errcode = 'P0001';
    end if;
    update public.inventario_fisico_seriales set encontrado = false where id = r.id;
    v_efecto := 'Escaneo descartado; product_serials sin cambios';

  elsif p_tipo = 'corregir_ubicacion' then
    if v_serial.id is null then
      raise exception 'corregir_ubicacion requiere un IMEI/serie ya registrado en el catálogo' using errcode = 'P0001';
    end if;
    if v_serial.location_id = f.location_id then
      raise exception 'Ese IMEI/serie ya está en esta sucursal' using errcode = 'P0001';
    end if;
    if v_serial.estado = 'disponible' then
      update public.inventory set cantidad = greatest(0, cantidad - 1), updated_at = now()
      where variant_id = v_serial.variant_id and location_id = v_serial.location_id;
      insert into public.inventory_movements(variant_id, location_id, cantidad_delta, motivo, staff_id)
      values (v_serial.variant_id, v_serial.location_id, -1,
              'Conteo físico: IMEI '||v_serial.serial_number||' reubicado a otra sucursal', s.id);
      insert into public.inventory(variant_id, location_id, cantidad, updated_at)
      values (v_serial.variant_id, f.location_id, 1, now())
      on conflict (variant_id, location_id) do update set cantidad = public.inventory.cantidad + 1, updated_at = now();
      insert into public.inventory_movements(variant_id, location_id, cantidad_delta, motivo, staff_id)
      values (v_serial.variant_id, f.location_id, 1,
              'Conteo físico: IMEI '||v_serial.serial_number||' encontrado aquí y reubicado', s.id);
    end if;
    update public.product_serials set location_id = f.location_id, updated_at = now() where id = v_serial.id;
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
    if v_serial.estado = 'disponible' then
      update public.inventory set cantidad = greatest(0, cantidad - 1), updated_at = now()
      where variant_id = v_serial.variant_id and location_id = v_serial.location_id;
      insert into public.inventory_movements(variant_id, location_id, cantidad_delta, motivo, staff_id)
      values (v_serial.variant_id, v_serial.location_id, -1,
              'Conteo físico: IMEI '||v_serial.serial_number||' pasa a '||v_estado_nuevo||coalesce(' — '||p_nota,''), s.id);
    end if;
    update public.product_serials set estado = v_estado_nuevo, updated_at = now() where id = v_serial.id;
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
end$function$;

revoke all on function public.resolver_reconciliacion_serial(uuid, text, text) from public, anon;
grant execute on function public.resolver_reconciliacion_serial(uuid, text, text) to authenticated;

-- NOTA: iniciar_inventario_fisico y cerrar_inventario_fisico quedan en su
-- versión definitiva en la migración siguiente
-- (20260909015208_conteo_serializado_cantidad_derivada_de_escaneos), que
-- corrige el caso de un serializado con 0 escaneos.
