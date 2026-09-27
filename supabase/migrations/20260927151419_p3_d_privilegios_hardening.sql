-- ============================================================================
-- P3.D — Endurecimiento de privilegios: RT-1, RT-2 y RT-3 del red team
-- ============================================================================
-- Los tres se confirmaron contra PRODUCCIÓN con consultas de sólo lectura
-- (2026-09-27) y los tres son restos de privilegios por defecto o de un control
-- que vive en una función pero se puede esquivar por la API. Ninguno cambia el
-- cuerpo de ninguna función: esta migración sólo quita permisos.
--
-- RT-1 · El control de administración sobre el documento del cliente se esquiva
-- ----------------------------------------------------------------------------
-- `public.actualizar_cliente_crm` (de _p2_d) exige `private.auth_is_admin()` para
-- tocar documento, dirección, segmento y consentimientos. Pero la misma migración
-- concedió privilegio de COLUMNA a `authenticated` sobre `documento` y `direccion`
-- (líneas 119-121 de 20260913224318_p2_d_crm_alcance.sql), y la policy de UPDATE de
-- la tabla es `USING true / WITH CHECK true`. Resultado: cualquier autenticado
-- reescribe el documento de cualquier cliente con un PATCH a /rest/v1/clientes,
-- saltándose la RPC. El documento es lo que se imprime en boleta y factura.
--
-- Hoy los 3 usuarios de Auth tienen ficha de personal, así que el titular del red
-- team ("un autenticado SIN ficha de staff") no se cumple en este momento; lo que
-- sí se cumple, y es el defecto real, es que un control declarado como "sólo
-- administración" no lo es. Se cierra quitando la columna, no la policy.
--
-- Por qué no se toca la policy: el mostrador edita datos de contacto de clientes
-- que no creó él, y eso es el flujo real del negocio. Restringir las FILAS rompería
-- la operación; restringir las COLUMNAS es exactamente lo que faltaba.
--
-- Por qué también se retira el INSERT de esas dos columnas: el alta desde el
-- mostrador escribe nombre, teléfono, email y notas, nada más — verificado en el
-- código (src/pages/Clientes.tsx:82 y src/pages/OrdenesServicio.tsx:185), no
-- supuesto. Quien necesite registrar el documento usa la RPC de administración.
--
-- RT-2 · TRUNCATE a merced de cualquier autenticado
-- ----------------------------------------------------------------------------
-- 69 de las 74 tablas de `public` conceden TRUNCATE a `authenticated`, herencia de
-- los `grant all on tables` de las migraciones antiguas. **La RLS no filtra
-- TRUNCATE**: una policy restrictiva no protege de un TRUNCATE, así que un
-- autenticado podría vaciar `auditoria_eventos` — el rastro con el que se
-- investigaría el propio borrado. PostgREST no expone TRUNCATE, de modo que hoy no
-- es alcanzable desde la aplicación; lo es desde cualquier ruta con SQL directo
-- (una credencial filtrada, un script, un cliente de base de datos).
--
-- RT-3 · Correlativos fiscales reescribibles
-- ----------------------------------------------------------------------------
-- 9 secuencias conceden UPDATE a `authenticated`, y UPDATE sobre una secuencia es
-- lo que habilita `setval`. Entre ellas `boleta_correlativo_seq` y
-- `factura_correlativo_seq`: rebobinarlas produce comprobantes con numeración
-- repetida, que es un problema tributario, no informático. Las tres secuencias que
-- creó OLA 1–4 llegaron sin privilegios para `authenticated`: el patrón correcto ya
-- estaba, sólo faltaba aplicarlo al resto.
--
-- Se quita UPDATE y se CONSERVA USAGE, que es lo que `nextval` necesita: emitir un
-- comprobante sigue funcionando, rebobinar el contador no.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 · RT-1 · documento y dirección sólo por la RPC de administración
-- ---------------------------------------------------------------------------
revoke insert (documento, direccion) on public.clientes from authenticated;
revoke update (documento, direccion) on public.clientes from authenticated;
revoke all on public.clientes from anon;

-- ---------------------------------------------------------------------------
-- 2 · RT-2 · nadie vacía una tabla por la puerta de atrás
-- ---------------------------------------------------------------------------
revoke truncate on all tables in schema public from authenticated;
revoke truncate on all tables in schema public from anon;

-- ---------------------------------------------------------------------------
-- 3 · RT-3 · el correlativo avanza, no se rebobina
-- ---------------------------------------------------------------------------
-- Se retira TODO privilegio de secuencia, no sólo UPDATE. `nextval` lo necesitaría si el
-- correlativo se consumiera desde el cliente, pero no ocurre: cada número lo asigna una función
-- SECURITY DEFINER propiedad de postgres (registrar_venta, crear_orden_compra,
-- crear_transferencia_stock, los triggers de comprobante), que resuelve la secuencia con los
-- privilegios del dueño, no del llamador. Lo demuestran las pruebas de negocio: emiten ventas,
-- órdenes y transferencias como `authenticated` con estas secuencias ya cerradas.
revoke all on all sequences in schema public from authenticated;
revoke all on all sequences in schema public from anon;

-- ---------------------------------------------------------------------------
-- 4 · RT-4 · los libros de movimientos sólo se escriben añadiendo
-- ---------------------------------------------------------------------------
-- Hallazgo del red team (K): `cliente_puntos_movimientos`, `inventory_movements` y
-- `orden_servicio_historial` conceden UPDATE y DELETE a `authenticated`. Hoy NO son
-- alcanzables: las tres tienen RLS activa y ninguna policy de UPDATE ni de DELETE, así que la
-- RLS deja la operación en cero filas. Pero el privilegio no debería estar: es lo único que
-- separaría el libro de una edición si mañana alguien añadiera una policy de escritura, y esa
-- policy se añadiría pensando en insertar, no en permitir borrados.
-- Nada legítimo depende de ellos: quien escribe estos libros son funciones SECURITY DEFINER.
revoke update, delete on public.cliente_puntos_movimientos from authenticated;
revoke update, delete on public.inventory_movements from authenticated;
revoke update, delete on public.orden_servicio_historial from authenticated;

-- ---------------------------------------------------------------------------
-- 5 · VERIFICACIÓN · lo cerrado está cerrado y lo que debía seguir abierto sigue
-- ---------------------------------------------------------------------------
-- Fallo cerrado: cada comprobación aborta la migración. Se comprueban las dos
-- direcciones — que el permiso se fue Y que no nos pasamos de largo — porque
-- quitar de más rompe el mostrador y eso también es un fallo.
do $migracion$
declare
  v_n integer;
  v_cuales text;
begin
  -- RT-1: documento y dirección cerrados para authenticated y anon.
  if has_column_privilege('authenticated', 'public.clientes', 'documento', 'UPDATE')
     or has_column_privilege('authenticated', 'public.clientes', 'direccion', 'UPDATE')
     or has_column_privilege('authenticated', 'public.clientes', 'documento', 'INSERT')
     or has_column_privilege('authenticated', 'public.clientes', 'direccion', 'INSERT') then
    raise exception 'P3.D · RT-1: authenticated todavía puede escribir documento o direccion' using errcode = 'P0001';
  end if;
  if has_table_privilege('anon', 'public.clientes', 'SELECT') then
    raise exception 'P3.D · RT-1: anon conserva acceso a clientes' using errcode = 'P0001';
  end if;

  -- RT-1 · no nos pasamos: el mostrador sigue pudiendo dar de alta y editar contacto.
  if not (has_column_privilege('authenticated', 'public.clientes', 'nombre', 'INSERT')
      and has_column_privilege('authenticated', 'public.clientes', 'telefono', 'INSERT')
      and has_column_privilege('authenticated', 'public.clientes', 'email', 'INSERT')
      and has_column_privilege('authenticated', 'public.clientes', 'notas', 'INSERT')
      and has_column_privilege('authenticated', 'public.clientes', 'nombre', 'UPDATE')
      and has_column_privilege('authenticated', 'public.clientes', 'notas', 'UPDATE')) then
    raise exception 'P3.D · RT-1: se quitó de más y el alta/edición de contacto del mostrador quedó rota' using errcode = 'P0001';
  end if;
  -- Y la vía legítima sigue en pie.
  if not has_function_privilege('authenticated',
        'public.actualizar_cliente_crm(uuid,text,text,text,boolean,boolean)', 'EXECUTE') then
    raise exception 'P3.D · RT-1: se perdió la vía legítima (actualizar_cliente_crm)' using errcode = 'P0001';
  end if;

  -- RT-2: ninguna tabla de public con TRUNCATE para authenticated ni anon.
  select count(*), string_agg(c.relname, ', ' order by c.relname) into v_n, v_cuales
    from (select c2.oid as oid, c2.relname from pg_class c2 join pg_namespace n on n.oid = c2.relnamespace
           where c2.relkind in ('r', 'p') and n.nspname = 'public' offset 0) c
   where has_table_privilege('authenticated', c.oid, 'TRUNCATE')
      or has_table_privilege('anon', c.oid, 'TRUNCATE');
  if v_n <> 0 then
    raise exception 'P3.D · RT-2: quedan % tabla(s) con TRUNCATE: %', v_n, v_cuales using errcode = 'P0001';
  end if;

  -- RT-3: ninguna secuencia con UPDATE...
  select count(*), string_agg(s.sequencename, ', ' order by s.sequencename) into v_n, v_cuales
    from (select (quote_ident(schemaname) || '.' || quote_ident(sequencename))::regclass as oid, sequencename
            from pg_sequences where schemaname = 'public' offset 0) s
   where has_sequence_privilege('authenticated', s.oid, 'UPDATE')
      or has_sequence_privilege('anon', s.oid, 'UPDATE');
  if v_n <> 0 then
    raise exception 'P3.D · RT-3: quedan % secuencia(s) con UPDATE (setval): %', v_n, v_cuales using errcode = 'P0001';
  end if;

  -- ...ni USAGE ni SELECT: el correlativo no se toca desde el cliente por ninguna vía.
  select count(*), string_agg(s.sequencename, ', ' order by s.sequencename) into v_n, v_cuales
    from (select (quote_ident(schemaname) || '.' || quote_ident(sequencename))::regclass as oid, sequencename
            from pg_sequences where schemaname = 'public' offset 0) s
   where has_sequence_privilege('authenticated', s.oid, 'USAGE')
      or has_sequence_privilege('authenticated', s.oid, 'SELECT')
      or has_sequence_privilege('anon', s.oid, 'USAGE');
  if v_n <> 0 then
    raise exception 'P3.D · RT-3: quedan % secuencia(s) accesibles: %', v_n, v_cuales using errcode = 'P0001';
  end if;

  -- RT-4: los tres libros marcados quedan sin UPDATE ni DELETE para authenticated.
  select count(*), string_agg(t.relname, ', ' order by t.relname) into v_n, v_cuales
    from (select c2.oid as oid, c2.relname from pg_class c2 join pg_namespace n on n.oid = c2.relnamespace
           where n.nspname = 'public'
             and c2.relname in ('cliente_puntos_movimientos', 'inventory_movements', 'orden_servicio_historial')
           offset 0) t
   where has_table_privilege('authenticated', t.oid, 'UPDATE')
      or has_table_privilege('authenticated', t.oid, 'DELETE');
  if v_n <> 0 then
    raise exception 'P3.D · RT-4: % libro(s) siguen editables: %', v_n, v_cuales using errcode = 'P0001';
  end if;
  -- Y se conserva el INSERT, que es como se escriben.
  if not (has_table_privilege('authenticated', 'public.inventory_movements', 'INSERT')
      and has_table_privilege('authenticated', 'public.cliente_puntos_movimientos', 'INSERT')) then
    raise exception 'P3.D · RT-4: se quitó el INSERT de un libro y eso rompe quien lo escribe' using errcode = 'P0001';
  end if;
end
$migracion$;
