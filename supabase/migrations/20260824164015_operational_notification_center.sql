create table if not exists public.notificaciones(
 id uuid primary key default gen_random_uuid(),staff_id uuid references public.staff(id) on delete cascade,location_id uuid references public.locations(id) on delete cascade,tipo text not null,titulo text not null,mensaje text not null,prioridad text not null default 'media' check(prioridad in('baja','media','alta','critica')),recurso_tipo text,recurso_id uuid,event_key text not null unique,leida_at timestamptz,created_at timestamptz not null default now()
);
alter table public.notificaciones enable row level security;
create policy notificaciones_read on public.notificaciones for select to authenticated using(private.auth_is_admin() or staff_id=private.auth_staff_id() or (staff_id is null and location_id=private.auth_location_id()));
create or replace function public.notificaciones_mias(p_limit integer default 50)
returns setof public.notificaciones language sql stable security definer set search_path='public','private' as $$
 select n.* from public.notificaciones n where private.auth_is_admin() or n.staff_id=private.auth_staff_id() or (n.staff_id is null and n.location_id=private.auth_location_id()) order by (n.leida_at is null) desc,case n.prioridad when 'critica' then 1 when 'alta' then 2 when 'media' then 3 else 4 end,n.created_at desc limit greatest(1,least(coalesce(p_limit,50),200));
$$;
create or replace function public.marcar_notificacion_leida(p_id uuid,p_leida boolean default true)
returns void language plpgsql security definer set search_path='public','private' as $$
begin
 update public.notificaciones n set leida_at=case when coalesce(p_leida,true) then now() else null end where n.id=p_id and (private.auth_is_admin() or n.staff_id=private.auth_staff_id() or (n.staff_id is null and n.location_id=private.auth_location_id()));
 if not found then raise exception 'Notificación inexistente o sin acceso'; end if;
end$$;
create or replace function public.generar_alertas_operativas_admin()
returns integer language plpgsql security definer set search_path='public','private' as $$
declare n integer:=0; x integer;
begin
 if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
 insert into public.notificaciones(location_id,tipo,titulo,mensaje,prioridad,recurso_tipo,recurso_id,event_key)
 select i.location_id,'stock_critico','Stock crítico',p.nombre||coalesce(' · '||pv.color,'')||': '||i.cantidad||' unidad(es), mínimo '||i.stock_minimo,case when i.cantidad<=0 then 'critica' else 'alta' end,'variant',i.variant_id,'stock:'||i.location_id||':'||i.variant_id||':'||current_date from public.inventory i join public.product_variants pv on pv.id=i.variant_id join public.products p on p.id=pv.product_id where i.cantidad<=i.stock_minimo on conflict(event_key) do nothing; get diagnostics x=row_count; n:=n+x;
 insert into public.notificaciones(staff_id,location_id,tipo,titulo,mensaje,prioridad,recurso_tipo,recurso_id,event_key)
 select a.staff_id,s.location_id,'tardanza','Tardanza registrada',s.nombre||' registró '||coalesce(a.minutos_tarde,0)||' min de tardanza','alta','asistencia',a.id,'tarde:'||a.id from public.asistencias a join public.staff s on s.id=a.staff_id where a.fecha>=current_date-7 and coalesce(a.minutos_tarde,0)>0 on conflict(event_key) do nothing; get diagnostics x=row_count; n:=n+x;
 insert into public.notificaciones(staff_id,location_id,tipo,titulo,mensaje,prioridad,recurso_tipo,recurso_id,event_key)
 select a.staff_id,s.location_id,'jornada_incompleta','Jornada sin salida',s.nombre||' tiene una entrada sin salida del '||a.fecha,'alta','asistencia',a.id,'sin-salida:'||a.id from public.asistencias a join public.staff s on s.id=a.staff_id where a.entrada is not null and a.salida is null and a.fecha<current_date on conflict(event_key) do nothing; get diagnostics x=row_count; n:=n+x;
 insert into public.notificaciones(location_id,tipo,titulo,mensaje,prioridad,recurso_tipo,recurso_id,event_key)
 select cs.location_id,'diferencia_caja','Diferencia de caja','Caja con diferencia de S/ '||coalesce(cs.diferencia,0)::text,case when abs(coalesce(cs.diferencia,0))>=coalesce((select diferencia_caja_critica from public.configuracion where id=1),20) then 'critica' else 'alta' end,'cash_session',cs.id,'caja-dif:'||cs.id from public.cash_sessions cs where cs.cierre is not null and abs(coalesce(cs.diferencia,0))>0 and cs.cierre>=now()-interval '30 days' on conflict(event_key) do nothing; get diagnostics x=row_count; n:=n+x;
 insert into public.notificaciones(staff_id,location_id,tipo,titulo,mensaje,prioridad,recurso_tipo,recurso_id,event_key)
 select pp.staff_id,s.location_id,'permiso_personal','Permiso / licencia registrado',s.nombre||': '||pp.tipo||' del '||pp.fecha_desde||' al '||pp.fecha_hasta,'media','personal_permiso',pp.id,'permiso:'||pp.id from public.personal_permisos pp join public.staff s on s.id=pp.staff_id where pp.activo and pp.created_at>=now()-interval '30 days' on conflict(event_key) do nothing; get diagnostics x=row_count; n:=n+x;
 return n;
end$$;
revoke execute on function public.notificaciones_mias(integer) from public,anon;
revoke execute on function public.marcar_notificacion_leida(uuid,boolean) from public,anon;
revoke execute on function public.generar_alertas_operativas_admin() from public,anon;
grant execute on function public.notificaciones_mias(integer) to authenticated;
grant execute on function public.marcar_notificacion_leida(uuid,boolean) to authenticated;
grant execute on function public.generar_alertas_operativas_admin() to authenticated;
