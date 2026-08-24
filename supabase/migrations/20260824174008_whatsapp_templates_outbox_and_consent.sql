create table if not exists public.whatsapp_plantillas(
 id uuid primary key default gen_random_uuid(),
 clave text not null unique,
 nombre text not null,
 meta_template_name text,
 idioma text not null default 'es',
 cuerpo_preview text not null,
 activo boolean not null default true,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table if not exists public.whatsapp_envios(
 id uuid primary key default gen_random_uuid(),
 cliente_id uuid not null references public.clientes(id),
 telefono text not null,
 plantilla_id uuid not null references public.whatsapp_plantillas(id),
 variables jsonb not null default '{}'::jsonb,
 recurso_tipo text,
 recurso_id text,
 event_key text not null unique,
 estado text not null default 'pendiente' check(estado in('pendiente','procesando','enviado','fallido','cancelado')),
 meta_message_id text,
 error text,
 creado_por uuid references public.staff(id),
 created_at timestamptz not null default now(),
 procesado_at timestamptz,
 enviado_at timestamptz
);
alter table public.whatsapp_plantillas enable row level security;
alter table public.whatsapp_envios enable row level security;
create policy whatsapp_plantillas_admin_read on public.whatsapp_plantillas for select to authenticated using(private.auth_is_admin());
create policy whatsapp_envios_admin_read on public.whatsapp_envios for select to authenticated using(private.auth_is_admin());

create or replace function public.encolar_whatsapp_admin(p_cliente_id uuid,p_plantilla_clave text,p_variables jsonb default '{}'::jsonb,p_recurso_tipo text default null,p_recurso_id text default null,p_event_key text default null)
returns uuid language plpgsql security definer set search_path='public','private' as $$
declare c public.clientes; p public.whatsapp_plantillas; rid uuid; k text; actor uuid:=private.auth_staff_id();
begin
 if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
 select * into c from public.clientes where id=p_cliente_id;
 if c.id is null then raise exception 'Cliente inexistente'; end if;
 if not coalesce(c.consentimiento_whatsapp,false) then raise exception 'Cliente sin consentimiento WhatsApp'; end if;
 if nullif(regexp_replace(coalesce(c.telefono,''),'\D','','g'),'') is null then raise exception 'Cliente sin teléfono'; end if;
 select * into p from public.whatsapp_plantillas where clave=p_plantilla_clave and activo=true;
 if p.id is null then raise exception 'Plantilla inexistente o inactiva'; end if;
 k:=coalesce(nullif(trim(p_event_key),''),'manual:'||p_cliente_id||':'||p.id||':'||extract(epoch from clock_timestamp())::bigint);
 insert into public.whatsapp_envios(cliente_id,telefono,plantilla_id,variables,recurso_tipo,recurso_id,event_key,creado_por)
 values(c.id,regexp_replace(c.telefono,'\D','','g'),p.id,coalesce(p_variables,'{}'::jsonb),nullif(trim(coalesce(p_recurso_tipo,'')),''),nullif(trim(coalesce(p_recurso_id,'')),''),k,actor)
 on conflict(event_key) do update set event_key=excluded.event_key returning id into rid;
 return rid;
end$$;

create or replace function public.whatsapp_outbox_admin(p_estado text default null,p_limit integer default 100)
returns table(id uuid,cliente_id uuid,cliente_nombre text,telefono text,plantilla_clave text,plantilla_nombre text,variables jsonb,recurso_tipo text,recurso_id text,event_key text,estado text,meta_message_id text,error text,created_at timestamptz,procesado_at timestamptz,enviado_at timestamptz)
language sql stable security definer set search_path='public','private' as $$
 select e.id,e.cliente_id,c.nombre,e.telefono,p.clave,p.nombre,e.variables,e.recurso_tipo,e.recurso_id,e.event_key,e.estado,e.meta_message_id,e.error,e.created_at,e.procesado_at,e.enviado_at
 from public.whatsapp_envios e join public.clientes c on c.id=e.cliente_id join public.whatsapp_plantillas p on p.id=e.plantilla_id
 where private.auth_is_admin() and (p_estado is null or e.estado=p_estado)
 order by e.created_at desc limit greatest(1,least(coalesce(p_limit,100),500));
$$;

revoke execute on function public.encolar_whatsapp_admin(uuid,text,jsonb,text,text,text) from public,anon;
revoke execute on function public.whatsapp_outbox_admin(text,integer) from public,anon;
grant execute on function public.encolar_whatsapp_admin(uuid,text,jsonb,text,text,text) to authenticated;
grant execute on function public.whatsapp_outbox_admin(text,integer) to authenticated;
