-- ============================================================================
-- P0.1 bloque 2: ajustar_stock perdió dos protecciones al reescribirse.
--
-- (a) `v_location := coalesce(p_location_id, v_staff.location_id)` permitía a
--     CUALQUIER staff no-admin (técnico/encargado/jefa) pasar el location_id
--     de OTRA sucursal y ajustar su stock — sin ninguna validación de que esa
--     sucursal le perteneciera. BOLA/IDOR clásico.
-- (b) `coalesce(p_staff_id, v_staff.id)` dejaba que el cliente atribuyera el
--     movimiento a OTRO staff_id arbitrario, falsificando la auditoría.
--     El frontend (Inventario.tsx, único caller) nunca lo envía — no tenía
--     ninguna justificación legítima, así que se elimina del todo en vez de
--     solo validarlo.
--
-- Reutiliza `staff_locations.puede_inventario` (ya existente, usado en otras
-- partes del sistema para permisos multi-sucursal) en vez de inventar un
-- mecanismo nuevo: un no-admin puede ajustar su propia sucursal siempre, u
-- otra sucursal solo si tiene `puede_inventario=true` ahí. Admin conserva
-- acceso a cualquier sucursal, igual que en el resto del sistema.
-- ============================================================================

create or replace function public.ajustar_stock(
  p_variant_id uuid,
  p_location_id uuid,
  p_cantidad_delta integer,
  p_motivo text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff public.staff;
  v_location uuid;
  v_control_serial boolean;
  v_actual integer;
begin
  select * into v_staff from public.staff where user_id = auth.uid() and activo = true limit 1;
  if v_staff.id is null then
    raise exception 'Personal no válido o inactivo' using errcode = 'P0001';
  end if;
  -- OJO: con puesto IS NULL, `puesto in (...)` da NULL (no false) en SQL, y
  -- `not (false or null)` también da NULL, que plpgsql trata como "no lanzar".
  if not (v_staff.rol = 'administrador' or coalesce(v_staff.puesto, '') in ('tecnico','encargado','jefa')) then
    raise exception 'No tienes permiso para ajustar inventario' using errcode = 'P0001';
  end if;

  if p_location_id is null then
    v_location := v_staff.location_id;
  elsif v_staff.rol = 'administrador' then
    v_location := p_location_id;
  elsif p_location_id = v_staff.location_id then
    v_location := p_location_id;
  elsif exists (
    select 1 from public.staff_locations sl
    where sl.staff_id = v_staff.id and sl.location_id = p_location_id and sl.puede_inventario
  ) then
    v_location := p_location_id;
  else
    raise exception 'No tienes autorización para ajustar inventario en esa sucursal' using errcode = 'P0001';
  end if;

  select p.control_serial into v_control_serial
  from public.product_variants pv
  join public.products p on p.id = pv.product_id
  where pv.id = p_variant_id;

  if coalesce(v_control_serial, false) then
    raise exception 'Este producto se controla por IMEI/serie — usa el flujo de seriales, no el ajuste genérico de stock' using errcode = 'P0001';
  end if;

  select cantidad into v_actual from public.inventory where variant_id = p_variant_id and location_id = v_location for update;
  v_actual := coalesce(v_actual, 0);

  if v_actual + p_cantidad_delta < 0 then
    raise exception 'Stock insuficiente. Disponible: %. Intentaste retirar: %.', v_actual, abs(p_cantidad_delta) using errcode = 'P0001';
  end if;

  insert into public.inventory (variant_id, location_id, cantidad, updated_at)
  values (p_variant_id, v_location, v_actual + p_cantidad_delta, now())
  on conflict (variant_id, location_id) do update set cantidad = excluded.cantidad, updated_at = now();

  -- staff_id siempre es el actor autenticado real: nunca un parámetro del cliente.
  insert into public.inventory_movements (variant_id, location_id, cantidad_delta, motivo, staff_id)
  values (p_variant_id, v_location, p_cantidad_delta, p_motivo, v_staff.id);
end;
$$;

-- Firma anterior tenía un 5to parámetro (p_staff_id) que ya no existe:
-- distinto signature, así que create or replace NO la reemplaza — hay que
-- eliminarla explícitamente para que no quede un overload ambiguo/inseguro.
drop function if exists public.ajustar_stock(uuid, uuid, integer, text, uuid);

revoke all on function public.ajustar_stock(uuid, uuid, integer, text) from public, anon;
grant execute on function public.ajustar_stock(uuid, uuid, integer, text) to authenticated;
