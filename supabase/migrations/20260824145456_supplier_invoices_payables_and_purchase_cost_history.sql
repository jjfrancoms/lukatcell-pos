create table if not exists public.facturas_proveedor(
  id uuid primary key default gen_random_uuid(),
  proveedor_id uuid not null references public.proveedores(id),
  orden_id uuid references public.ordenes_compra(id),
  location_id uuid not null references public.locations(id),
  tipo_documento text not null default 'factura',
  serie text not null,
  numero text not null,
  fecha_emision date not null,
  fecha_vencimiento date,
  moneda text not null default 'PEN',
  total numeric(14,2) not null check(total>=0),
  pagado numeric(14,2) not null default 0 check(pagado>=0),
  estado text not null default 'pendiente' check(estado in('pendiente','parcial','pagada','anulada')),
  storage_path text,
  observacion text,
  registrado_por uuid not null references public.staff(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(proveedor_id,serie,numero)
);
create table if not exists public.pagos_proveedor(
  id uuid primary key default gen_random_uuid(),
  factura_id uuid not null references public.facturas_proveedor(id),
  monto numeric(14,2) not null check(monto>0),
  metodo text not null,
  referencia text,
  pagado_por uuid not null references public.staff(id),
  pagado_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create table if not exists public.historial_costos_compra(
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  variant_id uuid not null references public.product_variants(id),
  proveedor_id uuid references public.proveedores(id),
  orden_id uuid references public.ordenes_compra(id),
  recepcion_id uuid references public.recepciones_compra(id),
  costo_unitario numeric(14,2) not null,
  cantidad integer not null,
  created_at timestamptz not null default now()
);
create index if not exists hcc_product_idx on public.historial_costos_compra(product_id,created_at desc);

alter table public.facturas_proveedor enable row level security;
alter table public.pagos_proveedor enable row level security;
alter table public.historial_costos_compra enable row level security;
create policy facturas_proveedor_admin on public.facturas_proveedor for all to authenticated using(private.auth_is_admin()) with check(private.auth_is_admin());
create policy pagos_proveedor_admin on public.pagos_proveedor for all to authenticated using(private.auth_is_admin()) with check(private.auth_is_admin());
create policy historial_costos_compra_admin on public.historial_costos_compra for select to authenticated using(private.auth_is_admin());
revoke all on public.facturas_proveedor,public.pagos_proveedor,public.historial_costos_compra from anon;
grant select on public.facturas_proveedor,public.pagos_proveedor,public.historial_costos_compra to authenticated;
revoke insert,update,delete on public.historial_costos_compra from authenticated;

create or replace function public.registrar_factura_proveedor(p_proveedor_id uuid,p_orden_id uuid,p_tipo_documento text,p_serie text,p_numero text,p_fecha_emision date,p_fecha_vencimiento date,p_total numeric,p_storage_path text default null,p_observacion text default null)
returns public.facturas_proveedor language plpgsql security definer set search_path='public','private' as $$
declare s public.staff; f public.facturas_proveedor; o public.ordenes_compra;
begin
  if not private.auth_is_admin() then raise exception 'Solo administradores'; end if;
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  if p_total<0 then raise exception 'Total inválido'; end if;
  if p_orden_id is not null then select * into o from public.ordenes_compra where id=p_orden_id; if o.id is null or o.proveedor_id<>p_proveedor_id then raise exception 'Orden/proveedor inválido'; end if; end if;
  insert into public.facturas_proveedor(proveedor_id,orden_id,location_id,tipo_documento,serie,numero,fecha_emision,fecha_vencimiento,total,storage_path,observacion,registrado_por)
  values(p_proveedor_id,p_orden_id,s.location_id,lower(coalesce(nullif(trim(p_tipo_documento),''),'factura')),upper(trim(p_serie)),trim(p_numero),p_fecha_emision,p_fecha_vencimiento,round(p_total,2),nullif(trim(p_storage_path),''),nullif(trim(p_observacion),''),s.id) returning * into f;
  return f;
end$$;

create or replace function public.registrar_pago_proveedor(p_factura_id uuid,p_monto numeric,p_metodo text,p_referencia text default null)
returns public.facturas_proveedor language plpgsql security definer set search_path='public','private' as $$
declare s public.staff; f public.facturas_proveedor; nuevo_pagado numeric;
begin
  if not private.auth_is_admin() then raise exception 'Solo administradores'; end if;
  if p_monto<=0 then raise exception 'Monto inválido'; end if;
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  select * into f from public.facturas_proveedor where id=p_factura_id for update;
  if f.id is null or f.estado in('pagada','anulada') then raise exception 'Factura no pagable'; end if;
  if f.pagado+p_monto>f.total+0.005 then raise exception 'El pago excede el saldo pendiente'; end if;
  insert into public.pagos_proveedor(factura_id,monto,metodo,referencia,pagado_por) values(f.id,round(p_monto,2),lower(trim(p_metodo)),nullif(trim(p_referencia),''),s.id);
  nuevo_pagado:=round(f.pagado+p_monto,2);
  update public.facturas_proveedor set pagado=nuevo_pagado,estado=case when nuevo_pagado>=total-0.005 then 'pagada' else 'parcial' end,updated_at=now() where id=f.id returning * into f;
  return f;
end$$;

create or replace function public.cuentas_por_pagar_admin()
returns table(factura_id uuid,proveedor text,documento text,fecha_emision date,fecha_vencimiento date,total numeric,pagado numeric,saldo numeric,estado text,dias_vencido integer)
language plpgsql stable security definer set search_path='public','private' as $$
begin
 if not private.auth_is_admin() then raise exception 'Solo administradores'; end if;
 return query select f.id,p.nombre,(f.serie||'-'||f.numero)::text,f.fecha_emision,f.fecha_vencimiento,f.total,f.pagado,round(f.total-f.pagado,2),f.estado,case when f.fecha_vencimiento is not null and f.estado<>'pagada' then greatest(0,current_date-f.fecha_vencimiento) else 0 end from public.facturas_proveedor f join public.proveedores p on p.id=f.proveedor_id where f.estado not in('pagada','anulada') order by f.fecha_vencimiento nulls last,f.fecha_emision;
end$$;

create or replace function private.log_recepcion_purchase_cost()
returns trigger language plpgsql security definer set search_path='public','private' as $$
declare oi public.orden_compra_items; r public.recepciones_compra; o public.ordenes_compra; pid uuid;
begin
 select * into oi from public.orden_compra_items where id=new.orden_item_id;
 select * into r from public.recepciones_compra where id=new.recepcion_id;
 select * into o from public.ordenes_compra where id=r.orden_id;
 select product_id into pid from public.product_variants where id=oi.variant_id;
 insert into public.historial_costos_compra(product_id,variant_id,proveedor_id,orden_id,recepcion_id,costo_unitario,cantidad) values(pid,oi.variant_id,o.proveedor_id,o.id,r.id,new.costo_unitario,new.cantidad);
 return new;
end$$;
revoke all on function private.log_recepcion_purchase_cost() from public,anon,authenticated;
drop trigger if exists trg_recepcion_purchase_cost on public.recepcion_compra_items;
create trigger trg_recepcion_purchase_cost after insert on public.recepcion_compra_items for each row execute function private.log_recepcion_purchase_cost();

revoke all on function public.registrar_factura_proveedor(uuid,uuid,text,text,text,date,date,numeric,text,text) from public,anon;
revoke all on function public.registrar_pago_proveedor(uuid,numeric,text,text) from public,anon;
revoke all on function public.cuentas_por_pagar_admin() from public,anon;
grant execute on function public.registrar_factura_proveedor(uuid,uuid,text,text,text,date,date,numeric,text,text) to authenticated;
grant execute on function public.registrar_pago_proveedor(uuid,numeric,text,text) to authenticated;
grant execute on function public.cuentas_por_pagar_admin() to authenticated;

create trigger audit_facturas_proveedor after insert or update or delete on public.facturas_proveedor for each row execute function private.registrar_auditoria();
create trigger audit_pagos_proveedor after insert or update or delete on public.pagos_proveedor for each row execute function private.registrar_auditoria();