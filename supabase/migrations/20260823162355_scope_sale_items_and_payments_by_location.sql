drop policy if exists sale_items_lectura on public.sale_items;
create policy sale_items_lectura_sucursal
on public.sale_items
for select
to authenticated
using (
  public.auth_is_admin()
  or exists (
    select 1 from public.sales s
    where s.id = sale_items.sale_id
      and s.location_id = public.auth_location_id()
  )
);

drop policy if exists payments_lectura on public.payments;
create policy payments_lectura_sucursal
on public.payments
for select
to authenticated
using (
  public.auth_is_admin()
  or exists (
    select 1 from public.sales s
    where s.id = payments.sale_id
      and s.location_id = public.auth_location_id()
  )
);
