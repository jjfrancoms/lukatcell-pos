-- ============================================================================
-- Libro de movimientos de caja (cash_movements).
--
-- Hoy `calcular_diferencia_caja()` reconstruye el efectivo esperado leyendo
-- directamente `payments`/`devoluciones`, y no existe NINGÚN mecanismo para
-- registrar ingresos, retiros, depósitos/retiros de banco, gastos ni pagos a
-- proveedor en efectivo desde caja — esas salidas de efectivo simplemente no
-- se pueden registrar hoy, así que nunca aparecen en el cálculo de diferencia
-- (cuadra "por accidente" solo si nunca ocurren). Esta migración crea un
-- libro de movimientos append-only (nunca se edita ni borra un movimiento;
-- las correcciones se hacen con una reversión explícita) y lo convierte en
-- la única fuente de verdad para el efectivo esperado de una caja.
-- ============================================================================

create table if not exists public.cash_movements (
  id uuid primary key default gen_random_uuid(),
  cash_session_id uuid not null references public.cash_sessions(id),
  tipo text not null check (tipo in (
    'venta_efectivo', 'devolucion_efectivo', 'ingreso', 'retiro',
    'deposito_banco', 'retiro_banco', 'gasto', 'pago_proveedor', 'ajuste'
  )),
  -- Monto SIEMPRE firmado: positivo = entra efectivo a la caja, negativo = sale.
  monto numeric not null check (monto <> 0),
  motivo text,
  referencia_tipo text,
  referencia_id uuid,
  staff_id uuid not null references public.staff(id),
  reversa_de uuid references public.cash_movements(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_cash_movements_session on public.cash_movements(cash_session_id);
create index if not exists idx_cash_movements_referencia on public.cash_movements(referencia_tipo, referencia_id);

alter table public.cash_movements enable row level security;

drop policy if exists cash_movements_lectura on public.cash_movements;
create policy cash_movements_lectura on public.cash_movements for select
  using (
    private.auth_is_admin()
    or exists (
      select 1 from public.cash_sessions cs
      where cs.id = cash_movements.cash_session_id and cs.cajero_id = private.auth_staff_id()
    )
  );

-- INSERT directo desde el cliente queda restringido a administradores; el
-- resto de altas (cajero registrando su propio ingreso/retiro, o el sistema
-- registrando venta/devolución/pago a proveedor) ocurre exclusivamente a
-- través de funciones SECURITY DEFINER, que al ser dueñas de la tabla
-- (postgres) omiten RLS igual que el resto de tablas de movimientos del
-- proyecto (p.ej. inventory_movements). No existen políticas de UPDATE/DELETE
-- a propósito: la tabla es append-only incluso para administradores.
drop policy if exists cash_movements_insercion_admin on public.cash_movements;
create policy cash_movements_insercion_admin on public.cash_movements for insert
  with check (private.auth_is_admin());

revoke update, delete on public.cash_movements from authenticated, anon;

-- ----------------------------------------------------------------------------
-- Helper interno: inserta un movimiento validando que la caja exista y siga
-- abierta. Todo el resto del sistema (registrar_venta, confirmar_reembolso_
-- devolucion, registrar_pago_proveedor, registrar_movimiento_caja) pasa por
-- aquí para no duplicar esa validación.
-- ----------------------------------------------------------------------------
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
  if v_sesion.cierre is not null then
    raise exception 'No se pueden registrar movimientos en una caja ya cerrada' using errcode = 'P0001';
  end if;

  insert into public.cash_movements (cash_session_id, tipo, monto, motivo, referencia_tipo, referencia_id, staff_id, reversa_de)
  values (p_cash_session_id, p_tipo, p_monto_firmado, nullif(btrim(coalesce(p_motivo, '')), ''), p_referencia_tipo, p_referencia_id, p_staff_id, p_reversa_de)
  returning * into v_mov;

  return v_mov;
end;
$$;

revoke all on function private.insertar_movimiento_caja(uuid, text, numeric, text, uuid, text, uuid, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- RPC para movimientos manuales de caja (ingreso, retiro, depósito/retiro de
-- banco, gasto, ajuste). Un cajero puede registrar ingreso/retiro únicamente
-- sobre su propia caja abierta; depósito/retiro de banco, gasto y ajuste
-- requieren administrador, encargado o jefa (mismo criterio de permisos que
-- el resto de operaciones sensibles del sistema).
-- ----------------------------------------------------------------------------
create or replace function public.registrar_movimiento_caja(
  p_cash_session_id uuid,
  p_tipo text,
  p_monto numeric,
  p_motivo text
)
returns public.cash_movements
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_staff public.staff;
  v_sesion public.cash_sessions;
  v_es_elevado boolean;
  v_signo numeric;
  v_monto_firmado numeric;
  v_saldo_actual numeric;
begin
  select * into v_staff from public.staff where user_id = auth.uid() and activo = true limit 1;
  if v_staff.id is null then
    raise exception 'Personal no válido o inactivo' using errcode = 'P0001';
  end if;

  v_es_elevado := v_staff.rol = 'administrador' or coalesce(v_staff.puesto, '') in ('encargado', 'jefa');

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

  if not v_staff.rol = 'administrador' then
    if v_sesion.location_id is distinct from v_staff.location_id then
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
    v_monto_firmado := p_monto;
  else
    if coalesce(p_monto, 0) <= 0 then
      raise exception 'El monto debe ser mayor a cero' using errcode = 'P0001';
    end if;
    v_signo := case when p_tipo in ('ingreso', 'retiro_banco') then 1 else -1 end;
    v_monto_firmado := round(p_monto, 2) * v_signo;
  end if;

  if v_monto_firmado < 0 then
    select coalesce(v_sesion.monto_inicial, 0) + coalesce(sum(monto), 0) into v_saldo_actual
    from public.cash_movements where cash_session_id = v_sesion.id;

    if v_saldo_actual + v_monto_firmado < 0 then
      raise exception 'Fondo insuficiente en caja. Disponible: S/ %, intentaste retirar: S/ %', round(v_saldo_actual, 2), abs(round(v_monto_firmado, 2)) using errcode = 'P0001';
    end if;
  end if;

  return private.insertar_movimiento_caja(v_sesion.id, p_tipo, v_monto_firmado, p_motivo, v_staff.id);
end;
$$;

revoke all on function public.registrar_movimiento_caja(uuid, text, numeric, text) from public, anon;
grant execute on function public.registrar_movimiento_caja(uuid, text, numeric, text) to authenticated;

-- ----------------------------------------------------------------------------
-- Reversión de un movimiento manual (nunca se edita ni borra el original).
-- Solo administrador; solo aplica a movimientos manuales, no a los que
-- refleja automáticamente el sistema (venta/devolución/pago a proveedor),
-- cuya corrección pasa por sus propios flujos (anulación, nota de crédito).
-- ----------------------------------------------------------------------------
create or replace function public.reversar_movimiento_caja(p_movimiento_id uuid, p_motivo text)
returns public.cash_movements
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_staff public.staff;
  v_mov public.cash_movements;
begin
  if not private.auth_is_admin() then
    raise exception 'Solo un administrador puede revertir un movimiento de caja' using errcode = 'P0001';
  end if;
  select * into v_staff from public.staff where user_id = auth.uid() and activo = true limit 1;

  select * into v_mov from public.cash_movements where id = p_movimiento_id for update;
  if v_mov.id is null then
    raise exception 'Movimiento no encontrado' using errcode = 'P0001';
  end if;
  if v_mov.tipo not in ('ingreso', 'retiro', 'deposito_banco', 'retiro_banco', 'gasto', 'ajuste') then
    raise exception 'Este movimiento no se puede revertir directamente; usa el flujo de anulación/devolución correspondiente' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.cash_movements where reversa_de = v_mov.id) then
    raise exception 'Este movimiento ya fue revertido' using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p_motivo, '')), '') is null then
    raise exception 'Debes indicar el motivo de la reversión' using errcode = 'P0001';
  end if;

  return private.insertar_movimiento_caja(v_mov.cash_session_id, v_mov.tipo, -v_mov.monto, 'Reversión: ' || p_motivo, v_staff.id, v_mov.referencia_tipo, v_mov.referencia_id, v_mov.id);
end;
$$;

revoke all on function public.reversar_movimiento_caja(uuid, text) from public, anon;
grant execute on function public.reversar_movimiento_caja(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- calcular_diferencia_caja(): ahora el efectivo esperado se reconstruye
-- exclusivamente desde el libro de movimientos (monto_inicial + suma de
-- cash_movements), no leyendo payments/devoluciones directamente. Esto es lo
-- que permite el invariante "el esperado siempre es reconstruible desde el
-- libro de movimientos".
-- ----------------------------------------------------------------------------
create or replace function public.calcular_diferencia_caja()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_movimientos numeric := 0;
begin
  if new.cierre is not null then
    select coalesce(sum(monto), 0) into v_movimientos
    from public.cash_movements where cash_session_id = old.id;

    new.monto_final_esperado := round(coalesce(old.monto_inicial, 0) + v_movimientos, 2);
    new.diferencia := round(coalesce(new.monto_final_contado, 0) - new.monto_final_esperado, 2);
  else
    new.monto_final_esperado := null;
    new.monto_final_contado := null;
    new.diferencia := null;
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- registrar_venta: cada pago en efectivo genera su movimiento de caja dentro
-- de la MISMA transacción (si falla el resto de la venta, no queda un
-- movimiento huérfano; si el movimiento fallara, la venta completa revierte).
-- Se reescribe la función completa preservando toda su lógica previa.
-- ----------------------------------------------------------------------------
create or replace function public.registrar_venta(
  p_items jsonb,
  p_pagos jsonb,
  p_subtotal numeric,
  p_impuesto numeric,
  p_total numeric,
  p_client_transaction_id uuid default null,
  p_cliente_id uuid default null,
  p_cliente_doc text default null,
  p_location_id uuid default null,
  p_cajero_id uuid default null,
  p_cash_session_id uuid default null,
  p_tipo_comprobante text default 'boleta',
  p_comprobante_cliente_tipo_doc text default null,
  p_comprobante_cliente_num_doc text default null,
  p_comprobante_cliente_denominacion text default null,
  p_comprobante_cliente_direccion text default null,
  p_occurred_at timestamptz default null,
  p_offline_origin boolean default false,
  p_orden_servicio_id uuid default null
)
returns sales
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale sales;
  v_item jsonb;
  v_pago jsonb;
  v_serie text;
  v_correlativo integer;
  v_nubefact_activo boolean;
  v_culqi_activo boolean;
  v_pago_digital_id uuid;
  v_fecha timestamptz;
  v_orden ordenes_servicio;
begin
  if p_client_transaction_id is not null then
    select * into v_sale from sales where client_transaction_id = p_client_transaction_id;
    if found then
      return v_sale;
    end if;
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La venta no tiene productos' using errcode = 'P0001';
  end if;
  if p_pagos is null or jsonb_array_length(p_pagos) = 0 then
    raise exception 'La venta no tiene un método de pago' using errcode = 'P0001';
  end if;
  if p_tipo_comprobante not in ('boleta', 'factura') then
    raise exception 'Tipo de comprobante inválido' using errcode = 'P0001';
  end if;

  v_fecha := coalesce(p_occurred_at, now());
  if v_fecha > now() + interval '5 minutes' then
    raise exception 'La fecha de la venta no puede ser futura' using errcode = 'P0001';
  end if;
  if v_fecha < now() - interval '30 days' then
    raise exception 'Esta venta ocurrió hace más de 30 días; no puede sincronizarse automáticamente. Contacta a un administrador.' using errcode = 'P0001';
  end if;
  if p_offline_origin and p_client_transaction_id is null then
    raise exception 'Las ventas offline requieren un identificador de transacción válido' using errcode = 'P0001';
  end if;

  if p_orden_servicio_id is not null then
    select * into v_orden from ordenes_servicio where id = p_orden_servicio_id for update;
    if v_orden.id is null then
      raise exception 'La orden de servicio no existe' using errcode = 'P0001';
    end if;
    if v_orden.venta_id is not null then
      raise exception 'Esta orden de servicio ya fue cobrada' using errcode = 'P0001';
    end if;
  end if;

  select coalesce(nubefact_activo, false), coalesce(culqi_activo, false)
    into v_nubefact_activo, v_culqi_activo
    from configuracion where id = 1;

  begin
    insert into sales (subtotal, impuesto, total, estado, cliente_id, cliente_doc, location_id, cajero_id, cash_session_id, client_transaction_id, fecha, synced_at, offline_origin)
    values (p_subtotal, p_impuesto, p_total, 'completada', p_cliente_id, p_cliente_doc, p_location_id, p_cajero_id, p_cash_session_id, p_client_transaction_id, v_fecha, now(), p_offline_origin)
    returning * into v_sale;
  exception
    when unique_violation then
      select * into v_sale from sales where client_transaction_id = p_client_transaction_id;
      if found then
        return v_sale;
      end if;
      raise;
  end;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into sale_items (sale_id, variant_id, cantidad, precio_unitario, subtotal, descuento, producto_nombre_snapshot, costo_snapshot, promocion_id, autorizacion_id)
    select
      v_sale.id,
      (v_item->>'variant_id')::uuid,
      (v_item->>'cantidad')::integer,
      (v_item->>'precio_unitario')::numeric,
      (v_item->>'subtotal')::numeric,
      coalesce((v_item->>'descuento')::numeric, 0),
      p.nombre,
      p.costo,
      nullif(v_item->>'promocion_id','')::uuid,
      nullif(v_item->>'autorizacion_id','')::uuid
    from product_variants pv
    join products p on p.id = pv.product_id
    where pv.id = (v_item->>'variant_id')::uuid;

    if not found then
      raise exception 'Producto no encontrado en el catálogo' using errcode = 'P0001';
    end if;
  end loop;

  for v_pago in select * from jsonb_array_elements(p_pagos)
  loop
    if v_culqi_activo and (v_pago->>'metodo') in ('yape', 'plin') then
      if nullif(v_pago->>'pago_digital_id', '') is null then
        raise exception 'Pago digital sin confirmar' using errcode = 'P0001';
      end if;

      update pagos_digitales
      set sale_id = v_sale.id, updated_at = now()
      where id = (v_pago->>'pago_digital_id')::uuid
        and estado = 'pagado'
        and sale_id is null
        and metodo = (v_pago->>'metodo')
        and monto = (v_pago->>'monto')::numeric
      returning id into v_pago_digital_id;

      if v_pago_digital_id is null then
        raise exception 'No se pudo verificar el pago digital (Yape/Plin): no está confirmado, ya fue usado, o el monto no coincide' using errcode = 'P0001';
      end if;

      insert into payments (sale_id, metodo, monto, referencia)
      values (v_sale.id, v_pago->>'metodo', (v_pago->>'monto')::numeric, 'culqi:' || (v_pago->>'pago_digital_id'));
    else
      insert into payments (sale_id, metodo, monto, referencia)
      values (v_sale.id, v_pago->>'metodo', (v_pago->>'monto')::numeric, nullif(v_pago->>'referencia', ''));
    end if;

    if lower(trim(v_pago->>'metodo')) = 'efectivo' and v_sale.cash_session_id is not null then
      perform private.insertar_movimiento_caja(
        v_sale.cash_session_id, 'venta_efectivo', (v_pago->>'monto')::numeric,
        'Venta en efectivo', v_sale.cajero_id, 'sale', v_sale.id
      );
    end if;
  end loop;

  if v_nubefact_activo then
    if p_tipo_comprobante = 'factura' then
      select nubefact_serie_factura into v_serie from configuracion where id = 1;
      v_correlativo := nextval('factura_correlativo_seq');
    else
      select nubefact_serie_boleta into v_serie from configuracion where id = 1;
      v_correlativo := nextval('boleta_correlativo_seq');
    end if;

    update sales set
      tipo_comprobante = p_tipo_comprobante,
      comprobante_serie = v_serie,
      comprobante_correlativo = v_correlativo,
      comprobante_cliente_tipo_doc = p_comprobante_cliente_tipo_doc,
      comprobante_cliente_num_doc = p_comprobante_cliente_num_doc,
      comprobante_cliente_denominacion = p_comprobante_cliente_denominacion,
      comprobante_cliente_direccion = p_comprobante_cliente_direccion
    where id = v_sale.id
    returning * into v_sale;

    insert into comprobantes_electronicos (sale_id, estado, tipo_comprobante, serie, numero)
    values (v_sale.id, 'pendiente', p_tipo_comprobante, v_serie, v_correlativo);
  end if;

  if p_orden_servicio_id is not null then
    update ordenes_servicio
    set venta_id = v_sale.id
    where id = p_orden_servicio_id and venta_id is null;

    if not found then
      raise exception 'La orden de servicio ya fue cobrada por otra operación' using errcode = 'P0001';
    end if;
  end if;

  return v_sale;
end;
$$;

-- ----------------------------------------------------------------------------
-- confirmar_reembolso_devolucion: el reembolso en efectivo ahora también
-- genera su movimiento de caja (salida) en la misma transacción.
-- ----------------------------------------------------------------------------
create or replace function public.confirmar_reembolso_devolucion(p_devolucion_id uuid, p_metodo text, p_referencia text default null, p_cash_session_id uuid default null)
returns devoluciones
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_actor public.staff;
  v_dev public.devoluciones;
  v_caja public.cash_sessions;
begin
  select * into v_actor from public.staff where user_id=auth.uid() and activo=true limit 1;
  if v_actor.id is null or v_actor.rol <> 'administrador' then raise exception 'Solo un administrador activo puede confirmar reembolsos'; end if;
  select * into v_dev from public.devoluciones where id=p_devolucion_id for update;
  if v_dev.id is null or v_dev.estado <> 'completada' then raise exception 'Devolución inválida'; end if;
  if v_dev.reembolso_estado='completado' then return v_dev; end if;
  if p_metodo is null or length(trim(p_metodo))<2 then raise exception 'Método de reembolso inválido'; end if;

  if lower(trim(p_metodo))='efectivo' then
    if p_cash_session_id is null then raise exception 'El reembolso en efectivo requiere una caja abierta'; end if;
    select * into v_caja from public.cash_sessions where id=p_cash_session_id and cierre is null for update;
    if v_caja.id is null then raise exception 'La caja seleccionada no está abierta'; end if;
    if v_caja.location_id is distinct from v_dev.location_id then raise exception 'La caja no pertenece a la sucursal de la devolución'; end if;
  end if;

  update public.devoluciones set
    reembolso_estado='completado',
    reembolso_metodo=lower(trim(p_metodo)),
    reembolso_referencia=nullif(trim(coalesce(p_referencia,'')),''),
    reembolso_cash_session_id=case when lower(trim(p_metodo))='efectivo' then p_cash_session_id else null end,
    reembolsado_at=now()
  where id=v_dev.id returning * into v_dev;

  if v_dev.reembolso_metodo = 'efectivo' then
    perform private.insertar_movimiento_caja(
      v_caja.id, 'devolucion_efectivo', -v_dev.monto,
      'Reembolso de devolución', v_actor.id, 'devolucion', v_dev.id
    );
  end if;

  return v_dev;
end;
$$;

-- ----------------------------------------------------------------------------
-- registrar_pago_proveedor: un pago en efectivo desde caja ahora exige una
-- caja abierta y genera su movimiento (salida) automáticamente, dando
-- trazabilidad factura ↔ pago ↔ movimiento de caja.
-- ----------------------------------------------------------------------------
create or replace function public.registrar_pago_proveedor(p_factura_id uuid, p_monto numeric, p_metodo text, p_referencia text default null, p_cash_session_id uuid default null)
returns facturas_proveedor
language plpgsql
security definer
set search_path = public, private
as $$
declare s public.staff; f public.facturas_proveedor; nuevo_pagado numeric; v_pago_id uuid; v_caja public.cash_sessions;
begin
  if not private.auth_is_admin() then raise exception 'Solo administradores'; end if;
  if p_monto<=0 then raise exception 'Monto inválido'; end if;
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  select * into f from public.facturas_proveedor where id=p_factura_id for update;
  if f.id is null or f.estado in('pagada','anulada') then raise exception 'Factura no pagable'; end if;
  if f.pagado+p_monto>f.total+0.005 then raise exception 'El pago excede el saldo pendiente'; end if;

  if lower(trim(p_metodo))='efectivo' then
    if p_cash_session_id is null then raise exception 'El pago en efectivo requiere indicar la caja de la que sale el dinero'; end if;
    select * into v_caja from public.cash_sessions where id=p_cash_session_id and cierre is null for update;
    if v_caja.id is null then raise exception 'La caja seleccionada no está abierta'; end if;
  end if;

  insert into public.pagos_proveedor(factura_id,monto,metodo,referencia,pagado_por) values(f.id,round(p_monto,2),lower(trim(p_metodo)),nullif(trim(p_referencia),''),s.id) returning id into v_pago_id;
  nuevo_pagado:=round(f.pagado+p_monto,2);
  update public.facturas_proveedor set pagado=nuevo_pagado,estado=case when nuevo_pagado>=total-0.005 then 'pagada' else 'parcial' end,updated_at=now() where id=f.id returning * into f;

  if lower(trim(p_metodo))='efectivo' then
    perform private.insertar_movimiento_caja(
      v_caja.id, 'pago_proveedor', -round(p_monto,2),
      'Pago a proveedor: factura ' || coalesce(f.numero, f.id::text), s.id, 'pago_proveedor', v_pago_id
    );
  end if;

  return f;
end$$;

-- registrar_pago_proveedor ganó un parámetro nuevo (p_cash_session_id), lo
-- que cambia su firma de tipos: CREATE OR REPLACE NO sobrescribe la función
-- de 4 parámetros, crea una segunda función sobrecargada y PostgREST queda
-- ambiguo sobre cuál invocar (mismo problema ya resuelto antes con
-- registrar_venta). Se elimina explícitamente la firma vieja.
drop function if exists public.registrar_pago_proveedor(uuid, numeric, text, text);
revoke all on function public.registrar_pago_proveedor(uuid, numeric, text, text, uuid) from public, anon;
grant execute on function public.registrar_pago_proveedor(uuid, numeric, text, text, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Backfill seguro: solo para cajas ACTUALMENTE ABIERTAS (no se toca ninguna
-- caja ya cerrada ni su diferencia histórica). Reconstruye en el libro los
-- movimientos de venta/devolución en efectivo que ya ocurrieron antes de que
-- este libro existiera, para que el próximo cierre de esas cajas calcule
-- correctamente. Idempotente: usa NOT EXISTS sobre referencia_tipo/id.
-- ----------------------------------------------------------------------------
insert into public.cash_movements (cash_session_id, tipo, monto, motivo, referencia_tipo, referencia_id, staff_id, created_at)
select s.cash_session_id, 'venta_efectivo', p.monto, 'Backfill: venta registrada antes del libro de caja', 'sale', s.id, s.cajero_id, s.fecha
from public.sales s
join public.payments p on p.sale_id = s.id and p.metodo = 'efectivo'
join public.cash_sessions cs on cs.id = s.cash_session_id and cs.cierre is null
where s.estado = 'completada'
  and not exists (
    select 1 from public.cash_movements cm where cm.referencia_tipo = 'sale' and cm.referencia_id = s.id
  );

insert into public.cash_movements (cash_session_id, tipo, monto, motivo, referencia_tipo, referencia_id, staff_id, created_at)
select d.reembolso_cash_session_id, 'devolucion_efectivo', -d.monto, 'Backfill: reembolso registrado antes del libro de caja', 'devolucion', d.id, cs.cajero_id, d.reembolsado_at
from public.devoluciones d
join public.cash_sessions cs on cs.id = d.reembolso_cash_session_id and cs.cierre is null
where d.estado = 'completada' and d.reembolso_estado = 'completado' and d.reembolso_metodo = 'efectivo'
  and not exists (
    select 1 from public.cash_movements cm where cm.referencia_tipo = 'devolucion' and cm.referencia_id = d.id
  );
