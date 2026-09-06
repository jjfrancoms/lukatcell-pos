-- ============================================================================
-- "Se cierra la caja con ventas pendientes" / "una venta offline sincroniza
-- horas o días después" (escenarios explícitos del hardening).
--
-- Con la migración anterior (cash_movements_ledger), insertar_movimiento_caja
-- rechaza CUALQUIER movimiento sobre una caja ya cerrada. Eso es correcto
-- para movimientos manuales (nadie debería poder registrar un gasto/retiro
-- "ahora" contra un cajón que ya se cerró y entregó), pero es un error grave
-- para una venta en efectivo que YA OCURRIÓ válidamente mientras la caja
-- SÍ estaba abierta y que recién sincroniza después de que el cajero cerró:
-- hoy esa venta se registraría en `sales` y luego, al intentar su
-- cash_movement, toda la transacción de registrar_venta reviente y la venta
-- se pierda por completo (queda en FAILED para siempre, porque cada reintento
-- vuelve a fallar igual). Perder una venta ya cobrada es inaceptable.
--
-- Se permite que específicamente 'venta_efectivo' se registre contra una
-- caja cerrada (su fecha real ya fue validada contra la ventana de apertura/
-- cierre de esa caja en validar_contexto_venta_autenticada), y se recalcula
-- monto_final_esperado/diferencia de esa caja para que sigan siendo
-- reconstruibles desde el libro — marcando la caja con
-- recalculado_tras_cierre para que quede visible que su cierre ya no refleja
-- el momento exacto en que se contó el efectivo.
-- ============================================================================

alter table public.cash_sessions add column if not exists recalculado_tras_cierre boolean not null default false;

create or replace function private.insertar_movimiento_caja(
  p_cash_session_id uuid,
  p_tipo text,
  p_monto_firmado numeric,
  p_motivo text,
  p_staff_id uuid,
  p_referencia_tipo text default null,
  p_referencia_id uuid default null,
  p_reversa_de uuid default null
)
returns public.cash_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sesion public.cash_sessions;
  v_mov public.cash_movements;
begin
  select * into v_sesion from public.cash_sessions where id = p_cash_session_id for update;
  if v_sesion.id is null then
    raise exception 'La caja indicada no existe' using errcode = 'P0001';
  end if;
  -- Excepción deliberada: una venta en efectivo que ocurrió mientras la caja
  -- estaba abierta (su fecha ya fue validada contra esa ventana) puede
  -- sincronizar después de que el cajero cerró, sin perderse.
  if v_sesion.cierre is not null and p_tipo <> 'venta_efectivo' then
    raise exception 'No se pueden registrar movimientos en una caja ya cerrada' using errcode = 'P0001';
  end if;

  insert into public.cash_movements (cash_session_id, tipo, monto, motivo, referencia_tipo, referencia_id, staff_id, reversa_de)
  values (p_cash_session_id, p_tipo, p_monto_firmado, nullif(btrim(coalesce(p_motivo, '')), ''), p_referencia_tipo, p_referencia_id, p_staff_id, p_reversa_de)
  returning * into v_mov;

  return v_mov;
end;
$$;

-- ----------------------------------------------------------------------------
-- validar_contexto_caja: se relaja la protección de "caja cerrada no se
-- modifica" para permitir EXCLUSIVAMENTE que monto_final_esperado/diferencia/
-- recalculado_tras_cierre cambien (recálculo automático); apertura, cierre,
-- monto_inicial, monto_final_contado, cajero_id y location_id de una caja
-- cerrada siguen siendo absolutamente inmutables.
-- ----------------------------------------------------------------------------
create or replace function public.validar_contexto_caja()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff public.staff;
  v_fecha date := (now() at time zone 'America/Lima')::date;
begin
  if auth.uid() is null then
    return new;
  end if;

  select * into v_staff
  from public.staff
  where user_id = auth.uid() and activo = true
  limit 1;

  if v_staff.id is null then
    raise exception 'Personal no válido o inactivo';
  end if;

  if tg_op = 'INSERT' then
    if new.cajero_id is distinct from v_staff.id then
      raise exception 'No puedes abrir caja a nombre de otro empleado';
    end if;

    if new.location_id is distinct from v_staff.location_id then
      raise exception 'La caja debe pertenecer a tu sucursal';
    end if;

    if coalesce(new.monto_inicial, 0) < 0 then
      raise exception 'El monto inicial no puede ser negativo';
    end if;

    if not exists (
      select 1
      from public.asistencias a
      where a.staff_id = v_staff.id
        and a.fecha = v_fecha
        and a.entrada is not null
        and a.salida is null
    ) then
      raise exception 'Debes tener una jornada activa para abrir caja';
    end if;

    new.apertura := now();
    new.cierre := null;
    new.monto_final_esperado := null;
    new.monto_final_contado := null;
    new.diferencia := null;
    return new;
  end if;

  if old.cajero_id is distinct from v_staff.id then
    raise exception 'Solo el cajero propietario puede modificar esta caja';
  end if;

  if new.cajero_id is distinct from old.cajero_id
     or new.location_id is distinct from old.location_id
     or new.apertura is distinct from old.apertura
     or new.monto_inicial is distinct from old.monto_inicial then
    raise exception 'No se puede modificar la identidad ni la apertura de una caja';
  end if;

  if old.cierre is not null then
    if new.apertura is distinct from old.apertura
       or new.cierre is distinct from old.cierre
       or new.monto_inicial is distinct from old.monto_inicial
       or new.monto_final_contado is distinct from old.monto_final_contado
       or new.cajero_id is distinct from old.cajero_id
       or new.location_id is distinct from old.location_id then
      raise exception 'Una caja cerrada no se puede modificar ni reabrir';
    end if;
    return new;
  end if;

  if new.cierre is not null then
    if new.monto_final_contado is null or new.monto_final_contado < 0 then
      raise exception 'Debes indicar un monto contado válido para cerrar caja';
    end if;
    new.cierre := now();
  elsif new.monto_final_esperado is not null
     or new.monto_final_contado is not null
     or new.diferencia is not null then
    raise exception 'Los montos de cierre solo se registran al cerrar caja';
  end if;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- Recalcula monto_final_esperado/diferencia de una caja YA CERRADA cuando le
-- llega tardíamente un movimiento (venta offline que sincroniza después del
-- cierre), para que "esperado" siga siendo reconstruible desde el libro en
-- todo momento, y deja marca visible (recalculado_tras_cierre) de que ese
-- cierre ya no representa el arqueo original hecho por el cajero.
-- ----------------------------------------------------------------------------
create or replace function private.recalcular_caja_tras_movimiento()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sesion public.cash_sessions;
  v_total numeric;
  v_nuevo_esperado numeric;
begin
  select * into v_sesion from public.cash_sessions where id = new.cash_session_id for update;
  if v_sesion.id is not null and v_sesion.cierre is not null then
    select coalesce(sum(monto), 0) into v_total from public.cash_movements where cash_session_id = v_sesion.id;
    v_nuevo_esperado := round(coalesce(v_sesion.monto_inicial, 0) + v_total, 2);
    update public.cash_sessions
    set monto_final_esperado = v_nuevo_esperado,
        diferencia = round(coalesce(v_sesion.monto_final_contado, 0) - v_nuevo_esperado, 2),
        recalculado_tras_cierre = true
    where id = v_sesion.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_recalcular_caja_tras_movimiento on public.cash_movements;
create trigger trg_recalcular_caja_tras_movimiento
  after insert on public.cash_movements
  for each row execute function private.recalcular_caja_tras_movimiento();
