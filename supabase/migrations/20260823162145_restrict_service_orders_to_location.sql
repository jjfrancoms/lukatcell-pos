drop policy if exists ordenes_autenticadas_all on public.ordenes_servicio;

create policy ordenes_lectura_sucursal
on public.ordenes_servicio
for select
to authenticated
using (public.auth_is_admin() or location_id = public.auth_location_id());

create policy ordenes_insercion_sucursal
on public.ordenes_servicio
for insert
to authenticated
with check (location_id = public.auth_location_id());

create policy ordenes_actualizacion_sucursal
on public.ordenes_servicio
for update
to authenticated
using (public.auth_is_admin() or location_id = public.auth_location_id())
with check (public.auth_is_admin() or location_id = public.auth_location_id());

create policy ordenes_eliminacion_admin
on public.ordenes_servicio
for delete
to authenticated
using (public.auth_is_admin());
