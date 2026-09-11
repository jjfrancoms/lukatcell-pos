-- ============================================================================
-- P0.4 — El ledger de inventario deja de registrar deltas inventados, y las
-- ventas dejan de ser invisibles en él.
--
-- HALLAZGO CRÍTICO (nuevo, no reportado por la auditoría externa):
--   descontar_inventario, el trigger que descuenta stock en cada línea de
--   venta, NO escribía NINGUNA fila en inventory_movements. Las ventas eran
--   invisibles en el libro mayor.
--
--   Eso no es sólo un hueco de auditoría: corrompe el conteo físico. La rama
--   NO serializada de cerrar_inventario_fisico calcula
--       esperado_al_contar = cantidad_sistema + sum(movimientos hasta contar)
--   y aplica  nuevo = actual + (contado - esperado). Si una venta real ocurre
--   con el conteo abierto y no deja movimiento:
--       snapshot 10, venta -2 (stock real 8), contado 8
--       esperado(mal) = 10  ->  diff = -2  ->  nuevo = 8 + (-2) = 6   ← CORRUPTO
--   Con el movimiento presente: esperado = 8, diff = 0, nuevo = 8 (correcto).
--
--   El caso B que P0.1 dio por verificado sólo funcionó porque aquella prueba
--   simuló la venta con ajustar_stock (que sí escribe movimiento) en vez de
--   una venta real. El camino real nunca se ejerció.
--
-- HALLAZGO 2: deltas fijos ±1. Varias funciones hacían
--       update inventory set cantidad = greatest(0, cantidad - 1);
--       insert inventory_movements(cantidad_delta = -1);
--   Con cantidad=0 el clamp no cambia nada pero el ledger afirma -1. Regla
--   nueva: todo movimiento registra cantidad_nueva - cantidad_anterior.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Las ventas entran al ledger. El delta es real: el UPDATE aplicó
--    exactamente new.cantidad o la función ya abortó por stock insuficiente.
-- ----------------------------------------------------------------------------
create or replace function public.descontar_inventario()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_location_id uuid;
  v_cajero_id uuid;
  v_permitir_negativo boolean;
  v_filas integer;
begin
  select location_id, cajero_id into v_location_id, v_cajero_id from sales where id = new.sale_id;

  select coalesce(permitir_stock_negativo, false) into v_permitir_negativo
    from configuracion where id = 1;

  if v_permitir_negativo then
    update inventory
      set cantidad = cantidad - new.cantidad, updated_at = now()
      where variant_id = new.variant_id and location_id = v_location_id;
  else
    update inventory
      set cantidad = cantidad - new.cantidad, updated_at = now()
      where variant_id = new.variant_id and location_id = v_location_id
        and cantidad >= new.cantidad;
  end if;

  get diagnostics v_filas = row_count;
  if v_filas = 0 then
    raise exception 'Stock insuficiente para completar la venta'
      using errcode = 'P0001';
  end if;

  -- Sin esta fila, el conteo físico calcula mal el stock esperado y termina
  -- corrigiendo el inventario hacia un valor equivocado.
  insert into inventory_movements(variant_id, location_id, cantidad_delta, motivo, staff_id)
  values (new.variant_id, v_location_id, -new.cantidad, 'Venta', v_cajero_id);

  return new;
end;
$function$;

-- ----------------------------------------------------------------------------
-- 2. Punto único para sincronizar el stock agregado de un producto
--    serializado con su verdad física (los seriales disponibles).
--    Atómica, con locks, auditable e idempotente: si no hay cambio real no
--    escribe nada y no genera movimiento.
-- ----------------------------------------------------------------------------
create or replace function private.sincronizar_stock_serializado(
  p_variant_id uuid,
  p_location_id uuid,
  p_staff_id uuid,
  p_motivo text
) returns integer
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_anterior integer;
  v_nuevo integer;
  v_delta integer;
begin
  if p_variant_id is null or p_location_id is null then
    raise exception 'sincronizar_stock_serializado requiere variant_id y location_id' using errcode = 'P0001';
  end if;

  -- R2 (hallazgo del red team): sin esta guarda, llamarla para una variante NO
  -- serializada pondría su inventory en el número de seriales 'disponible'
  -- (cero), borrando stock real. Hoy no hay ninguna variante no serializada
  -- con seriales, pero basta con que alguien desactive control_serial en un
  -- producto que ya los tuvo para convertirlo en pérdida de stock.
  if not exists (
    select 1 from public.product_variants pv
    join public.products p on p.id = pv.product_id
    where pv.id = p_variant_id and coalesce(p.control_serial, false)
  ) then
    raise exception 'sincronizar_stock_serializado sólo aplica a productos con IMEI/serie (variante %)', p_variant_id
      using errcode = 'P0001';
  end if;

  -- La fila agregada es el punto de serialización: se crea si falta y se
  -- bloquea, para que dos resoluciones concurrentes no se pisen.
  insert into public.inventory(variant_id, location_id, cantidad, updated_at)
  values (p_variant_id, p_location_id, 0, now())
  on conflict (variant_id, location_id) do nothing;

  select cantidad into v_anterior
  from public.inventory
  where variant_id = p_variant_id and location_id = p_location_id
  for update;
  v_anterior := coalesce(v_anterior, 0);

  select count(*)::int into v_nuevo
  from public.product_serials
  where variant_id = p_variant_id and location_id = p_location_id and estado = 'disponible';

  v_delta := v_nuevo - v_anterior;
  if v_delta = 0 then
    return 0;
  end if;

  update public.inventory set cantidad = v_nuevo, updated_at = now()
  where variant_id = p_variant_id and location_id = p_location_id;

  insert into public.inventory_movements(variant_id, location_id, cantidad_delta, motivo, staff_id)
  values (p_variant_id, p_location_id, v_delta,
          left(coalesce(nullif(btrim(p_motivo),''), 'Sincronización de stock con IMEI/serie disponibles'), 250),
          p_staff_id);

  return v_delta;
end$function$;

revoke all on function private.sincronizar_stock_serializado(uuid, uuid, uuid, text) from public, anon, authenticated;

-- Wrapper para operaciones que tocan DOS sucursales (reubicar un IMEI).
-- Ordena los locks por location_id para que dos transacciones simultáneas en
-- sentidos opuestos (A->B y B->A) no se bloqueen mutuamente.
create or replace function private.sincronizar_stock_serializado_par(
  p_variant_id uuid, p_loc_a uuid, p_loc_b uuid, p_staff_id uuid, p_motivo text
) returns void
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare v_1 uuid; v_2 uuid;
begin
  if p_loc_a is null or p_loc_b is null or p_loc_a = p_loc_b then
    perform private.sincronizar_stock_serializado(p_variant_id, coalesce(p_loc_a, p_loc_b), p_staff_id, p_motivo);
    return;
  end if;
  v_1 := least(p_loc_a::text, p_loc_b::text)::uuid;
  v_2 := greatest(p_loc_a::text, p_loc_b::text)::uuid;
  perform private.sincronizar_stock_serializado(p_variant_id, v_1, p_staff_id, p_motivo);
  perform private.sincronizar_stock_serializado(p_variant_id, v_2, p_staff_id, p_motivo);
end$function$;

revoke all on function private.sincronizar_stock_serializado_par(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. resolver_cuarentena_serial usaba +1 fijo. Ahora delega.
-- ----------------------------------------------------------------------------
create or replace function public.resolver_cuarentena_serial(p_serial_id uuid, p_decision text, p_observacion text default null)
returns product_serials
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
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

  -- El agregado se alinea al conteo real de seriales disponibles; el delta
  -- que quede registrado es el que realmente ocurrió.
  perform private.sincronizar_stock_serializado(
    v_serial.variant_id, v_serial.location_id, v_staff.id,
    'Cuarentena resuelta como '||p_decision||' ('||v_serial.serial_number||')'||coalesce(' — '||p_observacion, ''));

  return v_serial;
end$function$;
