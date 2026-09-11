-- ============================================================================
-- P0.4 / R9 — Superficie de solo lectura para que la aceptación de producción
-- pueda COMPROBAR los invariantes del release en vez de suponerlos.
--
-- Motivo: varias de las cosas que P0.4 arregla no son observables desde
-- PostgREST. La definición de una CHECK constraint, el NOT NULL de una
-- columna, el cuerpo de una función, los grants por columna y la tabla
-- supabase_migrations.schema_migrations no están expuestos. Sin esto, la
-- prueba de aceptación solo podía decir "no pude verificarlo", y una prueba
-- que no puede verificar es una prueba que puede mentir.
--
-- Se añade una RPC NUEVA en lugar de reescribir diagnostico_integridad_admin():
-- es aditivo, no arriesga romper el diagnóstico que ya funciona, y deja el
-- alcance de P0.4 aislado y revisable de un vistazo.
--
-- Solo lectura: `stable`, sin una sola escritura. SECURITY DEFINER porque los
-- catálogos y los grants no son legibles por `authenticated`; con la misma
-- guarda de administrador que el resto de RPC de diagnóstico.
-- ============================================================================

create or replace function public.p04_invariantes_admin()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'private'
-- to_timestamp interpreta en la zona de SESIÓN. Las versiones de migración son
-- UTC, así que se fija aquí en vez de confiar en la zona de la conexión.
set timezone to 'UTC'
as $function$
declare
  v_staff public.staff;
  v_corte timestamptz;
begin
  select * into v_staff from public.staff where user_id = auth.uid() and activo = true limit 1;
  if v_staff.id is null or v_staff.rol <> 'administrador' then
    raise exception 'Solo administración';
  end if;

  -- Instante en que descontar_inventario empezó a escribir en el libro mayor.
  -- Se deriva del historial, no se hardcodea: si la migración se reaplicara con
  -- otro timestamp esto sigue siendo correcto.
  -- Las versiones de migración son UTC y la base corre en UTC, así que
  -- to_timestamp las interpreta correctamente sin conversión adicional.
  select min(to_timestamp(version, 'YYYYMMDDHH24MISS'))
    into v_corte
  from supabase_migrations.schema_migrations
  where name like 'p04\_b\_%';

  return jsonb_build_object(
    'migraciones_aplicadas', (select count(*)::int from supabase_migrations.schema_migrations),
    'migraciones_p04', (
      select coalesce(jsonb_agg(version || '_' || name order by version), '[]'::jsonb)
      from supabase_migrations.schema_migrations where name like 'p04\_%'
    ),

    -- R8: la columna existe pero, si `authenticated` no puede SELECCIONARLA,
    -- los filtros del frontend fallan con 42501 y las pantallas quedan vacías.
    'products_is_test_existe', exists(
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'products' and column_name = 'is_test'
    ),
    'products_is_test_not_null', exists(
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'products' and column_name = 'is_test'
        and is_nullable = 'NO'
    ),
    'products_is_test_visible_authenticated',
      has_column_privilege('authenticated', 'public.products', 'is_test', 'SELECT'),
    'products_costo_oculto_authenticated',
      not has_column_privilege('authenticated', 'public.products', 'costo', 'SELECT'),

    -- R1
    'product_variants_product_id_not_null', (
      select attnotnull from pg_attribute
      where attrelid = 'public.product_variants'::regclass and attname = 'product_id'
    ),

    -- Matriz de transiciones + tipo nuevo
    'movimiento_posterior_permitido', exists(
      select 1 from pg_constraint
      where conrelid = 'public.inventario_fisico_seriales'::regclass
        and conname = 'invfis_seriales_tipo_resolucion_check'
        and pg_get_constraintdef(oid) like '%movimiento_posterior%'
    ),
    'matriz_valida_estado_previo', exists(
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'resolver_reconciliacion_serial'
        and p.prosrc like '%when ''vendido'' then%'
        and p.prosrc like '%and estado = v_serial.estado%'
    ),

    -- R7: el cierre de conteo debe derivar el stock serializado a través de la
    -- función que bloquea inventory ANTES de contar. Si volviera a contar por
    -- su cuenta, esta clave se apaga.
    -- Se ancla en una propiedad ESTRUCTURAL, no en un nombre de variable:
    -- la versión correcta delega y por tanto no menciona product_serials en
    -- absoluto; la versión con el bug lo cuenta ella misma. Anclarlo a
    -- `v_disponibles` era evadible renombrando la variable, y como prosrc
    -- incluye los comentarios del cuerpo, bastaba con dejar la palabra
    -- "sincronizar_stock_serializado" en un comentario para pasar en verde.
    'cierre_conteo_orden_seguro', exists(
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'cerrar_inventario_fisico'
        and p.prosrc like '%sincronizar_stock_serializado%'
        and p.prosrc not like '%product_serials%'
    ),
    -- position() devuelve 0 cuando no encuentra el texto, así que hay que
    -- exigir que AMBAS marcas existan: si no, borrar el `for update` haría que
    -- 0 < N y la comprobación pasaría justo cuando el lock desapareció.
    'sincronizar_bloquea_antes_de_contar', exists(
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname = 'sincronizar_stock_serializado'
        and position('for update' in p.prosrc) > 0
        and position('estado = ''disponible''' in p.prosrc) > 0
        and position('for update' in p.prosrc) < position('estado = ''disponible''' in p.prosrc)
    ),
    'sincronizar_expuesta_en_api', (
      select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname like 'sincronizar_stock_serializado%'
        and (has_function_privilege('anon', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    ),

    -- F3: las ventas tienen que dejar rastro en el libro mayor.
    'venta_escribe_ledger', exists(
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'descontar_inventario'
        and p.prosrc like '%inventory_movements%'
    ),

    -- Sin este booleano, un v_corte NULL (la migración B no consta aplicada, o
    -- `name` viene NULL) colapsaba los dos contadores a 0 y el consumidor lo
    -- leía como "no hubo ventas todavía". Es decir: el detector de "las ventas
    -- dejaron de escribir en el libro mayor" se apagaba solo justo cuando la
    -- migración que lo arregla no constaba. Ahora se distingue explícitamente
    -- "no hay ventas" de "no sé desde cuándo mirar".
    'corte_resuelto', v_corte is not null,

    -- Se compara LÍNEA a LÍNEA, no venta a movimiento: el trigger escribe un
    -- movimiento por cada sale_item, así que contar ventas contra movimientos
    -- comparaba granularidades distintas y `movimientos > 0` era casi una
    -- tautología (bastaba una sola venta para darlo por bueno).
    -- TODAS las líneas, incluidas las de ventas is_test y las de ventas luego
    -- anuladas: el trigger escribe un movimiento por cada sale_item, sin mirar
    -- is_test ni el estado posterior. Comparar sólo contra las líneas reales
    -- dejaba un margen de enmascaramiento — los movimientos de ventas de
    -- prueba podían tapar líneas reales que no escribieron en el ledger.
    'lineas_todas_desde_migracion', (
      select count(*)::int
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
      where v_corte is not null and s.fecha > v_corte
    ),
    'lineas_venta_desde_migracion', (
      select count(*)::int
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
      where s.estado = 'completada' and not s.is_test
        and v_corte is not null and s.fecha > v_corte
    ),
    'ventas_desde_migracion', (
      select count(*)::int from public.sales
      where estado = 'completada' and not is_test and v_corte is not null and fecha > v_corte
    ),
    -- Incluye los movimientos de ventas is_test (no hay FK de movimiento a
    -- venta para filtrarlos), así que este número puede ser mayor que el de
    -- líneas reales. Por eso el consumidor exige `movimientos >= lineas`: si
    -- alguna venta no escribió, el conteo se queda corto y salta.
    'movimientos_venta_desde_migracion', (
      select count(*)::int from public.inventory_movements
      where motivo = 'Venta' and v_corte is not null and created_at > v_corte
    ),

    -- Aislamiento QA
    'qa_productos_marcados', (select count(*)::int from public.products where is_test),
    'qa_unidades_operativas', (
      select coalesce(sum(i.cantidad), 0)::int from public.inventory i
      join public.product_variants pv on pv.id = i.variant_id
      join public.products p on p.id = pv.product_id where p.is_test
    ),
    'qa_valorizacion', (
      select coalesce(sum(round(i.cantidad * coalesce(p.costo, 0), 2)), 0)::numeric
      from public.inventory i
      join public.product_variants pv on pv.id = i.variant_id
      join public.products p on p.id = pv.product_id where p.is_test
    ),
    'qa_sin_marcar', (
      select count(*)::int from public.products
      where not is_test and (nombre ilike 'QA-%' or nombre ilike 'TEST-%' or nombre ilike 'PRUEBA-%')
    ),
    'stock_critico_real', (
      select count(*)::int from public.inventory i
      join public.product_variants pv on pv.id = i.variant_id
      join public.products p on p.id = pv.product_id
      where i.cantidad <= i.stock_minimo and not p.is_test
    ),
    'stock_critico_sin_filtrar_qa', (
      select count(*)::int from public.inventory i
      join public.product_variants pv on pv.id = i.variant_id
      join public.products p on p.id = pv.product_id
      where i.cantidad <= i.stock_minimo
    ),

    -- Los triggers desplegados no los expone ninguna otra RPC, así que hasta
    -- ahora la aceptación sólo podía decir "no lo sé". Se listan los de las
    -- tablas cuyo comportamiento sostiene la integridad del inventario y la
    -- caja, para poder afirmar que siguen ahí.
    'triggers_criticos', (
      select coalesce(jsonb_agg(t.tgname order by t.tgname), '[]'::jsonb)
      from pg_trigger t
      where not t.tgisinternal
        and t.tgrelid in (
          'public.sale_items'::regclass, 'public.sales'::regclass,
          'public.cash_movements'::regclass, 'public.product_serials'::regclass
        )
    ),

    -- El cuadre línea a línea exige una agregación que PostgREST no expone.
    'ventas_descuadradas', (
      select count(*)::int from public.sales s
      where s.estado = 'completada' and not s.is_test
        and abs(coalesce(s.subtotal, 0) + coalesce(s.impuesto, 0) - coalesce(s.total, 0)) > 0.05
    ),
    'ventas_sin_lineas', (
      select count(*)::int from public.sales s
      where s.estado = 'completada' and not s.is_test
        and not exists (select 1 from public.sale_items si where si.sale_id = s.id)
    ),

    -- Invariantes de datos que no deberían poder existir nunca.
    'inventario_negativo', (select count(*)::int from public.inventory where cantidad < 0),
    'imei_vendido_sin_venta', (select count(*)::int from public.product_serials where estado = 'vendido' and sale_id is null),
    'imei_disponible_con_venta', (select count(*)::int from public.product_serials where estado = 'disponible' and sale_id is not null),
    'pos_devices', (select count(*)::int from public.pos_devices)
  );
end$function$;

revoke all on function public.p04_invariantes_admin() from public, anon;
grant execute on function public.p04_invariantes_admin() to authenticated;
