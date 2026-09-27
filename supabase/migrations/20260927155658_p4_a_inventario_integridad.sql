-- ============================================================================
-- P4.A — INVENTARIO: el stock no puede ser negativo, y su cantidad sólo se mueve
--        por las funciones que dejan rastro en el libro.
-- ============================================================================
-- Auditoría de integridad del núcleo POS (sólo lectura contra producción, 2026-09-27).
-- De 21 invariantes, 18 dieron cero violaciones. Al investigar las otras tres salieron
-- dos hechos que sí son defectos del mecanismo, y uno que no lo era:
--
--   NO era defecto · las 999999 unidades de «Servicio técnico» son un centinela
--   deliberado de 20260819222111_inventario_servicio_tecnico.sql: ese concepto no es un
--   producto físico y el trigger descontar_inventario() exige una fila de inventario para
--   poder venderlo. Queda como está.
--
--   DEFECTO 1 · `public.inventory` no tiene NINGUNA restricción que impida cantidad < 0.
--   Las funciones lo comprueban una a una (ajustar_stock, el despacho de transferencias,
--   la reversión de recepciones), pero eso es disciplina repetida en código, no una
--   garantía de la base: basta una ruta nueva que se olvide de comprobarlo. Hoy hay 0
--   filas negativas en producción, así que la restricción entra limpia.
--
--   DEFECTO 2 · la policy `inventario_escritura_admin` (ALL para administrador) permite
--   escribir `inventory` directamente por PostgREST. Un UPDATE de `cantidad` por esa vía
--   cambia el stock SIN escribir movimiento: el libro deja de explicar el agregado, que es
--   exactamente lo que la auditoría encontró en 16 filas históricas. `ajustar_stock` existe
--   para eso — comprueba permisos, rechaza producto serializado y escribe el movimiento con
--   su responsable.
--
-- QUÉ SE CIERRA Y QUÉ NO
--   · Se retira el privilegio de columna sobre `inventory.cantidad`: la cantidad sólo la
--     mueven las funciones SECURITY DEFINER (que corren como su dueño y no dependen de este
--     privilegio). Cualquier intento directo recibe 42501.
--   · Se CONSERVAN el INSERT y el UPDATE de `stock_minimo`: la pantalla de Inventario los
--     usa para dar de alta una variante en una sucursal (Inventario.tsx:500) y para fijar el
--     mínimo (Inventario.tsx:675). Quitarlos rompería el alta de inventario.
--   · Queda declarado como deuda, NO cerrado aquí: ese alta escribe la fila y su movimiento
--     en DOS peticiones separadas, así que un fallo de red entre ambas deja stock sin libro.
--     La forma correcta es una RPC que haga las dos cosas en una transacción; exige cambiar
--     la pantalla y se trata aparte.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 · El stock no puede ser negativo. Garantía de la base, no del código.
-- ---------------------------------------------------------------------------
do $migracion$
declare v_n integer;
begin
  select count(*) into v_n from public.inventory where cantidad < 0;
  if v_n > 0 then
    raise exception 'P4.A: hay % fila(s) de inventario en negativo; corrígelas con un ajuste auditado antes de aplicar esta restricción', v_n
      using errcode = 'P0001';
  end if;
end
$migracion$;

alter table public.inventory drop constraint if exists inventory_cantidad_no_negativa;
alter table public.inventory add constraint inventory_cantidad_no_negativa check (cantidad >= 0);

-- ---------------------------------------------------------------------------
-- 2 · La cantidad se mueve por función, no por PostgREST.
-- ---------------------------------------------------------------------------
-- Un revoke de COLUMNA no reduce un privilegio de TABLA: `authenticated` tiene UPDATE sobre
-- toda la tabla por los `grant all on tables` antiguos, y eso cubre cualquier columna. Hay que
-- retirar el de tabla y devolver sólo la columna que debe seguir escribiéndose — el mismo
-- patrón que _p2_d aplicó a `clientes`.
revoke update on public.inventory from authenticated;
grant update (stock_minimo) on public.inventory to authenticated;

-- ---------------------------------------------------------------------------
-- 3 · VERIFICACIÓN
-- ---------------------------------------------------------------------------
do $migracion$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.inventory'::regclass
       and conname = 'inventory_cantidad_no_negativa'
       and pg_get_constraintdef(oid) ~ 'cantidad >= 0') then
    raise exception 'P4.A: no quedó la restricción de no-negatividad' using errcode = 'P0001';
  end if;

  if has_column_privilege('authenticated', 'public.inventory', 'cantidad', 'UPDATE') then
    raise exception 'P4.A: authenticated todavía puede escribir inventory.cantidad por la API' using errcode = 'P0001';
  end if;

  -- No nos pasamos: el alta de inventario y el mínimo siguen funcionando.
  if not (has_table_privilege('authenticated', 'public.inventory', 'INSERT')
      and has_column_privilege('authenticated', 'public.inventory', 'stock_minimo', 'UPDATE')) then
    raise exception 'P4.A: se rompió el alta de inventario o el ajuste de stock mínimo' using errcode = 'P0001';
  end if;

  -- Y la vía legítima para mover cantidad sigue en pie.
  if not has_function_privilege('authenticated', 'public.ajustar_stock(uuid,uuid,integer,text)', 'EXECUTE') then
    raise exception 'P4.A: se perdió ajustar_stock, que es la única vía que queda' using errcode = 'P0001';
  end if;
end
$migracion$;
