-- ============================================================================
-- P2.C — Corrige la policy tautológica de cliente_puntos_movimientos
-- ============================================================================
-- La policy `cliente_puntos_read` comparaba `s.cliente_id = s.cliente_id`, que
-- es siempre verdadero para cualquier venta con cliente. Resultado: cualquier
-- miembro del personal cuya sucursal activa tuviera al menos una venta con
-- cliente podía leer los movimientos de puntos de TODOS los clientes, de todas
-- las sucursales.
--
-- Intención original (evidente por la forma de la subconsulta): el personal no
-- administrador ve los movimientos de un cliente sólo si ese cliente compró en
-- su sucursal activa. Se corrige la correlación con la fila de la tabla.
--
-- Producción tiene 0 filas en la tabla: no hubo exposición de datos reales.
-- Mismo nombre, comando y rol: la huella de policies no cambia.
-- ============================================================================

drop policy if exists cliente_puntos_read on public.cliente_puntos_movimientos;

create policy cliente_puntos_read on public.cliente_puntos_movimientos
  for select to authenticated
  using (
    private.auth_is_admin()
    or exists (
      select 1
      from public.sales s
      where s.cliente_id = cliente_puntos_movimientos.cliente_id
        and s.location_id = private.auth_location_id()
    )
  );
