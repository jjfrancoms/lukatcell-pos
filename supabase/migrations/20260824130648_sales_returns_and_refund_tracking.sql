create table if not exists public.devoluciones (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id),
  location_id uuid not null references public.locations(id),
  tipo text not null default 'parcial' check (tipo in ('parcial','total')),
  motivo text not null,
  monto numeric not null default 0 check (monto >= 0),
  estado text not null default 'completada' check (estado in ('completada','cancelada')),
  reembolso_estado text not null default 'pendiente' check (reembolso_estado in ('pendiente','completado','fallido')),
  reembolso_metodo text,
  reembolso_referencia text,
  reembolso_cash_session_id uuid references public.cash_sessions(id),
  creado_por uuid not null references public.staff(id),
  created_at timestamptz not null default now(),
  reembolsado_at timestamptz
);

create table if not exists public.devolucion_items (
  id uuid primary key default gen_random_uuid(),
  devolucion_id uuid not null references public.devoluciones(id) on delete cascade,
  sale_item_id uuid not null references public.sale_items(id),
  variant_id uuid not null references public.product_variants(id),
  cantidad integer not null check (cantidad > 0),
  monto numeric not null check (monto >= 0),
  unique (devolucion_id, sale_item_id)
);

create index if not exists devoluciones_sale_id_idx on public.devoluciones(sale_id, created_at desc);
create index if not exists devoluciones_location_idx on public.devoluciones(location_id, created_at desc);
create index if not exists devolucion_items_sale_item_idx on public.devolucion_items(sale_item_id);

alter table public.devoluciones enable row level security;
alter table public.devolucion_items enable row level security;

drop policy if exists devoluciones_admin_select on public.devoluciones;
create policy devoluciones_admin_select on public.devoluciones for select to authenticated using (private.auth_is_admin());
drop policy if exists devolucion_items_admin_select on public.devolucion_items;
create policy devolucion_items_admin_select on public.devolucion_items for select to authenticated using (private.auth_is_admin());

revoke all on public.devoluciones from anon;
revoke all on public.devolucion_items from anon;
revoke insert, update, delete on public.devoluciones from authenticated;
revoke insert, update, delete on public.devolucion_items from authenticated;
grant select on public.devoluciones, public.devolucion_items to authenticated;

drop trigger if exists audit_devoluciones on public.devoluciones;
create trigger audit_devoluciones after insert or update or delete on public.devoluciones for each row execute function private.registrar_auditoria();

create or replace function public.registrar_devolucion(p_sale_id uuid, p_items jsonb, p_motivo text)
returns public.devoluciones
language plpgsql
security definer
set search_path='public','private'
as $$
declare
  v_actor public.staff;
  v_sale public.sales;
  v_dev public.devoluciones;
  v_json jsonb;
  v_item public.sale_items;
  v_cantidad integer;
  v_devuelta integer;
  v_monto_linea numeric;
  v_monto_total numeric := 0;
  v_total_vendido integer;
  v_total_devuelto integer;
begin
  select * into v_actor from public.staff where user_id=auth.uid() and activo=true limit 1;
  if v_actor.id is null or v_actor.rol <> 'administrador' then raise exception 'Solo un administrador activo puede registrar devoluciones'; end if;
  if p_motivo is null or length(trim(p_motivo)) < 5 then raise exception 'Debes indicar un motivo válido'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items)=0 then raise exception 'La devolución no tiene productos'; end if;

  select * into v_sale from public.sales where id=p_sale_id for update;
  if v_sale.id is null then raise exception 'Venta no encontrada'; end if;
  if v_sale.estado <> 'completada' then raise exception 'Solo se admiten devoluciones sobre ventas completadas'; end if;

  insert into public.devoluciones(sale_id,location_id,motivo,creado_por)
  values(v_sale.id,v_sale.location_id,trim(p_motivo),v_actor.id)
  returning * into v_dev;

  for v_json in select * from jsonb_array_elements(p_items) loop
    v_cantidad := coalesce((v_json->>'cantidad')::integer,0);
    if v_cantidad <= 0 then raise exception 'Cantidad de devolución inválida'; end if;

    select * into v_item from public.sale_items where id=(v_json->>'sale_item_id')::uuid and sale_id=v_sale.id for update;
    if v_item.id is null then raise exception 'Línea de venta inválida'; end if;

    select coalesce(sum(di.cantidad),0)::integer into v_devuelta
    from public.devolucion_items di join public.devoluciones d on d.id=di.devolucion_id
    where di.sale_item_id=v_item.id and d.estado='completada';

    if v_devuelta + v_cantidad > v_item.cantidad then raise exception 'La cantidad devuelta supera la cantidad vendida'; end if;

    v_monto_linea := round((v_item.subtotal / nullif(v_item.cantidad,0)) * v_cantidad,2);
    v_monto_total := v_monto_total + v_monto_linea;

    insert into public.devolucion_items(devolucion_id,sale_item_id,variant_id,cantidad,monto)
    values(v_dev.id,v_item.id,v_item.variant_id,v_cantidad,v_monto_linea);

    insert into public.inventory(variant_id,location_id,cantidad,updated_at)
    values(v_item.variant_id,v_sale.location_id,v_cantidad,now())
    on conflict(variant_id,location_id) do update set cantidad=public.inventory.cantidad+excluded.cantidad,updated_at=now();

    insert into public.inventory_movements(variant_id,location_id,cantidad_delta,motivo,staff_id)
    values(v_item.variant_id,v_sale.location_id,v_cantidad,'Devolución venta #'||v_sale.numero||': '||left(trim(p_motivo),220),v_actor.id);
  end loop;

  select coalesce(sum(si.cantidad),0)::integer into v_total_vendido from public.sale_items si where si.sale_id=v_sale.id;
  select coalesce(sum(di.cantidad),0)::integer into v_total_devuelto
  from public.devolucion_items di join public.devoluciones d on d.id=di.devolucion_id
  join public.sale_items si on si.id=di.sale_item_id
  where si.sale_id=v_sale.id and d.estado='completada';

  update public.devoluciones
  set monto=round(v_monto_total,2), tipo=case when v_total_devuelto>=v_total_vendido then 'total' else 'parcial' end
  where id=v_dev.id returning * into v_dev;

  return v_dev;
end;
$$;

create or replace function public.confirmar_reembolso_devolucion(p_devolucion_id uuid,p_metodo text,p_referencia text default null,p_cash_session_id uuid default null)
returns public.devoluciones
language plpgsql
security definer
set search_path='public','private'
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
  return v_dev;
end;
$$;

create or replace function public.calcular_diferencia_caja()
returns trigger
language plpgsql
security definer
set search_path='public'
as $$
declare
  v_ventas_efectivo numeric := 0;
  v_reembolsos_efectivo numeric := 0;
begin
  if new.cierre is not null then
    select coalesce(sum(p.monto),0) into v_ventas_efectivo
    from public.payments p join public.sales s on s.id=p.sale_id
    where s.cash_session_id=old.id and s.estado='completada' and p.metodo='efectivo';

    select coalesce(sum(d.monto),0) into v_reembolsos_efectivo
    from public.devoluciones d
    where d.reembolso_cash_session_id=old.id and d.estado='completada' and d.reembolso_estado='completado' and d.reembolso_metodo='efectivo';

    new.monto_final_esperado := round(coalesce(old.monto_inicial,0)+v_ventas_efectivo-v_reembolsos_efectivo,2);
    new.diferencia := round(coalesce(new.monto_final_contado,0)-new.monto_final_esperado,2);
  else
    new.monto_final_esperado:=null;
    new.monto_final_contado:=null;
    new.diferencia:=null;
  end if;
  return new;
end;
$$;

revoke all on function public.registrar_devolucion(uuid,jsonb,text) from public,anon;
revoke all on function public.confirmar_reembolso_devolucion(uuid,text,text,uuid) from public,anon;
grant execute on function public.registrar_devolucion(uuid,jsonb,text) to authenticated;
grant execute on function public.confirmar_reembolso_devolucion(uuid,text,text,uuid) to authenticated;
