alter table public.clientes add column if not exists documento text;
alter table public.clientes add column if not exists direccion text;
alter table public.clientes add column if not exists segmento text not null default 'general';
alter table public.clientes add column if not exists puntos integer not null default 0;
alter table public.clientes add column if not exists consentimiento_whatsapp boolean not null default false;
alter table public.clientes add column if not exists consentimiento_email boolean not null default false;
alter table public.clientes add column if not exists consentimiento_at timestamptz;
alter table public.configuracion add column if not exists puntos_por_sol numeric(10,4) not null default 0 check(puntos_por_sol>=0);

create table if not exists public.cliente_puntos_movimientos(
 id uuid primary key default gen_random_uuid(),cliente_id uuid not null references public.clientes(id) on delete cascade,puntos integer not null,motivo text not null,sale_id uuid references public.sales(id),actor_id uuid references public.staff(id),created_at timestamptz not null default now()
);
alter table public.cliente_puntos_movimientos enable row level security;
create policy cliente_puntos_read on public.cliente_puntos_movimientos for select to authenticated using(private.auth_is_admin() or exists(select 1 from public.sales s where s.cliente_id=cliente_id and s.location_id=private.auth_location_id()));

create or replace function public.perfil_cliente_crm(p_cliente_id uuid)
returns jsonb language plpgsql stable security definer set search_path='public','private' as $$
declare c public.clientes; out jsonb;
begin
 if private.auth_staff_id() is null then raise exception 'Usuario no vinculado'; end if;
 select * into c from public.clientes where id=p_cliente_id;
 if c.id is null then raise exception 'Cliente inexistente'; end if;
 select jsonb_build_object('cliente',to_jsonb(c),'resumen',jsonb_build_object('total_gastado',coalesce((select sum(s.total) from public.sales s where s.cliente_id=c.id and s.estado='completada'),0),'compras',coalesce((select count(*) from public.sales s where s.cliente_id=c.id and s.estado='completada'),0),'ultima_compra',(select max(s.fecha) from public.sales s where s.cliente_id=c.id and s.estado='completada'),'reparaciones',coalesce((select count(*) from public.ordenes_servicio o where o.cliente_id=c.id),0)),'compras',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'numero',s.numero,'fecha',s.fecha,'total',s.total,'estado',s.estado) order by s.fecha desc) from public.sales s where s.cliente_id=c.id),'[]'::jsonb),'reparaciones',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'numero',o.numero,'equipo',concat_ws(' ',o.equipo_marca,o.equipo_modelo),'estado',o.estado,'fecha_recepcion',o.fecha_recepcion,'costo_final',o.costo_final) order by o.fecha_recepcion desc) from public.ordenes_servicio o where o.cliente_id=c.id),'[]'::jsonb),'puntos_movimientos',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'puntos',m.puntos,'motivo',m.motivo,'created_at',m.created_at) order by m.created_at desc) from public.cliente_puntos_movimientos m where m.cliente_id=c.id),'[]'::jsonb)) into out; return out;
end$$;
create or replace function public.actualizar_cliente_crm(p_cliente_id uuid,p_documento text,p_direccion text,p_segmento text,p_consentimiento_whatsapp boolean,p_consentimiento_email boolean)
returns void language plpgsql security definer set search_path='public','private' as $$
begin
 if private.auth_staff_id() is null then raise exception 'Usuario no vinculado'; end if;
 update public.clientes set documento=nullif(trim(p_documento),''),direccion=nullif(trim(p_direccion),''),segmento=coalesce(nullif(trim(p_segmento),''),'general'),consentimiento_whatsapp=coalesce(p_consentimiento_whatsapp,false),consentimiento_email=coalesce(p_consentimiento_email,false),consentimiento_at=case when coalesce(p_consentimiento_whatsapp,false) or coalesce(p_consentimiento_email,false) then now() else consentimiento_at end where id=p_cliente_id;
 if not found then raise exception 'Cliente inexistente'; end if;
end$$;
create or replace function public.ajustar_puntos_cliente_admin(p_cliente_id uuid,p_puntos integer,p_motivo text)
returns integer language plpgsql security definer set search_path='public','private' as $$
declare nuevo integer; sid uuid:=private.auth_staff_id();
begin
 if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
 if p_puntos=0 or length(trim(coalesce(p_motivo,'')))<3 then raise exception 'Ajuste inválido'; end if;
 update public.clientes set puntos=greatest(0,puntos+p_puntos) where id=p_cliente_id returning puntos into nuevo;
 if nuevo is null then raise exception 'Cliente inexistente'; end if;
 insert into public.cliente_puntos_movimientos(cliente_id,puntos,motivo,actor_id) values(p_cliente_id,p_puntos,trim(p_motivo),sid); return nuevo;
end$$;
create or replace function public.clientes_segmentados_admin()
returns table(id uuid,nombre text,telefono text,email text,segmento text,puntos integer,total_gastado numeric,ultima_compra timestamptz,consentimiento_whatsapp boolean,consentimiento_email boolean)
language plpgsql stable security definer set search_path='public','private' as $$
begin
 if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
 return query select c.id,c.nombre::text,c.telefono::text,c.email::text,c.segmento,c.puntos,coalesce(sum(s.total) filter(where s.estado='completada'),0)::numeric,max(s.fecha) filter(where s.estado='completada'),c.consentimiento_whatsapp,c.consentimiento_email from public.clientes c left join public.sales s on s.cliente_id=c.id group by c.id order by coalesce(sum(s.total) filter(where s.estado='completada'),0) desc,c.nombre;
end$$;
revoke execute on function public.perfil_cliente_crm(uuid) from public,anon;
revoke execute on function public.actualizar_cliente_crm(uuid,text,text,text,boolean,boolean) from public,anon;
revoke execute on function public.ajustar_puntos_cliente_admin(uuid,integer,text) from public,anon;
revoke execute on function public.clientes_segmentados_admin() from public,anon;
grant execute on function public.perfil_cliente_crm(uuid) to authenticated;
grant execute on function public.actualizar_cliente_crm(uuid,text,text,text,boolean,boolean) to authenticated;
grant execute on function public.ajustar_puntos_cliente_admin(uuid,integer,text) to authenticated;
grant execute on function public.clientes_segmentados_admin() to authenticated;
