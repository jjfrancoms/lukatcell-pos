create table if not exists public.product_cost_history(
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  costo_anterior numeric(14,2),
  costo_nuevo numeric(14,2) not null check(costo_nuevo>=0),
  origen text not null default 'manual',
  referencia_id uuid,
  actor_staff_id uuid references public.staff(id),
  created_at timestamptz not null default now()
);
create index if not exists product_cost_history_product_idx on public.product_cost_history(product_id,created_at desc);
alter table public.product_cost_history enable row level security;
drop policy if exists product_cost_history_admin_read on public.product_cost_history;
create policy product_cost_history_admin_read on public.product_cost_history for select to authenticated using(private.auth_is_admin());
revoke all on public.product_cost_history from anon;
revoke insert,update,delete on public.product_cost_history from authenticated;
grant select on public.product_cost_history to authenticated;

create or replace function private.log_product_cost_change()
returns trigger language plpgsql security definer set search_path='public','private' as $$
begin
  if old.costo is distinct from new.costo then
    insert into public.product_cost_history(product_id,costo_anterior,costo_nuevo,origen,actor_staff_id)
    values(new.id,old.costo,new.costo,'manual',private.auth_staff_id());
  end if;
  return new;
end$$;
revoke all on function private.log_product_cost_change() from public,anon,authenticated;
drop trigger if exists trg_product_cost_history on public.products;
create trigger trg_product_cost_history after update of costo on public.products for each row execute function private.log_product_cost_change();

create or replace function public.actualizar_costo_producto_admin(p_product_id uuid,p_costo numeric,p_origen text default 'manual')
returns numeric language plpgsql security definer set search_path='public','private' as $$
declare v_old numeric; v_actor uuid;
begin
  if not private.auth_is_admin() then raise exception 'Solo administradores pueden cambiar costos'; end if;
  if p_costo is null or p_costo<0 then raise exception 'Costo inválido'; end if;
  v_actor:=private.auth_staff_id();
  select costo into v_old from public.products where id=p_product_id for update;
  if not found then raise exception 'Producto no encontrado'; end if;
  update public.products set costo=round(p_costo,2),updated_at=now() where id=p_product_id;
  if coalesce(p_origen,'manual')<>'manual' and v_old is distinct from round(p_costo,2) then
    update public.product_cost_history set origen=left(coalesce(p_origen,'manual'),60),actor_staff_id=v_actor
    where id=(select id from public.product_cost_history where product_id=p_product_id order by created_at desc limit 1);
  end if;
  return round(p_costo,2);
end$$;
revoke all on function public.actualizar_costo_producto_admin(uuid,numeric,text) from public,anon;
grant execute on function public.actualizar_costo_producto_admin(uuid,numeric,text) to authenticated;

create or replace function public.inventario_valorizado_admin(p_location_id uuid default null)
returns table(location_id uuid,variant_id uuid,producto text,sku text,color text,cantidad integer,costo_unitario numeric,valor_stock numeric)
language plpgsql stable security definer set search_path='public','private' as $$
declare v_staff public.staff; v_location uuid;
begin
  select * into v_staff from public.staff where user_id=auth.uid() and activo=true and rol='administrador' limit 1;
  if v_staff.id is null then raise exception 'Solo administración'; end if;
  v_location:=coalesce(p_location_id,v_staff.location_id);
  return query
    select i.location_id,i.variant_id,p.nombre::text,p.sku::text,pv.color::text,i.cantidad,coalesce(p.costo,0)::numeric,round(i.cantidad*coalesce(p.costo,0),2)::numeric
    from public.inventory i join public.product_variants pv on pv.id=i.variant_id join public.products p on p.id=pv.product_id
    where i.location_id=v_location order by p.nombre,pv.color;
end$$;
revoke all on function public.inventario_valorizado_admin(uuid) from public,anon;
grant execute on function public.inventario_valorizado_admin(uuid) to authenticated;

create trigger audit_product_cost_history after insert or update or delete on public.product_cost_history for each row execute function private.registrar_auditoria();