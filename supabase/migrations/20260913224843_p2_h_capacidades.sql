-- ============================================================================
-- P2.H — FASE 24 · Capacidades centralizadas (parte escrita a mano)
-- ============================================================================
-- Auditoría (2026-09-13): la autorización por puesto estaba copiada a mano en 17
-- funciones, 1 policy y 8 sitios del frontend, con dos listas
-- ('tecnico','encargado','jefa') y ('encargado','jefa'). Además,
-- staff_locations.puede_inventario / puede_taller / puede_vender se asignaban y
-- se mostraban, pero el servidor sólo aplicaba puede_inventario en ajustar_stock.
--
-- Esta migración crea la ÚNICA definición de cada capacidad. La sustitución en
-- las funciones la genera scripts/generar-p2i.mjs (_p2_i).
--
--   supervisar         administración, o puesto encargado / jefa.
--   operar_inventario  administración, o puesto técnico / encargado / jefa
--                      Y puede_inventario en la sucursal ACTIVA.
--   operar_taller      administración, o puesto técnico / encargado / jefa
--                      Y puede_taller en la sucursal ACTIVA.
--   vender             administración, o puede_vender en la sucursal ACTIVA.
--                      (Definida para la UI; el servidor de ventas no la aplica
--                      todavía: queda registrado como pendiente.)
--
-- Si el miembro del personal no tiene fila en staff_locations para su sucursal
-- activa, el flag no restringe (true): el alta de personal no crea esa fila y
-- ningún permiso debe perderse por omisión. Un flag explícitamente en false sí
-- restringe. En producción, las únicas filas con puede_taller = false son de
-- puesto vendedor, que ya no está en la lista de taller: impacto nulo hoy.
-- ============================================================================

create or replace function private.tiene_capacidad(p_capacidad text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_actor public.staff;
  v_flag  boolean;
begin
  if p_capacidad is null or p_capacidad not in ('supervisar', 'operar_inventario', 'operar_taller', 'vender') then
    raise exception 'Capacidad desconocida: %', p_capacidad;
  end if;

  select * into v_actor from public.staff where user_id = auth.uid() and activo = true limit 1;
  if v_actor.id is null then return false; end if;
  if v_actor.rol = 'administrador' then return true; end if;

  if p_capacidad = 'supervisar' then
    return coalesce(v_actor.puesto, '') in ('encargado', 'jefa');
  end if;
  if p_capacidad in ('operar_inventario', 'operar_taller')
     and coalesce(v_actor.puesto, '') not in ('tecnico', 'encargado', 'jefa') then
    return false;
  end if;

  select case p_capacidad
           when 'operar_inventario' then sl.puede_inventario
           when 'operar_taller'     then sl.puede_taller
           else sl.puede_vender
         end
    into v_flag
    from public.staff_locations sl
   where sl.staff_id = v_actor.id and sl.location_id = private.auth_location_id();
  return coalesce(v_flag, true);
end
$function$;

revoke all on function private.tiene_capacidad(text) from public;
-- Las policies se evalúan con el rol de quien consulta.
grant execute on function private.tiene_capacidad(text) to authenticated;

create or replace function public.mis_capacidades()
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'private'
as $function$
  select jsonb_build_object(
    'supervisar',        private.tiene_capacidad('supervisar'),
    'operar_inventario', private.tiene_capacidad('operar_inventario'),
    'operar_taller',     private.tiene_capacidad('operar_taller'),
    'vender',            private.tiene_capacidad('vender'));
$function$;

revoke all on function public.mis_capacidades() from public;
grant execute on function public.mis_capacidades() to authenticated, service_role;

-- La única policy que repetía la lista de puestos.
drop policy if exists ordenes_actualizacion_tecnica on public.ordenes_servicio;
create policy ordenes_actualizacion_tecnica on public.ordenes_servicio
  for update to authenticated
  using (private.auth_is_admin() or (location_id = private.auth_location_id() and private.tiene_capacidad('operar_taller')))
  with check (private.auth_is_admin() or (location_id = private.auth_location_id() and private.tiene_capacidad('operar_taller')));
