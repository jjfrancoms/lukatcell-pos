drop policy if exists compras_documentos_admin_delete on storage.objects;
create policy compras_documentos_admin_delete on storage.objects for delete to authenticated
using(bucket_id='compras-documentos' and private.auth_is_admin());
