alter table public.sales
  add column if not exists anulada_at timestamptz,
  add column if not exists anulada_por uuid references public.staff(id),
  add column if not exists anulacion_motivo text;

create index if not exists sales_estado_fecha_idx on public.sales(estado, fecha desc);

create or replace function public.anular_venta(p_sale_id uuid, p_motivo text)
returns public.sales
language plpgsql
security definer
set search_path = 'public','private'
as $$
declare
  v_actor public.staff;
  v_sale public.sales;
  v_item record;
begin
  select * into v_actor
  from public.staff
  where user_id = auth.uid() and activo = true
  limit 1;

  if v_actor.id is null or v_actor.rol <> 'administrador' then
    raise exception 'Solo un administrador activo puede anular ventas';
  end if;

  if p_motivo is null or length(trim(p_motivo)) < 5 then
    raise exception 'Debes indicar un motivo de anulación válido';
  end if;

  select * into v_sale
  from public.sales
  where id = p_sale_id
  for update;

  if v_sale.id is null then
    raise exception 'Venta no encontrada';
  end if;

  if v_sale.estado = 'anulada' then
    return v_sale;
  end if;

  if v_sale.estado <> 'completada' then
    raise exception 'Solo se pueden anular ventas completadas';
  end if;

  if exists (select 1 from public.comprobantes_electronicos ce where ce.sale_id = v_sale.id) then
    raise exception 'La venta tiene comprobante electrónico; requiere flujo de nota de crédito';
  end if;

  if exists (select 1 from public.pagos_digitales pd where pd.sale_id = v_sale.id and pd.estado = 'pagado') then
    raise exception 'La venta tiene pago digital confirmado; requiere flujo de reembolso';
  end if;

  for v_item in
    select si.variant_id, sum(si.cantidad)::integer cantidad
    from public.sale_items si
    where si.sale_id = v_sale.id
    group by si.variant_id
  loop
    insert into public.inventory (variant_id, location_id, cantidad, updated_at)
    values (v_item.variant_id, v_sale.location_id, v_item.cantidad, now())
    on conflict (variant_id, location_id) do update
      set cantidad = public.inventory.cantidad + excluded.cantidad,
          updated_at = now();

    insert into public.inventory_movements (variant_id, location_id, cantidad_delta, motivo, staff_id)
    values (
      v_item.variant_id,
      v_sale.location_id,
      v_item.cantidad,
      'Anulación venta #' || v_sale.numero || ': ' || left(trim(p_motivo), 220),
      v_actor.id
    );
  end loop;

  update public.ordenes_servicio
  set venta_id = null
  where venta_id = v_sale.id;

  update public.sales
  set estado = 'anulada',
      anulada_at = now(),
      anulada_por = v_actor.id,
      anulacion_motivo = trim(p_motivo)
  where id = v_sale.id
  returning * into v_sale;

  return v_sale;
end;
$$;

revoke all on function public.anular_venta(uuid,text) from public, anon;
grant execute on function public.anular_venta(uuid,text) to authenticated;
