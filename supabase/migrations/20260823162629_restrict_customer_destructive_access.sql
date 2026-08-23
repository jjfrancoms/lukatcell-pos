drop policy if exists clientes_autenticados_all on public.clientes;

create policy clientes_lectura_autenticados
on public.clientes
for select
to authenticated
using (true);

create policy clientes_insercion_autenticados
on public.clientes
for insert
to authenticated
with check (true);

create policy clientes_actualizacion_autenticados
on public.clientes
for update
to authenticated
using (true)
with check (true);

create policy clientes_eliminacion_admin
on public.clientes
for delete
to authenticated
using (public.auth_is_admin());
