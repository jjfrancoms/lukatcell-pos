alter table public.staff add column if not exists active_location_id uuid references public.locations(id);

create table if not exists public.staff_locations(
  staff_id uuid not null references public.staff(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  puede_vender boolean not null default true,
  puede_inventario boolean not null default true,
  puede_taller boolean not null default true,
  created_at timestamptz not null default now(),
  primary key(staff_id, location_id)
);
alter table public.staff_locations enable row level security;

insert into public.staff_locations(staff_id,location_id)
select s.id,s.location_id from public.staff s where s.location_id is not null
on conflict do nothing;

create policy staff_locations_self_read on public.staff_locations for select to authenticated
using(staff_id=private.auth_staff_id() or private.auth_is_admin());

create or replace function private.auth_location_id()
returns uuid
language sql
stable
security definer
set search_path='public','private'
as $$
  select case
    when s.active_location_id is not null and exists(
      select 1 from public.staff_locations sl
      where sl.staff_id=s.id and sl.location_id=s.active_location_id
    ) then s.active_location_id
    else s.location_id
  end
  from public.staff s
  where s.user_id=auth.uid() and s.activo=true
  limit 1;
$$;
revoke execute on function private.auth_location_id() from public,anon;
grant execute on function private.auth_location_id() to authenticated;

create or replace function public.mis_sucursales()
returns table(location_id uuid,nombre text,direccion text,activa boolean,puede_vender boolean,puede_inventario boolean,puede_taller boolean)
language sql
stable
security definer
set search_path='public','private'
as $$
 select l.id,l.nombre::text,l.direccion::text,(l.id=private.auth_location_id()),sl.puede_vender,sl.puede_inventario,sl.puede_taller
 from public.staff_locations sl
 join public.staff s on s.id=sl.staff_id
 join public.locations l on l.id=sl.location_id and l.activo=true
 where s.user_id=auth.uid() and s.activo=true
 order by l.nombre;
$$;

create or replace function public.cambiar_sucursal_activa(p_location_id uuid)
returns uuid
language plpgsql
security definer
set search_path='public','private'
as $$
declare sid uuid;
begin
 sid:=private.auth_staff_id();
 if sid is null then raise exception 'Usuario no vinculado'; end if;
 if not exists(select 1 from public.staff_locations sl join public.locations l on l.id=sl.location_id and l.activo where sl.staff_id=sid and sl.location_id=p_location_id) then
   raise exception 'Sin acceso a la sucursal';
 end if;
 update public.staff set active_location_id=p_location_id where id=sid;
 return p_location_id;
end$$;

create or replace function public.sucursales_admin()
returns table(id uuid,nombre text,direccion text,activo boolean,usuarios bigint)
language plpgsql
stable
security definer
set search_path='public','private'
as $$
begin
 if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
 return query select l.id,l.nombre::text,l.direccion::text,l.activo,count(sl.staff_id) from public.locations l left join public.staff_locations sl on sl.location_id=l.id group by l.id,l.nombre,l.direccion,l.activo order by l.nombre;
end$$;

create or replace function public.guardar_sucursal_admin(p_id uuid,p_nombre text,p_direccion text,p_activo boolean default true)
returns uuid
language plpgsql
security definer
set search_path='public','private'
as $$
declare rid uuid;
begin
 if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
 if length(trim(coalesce(p_nombre,'')))<2 then raise exception 'Nombre inválido'; end if;
 if p_id is null then
   insert into public.locations(nombre,direccion,activo) values(trim(p_nombre),nullif(trim(p_direccion),''),coalesce(p_activo,true)) returning id into rid;
 else
   update public.locations set nombre=trim(p_nombre),direccion=nullif(trim(p_direccion),''),activo=coalesce(p_activo,true) where id=p_id returning id into rid;
   if rid is null then raise exception 'Sucursal inexistente'; end if;
 end if;
 return rid;
end$$;

create or replace function public.asignar_sucursal_staff_admin(p_staff_id uuid,p_location_id uuid,p_habilitado boolean,p_vender boolean default true,p_inventario boolean default true,p_taller boolean default true)
returns void
language plpgsql
security definer
set search_path='public','private'
as $$
begin
 if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
 if p_habilitado then
   if not exists(select 1 from public.staff where id=p_staff_id and activo=true) or not exists(select 1 from public.locations where id=p_location_id and activo=true) then raise exception 'Personal o sucursal inválidos'; end if;
   insert into public.staff_locations(staff_id,location_id,puede_vender,puede_inventario,puede_taller)
   values(p_staff_id,p_location_id,coalesce(p_vender,true),coalesce(p_inventario,true),coalesce(p_taller,true))
   on conflict(staff_id,location_id) do update set puede_vender=excluded.puede_vender,puede_inventario=excluded.puede_inventario,puede_taller=excluded.puede_taller;
 else
   delete from public.staff_locations where staff_id=p_staff_id and location_id=p_location_id;
   update public.staff set active_location_id=null where id=p_staff_id and active_location_id=p_location_id;
 end if;
end$$;

revoke execute on function public.mis_sucursales() from public,anon;
revoke execute on function public.cambiar_sucursal_activa(uuid) from public,anon;
revoke execute on function public.sucursales_admin() from public,anon;
revoke execute on function public.guardar_sucursal_admin(uuid,text,text,boolean) from public,anon;
revoke execute on function public.asignar_sucursal_staff_admin(uuid,uuid,boolean,boolean,boolean,boolean) from public,anon;
grant execute on function public.mis_sucursales() to authenticated;
grant execute on function public.cambiar_sucursal_activa(uuid) to authenticated;
grant execute on function public.sucursales_admin() to authenticated;
grant execute on function public.guardar_sucursal_admin(uuid,text,text,boolean) to authenticated;
grant execute on function public.asignar_sucursal_staff_admin(uuid,uuid,boolean,boolean,boolean,boolean) to authenticated;
