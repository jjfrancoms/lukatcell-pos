-- ============================================================================
-- P3.B — TRANSFERENCIAS: DEUDA T3 (IMEI "no llegó" que nunca deja de contar
-- como pendiente) y T4 (crear_transferencia_stock sin clave de idempotencia).
--
-- FORWARD-ONLY. No se edita ninguna migración aplicada. Las funciones vigentes
-- que se redefinen son las de:
--   · public.recibir_transferencia_parcial  → 20260913225428_p2_i (línea 799)
--   · public.despachar_transferencia_stock  → 20260913225428_p2_i (línea 263)  [no se toca]
--   · public.transferencia_detalle          → 20260913221937_p1_a (línea 426)
--   · public.crear_transferencia_stock      → 20260913224059_p2_b (línea 389)
-- Se parte de ESOS cuerpos, no de los de _p1_a, para no revertir _p2_b
-- (sucursal activa) ni _p2_i (capacidades).
--
-- ---------------------------------------------------------------------------
-- T3 · "TODO IDENTIFICADO" NO ERA "TODO RECIBIDO"
--
-- Evidencia (20260913225428_p2_i_capacidades_funciones.sql):
--   · línea ~1025: un IMEI marcado 'faltante' NO suma a v_ok ni a v_dan, así
--     que no toca cantidad_recibida ni cantidad_danada.
--   · línea ~1040: el acumulador de la línea sólo escribe recibida/danada.
--   · línea ~1050: v_pendientes = count(*) where
--       cantidad_recibida + cantidad_danada < cantidad
--     ⇒ una línea con 5 enviadas, 4 ok y 1 marcada "no llegó" cuenta como
--     pendiente para siempre y la cabecera se queda en 'recibida_parcial'
--     aunque no quede NADA que identificar. El operador ya hizo su trabajo y
--     la transferencia sigue abierta.
--   · 20260913221937_p1_a línea ~449: 'pendiente' del detalle repite la misma
--     fórmula sin el faltante, así que la UI también miente.
--
-- LO QUE NO ERA CIERTO DE LA DEUDA: cantidad_faltante SÍ existe (_p1_a §1),
-- pero sólo se escribía AL CERRAR, como un valor derivado del resto. Nunca
-- durante el vuelo. Ése es exactamente el agujero.
--
-- ARREGLO: el faltante deja de ser un derivado del cierre y pasa a ser un
-- acumulador de pleno derecho, igual que recibida y danada. Se incrementa en
-- el mismo UPDATE de una sola sentencia (nada de leer-y-escribir: eso abriría
-- un lost update entre dos recepciones concurrentes) y entra en las CINCO
-- fórmulas de pendiente que existen:
--   1. filtro de "lo que queda por recibir" con p_items NULL,
--   2. cantidad_ok derivada en ese mismo camino,
--   3. v_pendientes (el que decide si la transferencia se cierra sola),
--   4. estado_linea,
--   5. 'pendiente' de transferencia_detalle.
-- La asignación absoluta del cierre (cantidad_faltante = cantidad - recibida
-- - danada) se conserva TAL CUAL: cuando todo está identificado da el mismo
-- número que el acumulado, y cuando se cierra a la fuerza sigue siendo la
-- única forma de dar por perdido lo que nadie marcó.
--
-- ALCANCE DELIBERADO: sólo las líneas CON IMEI pueden declarar faltante en
-- vuelo, porque sólo ahí existe la unidad concreta que el operador marca como
-- "no llegó" (p_items.serials[].resultado = 'faltante', ya cubierto por el
-- payload_hash de T2). NO se añade ningún campo nuevo a p_items: un
-- 'cantidad_faltante' suelto en las líneas sin IMEI obligaría a redefinir
-- private.hash_transferencia_recepcion, y una huella que no cubriera el campo
-- nuevo haría pasar por "reintento" dos peticiones distintas — justo la
-- regresión de T2. Para las líneas sin IMEI el cierre explícito sigue siendo
-- la vía, que es lo que la UI ya ofrece ("Cerrar con faltantes").
--
-- ---------------------------------------------------------------------------
-- T4 · CREAR SIN CLAVE
--
-- Evidencia (20260913224059_p2_b_sucursal_activa.sql línea 389): la firma es
-- (p_destino_id uuid, p_items jsonb, p_observacion text) y el cuerpo inserta
-- la cabecera sin ninguna clave. Dos envíos = dos borradores. La mitigación
-- vigente es un `useRef` en la UI (src/pages/Transferencias.tsx línea 371), que
-- no sobrevive a un reintento de red ni protege a ningún otro cliente.
--
-- Matiz real que la deuda no recogía: con productos serializados el segundo
-- borrador YA fallaba, porque tss_serial_en_vuelo (_p1_a §3) impide que un
-- IMEI esté en vuelo en dos transferencias. El agujero es real sólo para las
-- líneas SIN IMEI — y ahí es total, porque nada lo impide.
--
-- ARREGLO: misma forma que la recepción (_p1_a §4) y que recibir_orden_compra
-- (_p1_b): clave OBLIGATORIA + huella del contenido.
--   · clave nula  → excepción. Fallo cerrado; ningún cliente puede optar por
--     no tenerla, que es lo que convierte "mitigado en la UI" en "cerrado".
--   · misma clave + mismo contenido → devuelve el borrador existente, no crea
--     otro.
--   · misma clave + OTRO contenido → excepción. Nunca un éxito silencioso que
--     devuelva el borrador viejo como si fuera el nuevo (lección de T2).
-- La unicidad la sostiene un índice único en la base, no el código: dos
-- llamadas concurrentes con la misma clave chocan en el índice y la segunda
-- reintenta la lectura en vez de insertar. El ámbito de la clave es
-- (creado_por, client_transaction_id) y no la clave sola, para que nadie pueda
-- quemar la clave de otro.
--
-- CAMBIO DE FIRMA: la lista de argumentos cambia, así que se hace DROP de la
-- firma vieja y se reponen los privilegios EXACTOS. Sin el DROP quedarían dos
-- candidatas y PostgREST no sabría cuál resolver (el desastre de P0.2).
-- ATENCIÓN AL DESPLIEGUE: el frontend tiene que salir junto con esta migración
-- o antes; una pestaña abierta con el bundle viejo llamará a la firma de 3
-- argumentos y recibirá PGRST202 hasta recargar.
--
-- ---------------------------------------------------------------------------
-- T7 · HALLAZGO NUEVO DE ESTA AUDITORÍA (no estaba en la lista de deuda)
--
-- Evidencia (20260913225428_p2_i línea ~941): al conciliar un IMEI, el filtro
-- es (transferencia_id, serial_id, resultado is null). No comprueba que el
-- serial pertenezca a la VARIANTE de la línea que se está recibiendo. En una
-- transferencia con dos líneas serializadas, mandar el IMEI de la línea B bajo
-- el item_id de la línea A pasaba el control, movía el serial al destino, lo
-- contaba en la línea equivocada y sincronizaba el stock de la variante A. El
-- inventario de B nunca subía aunque su unidad ya estuviera físicamente allí:
-- inventory < product_serials disponibles. Es el mismo invariante que D1 cerró
-- en el despacho, abierto de nuevo en la recepción, y lo dispara un operador
-- escaneando en la línea equivocada — no hace falta mala fe.
-- Se corrige uniendo con product_serials en el propio UPDATE, para que el
-- rechazo ocurra ANTES de tocar nada, no después.
--
-- ---------------------------------------------------------------------------
-- LO QUE ESTA MIGRACIÓN NO TOCA
--   · T5 (sobrante sin contrapartida en el origen): es una decisión de negocio
--     del dueño, no del squad. cantidad_sobrante sigue derivado y la línea
--     sigue marcándose 'con_diferencia'. Ni una línea de comportamiento nuevo.
--   · private.hash_recepcion / recibir_orden_compra: propiedad de otro squad.
--   · El modelo de autorización: crear_transferencia_stock sigue siendo
--     private.auth_is_admin() ("Solo administradores"), que es lo vigente.
--     Cambiarlo a una capacidad sería ampliar o restringir permisos fuera del
--     alcance de T4.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 · T4 · ANCLAJE DE LA CLAVE DE CREACIÓN
-- ---------------------------------------------------------------------------

alter table public.transferencias_stock
  add column if not exists client_transaction_id uuid,
  add column if not exists payload_hash text;

comment on column public.transferencias_stock.client_transaction_id is
  'Clave de idempotencia de la CREACIÓN. Obligatoria desde _p3_b; nula sólo en las transferencias anteriores a esa migración.';
comment on column public.transferencias_stock.payload_hash is
  'Huella del contenido con el que se creó. Distingue un reintento legítimo (mismo contenido) de una clave reutilizada con otro contenido, que se rechaza.';

-- Las dos columnas van juntas o no van: una clave sin huella no podría
-- distinguir el reintento del contenido distinto, que es la mitad del arreglo.
alter table public.transferencias_stock drop constraint if exists ts_clave_creacion_completa;
alter table public.transferencias_stock add constraint ts_clave_creacion_completa
  check ((client_transaction_id is null) = (payload_hash is null));

-- LA idempotencia. Está en la base, no en el código: dos llamadas concurrentes
-- con la misma clave no pueden crear dos borradores ni aunque ambas lean antes
-- de que la otra haya hecho commit.
create unique index if not exists ts_creacion_idempotente
  on public.transferencias_stock(creado_por, client_transaction_id)
  where client_transaction_id is not null;

-- Huella canónica de una PETICIÓN de creación. Mismo criterio que
-- private.hash_transferencia_recepcion (_p1_a §4): se ordena todo lo que el
-- cliente puede mandar en otro orden y se normalizan los valores por omisión,
-- para que el mismo envío dé siempre la misma huella y uno distinto no.
create or replace function private.hash_transferencia_creacion(
  p_destino_id uuid, p_items jsonb, p_observacion text
) returns text
language sql
immutable
set search_path to 'public', 'private'
as $function$
  select md5(jsonb_build_object(
    'destino_id', p_destino_id::text,
    'observacion', nullif(btrim(coalesce(p_observacion, '')), ''),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'variant_id', e->>'variant_id',
               'cantidad', coalesce(e->>'cantidad', '0'),
               'serial_ids', coalesce((
                 select jsonb_agg(s order by s)
                 from jsonb_array_elements_text(coalesce(e->'serial_ids', '[]'::jsonb)) s), '[]'::jsonb))
             order by e->>'variant_id', coalesce(e->>'cantidad', '0'))
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) e), '[]'::jsonb)
  )::text)
$function$;

-- Sólo se invoca desde crear_transferencia_stock (SECURITY DEFINER). Basta con
-- quitar el EXECUTE que PUBLIC hereda: anon y authenticated no tienen USAGE
-- sobre `private`.
revoke all on function private.hash_transferencia_creacion(uuid, jsonb, text) from public;

-- ---------------------------------------------------------------------------
-- 2 · T4 · CREACIÓN IDEMPOTENTE
--
-- Se conserva TODO el comportamiento vigente de _p2_b: sólo administradores,
-- origen = sucursal ACTIVA (private.auth_location_id()), manifiesto de
-- seriales exacto, y el rechazo de seriales no disponibles.
-- Se añade la clave, la huella y el fallo CERRADO cuando el actor no tiene
-- sucursal: con `p_destino_id = private.auth_location_id()` y un location nulo
-- la comparación daba NULL, el IF no saltaba y la función seguía hasta
-- reventar con un "null value in column origen_id" que no explica nada. Misma
-- clase de fallo que T1, en el único sitio donde quedaba.
-- ---------------------------------------------------------------------------

drop function if exists public.crear_transferencia_stock(uuid, jsonb, text);

create or replace function public.crear_transferencia_stock(
  p_destino_id uuid,
  p_items jsonb,
  p_observacion text default null,
  p_client_transaction_id uuid default null
)
returns public.transferencias_stock
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  s public.staff;
  t public.transferencias_stock;
  x jsonb;
  v_loc uuid;
  v_control boolean;
  v_serials jsonb;
  sid text;
  v_qty int;
  v_hash text;
begin
  if p_client_transaction_id is null then
    raise exception 'La creación de una transferencia exige client_transaction_id (idempotencia)'
      using errcode = 'P0001';
  end if;

  if not private.auth_is_admin() then
    raise exception 'Solo administradores' using errcode = '42501';
  end if;
  select * into s from public.staff where user_id = auth.uid() and activo = true limit 1;
  if s.id is null then
    raise exception 'Personal inválido' using errcode = '42501';
  end if;

  -- Fallo CERRADO: sin sucursal no hay origen posible.
  v_loc := private.auth_location_id();
  if v_loc is null then
    raise exception 'Sin sucursal asignada: no se puede crear una transferencia' using errcode = '42501';
  end if;
  if p_destino_id is null or p_destino_id is not distinct from v_loc then
    raise exception 'Origen y destino no pueden ser iguales' using errcode = 'P0001';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'Transferencia vacía' using errcode = 'P0001';
  end if;

  -- Huella calculada YA con identidad y permiso comprobados, igual que en la
  -- recepción: una clave repetida no debe ni revelar que existe a quien no
  -- tendría permiso para crear nada.
  v_hash := private.hash_transferencia_creacion(p_destino_id, p_items, p_observacion);

  -- Camino rápido del reintento: la clave ya se usó.
  select * into t from public.transferencias_stock
   where creado_por = s.id and client_transaction_id = p_client_transaction_id;
  if t.id is not null then
    if t.payload_hash is distinct from v_hash then
      raise exception 'Ese client_transaction_id ya se usó con un contenido distinto. Genera una clave nueva para una transferencia distinta.'
        using errcode = 'P0001';
    end if;
    return t;
  end if;

  -- Y el camino de la carrera: dos envíos simultáneos con la misma clave no se
  -- ven entre sí en el SELECT de arriba, pero sí chocan en ts_creacion_idempotente.
  -- El bloque atrapa ESE choque y reintenta la lectura; el insert de la cabecera
  -- es lo primero que se hace, así que no hay líneas a medio escribir que deshacer.
  begin
    insert into public.transferencias_stock(
      origen_id, destino_id, creado_por, observacion, client_transaction_id, payload_hash)
    values (v_loc, p_destino_id, s.id, nullif(btrim(p_observacion), ''), p_client_transaction_id, v_hash)
    returning * into t;
  exception when unique_violation then
    select * into t from public.transferencias_stock
     where creado_por = s.id and client_transaction_id = p_client_transaction_id;
    if t.id is null then raise; end if;
    if t.payload_hash is distinct from v_hash then
      raise exception 'Ese client_transaction_id ya se usó con un contenido distinto. Genera una clave nueva para una transferencia distinta.'
        using errcode = 'P0001';
    end if;
    return t;
  end;

  for x in select * from jsonb_array_elements(p_items) loop
    v_qty := (x->>'cantidad')::int;
    insert into public.transferencia_stock_items(transferencia_id, variant_id, cantidad)
    values (t.id, (x->>'variant_id')::uuid, v_qty);

    select p.control_serial into v_control
    from public.product_variants pv join public.products p on p.id = pv.product_id
    where pv.id = (x->>'variant_id')::uuid;

    v_serials := coalesce(x->'serial_ids', '[]'::jsonb);
    if coalesce(v_control, false) then
      if jsonb_array_length(v_serials) <> v_qty then
        raise exception 'Transferencia requiere seriales exactos' using errcode = 'P0001';
      end if;
      for sid in select jsonb_array_elements_text(v_serials) loop
        if not exists(select 1 from public.product_serials
                       where id = sid::uuid
                         and variant_id = (x->>'variant_id')::uuid
                         and location_id = v_loc
                         and estado = 'disponible') then
          raise exception 'Serial no disponible' using errcode = 'P0001';
        end if;
        insert into public.transferencia_stock_serials(transferencia_id, serial_id)
        values (t.id, sid::uuid);
      end loop;
    elsif jsonb_array_length(v_serials) > 0 then
      raise exception 'Producto sin control serial' using errcode = 'P0001';
    end if;
  end loop;

  return t;
end
$function$;

-- ---------------------------------------------------------------------------
-- 3 · T3 · RECEPCIÓN PARCIAL CON EL FALTANTE COMO ACUMULADOR
--
-- Firma EXACTA de la vigente (_p2_i línea 799), SECURITY DEFINER,
-- search_path 'public','private', private.tiene_capacidad('operar_inventario')
-- y private.auth_location_id() con fallo CERRADO. Lo único que cambia es el
-- tratamiento del faltante; todo lo demás es el cuerpo vigente.
-- ---------------------------------------------------------------------------

create or replace function public.recibir_transferencia_parcial(
  p_transferencia_id uuid,
  p_client_transaction_id uuid,
  p_items jsonb default null,
  p_observacion text default null,
  p_cerrar boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  s public.staff;
  t public.transferencias_stock;
  v_loc uuid;
  v_rec uuid;
  x jsonb;
  sj jsonb;
  i public.transferencia_stock_items;
  v_control boolean;
  v_ok int;
  v_dan int;
  v_fal int;
  v_sid uuid;
  v_res text;
  v_pendientes int;
  v_items jsonb;
  v_hash text;
  v_prev_hash text;
begin
  if p_client_transaction_id is null then
    raise exception 'La recepción exige client_transaction_id (idempotencia)' using errcode = 'P0001';
  end if;

  select * into s from public.staff where user_id = auth.uid() and activo = true limit 1;
  if s.id is null or not(private.tiene_capacidad('operar_inventario')) then
    raise exception 'Sin permiso' using errcode = '42501';
  end if;
  v_loc := coalesce(private.auth_location_id(), private.auth_location_id());

  -- PUNTO DE SERIALIZACIÓN. Dos recepciones simultáneas de esta transferencia
  -- se ponen en fila aquí; la segunda continúa viendo ya el commit de la
  -- primera. Sin este FOR UPDATE la idempotencia por clave no bastaría: dos
  -- transacciones podrían insertar la misma clave a la vez y una de ellas
  -- descubriría el conflicto DESPUÉS de haber tocado inventory.
  select * into t from public.transferencias_stock where id = p_transferencia_id for update;
  if t.id is null then
    raise exception 'Transferencia inexistente' using errcode = 'P0001';
  end if;

  -- PERMISO POR SUCURSAL EN SERVIDOR: recibe el DESTINO.
  -- Fallo CERRADO (T1): con `<>`, un v_loc NULL daba NULL, el IF no saltaba y un
  -- operativo sin sucursal recibía cualquier transferencia.
  if v_loc is null or t.destino_id is distinct from v_loc then
    raise exception 'Solo la sucursal de destino puede recibir la transferencia #%', t.numero
      using errcode = '42501';
  end if;

  -- T2 · huella de la PETICIÓN tal como llegó, calculada ya con identidad y
  -- permiso comprobados. Se hashea lo recibido y no las líneas que el servidor
  -- deriva: con p_items NULL ("recibir todo lo pendiente") lo pendiente sale del
  -- estado actual, y el reintento de un "recibir todo" ya aplicado vería otra
  -- cosa y se rechazaría por error. cerrar_transferencia_stock delega aquí, así
  -- que esto cubre también el cierre.
  v_hash := private.hash_transferencia_recepcion(p_items, p_cerrar, p_observacion);

  if t.estado not in ('en_transito','recibida_parcial') then
    -- Con la transferencia ya cerrada, la misma clave es un reintento legítimo
    -- SÓLO si el contenido coincide.
    select payload_hash into v_prev_hash from public.transferencia_recepciones
     where transferencia_id = t.id and client_transaction_id = p_client_transaction_id;
    if found then
      if v_prev_hash is distinct from v_hash then
        raise exception 'Ese client_transaction_id ya se usó con un contenido distinto. Genera una clave nueva para una recepción distinta.' using errcode = 'P0001';
      end if;
      return public.transferencia_detalle(t.id);
    end if;
    raise exception 'Transferencia #% no recibible (estado %)', t.numero, t.estado using errcode = 'P0001';
  end if;

  -- IDEMPOTENCIA. Si la clave ya existe no se aplica NADA, y sólo se acepta como
  -- reintento si el contenido coincide (T2): si no, la recepción nueva se perdería
  -- en silencio mientras el cliente recibe el detalle como si hubiera entrado.
  insert into public.transferencia_recepciones(
    transferencia_id, client_transaction_id, recibido_por, observacion, es_cierre, payload_hash)
  values (t.id, p_client_transaction_id, s.id, nullif(btrim(p_observacion), ''), p_cerrar, v_hash)
  on conflict (transferencia_id, client_transaction_id) do nothing
  returning id into v_rec;

  if v_rec is null then
    select payload_hash into v_prev_hash from public.transferencia_recepciones
     where transferencia_id = t.id and client_transaction_id = p_client_transaction_id;
    if v_prev_hash is distinct from v_hash then
      raise exception 'Ese client_transaction_id ya se usó con un contenido distinto. Genera una clave nueva para una recepción distinta.' using errcode = 'P0001';
    end if;
    return public.transferencia_detalle(t.id);
  end if;

  -- p_items NULL = todo lo pendiente, correcto. Para las líneas con IMEI se
  -- rellenan los seriales que siguen en vuelo.
  -- T3 · lo pendiente descuenta TAMBIÉN el faltante ya identificado. Sin esto,
  -- un "recibir todo" tras marcar unidades como no llegadas volvería a pedir
  -- esas unidades y las recibiría como buenas.
  if p_items is null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'item_id', it.id,
      'cantidad_ok', it.cantidad - it.cantidad_recibida - it.cantidad_danada - it.cantidad_faltante,
      'cantidad_danada', 0,
      'serials', coalesce((
        select jsonb_agg(jsonb_build_object('serial_id', ts.serial_id, 'resultado', 'ok'))
        from public.transferencia_stock_serials ts
        join public.product_serials ps on ps.id = ts.serial_id
        where ts.transferencia_id = t.id and ts.resultado is null and ps.variant_id = it.variant_id
      ), '[]'::jsonb))), '[]'::jsonb)
    into v_items
    from public.transferencia_stock_items it
    where it.transferencia_id = t.id
      and it.cantidad > it.cantidad_recibida + it.cantidad_danada + it.cantidad_faltante;
  else
    v_items := p_items;
  end if;

  for x in select * from jsonb_array_elements(v_items) loop
    select * into i from public.transferencia_stock_items
     where id = (x->>'item_id')::uuid and transferencia_id = t.id
     for update;
    if i.id is null then
      raise exception 'La línea % no pertenece a la transferencia #%', x->>'item_id', t.numero
        using errcode = 'P0001';
    end if;

    select coalesce(p.control_serial, false) into v_control
    from public.product_variants pv join public.products p on p.id = pv.product_id
    where pv.id = i.variant_id;

    v_ok := 0;
    v_dan := 0;
    v_fal := 0;

    if v_control then
      -- ------------------------------------------------------------------
      -- Serializado: se concilian UNIDADES EXACTAS, nunca números sueltos.
      -- ------------------------------------------------------------------
      for sj in select * from jsonb_array_elements(coalesce(x->'serials', '[]'::jsonb)) loop
        v_sid := (sj->>'serial_id')::uuid;
        v_res := coalesce(sj->>'resultado', 'ok');
        if v_res not in ('ok','danado','faltante') then
          raise exception 'Resultado de IMEI inválido: %', v_res using errcode = 'P0001';
        end if;

        -- El serial tiene que pertenecer a ESTA transferencia, a ESTA línea y
        -- seguir EN VUELO. Un IMEI ajeno, o ya conciliado, se rechaza: es la
        -- barrera contra recibir en el destino B una unidad que viaja hacia C.
        --
        -- T7 (hallazgo de esta auditoría, no estaba en la lista de deuda): el
        -- filtro vigente (_p2_i línea ~941) es sólo (transferencia_id,
        -- serial_id, resultado is null). NO comprueba la variante. En una
        -- transferencia con dos líneas serializadas, mandar el IMEI de la
        -- línea B bajo el item_id de la línea A se aceptaba: el serial se
        -- movía al destino y se contaba en la línea equivocada, pero
        -- sincronizar_stock_serializado se llamaba con i.variant_id (el de A),
        -- así que el inventario de B nunca subía. Resultado: inventory deja de
        -- cuadrar con product_serials — exactamente el invariante P0.2/P0.4
        -- que el despacho de _p1_a se había molestado en cerrar (D1), abierto
        -- otra vez en la recepción. Se cierra uniendo con product_serials.
        update public.transferencia_stock_serials ts
           set resultado = v_res
          from public.product_serials ps
         where ts.transferencia_id = t.id and ts.serial_id = v_sid and ts.resultado is null
           and ps.id = ts.serial_id and ps.variant_id = i.variant_id;
        if not found then
          raise exception 'El IMEI % no está en vuelo en la línea % de la transferencia #% (ni pertenece a su variante): no puede recibirse aquí',
            v_sid, i.id, t.numero using errcode = 'P0001';
        end if;

        -- Transición con el estado ANTERIOR en el WHERE (matriz P0.3).
        if v_res = 'ok' then
          update public.product_serials
             set estado = 'disponible', location_id = t.destino_id, updated_at = now()
           where id = v_sid and estado = 'en_transito';
        elsif v_res = 'danado' then
          -- No existe estado 'dañado' en product_serials y no se inventa uno:
          -- cuarentena ya es el estado de "llegó, no se vende, hay que
          -- resolverlo", y su única salida es resolver_cuarentena_serial.
          update public.product_serials
             set estado = 'cuarentena', location_id = t.destino_id, updated_at = now()
           where id = v_sid and estado = 'en_transito';
        else
          -- No llegó. Se queda contablemente en el ORIGEN, que es de donde se
          -- descontó, y en un estado que NO cuenta como disponible: así el
          -- faltante no resucita stock en ninguna de las dos sucursales.
          update public.product_serials
             set estado = 'faltante', updated_at = now()
           where id = v_sid and estado = 'en_transito';
        end if;
        if not found then
          raise exception 'El IMEI % no estaba en tránsito; no se concilia', v_sid using errcode = 'P0001';
        end if;

        insert into public.transferencia_recepcion_serials(recepcion_id, serial_id, resultado)
        values (v_rec, v_sid, v_res);

        if v_res = 'ok' then v_ok := v_ok + 1;
        elsif v_res = 'danado' then v_dan := v_dan + 1;
        -- T3 · el "no llegó" se CUENTA. Antes se escribía en el serial y en la
        -- fila de la recepción, pero no en el acumulador de la línea, así que
        -- la unidad seguía figurando como pendiente de identificar.
        else v_fal := v_fal + 1;
        end if;
      end loop;

      if v_ok > 0 or v_dan > 0 then
        -- Igual que en el origen: el stock del destino se DERIVA de
        -- product_serials. La cuarentena no cuenta como disponible, así que un
        -- dañado no infla el inventario.
        perform private.sincronizar_stock_serializado(
          i.variant_id, t.destino_id, s.id, 'Transferencia # ' || t.numero || ' recibida');
      end if;
    else
      -- ------------------------------------------------------------------
      -- Sin IMEI: mandan las cantidades. Aquí NO hay faltante en vuelo: sin
      -- unidad concreta que marcar, lo que no llega se declara al cerrar.
      -- ------------------------------------------------------------------
      v_ok  := coalesce((x->>'cantidad_ok')::int, 0);
      v_dan := coalesce((x->>'cantidad_danada')::int, 0);
      if v_ok < 0 or v_dan < 0 then
        raise exception 'Cantidades negativas en la línea %', i.id using errcode = 'P0001';
      end if;

      if v_ok > 0 then
        insert into public.inventory(variant_id, location_id, cantidad)
        values (i.variant_id, t.destino_id, v_ok)
        on conflict (variant_id, location_id)
        do update set cantidad = public.inventory.cantidad + excluded.cantidad, updated_at = now();

        -- Delta REAL: lo que de verdad entró, no lo que se había enviado.
        insert into public.inventory_movements(variant_id, location_id, cantidad_delta, motivo, staff_id)
        values (i.variant_id, t.destino_id, v_ok,
                'Transferencia # ' || t.numero || ' recibida', s.id);
      end if;
      -- Las dañadas NO entran a inventory: nunca fueron stock vendible. Su
      -- rastro queda en la línea y en la auditoría, no en un movimiento falso.
    end if;

    insert into public.transferencia_recepcion_items(recepcion_id, item_id, cantidad_ok, cantidad_danada)
    values (v_rec, i.id, v_ok, v_dan)
    on conflict (recepcion_id, item_id) do update
      set cantidad_ok = public.transferencia_recepcion_items.cantidad_ok + excluded.cantidad_ok,
          cantidad_danada = public.transferencia_recepcion_items.cantidad_danada + excluded.cantidad_danada;

    -- UNA SOLA sentencia: acumula y recalcula el derivado a la vez. Partirla en
    -- dos violaría tsi_sobrante_derivado a mitad de camino y, sobre todo,
    -- abriría un hueco de lost update entre ambas. El faltante entra en esa
    -- misma sentencia por el mismo motivo (T3): leerlo y reescribirlo aparte
    -- perdería el incremento de una recepción concurrente.
    update public.transferencia_stock_items it
       set cantidad_recibida = it.cantidad_recibida + v_ok,
           cantidad_danada   = it.cantidad_danada + v_dan,
           cantidad_faltante = it.cantidad_faltante + v_fal,
           cantidad_sobrante = greatest(0, it.cantidad_recibida + v_ok + it.cantidad_danada + v_dan - it.cantidad),
           estado_linea = case
             when it.cantidad_recibida + v_ok + it.cantidad_danada + v_dan + it.cantidad_faltante + v_fal = 0 then 'pendiente'
             when it.cantidad_recibida + v_ok + it.cantidad_danada + v_dan > it.cantidad then 'con_diferencia'
             when it.cantidad_danada + v_dan > 0 or it.cantidad_faltante + v_fal > 0 then
               case when it.cantidad_recibida + v_ok + it.cantidad_danada + v_dan + it.cantidad_faltante + v_fal = it.cantidad
                    then 'con_diferencia' else 'parcial' end
             when it.cantidad_recibida + v_ok = it.cantidad then 'completa'
             else 'parcial' end
     where it.id = i.id;
  end loop;

  -- ---------------------------------------------------------------------
  -- CIERRE CONSISTENTE
  -- T3 · una línea deja de estar pendiente cuando TODAS sus unidades están
  -- identificadas, y "no llegó" es una identificación tan válida como
  -- "llegó bien" o "llegó dañada". Antes sólo contaban estas dos y la
  -- transferencia se quedaba en recibida_parcial para siempre.
  -- ---------------------------------------------------------------------
  select count(*)::int into v_pendientes
  from public.transferencia_stock_items
  where transferencia_id = t.id
    and cantidad_recibida + cantidad_danada + cantidad_faltante < cantidad;

  if p_cerrar or v_pendientes = 0 then
    -- Lo que no llegó es faltante, y se deja escrito. Asignación ABSOLUTA, no
    -- incremental: cuando todo estaba ya identificado da exactamente el mismo
    -- número que el acumulado (recibida + danada + faltante = cantidad), y en
    -- un cierre forzado es la única forma de dar por perdido lo que nadie marcó.
    update public.transferencia_stock_items
       set cantidad_faltante = greatest(0, cantidad - cantidad_recibida - cantidad_danada),
           estado_linea = case
             when cantidad_recibida = cantidad and cantidad_danada = 0 and cantidad_sobrante = 0
               then 'completa' else 'con_diferencia' end
     where transferencia_id = t.id;

    -- Los IMEI del manifiesto que nadie concilió quedan FALTANTES, no vuelven
    -- a estar disponibles en ningún sitio.
    update public.product_serials ps
       set estado = 'faltante', updated_at = now()
      from public.transferencia_stock_serials ts
     where ts.transferencia_id = t.id and ts.serial_id = ps.id
       and ts.resultado is null and ps.estado = 'en_transito';

    update public.transferencia_stock_serials
       set resultado = 'faltante'
     where transferencia_id = t.id and resultado is null;

    update public.transferencias_stock
       set estado = 'recibida', recibido_por = s.id, fecha_recepcion = now(),
           tiene_diferencias = exists(
             select 1 from public.transferencia_stock_items
             where transferencia_id = t.id and estado_linea = 'con_diferencia')
     where id = t.id
    returning * into t;
  else
    update public.transferencias_stock
       set estado = 'recibida_parcial', recibido_por = s.id
     where id = t.id
    returning * into t;
  end if;

  return public.transferencia_detalle(t.id);
end
$function$;

-- ---------------------------------------------------------------------------
-- 4 · T3 · EL DETALLE DEJA DE MENTIR SOBRE LO PENDIENTE
--
-- Firma EXACTA (_p1_a §6). Único cambio: 'pendiente' descuenta el faltante ya
-- identificado. Con la fórmula vieja, una línea de 5 con 4 recibidas y 1
-- marcada "no llegó" seguía anunciando 1 pendiente que nadie podía recibir.
-- ---------------------------------------------------------------------------

create or replace function public.transferencia_detalle(p_transferencia_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'private'
as $function$
  select jsonb_build_object(
    'id', t.id,
    'numero', t.numero,
    'estado', t.estado,
    'tiene_diferencias', t.tiene_diferencias,
    'origen_id', t.origen_id,
    'destino_id', t.destino_id,
    'lineas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_id', it.id,
        'variant_id', it.variant_id,
        'cantidad_enviada', it.cantidad,
        'cantidad_recibida', it.cantidad_recibida,
        'cantidad_danada', it.cantidad_danada,
        'cantidad_faltante', it.cantidad_faltante,
        'cantidad_sobrante', it.cantidad_sobrante,
        'pendiente', greatest(0, it.cantidad - it.cantidad_recibida - it.cantidad_danada - it.cantidad_faltante),
        'estado_linea', it.estado_linea,
        'seriales', coalesce((
          select jsonb_agg(jsonb_build_object(
            'serial_id', ps.id, 'serial_number', ps.serial_number,
            'resultado', ts.resultado, 'estado', ps.estado) order by ps.serial_number)
          from public.transferencia_stock_serials ts
          join public.product_serials ps on ps.id = ts.serial_id
          where ts.transferencia_id = t.id and ps.variant_id = it.variant_id), '[]'::jsonb)
      ) order by it.id)
      from public.transferencia_stock_items it where it.transferencia_id = t.id), '[]'::jsonb)
  )
  from public.transferencias_stock t
  where t.id = p_transferencia_id
    and (private.auth_is_admin()
         or t.origen_id = private.auth_location_id()
         or t.destino_id = private.auth_location_id());
$function$;

-- ---------------------------------------------------------------------------
-- 5 · PRIVILEGIOS
--
-- crear_transferencia_stock es una función NUEVA (cambió la lista de
-- argumentos), así que nace con EXECUTE para PUBLIC —y por tanto para anon—
-- por el privilegio por omisión de PostgreSQL. Se repone EXACTAMENTE la ACL
-- efectiva de la firma vieja: sin PUBLIC, sin anon, con authenticated. Sin
-- este bloque, el invariante de P0.4 "0 SECURITY DEFINER ejecutables por anon"
-- se rompe en la migración siguiente y nadie se entera hasta el ensayo.
-- Las otras dos conservan su ACL (CREATE OR REPLACE no la toca); se repiten
-- igualmente para no depender de ese detalle.
-- ---------------------------------------------------------------------------

revoke all on function public.crear_transferencia_stock(uuid, jsonb, text, uuid) from public;
revoke all on function public.crear_transferencia_stock(uuid, jsonb, text, uuid) from anon;
revoke all on function public.recibir_transferencia_parcial(uuid, uuid, jsonb, text, boolean) from public;
revoke all on function public.transferencia_detalle(uuid) from public;

grant execute on function public.crear_transferencia_stock(uuid, jsonb, text, uuid) to authenticated;
grant execute on function public.recibir_transferencia_parcial(uuid, uuid, jsonb, text, boolean) to authenticated;
grant execute on function public.transferencia_detalle(uuid) to authenticated;
