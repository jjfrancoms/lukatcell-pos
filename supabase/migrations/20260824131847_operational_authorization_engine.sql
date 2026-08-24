create table if not exists public.autorizaciones_operativas (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('descuento','anulacion','devolucion','ajuste_stock','otro')),
  solicitado_por uuid not null references public.staff(id),
  location_id uuid not null references public.locations(id),
  recurso_tipo text,
  recurso_id text,
  motivo text not null,
  payload jsonb not null default '{}'::jsonb,
  estado text not null default 'pendiente' check (estado in ('pendiente','aprobada','rechazada','consumida','cancelada')),
  resuelto_por uuid references public.staff(id),
  resolucion_motivo text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  consumed_at timestamptz
);

create index if not exists autorizaciones_estado_created_idx on public.autorizaciones_operativas(estado,created_at desc);
create index if not exists autorizaciones_solicitante_idx on public.autorizaciones_operativas(solicitado_por,created_at desc);
alter table public.autorizaciones_operativas enable row level security;
drop policy if exists autorizaciones_lectura on public.autorizaciones_operativas;
create policy autorizaciones_lectura on public.autorizaciones_operativas for select to authenticated using (solicitado_por=private.auth_staff_id() or private.auth_is_admin());
revoke all on public.autorizaciones_operativas from anon;
revoke insert,update,delete on public.autorizaciones_operativas from authenticated;
grant select on public.autorizaciones_operativas to authenticated;
drop trigger if exists audit_autorizaciones_operativas on public.autorizaciones_operativas;
create trigger audit_autorizaciones_operativas after insert or update or delete on public.autorizaciones_operativas for each row execute function private.registrar_auditoria();

create or replace function public.solicitar_autorizacion(p_tipo text,p_motivo text,p_recurso_tipo text default null,p_recurso_id text default null,p_payload jsonb default '{}'::jsonb)
returns public.autorizaciones_operativas language plpgsql security definer set search_path='public','private'
as $$ declare v_actor public.staff; v_row public.autorizaciones_operativas; begin
 select * into v_actor from public.staff where user_id=auth.uid() and activo=true limit 1;
 if v_actor.id is null then raise exception 'Personal no válido o inactivo'; end if;
 if p_tipo not in ('descuento','anulacion','devolucion','ajuste_stock','otro') then raise exception 'Tipo de autorización inválido'; end if;
 if p_motivo is null or length(trim(p_motivo))<5 then raise exception 'Debes indicar un motivo válido'; end if;
 if exists(select 1 from public.autorizaciones_operativas a where a.solicitado_por=v_actor.id and a.tipo=p_tipo and a.estado='pendiente' and a.recurso_tipo is not distinct from nullif(trim(coalesce(p_recurso_tipo,'')),'') and a.recurso_id is not distinct from nullif(trim(coalesce(p_recurso_id,'')),'')) then
  select * into v_row from public.autorizaciones_operativas a where a.solicitado_por=v_actor.id and a.tipo=p_tipo and a.estado='pendiente' and a.recurso_tipo is not distinct from nullif(trim(coalesce(p_recurso_tipo,'')),'') and a.recurso_id is not distinct from nullif(trim(coalesce(p_recurso_id,'')),'') order by created_at desc limit 1;
  return v_row;
 end if;
 insert into public.autorizaciones_operativas(tipo,solicitado_por,location_id,recurso_tipo,recurso_id,motivo,payload)
 values(p_tipo,v_actor.id,v_actor.location_id,nullif(trim(coalesce(p_recurso_tipo,'')),''),nullif(trim(coalesce(p_recurso_id,'')),''),trim(p_motivo),coalesce(p_payload,'{}'::jsonb)) returning * into v_row;
 return v_row;
end $$;

create or replace function public.resolver_autorizacion(p_autorizacion_id uuid,p_aprobar boolean,p_motivo text default null)
returns public.autorizaciones_operativas language plpgsql security definer set search_path='public','private'
as $$ declare v_admin public.staff; v_row public.autorizaciones_operativas; begin
 select * into v_admin from public.staff where user_id=auth.uid() and activo=true and rol='administrador' limit 1;
 if v_admin.id is null then raise exception 'Solo un administrador activo puede resolver autorizaciones'; end if;
 select * into v_row from public.autorizaciones_operativas where id=p_autorizacion_id for update;
 if v_row.id is null then raise exception 'Solicitud no encontrada'; end if;
 if v_row.estado<>'pendiente' then return v_row; end if;
 update public.autorizaciones_operativas set estado=case when p_aprobar then 'aprobada' else 'rechazada' end,resuelto_por=v_admin.id,resolucion_motivo=nullif(trim(coalesce(p_motivo,'')),''),resolved_at=now() where id=v_row.id returning * into v_row;
 return v_row;
end $$;

create or replace function private.consumir_autorizacion(p_autorizacion_id uuid,p_tipo text,p_actor_id uuid,p_recurso_tipo text default null,p_recurso_id text default null)
returns boolean language plpgsql security definer set search_path='public'
as $$ declare v_row public.autorizaciones_operativas; begin
 if p_autorizacion_id is null then return false; end if;
 select * into v_row from public.autorizaciones_operativas where id=p_autorizacion_id for update;
 if v_row.id is null or v_row.estado<>'aprobada' or v_row.tipo<>p_tipo or v_row.solicitado_por<>p_actor_id then return false; end if;
 if p_recurso_tipo is not null and v_row.recurso_tipo is distinct from p_recurso_tipo then return false; end if;
 if p_recurso_id is not null and v_row.recurso_id is distinct from p_recurso_id then return false; end if;
 update public.autorizaciones_operativas set estado='consumida',consumed_at=now() where id=v_row.id;
 return true;
end $$;

create or replace function public.mis_autorizaciones(p_limite integer default 50)
returns setof public.autorizaciones_operativas language sql stable security invoker set search_path='public','private'
as $$ select a.* from public.autorizaciones_operativas a where a.solicitado_por=private.auth_staff_id() order by a.created_at desc limit greatest(1,least(coalesce(p_limite,50),200)); $$;

create or replace function public.autorizaciones_admin(p_estado text default null,p_limite integer default 100)
returns table(id uuid,tipo text,solicitado_por uuid,solicitante_nombre text,location_id uuid,recurso_tipo text,recurso_id text,motivo text,payload jsonb,estado text,resuelto_por uuid,resolutor_nombre text,resolucion_motivo text,created_at timestamptz,resolved_at timestamptz,consumed_at timestamptz)
language sql stable security invoker set search_path='public','private'
as $$ select a.id,a.tipo,a.solicitado_por,s.nombre::text,a.location_id,a.recurso_tipo,a.recurso_id,a.motivo,a.payload,a.estado,a.resuelto_por,r.nombre::text,a.resolucion_motivo,a.created_at,a.resolved_at,a.consumed_at from public.autorizaciones_operativas a join public.staff s on s.id=a.solicitado_por left join public.staff r on r.id=a.resuelto_por where private.auth_is_admin() and (p_estado is null or a.estado=p_estado) order by a.created_at desc limit greatest(1,least(coalesce(p_limite,100),500)); $$;

revoke all on function public.solicitar_autorizacion(text,text,text,text,jsonb) from public,anon;
revoke all on function public.resolver_autorizacion(uuid,boolean,text) from public,anon;
revoke all on function private.consumir_autorizacion(uuid,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.solicitar_autorizacion(text,text,text,text,jsonb) to authenticated;
grant execute on function public.resolver_autorizacion(uuid,boolean,text) to authenticated;
grant execute on function public.mis_autorizaciones(integer) to authenticated;
grant execute on function public.autorizaciones_admin(text,integer) to authenticated;
