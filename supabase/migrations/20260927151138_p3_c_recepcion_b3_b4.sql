-- ============================================================================
-- P3.C — B3 y B4 de la recepción de compras.
--
-- Deuda registrada en docs/agents/CURRENT_EXECUTION.md (tabla de defectos de
-- `_p1_b`, líneas ~478-479):
--
--   B3 · P2 funcional — «Una orden recibida no admite correcciones y una
--        corrección sólo puede sumar.»
--   B4 · P2 funcional — «Lo faltante deja la orden en `parcial` para siempre;
--        no hay cierre con faltantes (misma clase que T3).»
--
-- AUDITORÍA DE LA VERSIÓN VIGENTE (confirmada, no desmentida)
-- ----------------------------------------------------------------------------
-- La definición viva de public.recibir_orden_compra(uuid,uuid,jsonb,text,uuid)
-- es la de 20260913225428_p2_i_capacidades_funciones.sql:442-796 (idéntica a la
-- de 20260913222322_p1_b_recepcion_idempotente.sql:421-780 salvo las dos
-- sustituciones mecánicas de _p2_b y _p2_i).
--
--   B3 primera mitad — 20260913225428:549-551
--        if v_orden.estado in ('recibida','cancelada') then
--          raise exception 'Orden no recepcionable (estado %)' ...
--     La guarda se evalúa ANTES y AL MARGEN de p_corrige_recepcion_id. Una
--     orden completa no admite NINGUNA corrección: si se descubre al día
--     siguiente que dos de las diez unidades venían rotas, el sistema no tiene
--     dónde anotarlo. La validación de corrección (553-557) queda muerta para
--     toda orden ya recibida.
--
--   B3 segunda mitad — 20260913225428:708-712
--        update public.orden_compra_items
--           set cantidad_recibida = cantidad_recibida + v_aplicado
--     `+` y sólo `+`. Con `v_buenas := greatest(..., 0)` (610) y el CHECK
--     `cantidad >= 0` de recepcion_compra_items (20260913222322:162) no existe
--     ninguna ruta que reste. Una corrección sólo puede sumar: lo registrado de
--     más es irreversible.
--
--   B4 — 20260913225428:784-791
--        select count(*) into v_pendientes
--          from public.orden_compra_items
--         where orden_id = v_orden.id and cantidad_recibida < cantidad_pedida;
--        update public.ordenes_compra
--           set estado = case when v_pendientes = 0 then 'recibida' else 'parcial' end
--     El estado es una FUNCIÓN PURA de las cantidades. `cantidad_faltante` se
--     guarda (20260913222322:143) pero no participa: una línea con faltante
--     definitivo mantiene `cantidad_recibida < cantidad_pedida` para siempre y
--     la orden queda en 'parcial' para siempre. No hay parámetro de cierre —
--     compárese con public.recibir_transferencia_parcial(..., p_cerrar boolean
--     default false) en 20260913225428:799, que sí lo tiene. Es la misma clase
--     que T3.
--
-- ----------------------------------------------------------------------------
-- DISEÑO
-- ----------------------------------------------------------------------------
-- B4 · CIERRE EXPLÍCITO — RPC propia, no un argumento más.
--   Cerrar con faltantes NO es recibir. Un argumento `p_cerrar` en
--   recibir_orden_compra obligaría a inventar una línea para cerrar una orden a
--   la que ya no va a llegar nada (p_items no admite lista vacía:
--   20260913225428:488), y mezclaría dos actos con auditorías distintas bajo una
--   sola clave de idempotencia. Se añade
--   public.cerrar_orden_compra_con_faltantes(uuid, uuid, text), con su propia
--   clave de idempotencia, su propia huella de contenido y su propio motivo
--   obligatorio. La firma de recibir_orden_compra NO cambia: no hay DROP, no hay
--   reposición de privilegios, no hay ventana en la que PostgREST resuelva a una
--   versión vieja (lección P0.2).
--
--   Estado nuevo 'cerrada', terminal como 'recibida'. NO se reutiliza
--   'recibida' —diría que llegó todo, que es falso— ni 'cancelada' —diría que no
--   llegó nada—. El faltante queda visible como lo que es: una orden cerrada con
--   deuda del proveedor.
--
-- B3 · CORRECCIÓN SOBRE ORDEN TERMINADA Y CORRECCIÓN QUE RESTA.
--   1. La guarda de estado deja de ser ciega: 'cancelada' sigue cerrada a todo,
--      pero una orden 'recibida' o 'cerrada' admite una recepción marcada como
--      corrección (p_corrige_recepcion_id no nulo). Sin esa marca el rechazo se
--      mantiene, con el mismo texto 'Orden no recepcionable' de siempre más la
--      indicación de cómo rectificar.
--   2. Las líneas aceptan `cantidad_revertida` (y `seriales_revertidos` para
--      producto con IMEI): unidades BUENAS que la recepción corregida registró y
--      que en realidad no entraron. Restan de cantidad_recibida, restan de
--      inventory, escriben un movimiento con delta NEGATIVO real y una fila de
--      historial de costo con cantidad negativa. Nada se reescribe ni se borra:
--      el documento anterior queda intacto y la corrección es una fila nueva.
--
--   Límite duro de la reversión: `private.recepcion_revertible` sólo deja
--   revertir lo que la recepción corregida aportó en esa línea MENOS lo ya
--   revertido por correcciones anteriores. Dos correcciones no pueden restar dos
--   veces la misma unidad, y una corrección no puede restar unidades que trajo
--   otra recepción.
--
-- ----------------------------------------------------------------------------
-- LO QUE NO SE TOCA (requisitos innegociables del encargo)
-- ----------------------------------------------------------------------------
--   · Firma exacta de recibir_orden_compra(uuid,uuid,jsonb,text,uuid).
--   · SECURITY DEFINER + SET search_path TO 'public','private'.
--   · private.tiene_capacidad('operar_inventario').
--   · Fallo CERRADO de sucursal: private.auth_location_id() is null or ... is
--     distinct from ...
--   · Clave de idempotencia obligatoria con huella de contenido.
--   · Append-only de recepciones_compra y recepcion_compra_items.
--   · CHECK cantidad_recibida <= cantidad_pedida de orden_compra_items.
--   · Rechazo de productos is_test.
--   · private.hash_recepcion NO se redefine (pertenece al AGENTE 1). Los campos
--     de reversión entran a la huella por private.hash_recepcion_reversion, que
--     es nueva, y se combinan en la RPC igual que ya se combinan los de
--     cabecera.
--
-- COMPATIBILIDAD DE LA HUELLA. Un payload que no declara reversión produce
-- EXACTAMENTE el mismo md5 que antes de esta migración: la clave 'reversion' se
-- añade al objeto sólo cuando hay reversión real. Así un reintento que cruce el
-- despliegue —envío antes, reintento después— se sigue reconociendo como
-- reintento en vez de rechazarse por contenido distinto.
-- ============================================================================


-- ============================================================================
-- 1. ESQUEMA
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1.1 Estado 'cerrada' en ordenes_compra.
-- El CHECK nació en línea dentro del CREATE TABLE
-- (20260824133109_suppliers_purchase_orders_and_receipts.sql:7), así que su
-- nombre lo puso PostgreSQL. Se localiza por su definición en vez de confiar en
-- el nombre: si alguien lo hubiera recreado con otro, esto lo encuentra igual y
-- no deja dos constraints contradictorios.
-- ----------------------------------------------------------------------------
do $$
declare c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid
      join pg_namespace ns on ns.oid = cl.relnamespace
     where ns.nspname = 'public' and cl.relname = 'ordenes_compra'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ~ 'borrador'
  loop
    execute format('alter table public.ordenes_compra drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.ordenes_compra
  add constraint ordenes_compra_estado_check
  check (estado in ('borrador','enviada','parcial','recibida','cancelada','cerrada'));

alter table public.ordenes_compra
  add column if not exists cerrada_por                  uuid references public.staff(id),
  add column if not exists cerrada_at                   timestamptz,
  add column if not exists motivo_cierre                text,
  add column if not exists cierre_client_transaction_id uuid,
  add column if not exists cierre_payload_hash          text;

-- LA garantía dura del cierre, igual que recepciones_compra_client_txn_key lo es
-- de la recepción: aunque la función tuviera un fallo lógico, dos cierres
-- simultáneos con la misma clave no pueden aplicarse los dos.
create unique index if not exists ordenes_compra_cierre_client_txn_key
  on public.ordenes_compra(cierre_client_transaction_id)
  where cierre_client_transaction_id is not null;

-- El estado y el registro del cierre no pueden divergir. Importa porque la
-- policy oc_write_admin (20260824133109:27) da UPDATE directo a un administrador
-- sobre ordenes_compra: sin esta comprobación podría poner estado='cerrada' a
-- mano, sin motivo ni responsable, o devolver a 'parcial' una orden cerrada.
alter table public.ordenes_compra
  drop constraint if exists ordenes_compra_cierre_coherente;
alter table public.ordenes_compra
  add constraint ordenes_compra_cierre_coherente
  check ((estado = 'cerrada') = (cerrada_at is not null)
         and (cerrada_at is null) = (cerrada_por is null)
         and (cerrada_at is null) = (motivo_cierre is null)
         and (cerrada_at is null) = (cierre_client_transaction_id is null)
         and (cerrada_at is null) = (cierre_payload_hash is null));

comment on column public.ordenes_compra.cerrada_at is
  'Momento del cierre con faltantes. Una orden cerrada es terminal: lo que no llegó no llegará, y queda registrado quién lo decidió y por qué.';
comment on column public.ordenes_compra.motivo_cierre is
  'Motivo del cierre con faltantes. Obligatorio: un cierre sin razón no es auditable frente al proveedor.';
comment on column public.ordenes_compra.cierre_client_transaction_id is
  'Clave de idempotencia del cierre, generada por el cliente. Dos envíos con la misma clave cierran una sola vez.';

-- El cierre, una vez escrito, es inmutable. La coherencia de arriba impide
-- inventarlo; esto impide reescribirlo o borrarlo. RLS no sirve aquí: la policy
-- oc_write_admin es de `authenticated` administrador, y un trigger sí corre
-- también para el dueño de la tabla.
create or replace function private.orden_compra_cierre_inmutable()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
begin
  if old.cerrada_at is null then
    return new;   -- la orden todavía no está cerrada: el cierre puede nacer.
  end if;
  if new.cerrada_at                   is distinct from old.cerrada_at
     or new.cerrada_por               is distinct from old.cerrada_por
     or new.motivo_cierre             is distinct from old.motivo_cierre
     or new.cierre_client_transaction_id is distinct from old.cierre_client_transaction_id
     or new.cierre_payload_hash       is distinct from old.cierre_payload_hash then
    raise exception 'El cierre con faltantes de una orden de compra es definitivo: no se reescribe ni se anula'
      using errcode = 'P0001';
  end if;
  return new;
end
$function$;

drop trigger if exists ordenes_compra_cierre_inmutable on public.ordenes_compra;
create trigger ordenes_compra_cierre_inmutable
  before update on public.ordenes_compra
  for each row execute function private.orden_compra_cierre_inmutable();

revoke all on function private.orden_compra_cierre_inmutable() from public;


-- ----------------------------------------------------------------------------
-- 1.2 Reversión en la línea del documento.
-- recepciones_compra y recepcion_compra_items usan grant de TABLA (verificado en
-- 20260913222322:66-67), así que las columnas nuevas heredan el SELECT de
-- `authenticated` y no hace falta ningún grant extra. La prueba lo comprueba
-- ejecutándolo con `set local role authenticated` (lección P0.4 / R8).
-- ----------------------------------------------------------------------------
alter table public.recepcion_compra_items
  add column if not exists cantidad_revertida  int not null default 0,
  add column if not exists seriales_revertidos text[];

alter table public.recepcion_compra_items
  drop constraint if exists recepcion_compra_items_revertida_no_negativa;
alter table public.recepcion_compra_items
  add constraint recepcion_compra_items_revertida_no_negativa
  check (cantidad_revertida >= 0);

-- Si se revierten unidades de un producto con IMEI hay que decir CUÁLES: una
-- reversión serializada sin los seriales no se puede auditar ni deshacer.
alter table public.recepcion_compra_items
  drop constraint if exists recepcion_compra_items_revertida_serial_coherente;
alter table public.recepcion_compra_items
  add constraint recepcion_compra_items_revertida_serial_coherente
  check (seriales_revertidos is null or cardinality(seriales_revertidos) = cantidad_revertida);

-- Una línea de corrección puede no traer NADA nuevo y sólo revertir. La
-- restricción de "fila no vacía" pasa a contar también la reversión.
alter table public.recepcion_compra_items
  drop constraint if exists recepcion_compra_items_no_vacia;
alter table public.recepcion_compra_items
  add constraint recepcion_compra_items_no_vacia
  check (cantidad + cantidad_danada + cantidad_faltante
       + cantidad_producto_equivocado + cantidad_revertida > 0);

comment on column public.recepcion_compra_items.cantidad_revertida is
  'Unidades BUENAS que la recepción corregida registró y que no entraron en realidad. Restan de cantidad_recibida y de inventory con delta negativo REAL. Sólo admisible en una recepción con corrige_recepcion_id.';
comment on column public.recepcion_compra_items.seriales_revertidos is
  'IMEI/serie concretos revertidos, para producto serializado. Pasan a estado baja: el catálogo conserva la unidad, el stock vendible no.';


-- ============================================================================
-- 2. CUÁNTO SE PUEDE REVERTIR
-- ============================================================================
-- El techo de una corrección es lo que la recepción corregida aportó en esa
-- línea, menos lo que correcciones anteriores de ESA MISMA recepción ya
-- revirtieron. Se calcula leyendo las filas append-only, no llevando un contador
-- mutable: no hay nada que pueda quedar desincronizado.
create or replace function private.recepcion_revertible(p_recepcion_id uuid, p_orden_item_id uuid)
returns int
language sql
stable
security definer
set search_path to 'public', 'private'
as $function$
  select greatest(
    coalesce((select sum(ri.cantidad)
                from public.recepcion_compra_items ri
               where ri.recepcion_id = p_recepcion_id
                 and ri.orden_item_id = p_orden_item_id), 0)
    - coalesce((select sum(ri2.cantidad_revertida)
                  from public.recepcion_compra_items ri2
                  join public.recepciones_compra r2 on r2.id = ri2.recepcion_id
                 where r2.corrige_recepcion_id = p_recepcion_id
                   and ri2.orden_item_id = p_orden_item_id), 0),
    0)::int
$function$;

revoke all on function private.recepcion_revertible(uuid, uuid) from public;


-- ============================================================================
-- 3. HUELLA DE LA REVERSIÓN
-- ============================================================================
-- B1 en su forma general: lo que no entra en la huella se pierde en silencio en
-- un reintento. `private.hash_recepcion` pertenece a otra migración y NO se
-- redefine aquí; los campos nuevos se cubren con esta función, que la RPC
-- combina con las demás piezas igual que ya hace con la observación general y
-- con corrige_recepcion_id.
--
-- Devuelve NULL cuando NINGUNA línea declara reversión real. Ese NULL es lo que
-- permite que la huella de un payload sin reversión sea byte a byte la de antes
-- de esta migración: la RPC no añade entonces la clave al objeto.
--
-- Como en hash_recepcion: jsonb y no concatenación con separadores, orden
-- canónico por orden_item_id y por serial, cantidades por numeric + trim_scale
-- (3 y 3.0 son lo mismo, y un "2.5" no revienta el cálculo antes de que se
-- compruebe el permiso).
create or replace function private.hash_recepcion_reversion(p_items jsonb)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case when count(*) filter (where declara) = 0
              then null
              else md5(jsonb_agg(huella order by orden_item_id)::text)
         end
    from (
      select e->>'orden_item_id' as orden_item_id,
             (coalesce(nullif(e->>'cantidad_revertida', '')::numeric, 0) <> 0
              or jsonb_array_length(case when jsonb_typeof(e->'seriales_revertidos') = 'array'
                                         then e->'seriales_revertidos' else '[]'::jsonb end) > 0) as declara,
             jsonb_build_object(
               'orden_item_id',       e->>'orden_item_id',
               'cantidad_revertida',  trim_scale(coalesce(nullif(e->>'cantidad_revertida', '')::numeric, 0)),
               'seriales_revertidos', coalesce((
                 select jsonb_agg(btrim(s #>> '{}') order by btrim(s #>> '{}'))
                   from jsonb_array_elements(
                          case when jsonb_typeof(e->'seriales_revertidos') = 'array'
                               then e->'seriales_revertidos' else '[]'::jsonb end) s
               ), '[]'::jsonb)
             ) as huella
        from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) e
    ) x
$function$;

revoke all on function private.hash_recepcion_reversion(jsonb) from public;


-- ============================================================================
-- 4. RESULTADO RECONSTRUIDO — ahora también la reversión
-- ============================================================================
-- Misma firma, mismo contrato: se LEE de las filas append-only, así que el
-- primer envío y su reintento ejecutan la misma consulta sobre las mismas filas
-- inmutables. Se añaden los dos campos nuevos para que una corrección que resta
-- no devuelva un resultado que parece no haber hecho nada.
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
               'cantidad_revertida',           ri.cantidad_revertida,
               'seriales_revertidos',          coalesce(to_jsonb(ri.seriales_revertidos), '[]'::jsonb),
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
    ),
    'revertidas', (
      select coalesce(sum(ri.cantidad_revertida), 0)
      from public.recepcion_compra_items ri
      where ri.recepcion_id = r.id
    )
  )
  from public.recepciones_compra r
  where r.id = p_recepcion_id
$function$;

revoke all on function private.recepcion_resultado(uuid) from public;


-- ============================================================================
-- 5. RESULTADO DEL CIERRE
-- ============================================================================
-- Mismo principio que recepcion_resultado: el cierre y su reintento devuelven lo
-- mismo porque los dos leen la fila ya escrita, no porque nadie recuerde qué se
-- respondió. El detalle de faltantes se calcula de orden_compra_items, que es
-- justo lo que el cierre congela.
create or replace function private.cierre_orden_resultado(p_orden_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'private'
as $function$
  select jsonb_build_object(
    'orden_id',               o.id,
    'estado',                 o.estado,
    'cerrada_por',            o.cerrada_por,
    'cerrada_at',             o.cerrada_at,
    'motivo_cierre',          o.motivo_cierre,
    'client_transaction_id',  o.cierre_client_transaction_id,
    'unidades_faltantes', coalesce((
      select sum(oi.cantidad_pedida - oi.cantidad_recibida)
        from public.orden_compra_items oi
       where oi.orden_id = o.id and oi.cantidad_recibida < oi.cantidad_pedida), 0),
    'lineas_con_faltante', coalesce((
      select jsonb_agg(jsonb_build_object(
               'orden_item_id',     oi.id,
               'variant_id',        oi.variant_id,
               'cantidad_pedida',   oi.cantidad_pedida,
               'cantidad_recibida', oi.cantidad_recibida,
               'faltante',          oi.cantidad_pedida - oi.cantidad_recibida)
             order by oi.id)
        from public.orden_compra_items oi
       where oi.orden_id = o.id and oi.cantidad_recibida < oi.cantidad_pedida), '[]'::jsonb)
  )
  from public.ordenes_compra o
  where o.id = p_orden_id
$function$;

revoke all on function private.cierre_orden_resultado(uuid) from public;


-- Reintento del cierre. Se separa igual que private.recepcion_replay para que
-- los tres puntos de reentrada (camino rápido, relectura bajo lock y pérdida del
-- UPDATE condicionado) no puedan divergir, y con las MISMAS tres barreras:
-- misma orden, misma persona y mismo contenido.
create or replace function private.cierre_replay(
  p_orden     public.ordenes_compra,
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
  if p_orden.id is distinct from p_orden_id then
    raise exception 'Ese client_transaction_id ya se usó para cerrar la orden %, no la %',
      p_orden.id, p_orden_id using errcode = 'P0001';
  end if;
  if p_orden.cerrada_por is distinct from p_staff_id then
    raise exception 'Ese client_transaction_id ya lo usó otra persona. Genera una clave nueva.'
      using errcode = 'P0001';
  end if;
  if p_orden.cierre_payload_hash is distinct from p_hash then
    raise exception 'Ese client_transaction_id ya se registró con un motivo distinto. Genera una clave nueva para una decisión distinta.'
      using errcode = 'P0001';
  end if;
  return private.cierre_orden_resultado(p_orden.id) || jsonb_build_object('reintento', true);
end
$function$;

revoke all on function private.cierre_replay(public.ordenes_compra, uuid, text, uuid) from public;


-- ============================================================================
-- 6. LA RPC DE RECEPCIÓN — misma firma, B3 resuelto
-- ============================================================================
-- CREATE OR REPLACE sobre la firma EXACTA que hay en producción: no hay DROP,
-- no hay hueco en el que PostgREST resuelva a otra versión y los privilegios se
-- conservan intactos (la lección P0.2 al revés: la forma segura de cambiar el
-- cuerpo es no tocar la identidad). Se reaplican igualmente al final, de forma
-- idempotente, para que el estado final quede escrito y no sólo heredado.
create or replace function public.recibir_orden_compra(
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
  v_hash_rev      text;
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
  v_rev           int;
  v_rev_ser       jsonb;
  v_rev_lista     text[];
  v_revertible    int;
  v_recibida_prev int;
begin
  ------------------------------------------------------------------------
  -- 6.1 Clave de idempotencia: obligatoria y primero que nada.
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
  -- 6.2 Identidad y permiso. Capacidad centralizada (_p2_h/_p2_i): ninguna
  -- lista literal de puestos vuelve a este cuerpo.
  ------------------------------------------------------------------------
  select * into v_staff from public.staff where user_id = auth.uid() and activo = true limit 1;
  if v_staff.id is null
     or not (private.tiene_capacidad('operar_inventario')) then
    raise exception 'Sin permiso para recibir compras' using errcode = 'P0001';
  end if;

  -- Huella del envío COMPLETO, calculada ya con identidad y permiso comprobados
  -- (B5). Las líneas las cubre private.hash_recepcion; la cabecera y la
  -- reversión se combinan aquí, en jsonb y no concatenando, para que ningún
  -- texto libre pueda hacer que dos envíos distintos compartan huella (B1).
  --
  -- La clave 'reversion' SÓLO se añade cuando hay reversión real, de modo que un
  -- payload sin reversión produce el mismo md5 que producía antes de esta
  -- migración y un reintento que cruce el despliegue se sigue reconociendo.
  v_hash_rev := private.hash_recepcion_reversion(p_items);
  v_hash := md5((
    jsonb_build_object(
      'lineas',               private.hash_recepcion(p_orden_id, p_items),
      'observacion',          nullif(btrim(coalesce(p_observacion, '')), ''),
      'corrige_recepcion_id', p_corrige_recepcion_id
    )
    || case when v_hash_rev is null then '{}'::jsonb
            else jsonb_build_object('reversion', v_hash_rev) end
  )::text);

  ------------------------------------------------------------------------
  -- 6.3 CAMINO RÁPIDO DEL REINTENTO. Timeout tras el commit: la transacción
  -- entró entera, la respuesta se perdió y el cliente reintenta. Se resuelve
  -- sin tocar nada y sin tomar ningún lock.
  ------------------------------------------------------------------------
  select * into v_rec from public.recepciones_compra
   where client_transaction_id = p_client_transaction_id;
  if v_rec.id is not null then
    return private.recepcion_replay(v_rec, p_orden_id, v_hash, v_staff.id);
  end if;

  ------------------------------------------------------------------------
  -- 6.4 Punto de serialización: la cabecera de la orden.
  ------------------------------------------------------------------------
  select * into v_orden from public.ordenes_compra where id = p_orden_id for update;
  -- Fallo CERRADO. `<>` con la sucursal del operador NULL da NULL, el IF no
  -- salta y cualquiera sin sucursal recibiría órdenes de cualquier sucursal (T1).
  if v_orden.id is null or private.auth_location_id() is null
     or v_orden.location_id is distinct from private.auth_location_id() then
    raise exception 'Orden inválida o de otra sucursal' using errcode = 'P0001';
  end if;

  -- Relectura BAJO el lock: bajo READ COMMITTED, si una sesión concurrente con
  -- la MISMA clave hizo commit mientras esperábamos, aquí sí la vemos (clase R6).
  select * into v_rec from public.recepciones_compra
   where client_transaction_id = p_client_transaction_id;
  if v_rec.id is not null then
    return private.recepcion_replay(v_rec, p_orden_id, v_hash, v_staff.id);
  end if;

  ------------------------------------------------------------------------
  -- 6.5 B3 · la guarda de estado deja de ser ciega.
  -- 'cancelada' sigue cerrada a todo: una orden anulada no tiene nada que
  -- rectificar. 'recibida' y 'cerrada' son terminales para una recepción NUEVA,
  -- pero no para una CORRECCIÓN: descubrir mañana que dos unidades venían rotas
  -- o que una nunca llegó tiene que poder anotarse, y antes no podía.
  ------------------------------------------------------------------------
  if v_orden.estado = 'cancelada' then
    raise exception 'Orden no recepcionable (estado %)', v_orden.estado using errcode = 'P0001';
  end if;
  if v_orden.estado in ('recibida','cerrada') and p_corrige_recepcion_id is null then
    raise exception 'Orden no recepcionable (estado %): para rectificar lo ya registrado envía la recepción como corrección, con corrige_recepcion_id',
      v_orden.estado using errcode = 'P0001';
  end if;

  if p_corrige_recepcion_id is not null
     and not exists (select 1 from public.recepciones_compra
                      where id = p_corrige_recepcion_id and orden_id = v_orden.id) then
    raise exception 'La recepción que se pretende corregir no pertenece a esta orden' using errcode = 'P0001';
  end if;

  ------------------------------------------------------------------------
  -- 6.6 Inserción de la cabecera con la clave única. Si dos sesiones llegan a
  -- la vez, la segunda espera el insert especulativo de la primera y recibe
  -- 23505 al hacer ésta commit; el bloque EXCEPTION deshace SÓLO este insert y
  -- devuelve la recepción ganadora. El índice único es la garantía real.
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
      raise exception 'Conflicto de unicidad al registrar la recepción' using errcode = 'P0001';
    end if;
    return private.recepcion_replay(v_rec, p_orden_id, v_hash, v_staff.id);
  end if;

  ------------------------------------------------------------------------
  -- 6.7 Líneas.
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
    v_rev      := greatest(coalesce((e->>'cantidad_revertida')::int, 0), 0);
    v_variant_eq := nullif(e->>'variant_id_recibido','')::uuid;

    v_rev_ser := case when jsonb_typeof(e->'seriales_revertidos') = 'array'
                      then e->'seriales_revertidos' else '[]'::jsonb end;
    if e ? 'seriales_revertidos' and jsonb_typeof(e->'seriales_revertidos') not in ('array','null') then
      raise exception 'El campo seriales_revertidos de la línea % no es una lista', v_item.id using errcode = 'P0001';
    end if;

    if v_buenas + v_danadas + v_faltante + v_equiv + v_rev = 0 then
      raise exception 'La línea % no declara ninguna cantidad', v_item.id using errcode = 'P0001';
    end if;

    --------------------------------------------------------------
    -- B3 · reversión: sólo dentro de una corrección y sólo hasta donde llega
    -- lo que aportó la recepción corregida.
    --------------------------------------------------------------
    if (v_rev > 0 or jsonb_array_length(v_rev_ser) > 0) and p_corrige_recepcion_id is null then
      raise exception 'Revertir unidades sólo cabe en una corrección: envía la recepción con corrige_recepcion_id apuntando a la que rectifica (línea %)',
        v_item.id using errcode = 'P0001';
    end if;
    if v_rev > 0 then
      v_revertible := private.recepcion_revertible(p_corrige_recepcion_id, v_item.id);
      if v_rev > v_revertible then
        raise exception 'No se pueden revertir % unidades de la línea %: la recepción corregida sólo tiene % revertibles (ya descontadas las correcciones anteriores)',
          v_rev, v_item.id, v_revertible using errcode = 'P0001';
      end if;
      if v_item.cantidad_recibida < v_rev then
        raise exception 'No se pueden revertir % unidades de la línea %: sólo constan % recibidas',
          v_rev, v_item.id, v_item.cantidad_recibida using errcode = 'P0001';
      end if;
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

    -- Lo revertido se descuenta ANTES de medir lo pendiente: una corrección que
    -- deshace tres unidades las devuelve a pendiente, y lo que llegue en ese
    -- mismo envío puede ocuparlas sin disparar el sobrante.
    v_recibida_prev := v_item.cantidad_recibida;
    v_pend    := greatest(v_item.cantidad_pedida - (v_recibida_prev - v_rev), 0);
    v_fisicas := v_buenas + v_danadas;

    -- SOBRANTE. Derivado por el servidor; el cliente no lo declara y por tanto
    -- no lo puede falsear. Si hay exceso, hace falta aceptación explícita: un
    -- dedazo (100 en vez de 10) no puede inflar stock en silencio.
    v_sobrante := greatest(v_fisicas - v_pend, 0);
    if v_sobrante > 0 and not coalesce((e->>'acepta_sobrante')::boolean, false) then
      raise exception 'Llegaron % unidades y sólo quedaban % pendientes en la línea %. Si el sobrante es real, reenvía la línea con acepta_sobrante = true.',
        v_fisicas, v_pend, v_item.id using errcode = 'P0001';
    end if;

    -- Lo que AVANZA la orden son únicamente las unidades buenas, y nunca por
    -- encima de lo pendiente: orden_compra_items conserva el CHECK
    -- cantidad_recibida <= cantidad_pedida y no se toca.
    v_aplicado := least(v_buenas, v_pend);

    ----------------------------------------------------------------
    -- Seriales / IMEI exactos de lo que LLEGA.
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
      -- Revertir una unidad serializada exige decir CUÁL: sin el IMEI concreto
      -- no se sabría qué unidad sale del stock vendible.
      if jsonb_array_length(v_rev_ser) <> v_rev then
        raise exception 'La línea % revierte % unidades y declara % IMEI/serie a revertir: tienen que coincidir',
          v_item.id, v_rev, jsonb_array_length(v_rev_ser) using errcode = 'P0001';
      end if;
      if exists (
        select 1 from jsonb_array_elements(v_rev_ser) s2
        group by btrim(s2 #>> '{}') having count(*) > 1) then
        raise exception 'Hay IMEI/serie repetidos en la reversión de la línea %', v_item.id using errcode = 'P0001';
      end if;
    else
      if v_n_ser > 0 then
        raise exception 'La línea % no es de un producto con IMEI/serie y trae seriales', v_item.id using errcode = 'P0001';
      end if;
      if jsonb_array_length(v_rev_ser) > 0 then
        raise exception 'La línea % no es de un producto con IMEI/serie y trae seriales a revertir', v_item.id using errcode = 'P0001';
      end if;
    end if;

    v_rev_lista := case when jsonb_array_length(v_rev_ser) = 0 then null else (
      select array_agg(btrim(s2 #>> '{}') order by btrim(s2 #>> '{}'))
        from jsonb_array_elements(v_rev_ser) s2) end;

    ----------------------------------------------------------------
    -- Documento de la línea. Append-only: se inserta, nunca se reescribe.
    ----------------------------------------------------------------
    insert into public.recepcion_compra_items
      (recepcion_id, orden_item_id, cantidad, costo_unitario,
       cantidad_danada, cantidad_faltante, cantidad_sobrante,
       cantidad_producto_equivocado, variant_id_recibido, observacion,
       cantidad_revertida, seriales_revertidos)
    values
      (v_rec.id, v_item.id, v_buenas, v_item.costo_unitario,
       v_danadas, v_faltante, v_sobrante,
       v_equiv, v_variant_eq, nullif(btrim(e->>'observacion'), ''),
       v_rev, v_rev_lista)
    returning id into v_ri;

    -- Un solo UPDATE con el efecto NETO: lo revertido resta y lo bueno suma. La
    -- resta nunca baja de 0 (comprobado arriba) y la suma nunca pasa de lo
    -- pedido (v_aplicado <= v_pend), así que los dos CHECK de la tabla siguen
    -- siendo ciertos sin relajarse.
    if v_aplicado - v_rev <> 0 then
      update public.orden_compra_items
         set cantidad_recibida = cantidad_recibida + v_aplicado - v_rev
       where id = v_item.id;
    end if;

    ----------------------------------------------------------------
    -- Inventario.
    ----------------------------------------------------------------
    if coalesce(v_control, false) then
      -- INVARIANTE P0.2/P0.4. No se toca `inventory` ni se escribe el
      -- movimiento a mano: se insertan (o se dan de baja) los seriales y se
      -- DERIVA el stock de product_serials.
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

      -- Reversión serializada. La unidad NO se borra —el catálogo es historia—
      -- sino que pasa a 'baja': existe, queda trazada contra el proveedor y sale
      -- del stock vendible. Se exige que siga 'disponible' y que la trajera
      -- precisamente la recepción que se corrige: una unidad ya vendida, en
      -- tránsito o en taller no se puede "des-recibir" por aquí.
      for s in select * from jsonb_array_elements(v_rev_ser) loop
        v_serial := btrim(s #>> '{}');
        if v_serial is null or v_serial = '' then
          raise exception 'IMEI/serie vacío en la reversión de la línea %', v_item.id using errcode = 'P0001';
        end if;
        update public.product_serials ps
           set estado = 'baja', updated_at = now()
         where ps.serial_number = v_serial
           and ps.variant_id = v_item.variant_id
           and ps.location_id = v_orden.location_id
           and ps.estado = 'disponible'
           and exists (select 1 from public.recepcion_compra_items ri
                        where ri.id = ps.recepcion_item_id
                          and ri.recepcion_id = p_corrige_recepcion_id
                          and ri.orden_item_id = v_item.id);
        if not found then
          raise exception 'No se puede revertir el IMEI/serie %: o no lo trajo la recepción que se corrige, o ya no está disponible en esta sucursal', v_serial
            using errcode = 'P0001';
        end if;
      end loop;

      if v_fisicas > 0 or v_rev > 0 then
        v_delta := private.sincronizar_stock_serializado(
                     v_item.variant_id, v_orden.location_id, v_staff.id,
                     case when v_rev > 0 and v_fisicas = 0
                          then 'Corrección recepción compra #' || v_orden.numero || ': reversión'
                          else 'Recepción compra #' || v_orden.numero end);
      end if;
    else
      -- Reversión primero: si lo revertido ya se vendió no hay stock que
      -- devolver y la corrección se rechaza entera. `where cantidad >= v_rev`
      -- hace la comprobación y el descuento en una sola sentencia atómica, sin
      -- ventana entre leer y escribir.
      if v_rev > 0 then
        update public.inventory
           set cantidad = cantidad - v_rev, updated_at = now()
         where variant_id = v_item.variant_id
           and location_id = v_orden.location_id
           and cantidad >= v_rev;
        if not found then
          raise exception 'No se pueden revertir % unidades de la línea %: el stock en la sucursal es menor. Si ya salieron, regístralo como ajuste de inventario.',
            v_rev, v_item.id using errcode = 'P0001';
        end if;
        insert into public.inventory_movements
          (variant_id, location_id, cantidad_delta, motivo, staff_id)
        values
          (v_item.variant_id, v_orden.location_id, -v_rev,
           left('Corrección recepción compra #' || v_orden.numero || ': reversión', 250), v_staff.id);
      end if;

      if v_buenas > 0 then
        insert into public.inventory (variant_id, location_id, cantidad, updated_at)
        values (v_item.variant_id, v_orden.location_id, v_buenas, now())
        on conflict (variant_id, location_id)
          do update set cantidad = public.inventory.cantidad + excluded.cantidad, updated_at = now();

        -- Delta REAL de esta recepción: las unidades buenas. Lo dañado, lo
        -- faltante y lo equivocado no mueven stock y por tanto no generan
        -- movimiento.
        insert into public.inventory_movements
          (variant_id, location_id, cantidad_delta, motivo, staff_id)
        values
          (v_item.variant_id, v_orden.location_id, v_buenas,
           left('Recepción compra #' || v_orden.numero, 250), v_staff.id);
      end if;
    end if;

    ----------------------------------------------------------------
    -- Historial de costo de compra. Append-only y atado a la recepción. La
    -- reversión añade una fila NEGATIVA en vez de borrar o reescribir la
    -- positiva: la suma queda correcta y el rastro entero se conserva.
    ----------------------------------------------------------------
    if v_buenas > 0 then
      insert into public.historial_costos_compra
        (product_id, variant_id, proveedor_id, orden_id, recepcion_id, costo_unitario, cantidad)
      values
        (v_product, v_item.variant_id, v_orden.proveedor_id, v_orden.id, v_rec.id,
         v_item.costo_unitario, v_buenas);
    end if;
    if v_rev > 0 then
      insert into public.historial_costos_compra
        (product_id, variant_id, proveedor_id, orden_id, recepcion_id, costo_unitario, cantidad)
      values
        (v_product, v_item.variant_id, v_orden.proveedor_id, v_orden.id, v_rec.id,
         v_item.costo_unitario, -v_rev);
    end if;

  end loop;

  ------------------------------------------------------------------------
  -- 6.8 Estado de la orden.
  -- Un cierre con faltantes es una decisión registrada, no un cálculo: una
  -- corrección posterior no lo deshace en silencio. Por eso 'cerrada' manda
  -- sobre el recuento de pendientes.
  ------------------------------------------------------------------------
  select count(*) into v_pendientes
    from public.orden_compra_items
   where orden_id = v_orden.id and cantidad_recibida < cantidad_pedida;

  update public.ordenes_compra
     set estado = case when v_orden.cerrada_at is not null then 'cerrada'
                       when v_pendientes = 0 then 'recibida'
                       else 'parcial' end,
         updated_at = now()
   where id = v_orden.id;

  return private.recepcion_resultado(v_rec.id) || jsonb_build_object('reintento', false);
end
$function$;

-- Reposición idempotente de los privilegios exactos. La firma no cambió, así que
-- CREATE OR REPLACE los conserva; se reescriben igualmente para que el estado
-- final quede declarado en esta migración y no dependa de lo heredado.
revoke all on function public.recibir_orden_compra(uuid, uuid, jsonb, text, uuid) from public;
revoke all on function public.recibir_orden_compra(uuid, uuid, jsonb, text, uuid) from anon;
grant execute on function public.recibir_orden_compra(uuid, uuid, jsonb, text, uuid) to authenticated;
grant execute on function public.recibir_orden_compra(uuid, uuid, jsonb, text, uuid) to service_role;


-- ============================================================================
-- 7. B4 · CIERRE EXPLÍCITO CON FALTANTES
-- ============================================================================
-- Idempotente por construcción, con las mismas tres reglas que la recepción:
--   · clave de cliente obligatoria,
--   · huella de contenido (misma clave + otro motivo se RECHAZA; devolverlo
--     como reintento haría desaparecer en silencio una decisión distinta),
--   · el resultado se RECONSTRUYE de la fila escrita, no se recuerda.
create or replace function public.cerrar_orden_compra_con_faltantes(
  p_orden_id               uuid,
  p_client_transaction_id  uuid,
  p_motivo                 text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_staff     public.staff;
  v_orden     public.ordenes_compra;
  v_motivo    text;
  v_hash      text;
  v_faltantes int;
  v_gano      boolean := false;
begin
  if p_client_transaction_id is null then
    raise exception 'El cierre requiere client_transaction_id: sin clave de idempotencia un reintento cerraría dos veces y registraría dos decisiones'
      using errcode = 'P0001';
  end if;
  if p_orden_id is null then
    raise exception 'Orden inválida' using errcode = 'P0001';
  end if;

  select * into v_staff from public.staff where user_id = auth.uid() and activo = true limit 1;
  if v_staff.id is null
     or not (private.tiene_capacidad('operar_inventario')) then
    raise exception 'Sin permiso para cerrar órdenes de compra' using errcode = 'P0001';
  end if;

  -- Un cierre sin motivo no se puede defender ante el proveedor ni ante una
  -- auditoría: se exige, ya con el permiso comprobado (B5).
  v_motivo := nullif(btrim(coalesce(p_motivo, '')), '');
  if v_motivo is null then
    raise exception 'Cerrar una orden con faltantes exige un motivo: explica por qué lo que falta ya no va a llegar'
      using errcode = 'P0001';
  end if;
  v_hash := md5(jsonb_build_object('orden_id', p_orden_id, 'motivo', v_motivo)::text);

  -- Camino rápido del reintento, sin lock.
  select * into v_orden from public.ordenes_compra
   where cierre_client_transaction_id = p_client_transaction_id;
  if v_orden.id is not null then
    return private.cierre_replay(v_orden, p_orden_id, v_hash, v_staff.id);
  end if;

  select * into v_orden from public.ordenes_compra where id = p_orden_id for update;
  -- Fallo CERRADO de sucursal, idéntico al de la recepción.
  if v_orden.id is null or private.auth_location_id() is null
     or v_orden.location_id is distinct from private.auth_location_id() then
    raise exception 'Orden inválida o de otra sucursal' using errcode = 'P0001';
  end if;

  -- Relectura BAJO el lock (clase R6).
  if v_orden.cierre_client_transaction_id = p_client_transaction_id then
    return private.cierre_replay(v_orden, p_orden_id, v_hash, v_staff.id);
  end if;

  if v_orden.estado = 'cerrada' then
    raise exception 'La orden ya se cerró con faltantes el %; el cierre es definitivo', v_orden.cerrada_at
      using errcode = 'P0001';
  end if;
  if v_orden.estado <> 'parcial' then
    raise exception 'Sólo se cierra con faltantes una orden parcialmente recibida (estado actual: %). Una orden sin ninguna recepción se cancela, no se cierra.',
      v_orden.estado using errcode = 'P0001';
  end if;

  select coalesce(sum(oi.cantidad_pedida - oi.cantidad_recibida), 0)::int
    into v_faltantes
    from public.orden_compra_items oi
   where oi.orden_id = v_orden.id and oi.cantidad_recibida < oi.cantidad_pedida;
  if v_faltantes <= 0 then
    raise exception 'La orden no tiene faltantes: no hay nada que cerrar' using errcode = 'P0001';
  end if;

  -- El UPDATE condicionado es la parte atómica: si otra sesión cerró mientras
  -- tanto, `where estado = 'parcial'` no encuentra nada. El índice único sobre
  -- cierre_client_transaction_id es la garantía dura frente a dos cierres
  -- simultáneos con la MISMA clave.
  begin
    update public.ordenes_compra
       set estado = 'cerrada',
           cerrada_por = v_staff.id,
           cerrada_at = now(),
           motivo_cierre = v_motivo,
           cierre_client_transaction_id = p_client_transaction_id,
           cierre_payload_hash = v_hash,
           updated_at = now()
     where id = v_orden.id and estado = 'parcial';
    v_gano := found;
  exception when unique_violation then
    v_gano := false;
  end;

  if not v_gano then
    select * into v_orden from public.ordenes_compra
     where cierre_client_transaction_id = p_client_transaction_id;
    if v_orden.id is null then
      raise exception 'La orden dejó de ser cerrable mientras se cerraba; vuelve a consultarla' using errcode = 'P0001';
    end if;
    return private.cierre_replay(v_orden, p_orden_id, v_hash, v_staff.id);
  end if;

  return private.cierre_orden_resultado(v_orden.id) || jsonb_build_object('reintento', false);
end
$function$;

revoke all on function public.cerrar_orden_compra_con_faltantes(uuid, uuid, text) from public;
revoke all on function public.cerrar_orden_compra_con_faltantes(uuid, uuid, text) from anon;
grant execute on function public.cerrar_orden_compra_con_faltantes(uuid, uuid, text) to authenticated;
grant execute on function public.cerrar_orden_compra_con_faltantes(uuid, uuid, text) to service_role;


-- ============================================================================
-- 8. PRIVILEGIOS DE LAS AUXILIARES
-- ============================================================================
-- Viven en `private`, al que anon/authenticated no tienen USAGE; el revoke es
-- la segunda vuelta de llave.
revoke all on function private.cierre_orden_resultado(uuid) from public;
revoke all on function private.recepcion_revertible(uuid, uuid) from public;
revoke all on function private.hash_recepcion_reversion(jsonb) from public;


-- ============================================================================
-- 9. VERIFICACIÓN EN LA PROPIA MIGRACIÓN
-- ============================================================================
do $$
declare n int; v_src text;
begin
  -- La identidad de la RPC de recepción NO ha cambiado, y sigue habiendo
  -- exactamente dos versiones (la idempotente y el envoltorio de compatibilidad).
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'recibir_orden_compra';
  if n <> 2 then
    raise exception 'Quedaron % versiones de public.recibir_orden_compra; se esperaban exactamente 2', n;
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = 'recibir_orden_compra'
       and pg_get_function_identity_arguments(p.oid) =
           'p_orden_id uuid, p_client_transaction_id uuid, p_items jsonb, p_observacion text, p_corrige_recepcion_id uuid'
  ) then
    raise exception 'La firma idempotente de public.recibir_orden_compra cambió; esta migración no puede alterarla';
  end if;

  select p.prosrc into v_src
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'recibir_orden_compra'
     and pg_get_function_identity_arguments(p.oid) =
         'p_orden_id uuid, p_client_transaction_id uuid, p_items jsonb, p_observacion text, p_corrige_recepcion_id uuid';

  if v_src !~ 'tiene_capacidad\(''operar_inventario''\)' then
    raise exception 'La RPC de recepción perdió la comprobación de capacidad operar_inventario';
  end if;
  if v_src !~ 'auth_location_id\(\) is null' then
    raise exception 'La RPC de recepción perdió el fallo CERRADO de sucursal';
  end if;
  if v_src !~ 'p_client_transaction_id is null' then
    raise exception 'La RPC de recepción perdió la obligatoriedad de la clave de idempotencia';
  end if;
  if v_src !~ 'is_test' then
    raise exception 'La RPC de recepción perdió el rechazo de productos is_test';
  end if;
  if v_src !~ 'hash_recepcion_reversion' then
    raise exception 'La huella de la RPC no cubre los campos de reversión (clase B1)';
  end if;

  -- anon no puede ejecutar nada de esto (P0.4 / migración D).
  if exists (
    select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace,
         lateral aclexplode(p.proacl) a join pg_roles r on r.oid = a.grantee
     where ns.nspname = 'public'
       and p.proname in ('recibir_orden_compra','cerrar_orden_compra_con_faltantes')
       and r.rolname = 'anon'
  ) then
    raise exception 'anon no puede tener EXECUTE sobre las RPC de compras';
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'ordenes_compra_cierre_client_txn_key'
  ) then
    raise exception 'Falta el índice único de idempotencia del cierre';
  end if;

  -- El estado nuevo existe y el viejo dominio sigue admitido.
  if not exists (
    select 1 from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid
      join pg_namespace ns on ns.oid = cl.relnamespace
     where ns.nspname = 'public' and cl.relname = 'ordenes_compra'
       and con.conname = 'ordenes_compra_estado_check'
       and pg_get_constraintdef(con.oid) ~ 'cerrada'
       and pg_get_constraintdef(con.oid) ~ 'borrador'
       and pg_get_constraintdef(con.oid) ~ 'cancelada'
  ) then
    raise exception 'El CHECK de estado de ordenes_compra no admite el dominio esperado';
  end if;

  if not exists (
    select 1 from pg_trigger t join pg_class cl on cl.oid = t.tgrelid
      join pg_namespace ns on ns.oid = cl.relnamespace
     where ns.nspname = 'public' and cl.relname = 'ordenes_compra'
       and t.tgname = 'ordenes_compra_cierre_inmutable' and not t.tgisinternal
  ) then
    raise exception 'Falta el trigger que hace inmutable el cierre con faltantes';
  end if;

  -- Los triggers append-only del documento de recepción siguen en pie.
  if (select count(*) from pg_trigger t join pg_class cl on cl.oid = t.tgrelid
        join pg_namespace ns on ns.oid = cl.relnamespace
       where ns.nspname = 'public'
         and cl.relname in ('recepciones_compra','recepcion_compra_items')
         and t.tgname like '%append_only%' and not t.tgisinternal) <> 2 then
    raise exception 'Los triggers append-only de la recepción ya no están completos';
  end if;

  -- El CHECK que impide recibir más de lo pedido no se ha relajado.
  if not exists (
    select 1 from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid
      join pg_namespace ns on ns.oid = cl.relnamespace
     where ns.nspname = 'public' and cl.relname = 'orden_compra_items' and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ~ 'cantidad_recibida <= cantidad_pedida'
  ) then
    raise exception 'Se perdió el CHECK cantidad_recibida <= cantidad_pedida de orden_compra_items';
  end if;

  -- Una huella sin reversión tiene que seguir siendo la de antes: si esto
  -- fallara, todo reintento que cruzara el despliegue se rechazaría.
  if private.hash_recepcion_reversion('[{"orden_item_id":"a","cantidad":3}]'::jsonb) is not null then
    raise exception 'La huella de reversión no es nula para un payload sin reversión: rompería los reintentos en curso';
  end if;
  if private.hash_recepcion_reversion('[{"orden_item_id":"a","cantidad_revertida":2}]'::jsonb) is null then
    raise exception 'La huella de reversión no cubre cantidad_revertida (clase B1)';
  end if;
  if private.hash_recepcion_reversion('[{"orden_item_id":"a","cantidad_revertida":2,"seriales_revertidos":["X"]}]'::jsonb)
     = private.hash_recepcion_reversion('[{"orden_item_id":"a","cantidad_revertida":2,"seriales_revertidos":["Y"]}]'::jsonb) then
    raise exception 'La huella de reversión no distingue los IMEI revertidos (clase B1)';
  end if;
end $$;
