drop policy if exists comprobantes_lectura on public.comprobantes_electronicos;
create policy comprobantes_lectura_sucursal
on public.comprobantes_electronicos
for select
to authenticated
using (
  public.auth_is_admin()
  or exists (
    select 1 from public.sales s
    where s.id = comprobantes_electronicos.sale_id
      and s.location_id = public.auth_location_id()
  )
);

drop policy if exists pagos_digitales_lectura on public.pagos_digitales;
create policy pagos_digitales_lectura_sucursal
on public.pagos_digitales
for select
to authenticated
using (
  public.auth_is_admin()
  or location_id = public.auth_location_id()
);

drop policy if exists anon_locations on public.locations;
