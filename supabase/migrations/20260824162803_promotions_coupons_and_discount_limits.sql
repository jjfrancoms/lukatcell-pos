alter table public.configuracion add column if not exists descuento_vendedor_max_pct numeric(5,2) not null default 0 check(descuento_vendedor_max_pct>=0 and descuento_vendedor_max_pct<=100);

create table if not exists public.promociones(
 id uuid primary key default gen_random_uuid(),
 nombre text not null,
 tipo text not null check(tipo in('porcentaje','monto_fijo','2x1','precio_especial','combo')),
 valor numeric(12,2) not null default 0 check(valor>=0),
 compra_cantidad integer not null default 1 check(compra_cantidad>0),
 paga_cantidad integer not null default 1 check(paga_cantidad>0 and paga_cantidad<=compra_cantidad),
 fecha_inicio timestamptz not null default now(),
 fecha_fin timestamptz,
 activo boolean not null default true,
 prioridad integer not null default 100,
 acumulable boolean not null default false,
 creado_por uuid references public.staff(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check(fecha_fin is null or fecha_fin>fecha_inicio)
);
create table if not exists public.promocion_items(
 promocion_id uuid not null references public.promociones(id) on delete cascade,
 variant_id uuid not null references public.product_variants(id),
 cantidad_requerida integer not null default 1 check(cantidad_requerida>0),
 primary key(promocion_id,variant_id)
);
create table if not exists public.cupones(
 id uuid primary key default gen_random_uuid(),
 codigo text not null unique,
 promocion_id uuid not null references public.promociones(id) on delete cascade,
 max_usos integer,
 usos integer not null default 0,
 fecha_inicio timestamptz not null default now(),
 fecha_fin timestamptz,
 activo boolean not null default true,
 created_at timestamptz not null default now(),
 check(max_usos is null or max_usos>0),
 check(fecha_fin is null or fecha_fin>fecha_inicio)
);
alter table public.promociones enable row level security;
alter table public.promocion_items enable row level security;
alter table public.cupones enable row level security;
create policy promociones_read on public.promociones for select to authenticated using(activo=true or private.auth_is_admin());
create policy promocion_items_read on public.promocion_items for select to authenticated using(exists(select 1 from public.promociones p where p.id=promocion_id and (p.activo or private.auth_is_admin())));
create policy cupones_admin_read on public.cupones for select to authenticated using(private.auth_is_admin());

create or replace function public.guardar_promocion_admin(p_id uuid,p_nombre text,p_tipo text,p_valor numeric,p_compra_cantidad integer,p_paga_cantidad integer,p_fecha_inicio timestamptz,p_fecha_fin timestamptz,p_activo boolean,p_prioridad integer,p_acumulable boolean,p_variants jsonb)
returns uuid language plpgsql security definer set search_path='public','private' as $$
declare rid uuid; s uuid:=private.auth_staff_id(); it jsonb;
begin
 if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
 if p_tipo not in('porcentaje','monto_fijo','2x1','precio_especial','combo') then raise exception 'Tipo inválido'; end if;
 if length(trim(coalesce(p_nombre,'')))<2 then raise exception 'Nombre inválido'; end if;
 if p_tipo='porcentaje' and (p_valor<0 or p_valor>100) then raise exception 'Porcentaje inválido'; end if;
 if p_tipo='2x1' and (p_compra_cantidad<2 or p_paga_cantidad>=p_compra_cantidad) then raise exception 'Regla 2x1 inválida'; end if;
 if p_id is null then
   insert into public.promociones(nombre,tipo,valor,compra_cantidad,paga_cantidad,fecha_inicio,fecha_fin,activo,prioridad,acumulable,creado_por)
   values(trim(p_nombre),p_tipo,coalesce(p_valor,0),greatest(1,coalesce(p_compra_cantidad,1)),greatest(1,coalesce(p_paga_cantidad,1)),coalesce(p_fecha_inicio,now()),p_fecha_fin,coalesce(p_activo,true),coalesce(p_prioridad,100),coalesce(p_acumulable,false),s) returning id into rid;
 else
   update public.promociones set nombre=trim(p_nombre),tipo=p_tipo,valor=coalesce(p_valor,0),compra_cantidad=greatest(1,coalesce(p_compra_cantidad,1)),paga_cantidad=greatest(1,coalesce(p_paga_cantidad,1)),fecha_inicio=coalesce(p_fecha_inicio,fecha_inicio),fecha_fin=p_fecha_fin,activo=coalesce(p_activo,true),prioridad=coalesce(p_prioridad,100),acumulable=coalesce(p_acumulable,false),updated_at=now() where id=p_id returning id into rid;
   if rid is null then raise exception 'Promoción inexistente'; end if;
   delete from public.promocion_items where promocion_id=rid;
 end if;
 for it in select * from jsonb_array_elements(coalesce(p_variants,'[]'::jsonb)) loop
   insert into public.promocion_items(promocion_id,variant_id,cantidad_requerida) values(rid,(it->>'variant_id')::uuid,greatest(1,coalesce((it->>'cantidad')::int,1))) on conflict(promocion_id,variant_id) do update set cantidad_requerida=excluded.cantidad_requerida;
 end loop;
 if not exists(select 1 from public.promocion_items where promocion_id=rid) then raise exception 'La promoción requiere al menos un producto'; end if;
 return rid;
end$$;

create or replace function public.guardar_cupon_admin(p_codigo text,p_promocion_id uuid,p_max_usos integer,p_fecha_inicio timestamptz,p_fecha_fin timestamptz,p_activo boolean)
returns uuid language plpgsql security definer set search_path='public','private' as $$
declare rid uuid;
begin
 if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
 if length(trim(coalesce(p_codigo,'')))<3 then raise exception 'Código inválido'; end if;
 insert into public.cupones(codigo,promocion_id,max_usos,fecha_inicio,fecha_fin,activo)
 values(upper(trim(p_codigo)),p_promocion_id,p_max_usos,coalesce(p_fecha_inicio,now()),p_fecha_fin,coalesce(p_activo,true))
 on conflict(codigo) do update set promocion_id=excluded.promocion_id,max_usos=excluded.max_usos,fecha_inicio=excluded.fecha_inicio,fecha_fin=excluded.fecha_fin,activo=excluded.activo
 returning id into rid; return rid;
end$$;

create or replace function public.evaluar_promociones_carrito(p_items jsonb,p_codigo_cupon text default null)
returns table(promocion_id uuid,nombre text,tipo text,descuento numeric)
language plpgsql stable security definer set search_path='public','private' as $$
begin
 if private.auth_staff_id() is null then raise exception 'Usuario no vinculado'; end if;
 return query
 with cart as (
   select (x->>'variant_id')::uuid variant_id,greatest(0,(x->>'cantidad')::int) cantidad,greatest(0,(x->>'precio_unitario')::numeric) precio
   from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) x
 ), elegibles as (
   select p.id,p.nombre,p.tipo,p.valor,p.compra_cantidad,p.paga_cantidad,p.prioridad,
          case when p.tipo='combo' then bool_and(coalesce(c.cantidad,0)>=pi.cantidad_requerida)
               else count(*) filter(where coalesce(c.cantidad,0)>=pi.cantidad_requerida)>0 end cumple,
          sum(case when c.variant_id is not null then c.cantidad*c.precio else 0 end) base,
          sum(case when c.variant_id is not null then floor(c.cantidad::numeric/p.compra_cantidad)*(p.compra_cantidad-p.paga_cantidad)*c.precio else 0 end) d_2x1,
          sum(case when c.variant_id is not null then greatest(0,(c.precio-p.valor)*c.cantidad) else 0 end) d_especial
   from public.promociones p join public.promocion_items pi on pi.promocion_id=p.id left join cart c on c.variant_id=pi.variant_id
   where p.activo and p.fecha_inicio<=now() and (p.fecha_fin is null or p.fecha_fin>now())
     and (p_codigo_cupon is null or exists(select 1 from public.cupones cu where cu.promocion_id=p.id and cu.codigo=upper(trim(p_codigo_cupon)) and cu.activo and cu.fecha_inicio<=now() and (cu.fecha_fin is null or cu.fecha_fin>now()) and (cu.max_usos is null or cu.usos<cu.max_usos)))
   group by p.id,p.nombre,p.tipo,p.valor,p.compra_cantidad,p.paga_cantidad,p.prioridad
 )
 select e.id,e.nombre,e.tipo,
        round(case e.tipo when 'porcentaje' then e.base*e.valor/100 when 'monto_fijo' then least(e.base,e.valor) when '2x1' then e.d_2x1 when 'precio_especial' then e.d_especial when 'combo' then least(e.base,e.valor) else 0 end,2)
 from elegibles e where e.cumple
 order by e.prioridad,4 desc;
end$$;

create or replace function public.limite_descuento_actual()
returns numeric language sql stable security definer set search_path='public','private' as $$
 select case when private.auth_is_admin() then 100::numeric else coalesce((select descuento_vendedor_max_pct from public.configuracion where id=1),0) end;
$$;

revoke execute on function public.guardar_promocion_admin(uuid,text,text,numeric,integer,integer,timestamptz,timestamptz,boolean,integer,boolean,jsonb) from public,anon;
revoke execute on function public.guardar_cupon_admin(text,uuid,integer,timestamptz,timestamptz,boolean) from public,anon;
revoke execute on function public.evaluar_promociones_carrito(jsonb,text) from public,anon;
revoke execute on function public.limite_descuento_actual() from public,anon;
grant execute on function public.guardar_promocion_admin(uuid,text,text,numeric,integer,integer,timestamptz,timestamptz,boolean,integer,boolean,jsonb) to authenticated;
grant execute on function public.guardar_cupon_admin(text,uuid,integer,timestamptz,timestamptz,boolean) to authenticated;
grant execute on function public.evaluar_promociones_carrito(jsonb,text) to authenticated;
grant execute on function public.limite_descuento_actual() to authenticated;
