-- ============================================================================
-- P4.B — El alta de inventario deja de ser dos peticiones: una RPC atómica.
-- ============================================================================
-- Deuda declarada en P4.A. La pantalla de Inventario daba de alta una variante en una
-- sucursal con DOS llamadas separadas (src/pages/Inventario.tsx): un INSERT en
-- `inventory` con la cantidad inicial y, después, un INSERT en `inventory_movements`.
-- Si la red se corta entre ambas —o si alguien llama sólo a la primera— queda stock que
-- el libro no explica. Es exactamente el desajuste que la auditoría del 2026-09-27
-- encontró en filas históricas, y la única forma de cerrarlo es que las dos escrituras
-- ocurran en la misma transacción, del lado del servidor.
--
-- DISEÑO
--   · Una RPC, `registrar_stock_inicial`, hace las dos escrituras o ninguna.
--   · Mismo modelo de autorización que `ajustar_stock`, que es la función hermana:
--     capacidad `operar_inventario` y, para quien no es administrador, su sucursal
--     ACTIVA o una donde tenga `puede_inventario`. Fallo CERRADO con sucursal nula.
--   · Rechaza producto con IMEI cuando la cantidad es > 0: ahí el stock se DERIVA de
--     `product_serials` (invariante P0.2/P0.4) y se carga registrando cada unidad.
--   · No inventa idempotencia con clave: la unicidad (variant_id, location_id) ya impide
--     la fila duplicada, y al no insertarse la fila tampoco se escribe el movimiento, así
--     que un doble clic no puede duplicar nada. Si la fila existe, manda a `ajustar_stock`,
--     que es la vía correcta para MOVER stock ya existente.
--   · Se retira el INSERT directo sobre `inventory` a `authenticated`: a partir de aquí la
--     única forma de crear inventario desde la aplicación es esta función. `stock_minimo`
--     sigue siendo editable (columna concedida en P4.A) y la cantidad sigue moviéndose
--     sólo por funciones que escriben el libro.
-- ============================================================================

create or replace function public.registrar_stock_inicial(
  p_variant_id   uuid,
  p_location_id  uuid,
  p_cantidad     integer,
  p_stock_minimo integer default 0,
  p_motivo       text default null
)
returns public.inventory
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_staff    public.staff;
  v_location uuid;
  v_control  boolean;
  v_fila     public.inventory;
  v_motivo   text;
begin
  select * into v_staff from public.staff where user_id = auth.uid() and activo = true limit 1;
  if v_staff.id is null or not private.tiene_capacidad('operar_inventario') then
    raise exception 'No tienes permiso para dar de alta inventario' using errcode = 'P0001';
  end if;
  if p_variant_id is null then
    raise exception 'Variante inválida' using errcode = 'P0001';
  end if;
  if coalesce(p_cantidad, -1) < 0 or coalesce(p_stock_minimo, -1) < 0 then
    raise exception 'La cantidad y el stock mínimo no pueden ser negativos' using errcode = 'P0001';
  end if;

  -- Sucursal: mismas reglas que ajustar_stock, con fallo CERRADO.
  if p_location_id is null then
    v_location := private.auth_location_id();
  elsif v_staff.rol = 'administrador' then
    v_location := p_location_id;
  elsif p_location_id = private.auth_location_id() then
    v_location := p_location_id;
  elsif exists (select 1 from public.staff_locations sl
                 where sl.staff_id = v_staff.id and sl.location_id = p_location_id and sl.puede_inventario) then
    v_location := p_location_id;
  else
    raise exception 'No tienes autorización para dar de alta inventario en esa sucursal' using errcode = 'P0001';
  end if;
  if v_location is null then
    raise exception 'Sin sucursal activa: no se puede dar de alta inventario' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.locations where id = v_location) then
    raise exception 'Sucursal inexistente' using errcode = 'P0001';
  end if;

  select p.control_serial into v_control
    from public.product_variants pv join public.products p on p.id = pv.product_id
   where pv.id = p_variant_id;
  if v_control is null then
    raise exception 'La variante no existe' using errcode = 'P0001';
  end if;
  if coalesce(v_control, false) and p_cantidad > 0 then
    raise exception 'Este producto se controla por IMEI/serie: su stock se deriva de las unidades registradas, no de una cantidad inicial'
      using errcode = 'P0001';
  end if;

  v_motivo := coalesce(nullif(btrim(coalesce(p_motivo, '')), ''), 'Alta de inventario');

  -- La fila y su movimiento, en la MISMA transacción. Si la fila ya existía no se inserta
  -- nada y tampoco se escribe movimiento: nada que pueda quedar a medias.
  insert into public.inventory (variant_id, location_id, cantidad, stock_minimo, updated_at)
  values (p_variant_id, v_location, p_cantidad, p_stock_minimo, now())
  on conflict (variant_id, location_id) do nothing
  returning * into v_fila;

  if v_fila.variant_id is null then
    raise exception 'Esa variante ya tiene inventario en esa sucursal: usa ajustar_stock para mover la cantidad, que deja el movimiento registrado'
      using errcode = 'P0001';
  end if;

  if p_cantidad > 0 then
    insert into public.inventory_movements (variant_id, location_id, cantidad_delta, motivo, staff_id)
    values (p_variant_id, v_location, p_cantidad, left(v_motivo, 250), v_staff.id);
  end if;

  return v_fila;
end
$function$;

revoke all on function public.registrar_stock_inicial(uuid, uuid, integer, integer, text) from public;
revoke all on function public.registrar_stock_inicial(uuid, uuid, integer, integer, text) from anon;
grant execute on function public.registrar_stock_inicial(uuid, uuid, integer, integer, text) to authenticated;
grant execute on function public.registrar_stock_inicial(uuid, uuid, integer, integer, text) to service_role;

-- La única vía para crear inventario desde la aplicación es la RPC de arriba.
revoke insert on public.inventory from authenticated;

-- ---------------------------------------------------------------------------
-- VERIFICACIÓN
-- ---------------------------------------------------------------------------
do $migracion$
begin
  if has_table_privilege('authenticated', 'public.inventory', 'INSERT') then
    raise exception 'P4.B: authenticated todavía puede insertar en inventory por la API' using errcode = 'P0001';
  end if;
  if not has_function_privilege('authenticated', 'public.registrar_stock_inicial(uuid,uuid,integer,integer,text)', 'EXECUTE') then
    raise exception 'P4.B: authenticated no puede ejecutar la RPC que ahora es la única vía' using errcode = 'P0001';
  end if;
  if has_function_privilege('anon', 'public.registrar_stock_inicial(uuid,uuid,integer,integer,text)', 'EXECUTE') then
    raise exception 'P4.B: anon no puede ejecutar la RPC' using errcode = 'P0001';
  end if;
  -- No nos pasamos: el stock mínimo sigue editable y la cantidad sigue cerrada (P4.A).
  if not has_column_privilege('authenticated', 'public.inventory', 'stock_minimo', 'UPDATE')
     or has_column_privilege('authenticated', 'public.inventory', 'cantidad', 'UPDATE') then
    raise exception 'P4.B: cambió el privilegio de stock_minimo o de cantidad' using errcode = 'P0001';
  end if;
end
$migracion$;
