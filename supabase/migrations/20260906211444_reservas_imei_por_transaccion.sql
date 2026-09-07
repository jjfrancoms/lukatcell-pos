-- ============================================================================
-- Fase 8/9 del hardening: "reservas de IMEI por transacción" y exponer
-- control_serial al frontend de venta.
--
-- Hallazgo de auditoría: la pantalla de venta real (Venta.tsx/ModalPago.tsx)
-- NUNCA consulta ni usa `control_serial`, `product_serials`, `reservar_
-- seriales_carrito` ni `registrar_venta_serializada`. La única forma de
-- vender hoy un producto serializado es que el cajero, ANTES de ir a la
-- pantalla de venta, entre a /seriales (una página de administración de
-- inventario) y reserve manualmente los seriales exactos — algo que ningún
-- cajero descubre solo, y que además guarda reservas por staff_id+variant_id
-- sin ningún identificador de carrito/transacción, así que si el mismo
-- cajero tiene dos carritos en curso (dos pestañas) con el mismo producto,
-- reservar en uno borra silenciosamente la reserva del otro.
--
-- Esta migración prepara el backend para que Venta.tsx pueda: (a) saber qué
-- productos son serializados, y (b) reservar/soltar seriales atados a un
-- identificador de carrito estable (el mismo client_transaction_id que ya
-- usa el sistema para idempotencia de ventas), no solo a staff+variant.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (a) Exponer control_serial en las RPC que alimentan el catálogo de venta.
-- RETURNS TABLE no admite agregar columnas vía CREATE OR REPLACE (cambia el
-- rowtype) — hay que borrar y recrear cada función.
-- ----------------------------------------------------------------------------
drop function if exists public.variantes_actualizadas_desde(timestamptz);
create function public.variantes_actualizadas_desde(desde timestamptz)
returns table(id uuid, product_id uuid, color varchar, modelo_celular_id uuid, precio_override numeric, codigo_barras varchar, producto_nombre varchar, producto_sku varchar, producto_precio numeric, producto_imagen text, producto_activo boolean, producto_control_serial boolean, modelo_marca varchar, modelo_modelo varchar, updated_at timestamptz)
language sql stable set search_path = public
as $$
  select pv.id, pv.product_id, pv.color, pv.modelo_celular_id,
    pv.precio_override, pv.codigo_barras,
    p.nombre, p.sku, p.precio_base, p.imagen_url, p.activo, coalesce(p.control_serial, false),
    m.marca, m.modelo,
    greatest(p.updated_at, pv.updated_at) as updated_at
  from product_variants pv
  join products p on p.id = pv.product_id
  left join modelos_celular m on m.id = pv.modelo_celular_id
  where greatest(p.updated_at, pv.updated_at) > desde
  order by greatest(p.updated_at, pv.updated_at) asc
  limit 500;
$$;
revoke all on function public.variantes_actualizadas_desde(timestamptz) from public, anon;
grant execute on function public.variantes_actualizadas_desde(timestamptz) to authenticated;

drop function if exists public.variantes_por_categoria(uuid);
create function public.variantes_por_categoria(cat_id uuid)
returns table(id uuid, product_id uuid, color varchar, modelo_celular_id uuid, precio_override numeric, codigo_barras varchar, producto_nombre varchar, producto_sku varchar, producto_precio numeric, producto_imagen text, producto_control_serial boolean, modelo_marca varchar, modelo_modelo varchar)
language sql stable set search_path = public
as $$
  select pv.id, pv.product_id, pv.color, pv.modelo_celular_id,
    pv.precio_override, pv.codigo_barras,
    p.nombre, p.sku, p.precio_base, p.imagen_url, coalesce(p.control_serial, false),
    m.marca, m.modelo
  from product_variants pv
  join products p on p.id = pv.product_id
  left join modelos_celular m on m.id = pv.modelo_celular_id
  where p.activo = true and p.categoria_id = cat_id
  limit 30;
$$;
revoke all on function public.variantes_por_categoria(uuid) from public, anon;
grant execute on function public.variantes_por_categoria(uuid) to authenticated;

drop function if exists public.buscar_por_barcode(text);
create function public.buscar_por_barcode(barcode text)
returns table(id uuid, product_id uuid, color varchar, modelo_celular_id uuid, precio_override numeric, codigo_barras varchar, producto_nombre varchar, producto_sku varchar, producto_precio numeric, producto_imagen text, producto_control_serial boolean, modelo_marca varchar, modelo_modelo varchar)
language sql stable set search_path = public
as $$
  select pv.id, pv.product_id, pv.color, pv.modelo_celular_id,
    pv.precio_override, pv.codigo_barras,
    p.nombre, p.sku, p.precio_base, p.imagen_url, coalesce(p.control_serial, false),
    m.marca, m.modelo
  from product_variants pv
  join products p on p.id = pv.product_id
  left join modelos_celular m on m.id = pv.modelo_celular_id
  where pv.codigo_barras = barcode and p.activo = true
  limit 1;
$$;
revoke all on function public.buscar_por_barcode(text) from public, anon;
grant execute on function public.buscar_por_barcode(text) to authenticated;

drop function if exists public.obtener_favoritos();
create function public.obtener_favoritos()
returns table(id uuid, product_id uuid, color varchar, modelo_celular_id uuid, precio_override numeric, codigo_barras varchar, producto_nombre varchar, producto_sku varchar, producto_precio numeric, producto_imagen text, producto_control_serial boolean, modelo_marca varchar, modelo_modelo varchar)
language sql stable set search_path = public
as $$
  select pv.id, pv.product_id, pv.color, pv.modelo_celular_id,
    pv.precio_override, pv.codigo_barras,
    p.nombre, p.sku, p.precio_base, p.imagen_url, coalesce(p.control_serial, false),
    m.marca, m.modelo
  from product_variants pv
  join products p on p.id = pv.product_id
  left join modelos_celular m on m.id = pv.modelo_celular_id
  where p.activo = true and p.favorito = true
  order by p.nombre
  limit 20;
$$;
revoke all on function public.obtener_favoritos() from public, anon;
grant execute on function public.obtener_favoritos() to authenticated;

-- ----------------------------------------------------------------------------
-- (b) serial_reservations: se agrega client_transaction_id para que la
-- reserva quede atada a UN carrito concreto, no solo a staff+variant. Filas
-- existentes (si las hay) quedan con NULL — el propio reservar/liberar/
-- asignar de abajo tratan NULL=NULL como "mismo carrito" para no romper
-- reservas ya en curso al momento del despliegue.
-- ----------------------------------------------------------------------------
alter table public.serial_reservations add column if not exists client_transaction_id uuid;

create or replace function public.reservar_seriales_carrito(p_variant_id uuid, p_serial_ids jsonb, p_client_transaction_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public, private
as $$
declare
  s public.staff;
  sid text;
  n int := 0;
begin
  select * into s from public.staff where user_id = auth.uid() and activo = true limit 1;
  if s.id is null then
    raise exception 'Personal inválido';
  end if;

  -- Limpieza perezosa de reservas vencidas (antes no se hacía aquí, solo al
  -- vender), necesaria porque ahora dependemos de la unicidad de serial_id
  -- para bloquear seriales entre carritos distintos.
  delete from public.serial_reservations where expires_at < now();

  delete from public.serial_reservations
  where staff_id = s.id and variant_id = p_variant_id
    and coalesce(client_transaction_id::text, '') = coalesce(p_client_transaction_id::text, '');

  for sid in select jsonb_array_elements_text(coalesce(p_serial_ids, '[]'::jsonb))
  loop
    if not exists (select 1 from public.product_serials where id = sid::uuid and variant_id = p_variant_id and location_id = s.location_id and estado = 'disponible') then
      raise exception 'Serial no disponible';
    end if;
    begin
      insert into public.serial_reservations(staff_id, variant_id, serial_id, client_transaction_id)
      values (s.id, p_variant_id, sid::uuid, p_client_transaction_id);
    exception
      when unique_violation then
        raise exception 'Este IMEI/serie ya fue reservado por otra venta en curso' using errcode = 'P0001';
    end;
    n := n + 1;
  end loop;
  return n;
end;
$$;

drop function if exists public.reservar_seriales_carrito(uuid, jsonb);
revoke all on function public.reservar_seriales_carrito(uuid, jsonb, uuid) from public, anon;
grant execute on function public.reservar_seriales_carrito(uuid, jsonb, uuid) to authenticated;

create or replace function public.liberar_seriales_carrito(p_variant_id uuid, p_client_transaction_id uuid default null)
returns boolean
language plpgsql
security definer
set search_path = public, private
as $$
begin
  delete from public.serial_reservations
  where staff_id = private.auth_staff_id() and variant_id = p_variant_id
    and coalesce(client_transaction_id::text, '') = coalesce(p_client_transaction_id::text, '');
  return true;
end;
$$;

drop function if exists public.liberar_seriales_carrito(uuid);
revoke all on function public.liberar_seriales_carrito(uuid, uuid) from public, anon;
grant execute on function public.liberar_seriales_carrito(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- asignar_seriales_venta: además de staff+variant+ubicación, ahora exige que
-- la reserva pertenezca al MISMO client_transaction_id de la venta (o que
-- ambos sean NULL, para no romper reservas creadas antes de este despliegue).
-- Esto es lo que evita que dos carritos del mismo cajero con el mismo
-- producto se crucen los seriales entre sí.
-- ----------------------------------------------------------------------------
create or replace function private.asignar_seriales_venta()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_control boolean;
  v_sale public.sales;
  v_count int;
  r record;
begin
  select p.control_serial into v_control from public.product_variants pv join public.products p on p.id = pv.product_id where pv.id = new.variant_id;
  if not coalesce(v_control, false) then
    return new;
  end if;

  select * into v_sale from public.sales where id = new.sale_id;
  delete from public.serial_reservations where expires_at < now();

  select count(*) into v_count
  from public.serial_reservations sr
  join public.product_serials ps on ps.id = sr.serial_id
  where sr.staff_id = v_sale.cajero_id and sr.variant_id = new.variant_id
    and ps.location_id = v_sale.location_id and ps.estado = 'disponible'
    and coalesce(sr.client_transaction_id::text, '') = coalesce(v_sale.client_transaction_id::text, '');

  if v_count <> new.cantidad then
    raise exception 'Selecciona exactamente % IMEI/serie(s) disponibles antes de cobrar', new.cantidad;
  end if;

  for r in
    select sr.id reservation_id, ps.id serial_id
    from public.serial_reservations sr
    join public.product_serials ps on ps.id = sr.serial_id
    where sr.staff_id = v_sale.cajero_id and sr.variant_id = new.variant_id
      and ps.location_id = v_sale.location_id and ps.estado = 'disponible'
      and coalesce(sr.client_transaction_id::text, '') = coalesce(v_sale.client_transaction_id::text, '')
    order by sr.created_at
    limit new.cantidad
  loop
    update public.product_serials set estado = 'vendido', sale_id = v_sale.id, sold_at = now(), updated_at = now() where id = r.serial_id;
    insert into public.sale_item_serials(sale_item_id, serial_id) values (new.id, r.serial_id);
    delete from public.serial_reservations where id = r.reservation_id;
  end loop;

  return new;
end;
$$;
