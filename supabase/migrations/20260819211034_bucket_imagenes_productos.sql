-- Bucket público para imágenes de producto (antes solo se podía pegar una URL externa)
insert into storage.buckets (id, name, public)
values ('productos', 'productos', true)
on conflict (id) do nothing;

drop policy if exists "productos_lectura_publica" on storage.objects;
create policy "productos_lectura_publica" on storage.objects
  for select using (bucket_id = 'productos');

drop policy if exists "productos_escritura_autenticados" on storage.objects;
create policy "productos_escritura_autenticados" on storage.objects
  for insert to authenticated with check (bucket_id = 'productos');

drop policy if exists "productos_actualizacion_autenticados" on storage.objects;
create policy "productos_actualizacion_autenticados" on storage.objects
  for update to authenticated using (bucket_id = 'productos');

drop policy if exists "productos_borrado_autenticados" on storage.objects;
create policy "productos_borrado_autenticados" on storage.objects
  for delete to authenticated using (bucket_id = 'productos');
