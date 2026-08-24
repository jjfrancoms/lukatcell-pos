alter table public.recepciones_compra add column if not exists storage_path text;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('compras-documentos','compras-documentos',false,15728640,array['application/pdf','image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists compras_documentos_admin_insert on storage.objects;
drop policy if exists compras_documentos_admin_read on storage.objects;
drop policy if exists compras_documentos_admin_delete on storage.objects;
create policy compras_documentos_admin_insert on storage.objects for insert to authenticated
with check(bucket_id='compras-documentos' and private.auth_is_admin());
create policy compras_documentos_admin_read on storage.objects for select to authenticated
using(bucket_id='compras-documentos' and private.auth_is_admin());
create policy compras_documentos_admin_delete on storage.objects for delete to authenticated
using(bucket_id='compras-documentos' and private.auth_is_admin());

create or replace function public.vincular_documento_recepcion_admin(p_recepcion_id uuid,p_storage_path text)
returns void
language plpgsql
security definer
set search_path='public','private'
as $$
declare s public.staff; r public.recepciones_compra; o public.ordenes_compra;
begin
 if not private.auth_is_admin() then raise exception 'Solo administradores'; end if;
 select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
 select * into r from public.recepciones_compra where id=p_recepcion_id;
 select * into o from public.ordenes_compra where id=r.orden_id;
 if r.id is null or o.location_id<>s.location_id then raise exception 'Recepción inválida'; end if;
 if split_part(p_storage_path,'/',1)<>s.location_id::text then raise exception 'Ruta de documento inválida'; end if;
 update public.recepciones_compra set storage_path=nullif(trim(p_storage_path),'') where id=r.id;
end$$;

revoke execute on function public.vincular_documento_recepcion_admin(uuid,text) from public,anon;
grant execute on function public.vincular_documento_recepcion_admin(uuid,text) to authenticated;
