alter table public.promociones add column if not exists requiere_cupon boolean not null default false;
update public.promociones p set requiere_cupon=true where exists(select 1 from public.cupones c where c.promocion_id=p.id);

create table if not exists public.cupon_usos(
 id uuid primary key default gen_random_uuid(),
 cupon_id uuid not null references public.cupones(id),
 sale_id uuid not null references public.sales(id),
 usado_por uuid not null references public.staff(id),
 created_at timestamptz not null default now(),
 unique(cupon_id,sale_id)
);
alter table public.cupon_usos enable row level security;
drop policy if exists cupon_usos_admin_read on public.cupon_usos;
create policy cupon_usos_admin_read on public.cupon_usos for select to authenticated using(private.auth_is_admin());

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
     and ((p_codigo_cupon is null and not p.requiere_cupon)
       or (p_codigo_cupon is not null and exists(select 1 from public.cupones cu where cu.promocion_id=p.id and cu.codigo=upper(trim(p_codigo_cupon)) and cu.activo and cu.fecha_inicio<=now() and (cu.fecha_fin is null or cu.fecha_fin>now()) and (cu.max_usos is null or cu.usos<cu.max_usos))))
   group by p.id,p.nombre,p.tipo,p.valor,p.compra_cantidad,p.paga_cantidad,p.prioridad
 )
 select e.id,e.nombre,e.tipo,
        round(case e.tipo when 'porcentaje' then e.base*e.valor/100 when 'monto_fijo' then least(e.base,e.valor) when '2x1' then e.d_2x1 when 'precio_especial' then e.d_especial when 'combo' then least(e.base,e.valor) else 0 end,2)
 from elegibles e where e.cumple
 order by e.prioridad,4 desc;
end$$;

create or replace function public.resolver_promociones_carrito(p_items jsonb,p_codigo_cupon text default null)
returns table(variant_id uuid,descuento_promocion_unitario numeric,promocion_id uuid,promocion_nombre text,acumulable boolean)
language plpgsql stable security definer set search_path='public','private' as $$
declare v_pid uuid; v_nombre text; v_tipo text; v_total numeric; v_valor numeric; v_compra int; v_paga int; v_acum boolean; v_base numeric;
begin
 if private.auth_staff_id() is null then raise exception 'Usuario no vinculado'; end if;
 select e.promocion_id,e.nombre,e.tipo,e.descuento into v_pid,v_nombre,v_tipo,v_total
 from public.evaluar_promociones_carrito(p_items,p_codigo_cupon) e limit 1;
 if v_pid is null or coalesce(v_total,0)<=0 then return; end if;
 select p.valor,p.compra_cantidad,p.paga_cantidad,p.acumulable into v_valor,v_compra,v_paga,v_acum from public.promociones p where p.id=v_pid;
 select coalesce(sum(greatest(0,(x->>'cantidad')::int)*greatest(0,(x->>'precio_unitario')::numeric)),0) into v_base
 from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) x join public.promocion_items pi on pi.promocion_id=v_pid and pi.variant_id=(x->>'variant_id')::uuid;
 return query
 with cart as (
   select (x->>'variant_id')::uuid vid,greatest(0,(x->>'cantidad')::int) qty,greatest(0,(x->>'precio_unitario')::numeric) price
   from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) x
 ), eleg as (
   select c.* from cart c join public.promocion_items pi on pi.promocion_id=v_pid and pi.variant_id=c.vid
 )
 select e.vid,
   round(case
     when e.qty<=0 or e.price<=0 then 0
     when v_tipo='porcentaje' then least(e.price,e.price*v_valor/100)
     when v_tipo='precio_especial' then greatest(0,e.price-v_valor)
     when v_tipo='2x1' then least(e.price,(floor(e.qty::numeric/v_compra)*(v_compra-v_paga)*e.price)/e.qty)
     when v_tipo in('monto_fijo','combo') and v_base>0 then least(e.price,(v_total*(e.qty*e.price/v_base))/e.qty)
     else 0 end,2),
   v_pid,v_nombre,v_acum
 from eleg e;
end$$;

create or replace function public.registrar_uso_cupon(p_codigo text,p_sale_id uuid)
returns void language plpgsql security definer set search_path='public','private' as $$
declare v_staff public.staff; v_cupon public.cupones; v_inserted int;
begin
 select * into v_staff from public.staff where user_id=auth.uid() and activo=true limit 1;
 if v_staff.id is null then raise exception 'Personal no válido'; end if;
 if not exists(select 1 from public.sales s where s.id=p_sale_id and s.location_id=private.auth_location_id()) then raise exception 'Venta inválida'; end if;
 select * into v_cupon from public.cupones c where c.codigo=upper(trim(p_codigo)) and c.activo and c.fecha_inicio<=now() and (c.fecha_fin is null or c.fecha_fin>now()) for update;
 if v_cupon.id is null then raise exception 'Cupón inválido o vencido'; end if;
 if v_cupon.max_usos is not null and v_cupon.usos>=v_cupon.max_usos then raise exception 'Cupón sin usos disponibles'; end if;
 insert into public.cupon_usos(cupon_id,sale_id,usado_por) values(v_cupon.id,p_sale_id,v_staff.id) on conflict(cupon_id,sale_id) do nothing;
 get diagnostics v_inserted=row_count;
 if v_inserted=1 then update public.cupones set usos=usos+1 where id=v_cupon.id; end if;
end$$;

revoke execute on function public.resolver_promociones_carrito(jsonb,text) from public,anon;
revoke execute on function public.registrar_uso_cupon(text,uuid) from public,anon;
grant execute on function public.resolver_promociones_carrito(jsonb,text) to authenticated;
grant execute on function public.registrar_uso_cupon(text,uuid) to authenticated;
