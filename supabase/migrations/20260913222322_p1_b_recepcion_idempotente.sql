-- ============================================================================
-- P1.B — FASE 14. Recepción de compras idempotente, parcial y con incidencias.
--
-- BACKLOG.md daba esta fase por terminada. Es falso. La versión en producción
-- de public.recibir_orden_compra(uuid, jsonb, text) tiene tres defectos
-- estructurales, verificados con pg_get_functiondef contra
-- fbwkclpgnsxuqycazumj:
--
--   1. NO HAY IDEMPOTENCIA. `insert into recepciones_compra(...)` sin ninguna
--      clave de cliente. Un doble POST —el caso normal cuando la respuesta se
--      pierde por timeout DESPUÉS del commit y el usuario reintenta— crea dos
--      recepciones, suma el stock dos veces, avanza cantidad_recibida dos veces
--      y graba dos movimientos de inventario. `recepciones_compra` no tenía
--      NINGÚN índice único fuera de la PK generada.
--
--   2. ROMPE EL INVARIANTE DE STOCK SERIALIZADO (P0.2/P0.4). Para productos con
--      control_serial hacía las dos cosas a la vez: sumaba +cantidad a
--      `inventory` con un delta FIJO y además insertaba las filas en
--      `product_serials`. El invariante cerrado en P0.2 es que el stock
--      serializado se DERIVA de product_serials vía
--      private.sincronizar_stock_serializado, que escribe el delta REAL. La
--      versión vieja escribía un delta fijo por un camino paralelo: si el
--      inventario ya estaba desalineado, la recepción perpetuaba la desviación
--      en vez de corregirla, y ninguna unidad recibida dañada podía quedar
--      fuera del stock vendible.
--
--   3. NO MODELA INCIDENCIAS. `recepcion_compra_items` sólo tenía `cantidad`.
--      Faltante, sobrante, dañado y producto equivocado no existían: la única
--      salida del operario era mentir en la cantidad, y la orden quedaba
--      "recibida" con mercadería que nunca llegó.
--
-- Esta migración es forward-only y no toca ninguna migración ya aplicada.
--
-- ----------------------------------------------------------------------------
-- LECCIÓN DE P0.2 — LAS SOBRECARGAS
-- ----------------------------------------------------------------------------
-- La firma nueva añade un parámetro. `create or replace function` con una
-- lista de parámetros distinta NO reemplaza: crea una SOBRECARGA. Quedarían
-- vivas recibir_orden_compra(uuid,jsonb,text) —la no idempotente— y
-- recibir_orden_compra(uuid,uuid,jsonb,text). PostgREST resolvería por los
-- nombres del body y un cliente viejo, o un atacante que omita
-- p_client_transaction_id, seguiría llegando a la versión duplicadora.
--
-- Por eso aquí se DROPEAN explícitamente TODAS las sobrecargas de
-- public.recibir_orden_compra antes de crear la nueva. La firma de 3
-- argumentos se recrea después como envoltorio de compatibilidad (C2) que
-- DELEGA en la nueva, y al final un DO verifica que quedan exactamente esas
-- dos: la idempotente y el envoltorio, y ninguna otra.
--
-- p_client_transaction_id NO tiene DEFAULT, a propósito. Con default, una
-- llamada de 3 argumentos resolvería a la función nueva con la clave en NULL y
-- volveríamos a no tener idempotencia en silencio. Las llamadas de 3
-- argumentos (frontend anterior a P1 y bundles offline en caché) llegan al
-- envoltorio C2, que genera una clave: pasan por toda la validación nueva y lo
-- único que no obtienen es idempotencia entre reintentos.
--
-- ----------------------------------------------------------------------------
-- PRIVILEGIOS — LECCIÓN DE P0.4 / R8
-- ----------------------------------------------------------------------------
-- En P0.4 una columna nueva nació invisible para `authenticated` porque
-- public.products usa GRANTS POR COLUMNA y `add column` sólo hereda los de
-- TABLA. Verificado para esta migración contra pg_class.relacl y
-- pg_attribute.attacl en producción:
--
--   products                -> relacl awdDxtm + attacl POR COLUMNA (12 columnas)
--   recepciones_compra      -> relacl arwdDxtm para authenticated, attacl NULL
--   recepcion_compra_items  -> relacl arwdDxtm para authenticated, attacl NULL
--
-- Las dos tablas que se amplían aquí usan grant de TABLA, no por columna, así
-- que las columnas nuevas SÍ heredan el SELECT y no hace falta ningún grant
-- adicional. No se añade uno redundante, pero la prueba
-- scripts/verify-recepcion-compras.mjs comprueba la visibilidad real haciendo
-- `set local role authenticated` y seleccionando las columnas nuevas: si
-- alguien convierte esas tablas a grants por columna, la prueba se pone roja.
--
-- La escritura directa sigue cerrada por RLS: recepciones_compra y
-- recepcion_compra_items sólo tienen policy de SELECT (rc_read / rci_read), y
-- RLS sin policy de INSERT/UPDATE/DELETE deniega. Todo pasa por esta RPC, que
-- es SECURITY DEFINER. A `anon` no se le concede nada.
-- ============================================================================


-- ============================================================================
-- 1. ESQUEMA — clave de idempotencia y columnas de incidencia
-- ============================================================================

alter table public.recepciones_compra
  add column if not exists client_transaction_id uuid,
  add column if not exists payload_hash          text,
  add column if not exists corrige_recepcion_id  uuid;

-- Backfill de las recepciones históricas. No se borra ni se altera ninguna:
-- se les asigna una clave propia para poder poner NOT NULL. El hash lleva el
-- prefijo 'legacy:' para que nunca pueda coincidir con un hash md5 calculado
-- por la función (32 hex), y así una recepción vieja jamás se confunda con un
-- reintento de una nueva.
update public.recepciones_compra
   set client_transaction_id = gen_random_uuid()
 where client_transaction_id is null;

update public.recepciones_compra
   set payload_hash = 'legacy:' || id::text
 where payload_hash is null;

alter table public.recepciones_compra
  alter column client_transaction_id set not null,
  alter column payload_hash          set not null;

-- LA garantía dura. Aunque la función tuviera un fallo lógico, aunque dos
-- transacciones simultáneas pasen a la vez el chequeo previo, el índice único
-- impide físicamente la segunda recepción: la segunda sesión se queda
-- esperando el insert especulativo de la primera y, al hacer ésta commit,
-- recibe 23505. La función lo captura y devuelve la recepción ganadora.
create unique index if not exists recepciones_compra_client_txn_key
  on public.recepciones_compra(client_transaction_id);

create index if not exists recepciones_compra_orden_idx
  on public.recepciones_compra(orden_id);

alter table public.recepciones_compra
  drop constraint if exists recepciones_compra_corrige_fkey;
alter table public.recepciones_compra
  add constraint recepciones_compra_corrige_fkey
  foreign key (corrige_recepcion_id) references public.recepciones_compra(id);

-- Una recepción no puede corregirse a sí misma.
alter table public.recepciones_compra
  drop constraint if exists recepciones_compra_corrige_no_self;
alter table public.recepciones_compra
  add constraint recepciones_compra_corrige_no_self
  check (corrige_recepcion_id is null or corrige_recepcion_id <> id);

comment on column public.recepciones_compra.client_transaction_id is
  'Clave de idempotencia generada por el cliente ANTES de enviar. Dos envíos con la misma clave producen una sola recepción y devuelven el mismo resultado.';
comment on column public.recepciones_compra.payload_hash is
  'md5 canónico del payload aceptado. Un reintento con la misma clave pero distinto contenido se RECHAZA en vez de devolver el resultado viejo: devolverlo perdería en silencio una recepción real distinta.';
comment on column public.recepciones_compra.corrige_recepcion_id is
  'Recepción que ésta corrige. Las correcciones son filas NUEVAS; el historial es append-only y nada se borra ni se reescribe.';


alter table public.recepcion_compra_items
  add column if not exists cantidad_danada              int  not null default 0,
  add column if not exists cantidad_faltante            int  not null default 0,
  add column if not exists cantidad_sobrante            int  not null default 0,
  add column if not exists cantidad_producto_equivocado int  not null default 0,
  add column if not exists variant_id_recibido          uuid,
  add column if not exists observacion                  text;

alter table public.recepcion_compra_items
  drop constraint if exists recepcion_compra_items_variant_recibido_fkey;
alter table public.recepcion_compra_items
  add constraint recepcion_compra_items_variant_recibido_fkey
  foreign key (variant_id_recibido) references public.product_variants(id);

-- `cantidad > 0` era correcto cuando una línea sólo podía ser "llegó bien".
-- Ahora una línea legítima puede tener cantidad = 0: llegaron 3 unidades y las
-- 3 venían rotas, o no llegó ninguna y se declara el faltante. Se relaja a
-- >= 0 y se sustituye por una restricción que sigue impidiendo la fila vacía.
alter table public.recepcion_compra_items
  drop constraint if exists recepcion_compra_items_cantidad_check;
alter table public.recepcion_compra_items
  add constraint recepcion_compra_items_cantidad_check check (cantidad >= 0);

alter table public.recepcion_compra_items
  drop constraint if exists recepcion_compra_items_incidencias_no_negativas;
alter table public.recepcion_compra_items
  add constraint recepcion_compra_items_incidencias_no_negativas
  check (cantidad_danada >= 0 and cantidad_faltante >= 0
     and cantidad_sobrante >= 0 and cantidad_producto_equivocado >= 0);

alter table public.recepcion_compra_items
  drop constraint if exists recepcion_compra_items_no_vacia;
alter table public.recepcion_compra_items
  add constraint recepcion_compra_items_no_vacia
  check (cantidad + cantidad_danada + cantidad_faltante + cantidad_producto_equivocado > 0);

-- Producto equivocado y variante recibida van siempre juntos: una cantidad de
-- producto equivocado sin decir QUÉ llegó no sirve para reclamar al proveedor,
-- y una variante recibida con cantidad 0 es ruido.
alter table public.recepcion_compra_items
  drop constraint if exists recepcion_compra_items_equivocado_coherente;
alter table public.recepcion_compra_items
  add constraint recepcion_compra_items_equivocado_coherente
  check ((cantidad_producto_equivocado > 0) = (variant_id_recibido is not null));

comment on column public.recepcion_compra_items.cantidad is
  'Unidades BUENAS aceptadas. Es lo único que entra a inventory. Las demás columnas no suman stock.';
comment on column public.recepcion_compra_items.cantidad_danada is
  'Unidades que llegaron físicamente pero inservibles. NO entran al stock vendible. Si el producto es serializado, sus IMEI se registran en estado cuarentena.';
comment on column public.recepcion_compra_items.cantidad_faltante is
  'Unidades que el proveedor debía enviar y no llegaron. No tocan inventario y dejan la línea pendiente.';
comment on column public.recepcion_compra_items.cantidad_sobrante is
  'DERIVADA por el servidor: exceso físico sobre lo pendiente. Nunca la fija el cliente.';
comment on column public.recepcion_compra_items.cantidad_producto_equivocado is
  'Unidades de OTRO producto que llegaron en lugar del pedido. No entran a inventario: no se stockea automáticamente lo que no se pidió.';


-- ============================================================================
-- 2. HISTORIAL APPEND-ONLY
-- ============================================================================
-- El requisito es que ninguna corrección borre el registro anterior. RLS ya
-- deniega UPDATE/DELETE a `authenticated` (no hay policy para esos comandos),
-- pero RLS no protege frente a una función SECURITY DEFINER propiedad de
-- postgres, que es exactamente por donde pasa todo este flujo. El trigger sí,
-- porque los triggers se ejecutan también para el dueño de la tabla.
--
-- La comparación es sobre la fila ENTERA convertida a jsonb menos la columna
-- permitida, no sobre una lista enumerada de columnas: una columna añadida en
-- el futuro queda protegida automáticamente en vez de abrir un agujero
-- silencioso.
create or replace function private.recepcion_append_only()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'El historial de recepciones es append-only: no se puede borrar %.%', tg_table_schema, tg_table_name
      using errcode = 'P0001';
  end if;

  if tg_table_name = 'recepciones_compra' then
    -- Única mutación permitida: adjuntar el documento escaneado una vez.
    if to_jsonb(new) - 'storage_path' is distinct from to_jsonb(old) - 'storage_path' then
      raise exception 'El historial de recepciones es append-only: para corregir una recepción se registra otra nueva con corrige_recepcion_id, no se reescribe la anterior'
        using errcode = 'P0001';
    end if;
    if old.storage_path is not null and new.storage_path is distinct from old.storage_path then
      raise exception 'El documento de la recepción ya estaba adjunto y no se puede sustituir'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  raise exception 'El historial de recepciones es append-only: no se puede modificar %.%', tg_table_schema, tg_table_name
    using errcode = 'P0001';
end
$function$;

drop trigger if exists recepciones_compra_append_only on public.recepciones_compra;
create trigger recepciones_compra_append_only
  before update or delete on public.recepciones_compra
  for each row execute function private.recepcion_append_only();

drop trigger if exists recepcion_compra_items_append_only on public.recepcion_compra_items;
create trigger recepcion_compra_items_append_only
  before update or delete on public.recepcion_compra_items
  for each row execute function private.recepcion_append_only();


-- ============================================================================
-- 3. HASH CANÓNICO DEL PAYLOAD
-- ============================================================================
-- Huella canónica de las LÍNEAS del envío, construida como jsonb y no como
-- cadena con separadores: una observación que contuviera ':' o '|' podía hacer
-- que dos envíos DISTINTOS produjeran la misma cadena y se tomaran por el mismo,
-- que es justo el fallo que esta huella existe para impedir. Líneas ordenadas
-- por orden_item_id y seriales por número, para que el orden de envío no cambie
-- la identidad. Cantidades normalizadas con trim_scale (3 y 3.0 son lo mismo)
-- SIN castear a entero: un "2.5" ya no revienta aquí.
--
-- B1: la huella anterior ignoraba acepta_sobrante, la observación de línea e
-- imei2, así que la misma clave con esos campos cambiados se devolvía como
-- reintento y el cambio se perdía sin error. Ahora entran todos. Los campos de
-- CABECERA (observación general y recepción corregida) se combinan en la RPC.
create or replace function private.hash_recepcion(p_orden_id uuid, p_items jsonb)
returns text
language sql
immutable
as $function$
  select md5(jsonb_build_object(
    'orden_id', p_orden_id,
    'lineas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'orden_item_id',                e->>'orden_item_id',
               'cantidad',                     trim_scale(coalesce(nullif(e->>'cantidad', '')::numeric, 0)),
               'cantidad_danada',              trim_scale(coalesce(nullif(e->>'cantidad_danada', '')::numeric, 0)),
               'cantidad_faltante',            trim_scale(coalesce(nullif(e->>'cantidad_faltante', '')::numeric, 0)),
               'cantidad_producto_equivocado', trim_scale(coalesce(nullif(e->>'cantidad_producto_equivocado', '')::numeric, 0)),
               'variant_id_recibido',          nullif(e->>'variant_id_recibido', ''),
               'acepta_sobrante',              coalesce((e->>'acepta_sobrante')::boolean, false),
               'observacion',                  nullif(btrim(coalesce(e->>'observacion', '')), ''),
               'seriales', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'serial_number', btrim(s->>'serial_number'),
                          'imei2',         nullif(btrim(coalesce(s->>'imei2', '')), ''),
                          'danado',        coalesce((s->>'danado')::boolean, false))
                        order by btrim(s->>'serial_number'))
                 from jsonb_array_elements(coalesce(e->'seriales', '[]'::jsonb)) s
               ), '[]'::jsonb))
             order by e->>'orden_item_id')
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) e
    ), '[]'::jsonb)
  )::text)
$function$;


-- ============================================================================
-- 4. RESULTADO RECONSTRUIDO DESDE LA BASE
-- ============================================================================
-- "El doble envío devuelve el MISMO resultado" no se consigue recordando lo
-- que se devolvió: se consigue no calculando nada en la respuesta. Esta
-- función lee las filas ya escritas, que son append-only, así que la primera
-- llamada y el reintento ejecutan LA MISMA consulta sobre LAS MISMAS filas
-- inmutables. La igualdad es estructural, no una coincidencia que haya que
-- mantener a mano.
--
-- Deliberadamente NO incluye el estado de la orden: entre el envío original y
-- el reintento puede haber entrado una recepción distinta y legítima que lo
-- cambie de 'parcial' a 'recibida'. Incluirlo haría que el resultado del
-- reintento difiriera por algo que no es de esta recepción. La UI refresca la
-- orden aparte.
create or replace function private.recepcion_resultado(p_recepcion_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'private'
as $function$
  select jsonb_build_object(
    'recepcion_id',           r.id,
    'client_transaction_id',  r.client_transaction_id,
    'orden_id',               r.orden_id,
    'recibido_por',           r.recibido_por,
    'corrige_recepcion_id',   r.corrige_recepcion_id,
    'lineas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'recepcion_item_id',            ri.id,
               'orden_item_id',                ri.orden_item_id,
               'cantidad',                     ri.cantidad,
               'cantidad_danada',              ri.cantidad_danada,
               'cantidad_faltante',            ri.cantidad_faltante,
               'cantidad_sobrante',            ri.cantidad_sobrante,
               'cantidad_producto_equivocado', ri.cantidad_producto_equivocado,
               'variant_id_recibido',          ri.variant_id_recibido,
               'observacion',                  ri.observacion,
               'seriales', coalesce((
                 select jsonb_agg(ps.serial_number order by ps.serial_number)
                 from public.product_serials ps
                 where ps.recepcion_item_id = ri.id
               ), '[]'::jsonb)
             ) order by ri.orden_item_id)
      from public.recepcion_compra_items ri
      where ri.recepcion_id = r.id
    ), '[]'::jsonb),
    'incidencias', (
      select coalesce(sum(ri.cantidad_danada + ri.cantidad_faltante
                        + ri.cantidad_sobrante + ri.cantidad_producto_equivocado), 0)
      from public.recepcion_compra_items ri
      where ri.recepcion_id = r.id
    )
  )
  from public.recepciones_compra r
  where r.id = p_recepcion_id
$function$;


-- ============================================================================
-- 5. LA RPC
-- ============================================================================
-- Se dropean TODAS las sobrecargas antes de crear, incluida la firma de 3
-- argumentos que existe en producción. Esa firma se recrea más abajo como
-- envoltorio de compatibilidad (C2). Ojo: como el DROP la elimina, sus grants
-- también desaparecen, y por eso se reaplican explícitamente tras recrearla.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as firma
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'recibir_orden_compra'
  loop
    execute format('drop function %s', f.firma);
  end loop;
end $$;

-- Devolver un reintento no es sólo leer la fila: hay que comprobar que el
-- reintento es realmente el MISMO envío. Se separa en su propia función para
-- que los tres puntos de reentrada de la RPC (camino rápido, relectura bajo
-- lock y captura de 23505) no puedan divergir.
create or replace function private.recepcion_replay(
  p_rec       public.recepciones_compra,
  p_orden_id  uuid,
  p_hash      text,
  p_staff_id  uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'private'
as $function$
begin
  -- Reutilizar una clave contra OTRA orden es un fallo del cliente o un
  -- replay: nunca se devuelve el resultado de una orden distinta.
  if p_rec.orden_id is distinct from p_orden_id then
    raise exception 'El client_transaction_id % ya se usó en la orden %, no en la %',
      p_rec.client_transaction_id, p_rec.orden_id, p_orden_id using errcode = 'P0001';
  end if;

  -- B2 · la misma clave presentada por OTRA persona no devuelve su resultado:
  -- sólo quien hizo el envío original puede recibirlo como reintento.
  if p_rec.recibido_por is distinct from p_staff_id then
    raise exception 'Ese client_transaction_id ya lo usó otra persona. Genera una clave nueva.'
      using errcode = 'P0001';
  end if;

  -- Misma clave, contenido distinto. Devolver el resultado viejo haría
  -- desaparecer en silencio una recepción real diferente; se rechaza.
  if p_rec.payload_hash is distinct from p_hash then
    raise exception 'El client_transaction_id % ya se registró con un contenido distinto. Genera una clave nueva para una recepción distinta.',
      p_rec.client_transaction_id using errcode = 'P0001';
  end if;

  return private.recepcion_resultado(p_rec.id) || jsonb_build_object('reintento', true);
end
$function$;


create function public.recibir_orden_compra(
  p_orden_id               uuid,
  p_client_transaction_id  uuid,
  p_items                  jsonb,
  p_observacion            text default null,
  p_corrige_recepcion_id   uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_staff         public.staff;
  v_orden         public.ordenes_compra;
  v_rec           public.recepciones_compra;
  v_item          public.orden_compra_items;
  v_hash          text;
  v_gano          boolean := false;
  e               jsonb;
  s               jsonb;
  v_pend          int;
  v_buenas        int;
  v_danadas       int;
  v_faltante      int;
  v_equiv         int;
  v_sobrante      int;
  v_aplicado      int;
  v_fisicas       int;
  v_control       boolean;
  v_is_test       boolean;
  v_product       uuid;
  v_seriales      jsonb;
  v_n_ser         int;
  v_n_dan         int;
  v_ri            uuid;
  v_variant_eq    uuid;
  v_delta         int;
  v_vistos        uuid[] := '{}';
  v_pendientes    int;
  v_serial        text;
begin
  ------------------------------------------------------------------------
  -- 5.1 Clave de idempotencia: obligatoria y primero que nada.
  ------------------------------------------------------------------------
  if p_client_transaction_id is null then
    raise exception 'La recepción requiere client_transaction_id: sin clave de idempotencia un reintento duplicaría stock, costo, documento, serial y movimiento'
      using errcode = 'P0001';
  end if;
  if p_orden_id is null then
    raise exception 'Orden inválida' using errcode = 'P0001';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Recepción vacía' using errcode = 'P0001';
  end if;

  ------------------------------------------------------------------------
  -- 5.2 Identidad y permiso. Se mantiene EXACTAMENTE la regla que ya estaba
  -- en producción: mismo conjunto de roles y misma restricción de sucursal.
  -- Esta migración no relaja ni amplía permisos.
  ------------------------------------------------------------------------
  select * into v_staff from public.staff where user_id = auth.uid() and activo = true limit 1;
  if v_staff.id is null
     or not (v_staff.rol = 'administrador' or coalesce(v_staff.puesto, '') in ('tecnico','encargado','jefa')) then
    raise exception 'Sin permiso para recibir compras' using errcode = 'P0001';
  end if;

  -- Huella del envío COMPLETO, calculada ya con identidad y permiso comprobados:
  -- antes se evaluaba la entrada de cualquiera, autorizado o no (B5). El helper
  -- cubre las líneas; aquí se añaden los campos de cabecera, que también forman
  -- parte de la identidad del envío (B1): la misma clave con otra observación
  -- general, o marcada ahora como corrección, no es un reintento. Se combina en
  -- jsonb y no concatenando, para que ningún texto libre pueda hacer que dos
  -- envíos distintos compartan huella.
  v_hash := md5(jsonb_build_object(
    'lineas',               private.hash_recepcion(p_orden_id, p_items),
    'observacion',          nullif(btrim(coalesce(p_observacion, '')), ''),
    'corrige_recepcion_id', p_corrige_recepcion_id
  )::text);

  ------------------------------------------------------------------------
  -- 5.3 CAMINO RÁPIDO DEL REINTENTO.
  -- El caso que hoy duplica en producción: la transacción hizo commit, la
  -- respuesta se perdió y el usuario reintenta. Aquí se resuelve sin tocar
  -- NADA y sin tomar ningún lock.
  ------------------------------------------------------------------------
  select * into v_rec from public.recepciones_compra
   where client_transaction_id = p_client_transaction_id;
  if v_rec.id is not null then
    return private.recepcion_replay(v_rec, p_orden_id, v_hash, v_staff.id);
  end if;

  ------------------------------------------------------------------------
  -- 5.4 Punto de serialización: la cabecera de la orden.
  ------------------------------------------------------------------------
  select * into v_orden from public.ordenes_compra where id = p_orden_id for update;
  -- Fallo CERRADO. `<>` con la sucursal del operador NULL da NULL, el IF no
  -- salta y cualquiera sin sucursal recibiría órdenes de cualquier sucursal (T1).
  if v_orden.id is null or v_staff.location_id is null
     or v_orden.location_id is distinct from v_staff.location_id then
    raise exception 'Orden inválida o de otra sucursal' using errcode = 'P0001';
  end if;

  -- Relectura BAJO el lock. Bajo READ COMMITTED cada sentencia toma su propio
  -- snapshot, así que si una sesión concurrente con la MISMA clave hizo commit
  -- mientras esperábamos el lock, aquí sí la vemos. Es la misma clase de
  -- carrera que R6, resuelta bloqueando antes de decidir.
  select * into v_rec from public.recepciones_compra
   where client_transaction_id = p_client_transaction_id;
  if v_rec.id is not null then
    return private.recepcion_replay(v_rec, p_orden_id, v_hash, v_staff.id);
  end if;

  if v_orden.estado in ('recibida','cancelada') then
    raise exception 'Orden no recepcionable (estado %)', v_orden.estado using errcode = 'P0001';
  end if;

  if p_corrige_recepcion_id is not null
     and not exists (select 1 from public.recepciones_compra
                      where id = p_corrige_recepcion_id and orden_id = v_orden.id) then
    raise exception 'La recepción que se pretende corregir no pertenece a esta orden' using errcode = 'P0001';
  end if;

  ------------------------------------------------------------------------
  -- 5.5 Inserción de la cabecera con la clave única.
  -- Si dos sesiones llegan aquí a la vez (sólo posible si el lock de la orden
  -- no las serializó), la segunda se queda esperando el insert especulativo de
  -- la primera y recibe 23505 al hacer ésta commit. El bloque EXCEPTION crea
  -- un savepoint implícito: al capturarla se deshace SÓLO este insert, el lock
  -- de fila sobre la orden sigue en pie, y se devuelve la recepción ganadora.
  -- El índice único es la garantía real; el chequeo previo es sólo el camino
  -- rápido.
  ------------------------------------------------------------------------
  begin
    insert into public.recepciones_compra
      (orden_id, recibido_por, observacion, client_transaction_id, payload_hash, corrige_recepcion_id)
    values
      (v_orden.id, v_staff.id, nullif(btrim(p_observacion), ''), p_client_transaction_id, v_hash, p_corrige_recepcion_id)
    returning * into v_rec;
    v_gano := true;
  exception when unique_violation then
    v_gano := false;
  end;

  if not v_gano then
    select * into v_rec from public.recepciones_compra
     where client_transaction_id = p_client_transaction_id;
    if v_rec.id is null then
      -- Unique violation que no viene de la clave de idempotencia: no la
      -- tragamos.
      raise exception 'Conflicto de unicidad al registrar la recepción' using errcode = 'P0001';
    end if;
    return private.recepcion_replay(v_rec, p_orden_id, v_hash, v_staff.id);
  end if;

  ------------------------------------------------------------------------
  -- 5.6 Líneas.
  ------------------------------------------------------------------------
  for e in select * from jsonb_array_elements(p_items) loop

    select * into v_item from public.orden_compra_items
     where id = (e->>'orden_item_id')::uuid and orden_id = v_orden.id
     for update;
    if v_item.id is null then
      raise exception 'Línea inválida o de otra orden: %', coalesce(e->>'orden_item_id','(null)') using errcode = 'P0001';
    end if;

    -- Una línea repetida dentro del mismo payload sumaría dos veces bajo el
    -- mismo hash: se rechaza.
    if v_item.id = any (v_vistos) then
      raise exception 'La línea % aparece dos veces en la misma recepción', v_item.id using errcode = 'P0001';
    end if;
    v_vistos := v_vistos || v_item.id;

    v_buenas   := greatest(coalesce((e->>'cantidad')::int, 0), 0);
    v_danadas  := greatest(coalesce((e->>'cantidad_danada')::int, 0), 0);
    v_faltante := greatest(coalesce((e->>'cantidad_faltante')::int, 0), 0);
    v_equiv    := greatest(coalesce((e->>'cantidad_producto_equivocado')::int, 0), 0);
    v_variant_eq := nullif(e->>'variant_id_recibido','')::uuid;

    if v_buenas + v_danadas + v_faltante + v_equiv = 0 then
      raise exception 'La línea % no declara ninguna cantidad', v_item.id using errcode = 'P0001';
    end if;
    if (v_equiv > 0) <> (v_variant_eq is not null) then
      raise exception 'Producto equivocado: hay que declarar a la vez la cantidad y la variante que llegó (línea %)', v_item.id
        using errcode = 'P0001';
    end if;
    if v_variant_eq is not null then
      if v_variant_eq = v_item.variant_id then
        raise exception 'La variante declarada como equivocada es la misma que se pidió (línea %)', v_item.id using errcode = 'P0001';
      end if;
      if not exists (select 1 from public.product_variants where id = v_variant_eq) then
        raise exception 'La variante recibida por equivocación no existe: %', v_variant_eq using errcode = 'P0001';
      end if;
    end if;

    -- P0.4: el catálogo de prueba no entra en ningún consumidor operativo, y
    -- una recepción escribe inventario, movimientos e historial de costo.
    select p.control_serial, p.is_test, p.id
      into v_control, v_is_test, v_product
      from public.product_variants pv
      join public.products p on p.id = pv.product_id
     where pv.id = v_item.variant_id;
    if coalesce(v_is_test, false) then
      raise exception 'No se puede recibir mercadería contra un producto marcado como de prueba (is_test)' using errcode = 'P0001';
    end if;

    v_pend    := greatest(v_item.cantidad_pedida - v_item.cantidad_recibida, 0);
    v_fisicas := v_buenas + v_danadas;

    -- SOBRANTE. Derivado por el servidor; el cliente no lo declara y por tanto
    -- no lo puede falsear. Si hay exceso, hace falta aceptación explícita: un
    -- dedazo (100 en vez de 10) no puede inflar stock en silencio, que es
    -- justo lo que la versión vieja convertía en un error duro sin matices.
    v_sobrante := greatest(v_fisicas - v_pend, 0);
    if v_sobrante > 0 and not coalesce((e->>'acepta_sobrante')::boolean, false) then
      raise exception 'Llegaron % unidades y sólo quedaban % pendientes en la línea %. Si el sobrante es real, reenvía la línea con acepta_sobrante = true.',
        v_fisicas, v_pend, v_item.id using errcode = 'P0001';
    end if;

    -- Lo que AVANZA la orden son únicamente las unidades buenas, y nunca por
    -- encima de lo pendiente: orden_compra_items tiene el CHECK
    -- cantidad_recibida <= cantidad_pedida y no se toca. Lo dañado, lo
    -- faltante y lo equivocado dejan la línea pendiente a propósito: son
    -- reclamos al proveedor, no mercadería recibida.
    v_aplicado := least(v_buenas, v_pend);

    ----------------------------------------------------------------
    -- Seriales / IMEI exactos.
    ----------------------------------------------------------------
    v_seriales := coalesce(e->'seriales', '[]'::jsonb);
    if jsonb_typeof(v_seriales) <> 'array' then
      raise exception 'El campo seriales de la línea % no es una lista', v_item.id using errcode = 'P0001';
    end if;
    select count(*)::int,
           count(*) filter (where coalesce((s2->>'danado')::boolean, false))::int
      into v_n_ser, v_n_dan
      from jsonb_array_elements(v_seriales) s2;

    if coalesce(v_control, false) then
      -- Exactitud: un IMEI por unidad que LLEGÓ (buena o dañada). Ni lo
      -- faltante ni lo equivocado aportan seriales de esta variante.
      if v_n_ser <> v_fisicas then
        raise exception 'La línea % requiere exactamente % IMEI/serie (% buenas + % dañadas) y llegaron %',
          v_item.id, v_fisicas, v_buenas, v_danadas, v_n_ser using errcode = 'P0001';
      end if;
      if v_n_dan <> v_danadas then
        raise exception 'La línea % declara % unidades dañadas pero marca % IMEI como dañados',
          v_item.id, v_danadas, v_n_dan using errcode = 'P0001';
      end if;
      if exists (
        select 1 from jsonb_array_elements(v_seriales) s2
        group by btrim(s2->>'serial_number') having count(*) > 1) then
        raise exception 'Hay IMEI/serie repetidos dentro de la línea %', v_item.id using errcode = 'P0001';
      end if;
    elsif v_n_ser > 0 then
      raise exception 'La línea % no es de un producto con IMEI/serie y trae seriales', v_item.id using errcode = 'P0001';
    end if;

    ----------------------------------------------------------------
    -- Documento de la línea. Append-only: se inserta, nunca se reescribe.
    ----------------------------------------------------------------
    insert into public.recepcion_compra_items
      (recepcion_id, orden_item_id, cantidad, costo_unitario,
       cantidad_danada, cantidad_faltante, cantidad_sobrante,
       cantidad_producto_equivocado, variant_id_recibido, observacion)
    values
      (v_rec.id, v_item.id, v_buenas, v_item.costo_unitario,
       v_danadas, v_faltante, v_sobrante,
       v_equiv, v_variant_eq, nullif(btrim(e->>'observacion'), ''))
    returning id into v_ri;

    if v_aplicado > 0 then
      update public.orden_compra_items
         set cantidad_recibida = cantidad_recibida + v_aplicado
       where id = v_item.id;
    end if;

    ----------------------------------------------------------------
    -- Inventario.
    ----------------------------------------------------------------
    if coalesce(v_control, false) then
      -- INVARIANTE P0.2/P0.4. No se toca `inventory` ni se escribe el
      -- movimiento a mano: se insertan los seriales y se DERIVA el stock de
      -- product_serials. sincronizar_stock_serializado bloquea la fila
      -- agregada, cuenta los 'disponible' y registra el delta REAL.
      -- Las unidades dañadas entran como 'cuarentena', así que existen,
      -- quedan trazadas contra el proveedor y NO cuentan como stock vendible.
      for s in select * from jsonb_array_elements(v_seriales) loop
        v_serial := btrim(s->>'serial_number');
        if v_serial is null or v_serial = '' then
          raise exception 'IMEI/serie vacío en la línea %', v_item.id using errcode = 'P0001';
        end if;
        if exists (select 1 from public.product_serials where serial_number = v_serial) then
          raise exception 'El IMEI/serie % ya está registrado', v_serial using errcode = 'P0001';
        end if;
        insert into public.product_serials
          (variant_id, location_id, serial_number, imei2, estado, recepcion_item_id)
        values
          (v_item.variant_id, v_orden.location_id, v_serial,
           nullif(btrim(s->>'imei2'), ''),
           case when coalesce((s->>'danado')::boolean, false) then 'cuarentena' else 'disponible' end,
           v_ri);
      end loop;

      if v_fisicas > 0 then
        v_delta := private.sincronizar_stock_serializado(
                     v_item.variant_id, v_orden.location_id, v_staff.id,
                     'Recepción compra #' || v_orden.numero);
      end if;
    else
      if v_buenas > 0 then
        insert into public.inventory (variant_id, location_id, cantidad, updated_at)
        values (v_item.variant_id, v_orden.location_id, v_buenas, now())
        on conflict (variant_id, location_id)
          do update set cantidad = public.inventory.cantidad + excluded.cantidad, updated_at = now();

        -- Delta REAL de esta recepción: las unidades buenas. Lo dañado, lo
        -- faltante y lo equivocado no mueven stock y por tanto no generan
        -- movimiento: un movimiento por cantidad "recibida" incluyendo lo que
        -- no entró sería exactamente el delta fijo que P0.2 prohibió.
        insert into public.inventory_movements
          (variant_id, location_id, cantidad_delta, motivo, staff_id)
        values
          (v_item.variant_id, v_orden.location_id, v_buenas,
           left('Recepción compra #' || v_orden.numero, 250), v_staff.id);
      end if;
    end if;

    ----------------------------------------------------------------
    -- Historial de costo de compra. Append-only y atado a la recepción:
    -- como la recepción es única por client_transaction_id, estas filas se
    -- escriben exactamente una vez por envío. El costo es SIEMPRE el de la
    -- orden; el cliente no puede inyectar uno.
    ----------------------------------------------------------------
    if v_buenas > 0 then
      insert into public.historial_costos_compra
        (product_id, variant_id, proveedor_id, orden_id, recepcion_id, costo_unitario, cantidad)
      values
        (v_product, v_item.variant_id, v_orden.proveedor_id, v_orden.id, v_rec.id,
         v_item.costo_unitario, v_buenas);
    end if;

  end loop;

  ------------------------------------------------------------------------
  -- 5.7 Estado de la orden.
  ------------------------------------------------------------------------
  select count(*) into v_pendientes
    from public.orden_compra_items
   where orden_id = v_orden.id and cantidad_recibida < cantidad_pedida;

  update public.ordenes_compra
     set estado = case when v_pendientes = 0 then 'recibida' else 'parcial' end,
         updated_at = now()
   where id = v_orden.id;

  return private.recepcion_resultado(v_rec.id) || jsonb_build_object('reintento', false);
end
$function$;


-- ============================================================================
-- 6. PRIVILEGIOS
-- ============================================================================
revoke all on function public.recibir_orden_compra(uuid, uuid, jsonb, text, uuid) from public;
revoke all on function public.recibir_orden_compra(uuid, uuid, jsonb, text, uuid) from anon;
grant execute on function public.recibir_orden_compra(uuid, uuid, jsonb, text, uuid) to authenticated;
grant execute on function public.recibir_orden_compra(uuid, uuid, jsonb, text, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- C2 · compatibilidad hacia atrás con la firma de 3 argumentos.
--
-- El frontend desplegado antes de P1 llama a recibir_orden_compra(p_orden_id,
-- p_items, p_observacion). Esa función ya existe en producción e inserta en
-- recepciones_compra SIN client_transaction_id ni payload_hash; como esta
-- migración pone ambas columnas NOT NULL, tras migrar fallaría con una
-- violación de not-null en la primera recepción. Y como el POS funciona
-- offline, un bundle viejo en caché puede seguir llamándola durante días.
--
-- Se recrea con la MISMA identidad (uuid, jsonb, text) y el mismo tipo de
-- retorno, así que para los clientes es la misma función. Ojo: el bloque DO de
-- arriba ya borró todas las sobrecargas, de modo que esto es una creación nueva
-- —nace con EXECUTE para PUBLIC y sin los grants de producción—; por eso lleva
-- revoke/grant explícitos debajo. Es un envoltorio que delega en la versión
-- nueva con una clave generada. El payload
-- viejo ({orden_item_id, cantidad, seriales}) es un subconjunto del que acepta
-- la nueva. Toda la validación (permisos, sucursal, estado de la orden, IMEI,
-- stock, costo) ocurre dentro de la nueva: el envoltorio no decide nada.
--
-- `p_observacion` lleva `default null` a propósito: CREATE OR REPLACE falla si
-- QUITA un default que la función existente tuviera, pero añadirlo es seguro
-- en cualquier caso.
--
-- Por esta vía se pierde sólo la idempotencia, que es exactamente el
-- comportamiento previo a P1. Deuda P2: retirarla cuando no quede en caché
-- ningún bundle anterior a P1.
-- ----------------------------------------------------------------------------
create or replace function public.recibir_orden_compra(
  p_orden_id    uuid,
  p_items       jsonb,
  p_observacion text default null
)
returns public.recepciones_compra
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_res jsonb;
  v_rec public.recepciones_compra;
begin
  v_res := public.recibir_orden_compra(p_orden_id, gen_random_uuid(), p_items, p_observacion, null::uuid);
  select * into v_rec from public.recepciones_compra where id = (v_res->>'recepcion_id')::uuid;
  return v_rec;
end
$function$;

revoke all on function public.recibir_orden_compra(uuid, jsonb, text) from public;
revoke all on function public.recibir_orden_compra(uuid, jsonb, text) from anon;
grant execute on function public.recibir_orden_compra(uuid, jsonb, text) to authenticated;

-- Las auxiliares viven en `private`, al que anon/authenticated no tienen USAGE.
revoke all on function private.hash_recepcion(uuid, jsonb) from public;
revoke all on function private.recepcion_resultado(uuid) from public;
revoke all on function private.recepcion_replay(public.recepciones_compra, uuid, text, uuid) from public;
revoke all on function private.recepcion_append_only() from public;


-- ============================================================================
-- 7. VERIFICACIÓN EN LA PROPIA MIGRACIÓN
-- ============================================================================
-- Si algo de lo anterior no quedó como se pretende, la migración falla aquí y
-- no se aplica a medias.
do $$
declare n int;
begin
  -- C2: la firma de 3 argumentos se conserva a propósito como envoltorio de
  -- compatibilidad (frontend desplegado y bundles offline en caché). Lo que la
  -- lección de P0.2 prohíbe es una sobrecarga NO prevista, así que se exigen
  -- exactamente estas dos. Nota: la versión original de esta comprobación exigía
  -- 1, y contra producción —donde la firma de 3 args ya existe— habría dado 2 y
  -- abortado el deploy, porque el DROP que presuponía nunca se escribió.
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'recibir_orden_compra';
  if n <> 2 then
    raise exception 'Quedaron % versiones de public.recibir_orden_compra; se esperaban exactamente 2 (la idempotente y el envoltorio de compatibilidad)', n;
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = 'recibir_orden_compra'
       and pg_get_function_identity_arguments(p.oid) =
           'p_orden_id uuid, p_client_transaction_id uuid, p_items jsonb, p_observacion text, p_corrige_recepcion_id uuid'
  ) then
    raise exception 'La firma idempotente de public.recibir_orden_compra no es la esperada';
  end if;

  -- El envoltorio no puede conservar la lógica vieja que duplicaba: sólo delega.
  if not exists (
    select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = 'recibir_orden_compra'
       and pg_get_function_identity_arguments(p.oid) = 'p_orden_id uuid, p_items jsonb, p_observacion text'
       and p.prosrc ~* 'recibir_orden_compra\s*\('
       and p.prosrc !~* 'insert\s+into'
  ) then
    raise exception 'La firma de 3 argumentos de public.recibir_orden_compra no es el envoltorio que delega (conserva lógica propia o no existe)';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace,
         lateral aclexplode(p.proacl) a join pg_roles r on r.oid = a.grantee
     where ns.nspname = 'public' and p.proname = 'recibir_orden_compra' and r.rolname = 'anon'
  ) then
    raise exception 'anon no puede tener EXECUTE sobre recibir_orden_compra (P0.4 / migración D)';
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'recepciones_compra_client_txn_key'
  ) then
    raise exception 'Falta el índice único de idempotencia recepciones_compra_client_txn_key';
  end if;

  if exists (select 1 from public.recepciones_compra where client_transaction_id is null) then
    raise exception 'Quedaron recepciones sin client_transaction_id';
  end if;
end $$;
