-- ============================================================================
-- P0.1 bloque 6: seriales_disponibles no debía depender solo de que el
-- INSERT de reservar_seriales_carrito fallara después. Un IMEI ya reservado
-- (activamente, no vencido) por OTRO carrito seguía apareciendo como
-- seleccionable en el selector — el cajero lo elegía, y recién al confirmar
-- se enteraba de que ya no estaba disponible.
--
-- Gana un p_client_transaction_id opcional: si se pasa, excluye seriales con
-- una reserva viva de OTRO carrito, pero seguirá mostrando los que YA
-- reservó el carrito actual (para poder editar/deseleccionar su propia
-- elección). Sin ese parámetro (Transferencias.tsx, que no tiene concepto de
-- carrito), excluye cualquier serial con una reserva viva de cualquiera.
-- ============================================================================

drop function if exists public.seriales_disponibles(uuid);

create function public.seriales_disponibles(p_variant_id uuid, p_client_transaction_id uuid default null)
returns table(id uuid, serial_number text, imei2 text)
language sql
stable
security definer
set search_path = public, private
as $$
  select ps.id, ps.serial_number, ps.imei2
  from public.product_serials ps
  where ps.variant_id = p_variant_id
    and ps.location_id = private.auth_location_id()
    and ps.estado = 'disponible'
    and not exists (
      select 1 from public.serial_reservations sr
      where sr.serial_id = ps.id
        and sr.expires_at > now()
        and (p_client_transaction_id is null or sr.client_transaction_id is distinct from p_client_transaction_id)
    )
  order by ps.serial_number
$$;

revoke all on function public.seriales_disponibles(uuid, uuid) from public, anon;
grant execute on function public.seriales_disponibles(uuid, uuid) to authenticated;
