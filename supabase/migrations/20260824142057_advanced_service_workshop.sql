create or replace function private.auth_jornada_activa()
returns boolean
language sql
stable
security invoker
set search_path='public','private'
as $$
  select exists(
    select 1 from public.asistencias a
    where a.staff_id=private.auth_staff_id()
      and a.entrada is not null and a.salida is null
      and a.fecha in (current_date,current_date-1)
  );
$$;
grant execute on function private.auth_jornada_activa() to authenticated;

alter table public.ordenes_servicio
  add column if not exists tecnico_id uuid references public.staff(id),
  add column if not exists equipo_serial text,
  add column if not exists equipo_imei text,
  add column if not exists mano_obra numeric(12,2) not null default 0,
  add column if not exists fecha_prometida timestamptz,
  add column if not exists garantia_dias integer not null default 0,
  add column if not exists garantia_hasta date,
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.orden_servicio_repuestos(
  id uuid primary key default gen_random_uuid(), orden_id uuid not null references public.ordenes_servicio(id) on delete cascade,
  variant_id uuid not null references public.product_variants(id), cantidad integer not null check(cantidad>0),
  precio_unitario numeric(12,2) not null default 0, costo_unitario numeric(12,2) not null default 0,
  agregado_por uuid references public.staff(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(orden_id,variant_id)
);
create table if not exists public.orden_servicio_historial(
  id uuid primary key default gen_random_uuid(), orden_id uuid not null references public.ordenes_servicio(id) on delete cascade,
  tipo text not null, descripcion text, estado_anterior text, estado_nuevo text, actor_id uuid references public.staff(id), created_at timestamptz not null default now()
);
create table if not exists public.orden_servicio_fotos(
  id uuid primary key default gen_random_uuid(), orden_id uuid not null references public.ordenes_servicio(id) on delete cascade,
  tipo text not null check(tipo in('antes','despues','diagnostico','otro')), storage_path text not null, descripcion text,
  subido_por uuid references public.staff(id), created_at timestamptz not null default now()
);
alter table public.orden_servicio_repuestos enable row level security;
alter table public.orden_servicio_historial enable row level security;
alter table public.orden_servicio_fotos enable row level security;

drop policy if exists ordenes_actualizacion_sucursal on public.ordenes_servicio;
drop policy if exists ordenes_insercion_sucursal on public.ordenes_servicio;
create policy ordenes_insercion_sucursal on public.ordenes_servicio for insert to authenticated
with check(location_id=private.auth_location_id() and (private.auth_is_admin() or private.auth_jornada_activa()));
create policy ordenes_actualizacion_tecnica on public.ordenes_servicio for update to authenticated
using(private.auth_is_admin() or (location_id=private.auth_location_id() and exists(select 1 from public.staff s where s.user_id=auth.uid() and s.activo and s.puesto in('tecnico','encargado','jefa'))))
with check(private.auth_is_admin() or (location_id=private.auth_location_id() and exists(select 1 from public.staff s where s.user_id=auth.uid() and s.activo and s.puesto in('tecnico','encargado','jefa'))));
create policy orden_repuestos_read on public.orden_servicio_repuestos for select to authenticated using(exists(select 1 from public.ordenes_servicio o where o.id=orden_id and (private.auth_is_admin() or o.location_id=private.auth_location_id())));
create policy orden_historial_read on public.orden_servicio_historial for select to authenticated using(exists(select 1 from public.ordenes_servicio o where o.id=orden_id and (private.auth_is_admin() or o.location_id=private.auth_location_id())));
create policy orden_fotos_read on public.orden_servicio_fotos for select to authenticated using(exists(select 1 from public.ordenes_servicio o where o.id=orden_id and (private.auth_is_admin() or o.location_id=private.auth_location_id())));

create or replace function private.recalcular_total_orden_servicio(p_orden_id uuid)
returns void language plpgsql security invoker set search_path='public','private' as $$
begin
 update public.ordenes_servicio o set costo_final=coalesce(o.mano_obra,0)+coalesce((select sum(r.precio_unitario*r.cantidad) from public.orden_servicio_repuestos r where r.orden_id=o.id),0),updated_at=now() where o.id=p_orden_id;
end$$;
grant execute on function private.recalcular_total_orden_servicio(uuid) to authenticated;

create or replace function private.historial_orden_tecnica()
returns trigger language plpgsql security definer set search_path='public','private' as $$
declare v_actor uuid:=private.auth_staff_id();
begin
 new.updated_at:=now();
 if new.estado='entregado' and old.estado is distinct from new.estado and new.garantia_dias>0 then new.garantia_hasta:=current_date+new.garantia_dias; end if;
 if old.estado is distinct from new.estado then insert into public.orden_servicio_historial(orden_id,tipo,descripcion,estado_anterior,estado_nuevo,actor_id) values(new.id,'estado','Cambio de estado',old.estado,new.estado,v_actor); end if;
 if old.diagnostico is distinct from new.diagnostico then insert into public.orden_servicio_historial(orden_id,tipo,descripcion,actor_id) values(new.id,'diagnostico',new.diagnostico,v_actor); end if;
 if old.tecnico_id is distinct from new.tecnico_id then insert into public.orden_servicio_historial(orden_id,tipo,descripcion,actor_id) values(new.id,'asignacion','Técnico asignado/modificado',v_actor); end if;
 return new;
end$$;
drop trigger if exists trg_historial_orden_tecnica on public.ordenes_servicio;
create trigger trg_historial_orden_tecnica before update on public.ordenes_servicio for each row execute function private.historial_orden_tecnica();

create or replace function public.actualizar_orden_servicio_tecnica(p_orden_id uuid,p_patch jsonb)
returns public.ordenes_servicio language plpgsql security definer set search_path='public','private' as $$
declare s public.staff;o public.ordenes_servicio;v_tec public.staff;v_estado text;
begin
 select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
 if s.id is null or not(s.rol='administrador' or s.puesto in('tecnico','encargado','jefa')) then raise exception 'Sin permiso técnico'; end if;
 select * into o from public.ordenes_servicio where id=p_orden_id for update;
 if o.id is null or (s.rol<>'administrador' and o.location_id<>s.location_id) then raise exception 'Orden inválida o de otra sucursal'; end if;
 if s.puesto='tecnico' and s.rol<>'administrador' and o.tecnico_id is not null and o.tecnico_id<>s.id then raise exception 'La orden está asignada a otro técnico'; end if;
 if p_patch ? 'tecnico_id' then if s.rol<>'administrador' and s.puesto not in('encargado','jefa') then raise exception 'Solo jefa/encargado/admin asigna técnicos'; end if; if p_patch->>'tecnico_id' is not null then select * into v_tec from public.staff where id=(p_patch->>'tecnico_id')::uuid and activo and puesto='tecnico' and location_id=o.location_id; if v_tec.id is null then raise exception 'Técnico inválido'; end if; end if; end if;
 if p_patch ? 'estado' then v_estado:=p_patch->>'estado'; if v_estado not in('recibido','diagnosticado','en_reparacion','listo','entregado','cancelado') then raise exception 'Estado inválido'; end if; end if;
 update public.ordenes_servicio set
 tecnico_id=case when p_patch?'tecnico_id' then nullif(p_patch->>'tecnico_id','')::uuid else tecnico_id end,
 diagnostico=case when p_patch?'diagnostico' then nullif(btrim(p_patch->>'diagnostico'),'') else diagnostico end,
 estado=case when p_patch?'estado' then v_estado else estado end,
 mano_obra=case when p_patch?'mano_obra' then greatest(0,coalesce((p_patch->>'mano_obra')::numeric,0)) else mano_obra end,
 fecha_prometida=case when p_patch?'fecha_prometida' then nullif(p_patch->>'fecha_prometida','')::timestamptz else fecha_prometida end,
 garantia_dias=case when p_patch?'garantia_dias' then greatest(0,coalesce((p_patch->>'garantia_dias')::int,0)) else garantia_dias end,
 equipo_serial=case when p_patch?'equipo_serial' then nullif(btrim(p_patch->>'equipo_serial'),'') else equipo_serial end,
 equipo_imei=case when p_patch?'equipo_imei' then nullif(btrim(p_patch->>'equipo_imei'),'') else equipo_imei end,
 notas=case when p_patch?'notas' then nullif(btrim(p_patch->>'notas'),'') else notas end
 where id=o.id returning * into o;
 perform private.recalcular_total_orden_servicio(o.id); select * into o from public.ordenes_servicio where id=o.id; return o;
end$$;

create or replace function public.agregar_repuesto_orden(p_orden_id uuid,p_variant_id uuid,p_cantidad integer)
returns public.orden_servicio_repuestos language plpgsql security definer set search_path='public','private' as $$
declare s public.staff;o public.ordenes_servicio;r public.orden_servicio_repuestos;v_precio numeric;v_costo numeric;
begin
 if p_cantidad<=0 then raise exception 'Cantidad inválida'; end if; select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
 if s.id is null or not(s.rol='administrador' or s.puesto in('tecnico','encargado','jefa')) then raise exception 'Sin permiso'; end if;
 select * into o from public.ordenes_servicio where id=p_orden_id for update; if o.id is null or (s.rol<>'administrador' and o.location_id<>s.location_id) then raise exception 'Orden inválida'; end if;
 if s.puesto='tecnico' and s.rol<>'administrador' and o.tecnico_id is not null and o.tecnico_id<>s.id then raise exception 'Orden asignada a otro técnico'; end if;
 select coalesce(pv.precio_override,p.precio_base,0),coalesce(p.costo,0) into v_precio,v_costo from public.product_variants pv join public.products p on p.id=pv.product_id where pv.id=p_variant_id and p.activo; if v_precio is null then raise exception 'Producto inválido'; end if;
 update public.inventory set cantidad=cantidad-p_cantidad,updated_at=now() where variant_id=p_variant_id and location_id=o.location_id and cantidad>=p_cantidad; if not found then raise exception 'Stock insuficiente'; end if;
 insert into public.inventory_movements(variant_id,location_id,cantidad_delta,motivo,staff_id) values(p_variant_id,o.location_id,-p_cantidad,'Repuesto orden #'||o.numero,s.id);
 insert into public.orden_servicio_repuestos(orden_id,variant_id,cantidad,precio_unitario,costo_unitario,agregado_por) values(o.id,p_variant_id,p_cantidad,v_precio,v_costo,s.id) on conflict(orden_id,variant_id) do update set cantidad=public.orden_servicio_repuestos.cantidad+excluded.cantidad,updated_at=now() returning * into r;
 insert into public.orden_servicio_historial(orden_id,tipo,descripcion,actor_id) values(o.id,'repuesto','Repuesto agregado x'||p_cantidad,s.id); perform private.recalcular_total_orden_servicio(o.id); return r;
end$$;

create or replace function public.retirar_repuesto_orden(p_repuesto_id uuid,p_cantidad integer)
returns void language plpgsql security definer set search_path='public','private' as $$
declare s public.staff;r public.orden_servicio_repuestos;o public.ordenes_servicio;
begin
 if p_cantidad<=0 then raise exception 'Cantidad inválida'; end if; select * into s from public.staff where user_id=auth.uid() and activo=true limit 1; if s.id is null or not(s.rol='administrador' or s.puesto in('tecnico','encargado','jefa')) then raise exception 'Sin permiso'; end if;
 select * into r from public.orden_servicio_repuestos where id=p_repuesto_id for update; select * into o from public.ordenes_servicio where id=r.orden_id; if r.id is null or o.id is null or (s.rol<>'administrador' and o.location_id<>s.location_id) or p_cantidad>r.cantidad then raise exception 'Repuesto inválido'; end if;
 insert into public.inventory(variant_id,location_id,cantidad) values(r.variant_id,o.location_id,p_cantidad) on conflict(variant_id,location_id) do update set cantidad=public.inventory.cantidad+excluded.cantidad,updated_at=now(); insert into public.inventory_movements(variant_id,location_id,cantidad_delta,motivo,staff_id) values(r.variant_id,o.location_id,p_cantidad,'Retiro repuesto orden #'||o.numero,s.id);
 if p_cantidad=r.cantidad then delete from public.orden_servicio_repuestos where id=r.id; else update public.orden_servicio_repuestos set cantidad=cantidad-p_cantidad,updated_at=now() where id=r.id; end if; insert into public.orden_servicio_historial(orden_id,tipo,descripcion,actor_id) values(o.id,'repuesto','Repuesto retirado x'||p_cantidad,s.id); perform private.recalcular_total_orden_servicio(o.id);
end$$;

create or replace function public.registrar_foto_orden(p_orden_id uuid,p_tipo text,p_storage_path text,p_descripcion text default null)
returns public.orden_servicio_fotos language plpgsql security definer set search_path='public','private' as $$
declare s public.staff;o public.ordenes_servicio;f public.orden_servicio_fotos;
begin
 select * into s from public.staff where user_id=auth.uid() and activo=true limit 1; if s.id is null or not(s.rol='administrador' or s.puesto in('tecnico','encargado','jefa')) then raise exception 'Sin permiso'; end if; select * into o from public.ordenes_servicio where id=p_orden_id; if o.id is null or (s.rol<>'administrador' and o.location_id<>s.location_id) then raise exception 'Orden inválida'; end if; if p_tipo not in('antes','despues','diagnostico','otro') then raise exception 'Tipo inválido'; end if; if split_part(p_storage_path,'/',1)<>o.location_id::text or split_part(p_storage_path,'/',2)<>o.id::text then raise exception 'Ruta de foto inválida'; end if;
 insert into public.orden_servicio_fotos(orden_id,tipo,storage_path,descripcion,subido_por) values(o.id,p_tipo,p_storage_path,nullif(btrim(p_descripcion),''),s.id) returning * into f; insert into public.orden_servicio_historial(orden_id,tipo,descripcion,actor_id) values(o.id,'foto','Foto '||p_tipo||' agregada',s.id); return f;
end$$;

revoke execute on function public.actualizar_orden_servicio_tecnica(uuid,jsonb) from public,anon;
revoke execute on function public.agregar_repuesto_orden(uuid,uuid,integer) from public,anon;
revoke execute on function public.retirar_repuesto_orden(uuid,integer) from public,anon;
revoke execute on function public.registrar_foto_orden(uuid,text,text,text) from public,anon;
grant execute on function public.actualizar_orden_servicio_tecnica(uuid,jsonb) to authenticated;
grant execute on function public.agregar_repuesto_orden(uuid,uuid,integer) to authenticated;
grant execute on function public.retirar_repuesto_orden(uuid,integer) to authenticated;
grant execute on function public.registrar_foto_orden(uuid,text,text,text) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('ordenes-servicio','ordenes-servicio',false,10485760,array['image/jpeg','image/png','image/webp']) on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists ordenes_servicio_storage_read on storage.objects; drop policy if exists ordenes_servicio_storage_write on storage.objects;
create policy ordenes_servicio_storage_read on storage.objects for select to authenticated using(bucket_id='ordenes-servicio' and split_part(name,'/',1)=private.auth_location_id()::text);
create policy ordenes_servicio_storage_write on storage.objects for insert to authenticated with check(bucket_id='ordenes-servicio' and split_part(name,'/',1)=private.auth_location_id()::text and exists(select 1 from public.staff s where s.user_id=auth.uid() and s.activo and (s.rol='administrador' or s.puesto in('tecnico','encargado','jefa'))));

create trigger audit_orden_servicio_repuestos after insert or update or delete on public.orden_servicio_repuestos for each row execute function private.registrar_auditoria();
create trigger audit_orden_servicio_fotos after insert or update or delete on public.orden_servicio_fotos for each row execute function private.registrar_auditoria();
