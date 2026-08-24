-- RELEASE ORDER: deploy the UI that stops selecting products.costo before applying this migration.
revoke select on table public.products from authenticated;
grant select(id,sku,nombre,categoria_id,precio_base,activo,created_at,imagen_url,favorito,updated_at,control_serial) on public.products to authenticated;
revoke all privileges on table public.products from anon;
