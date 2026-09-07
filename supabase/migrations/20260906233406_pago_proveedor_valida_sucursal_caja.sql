-- ============================================================================
-- P0.1 bloque 4: registrar_pago_proveedor ya exigía p_cash_session_id para
-- efectivo, pero no validaba que esa caja perteneciera a la MISMA sucursal
-- de la factura — un admin podía pagar una factura de una tienda con el
-- efectivo de la caja de otra. Se agrega esa validación (facturas_proveedor
-- ya tiene location_id). El resto de la función queda igual.
-- ============================================================================
create or replace function public.registrar_pago_proveedor(p_factura_id uuid, p_monto numeric, p_metodo text, p_referencia text default null, p_cash_session_id uuid default null)
returns facturas_proveedor
language plpgsql
security definer
set search_path = public, private
as $function$
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
    if v_caja.location_id is distinct from f.location_id then raise exception 'La caja seleccionada no pertenece a la sucursal de esta factura'; end if;
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
end$function$;
