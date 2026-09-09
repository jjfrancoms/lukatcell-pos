-- ============================================================================
-- P0.4 — Matriz de transiciones de IMEI y cierre del hueco que dejaba un
-- conteo bloqueado para siempre.
--
-- HALLAZGO 1: resolver_reconciliacion_serial no miraba el estado ANTERIOR del
--   serial. Un IMEI 'vendido' (con sale_id y sold_at intactos) podía pasar a
--   'faltante' o 'baja' desde un conteo físico, y un 'baja' podía revivir vía
--   cuarentena. Todas las demás funciones del sistema que cambian
--   product_serials.estado (venta, devolución, anulación, transferencia,
--   cuarentena) llevan el estado previo en el WHERE; ésta era la única que no.
--
-- HALLAZGO 2 (nuevo, encontrado al diseñar la matriz): el conteo permanece
--   abierto mientras el POS sigue vendiendo. Un serial esperado puede
--   venderse o despacharse DURANTE el conteo. Si la matriz sólo rechazara,
--   esa fila quedaría irresoluble y cerrar_inventario_fisico bloquearía para
--   siempre. Por eso se añade el tipo 'movimiento_posterior': no toca el
--   catálogo, deja constancia y NO bloquea el cierre. Es el único tipo
--   admitido desde 'vendido'/'en_transito' en una fila esperada.
--
-- Criterio de la matriz: el conteo físico sólo es dueño de la vitrina
-- ('disponible') y de los estados que él mismo produce ('faltante',
-- 'investigacion'), más la cuarentena. Venta, transferencia, taller y baja
-- contable tienen sus propios flujos y se redirige explícitamente a ellos.
-- Ninguna ruta devuelve un serial a 'disponible': la única puerta de regreso
-- sigue siendo cuarentena + resolver_cuarentena_serial (admin).
-- ============================================================================

alter table public.inventario_fisico_seriales drop constraint if exists invfis_seriales_tipo_resolucion_check;
alter table public.inventario_fisico_seriales add constraint invfis_seriales_tipo_resolucion_check
  check (tipo_resolucion is null or tipo_resolucion = any (array[
    'error_escaneo','corregir_ubicacion','cuarentena','faltante_confirmado','baja',
    'recepcion_omitida','investigacion','movimiento_posterior'
  ]));

comment on column public.inventario_fisico_seriales.tipo_resolucion is
  'Tipo de resolución con efecto real. TERMINALES (permiten cerrar): error_escaneo, corregir_ubicacion, cuarentena, faltante_confirmado, baja, movimiento_posterior. BLOQUEANTES: recepcion_omitida, investigacion.';

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
  v_origen uuid;
  v_estado_nuevo text;
  v_efecto text;
  v_delta int;
begin
  select * into s from public.staff where user_id = auth.uid() and activo = true limit 1;
  if s.id is null or not(s.rol = 'administrador' or coalesce(s.puesto,'') in ('encargado','jefa')) then
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
  if f.id is null or f.location_id <> s.location_id or f.estado <> 'abierto' then
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
end$function$;

revoke all on function public.resolver_reconciliacion_serial(uuid, text, text) from public, anon;
grant execute on function public.resolver_reconciliacion_serial(uuid, text, text) to authenticated;

-- Higiene: estas dos internas conservaban el EXECUTE implícito a PUBLIC. No
-- son alcanzables (anon no tiene USAGE sobre `private` y PostgREST no expone
-- ese esquema), pero es el mismo patrón que ya causó una regresión antes.
revoke all on function private.vincular_autorizacion_descuento() from public, anon, authenticated;
revoke all on function private.estado_dispositivos_cierre(uuid) from public, anon, authenticated;
