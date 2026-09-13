-- ============================================================================
-- P1.A — FASE 13: TRANSFERENCIAS PARCIALES
--
-- ESTADO ANTERIOR (verificado contra producción con pg_get_functiondef):
--   transferencia_stock_items tenía UNA sola `cantidad`. La recepción era
--   todo-o-nada: `recibir_transferencia_stock` sumaba `i.cantidad` al destino
--   y marcaba la cabecera 'recibida'. No existía faltante, sobrante, dañado,
--   estado por línea ni clave de idempotencia.
--
-- TRES DEFECTOS REALES QUE ESTA MIGRACIÓN CIERRA, más allá de la parcialidad:
--
--   D1 · DESPACHO QUE DESINCRONIZA EL STOCK SERIALIZADO.
--        `despachar_transferencia_stock` restaba `i.cantidad` de inventory y
--        por separado hacía
--            update product_serials set estado='en_transito' ... and estado='disponible'
--        SIN comprobar cuántas filas movió. Si un IMEI del manifiesto se vendía
--        entre la creación y el despacho, inventory bajaba N pero sólo N-1
--        seriales viajaban: inventory dejaba de cuadrar con product_serials,
--        que es justo el invariante de P0.2/P0.4. Ahora se cuenta lo movido, se
--        exige que coincida con la línea, y el stock del origen se DERIVA con
--        private.sincronizar_stock_serializado (que bloquea inventory antes de
--        contar), no con un delta fijo.
--
--   D2 · RECEPCIÓN SERIALIZADA CON DELTA FIJO.
--        La recepción sumaba `i.cantidad` al destino y aparte movía los
--        seriales. Con recepción parcial eso se vuelve insostenible: el stock
--        serializado del destino se deriva ahora de product_serials, igual que
--        en el origen.
--
--   D3 · UN IMEI NO PODÍA VOLVER NUNCA.
--        transferencia_stock_serials tenía UNIQUE(serial_id) de por vida: una
--        unidad transferida de A a B no podía transferirse jamás de vuelta.
--        Se sustituye por un índice único PARCIAL sobre los seriales todavía
--        EN VUELO (resultado is null). Esa es la invariante que de verdad
--        importa —un IMEI no puede estar en dos transferencias abiertas a la
--        vez, es decir, en dos ubicaciones— y además desbloquea el retorno.
--
-- IDEMPOTENCIA: toda recepción exige `client_transaction_id`. La recepción se
-- ancla en public.transferencia_recepciones con UNIQUE(transferencia_id,
-- client_transaction_id); el segundo envío con la misma clave hace conflicto,
-- no aplica NADA y devuelve el estado vigente. Ya no basta con la máquina de
-- estados: con parciales la transferencia sigue 'en_transito' entre recepciones
-- y un doble clic SÍ habría duplicado stock.
--
-- CONCURRENCIA: la primera sentencia útil de la recepción es
--   select * from transferencias_stock where id=... for update
-- Ese es el punto de serialización. Dos recepciones simultáneas de la misma
-- transferencia se ponen en fila; la segunda, ya con el commit de la primera
-- visible, ve el conflicto de la clave idempotente (misma clave) o aplica su
-- propio delta sobre la fila ya actualizada (claves distintas). En ningún caso
-- hay lost update, porque los acumuladores de la línea se escriben con una
-- ÚNICA sentencia `set x = x + delta`.
--
-- PERMISOS POR SUCURSAL, EN SERVIDOR: origen despacha, destino recibe. Se
-- valida dentro de la función SECURITY DEFINER contra auth.uid(), nunca desde
-- el cliente. Se usa private.auth_location_id() (que honra active_location_id)
-- con caída a staff.location_id, para dejar de contradecir a las policies RLS
-- de estas mismas tablas, que ya usaban auth_location_id().
--
-- MATRIZ DE IMEI (P0.3/P0.4): toda transición lleva el estado ANTERIOR en el
-- WHERE. 'en_transito' -> 'disponible' (llegó bien), -> 'cuarentena' (llegó
-- dañado; la única puerta de vuelta sigue siendo resolver_cuarentena_serial),
-- -> 'faltante' (no llegó). Ninguna ruta resucita stock: 'cuarentena' y
-- 'faltante' no cuentan como 'disponible', así que la sincronización no los
-- suma. 'dañado' NO se añade al check de product_serials.estado: se mapea a
-- 'cuarentena', que ya existe y ya tiene flujo de resolución.
--
-- FORWARD-ONLY: no se toca ninguna migración ya aplicada. Las funciones se
-- recrean con su firma EXACTA (mismo nombre de parámetro y mismo tipo de
-- retorno) para REEMPLAZARLAS y no crear una sobrecarga nueva, que fue el
-- desastre de P0.2.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 · CANTIDADES Y ESTADO POR LÍNEA
-- `cantidad` conserva su significado: unidades ENVIADAS (lo que salió del
-- origen). Los acumuladores nuevos describen lo que ocurrió al recibir.
-- ---------------------------------------------------------------------------

alter table public.transferencia_stock_items
  add column if not exists cantidad_recibida integer not null default 0,
  add column if not exists cantidad_danada   integer not null default 0,
  add column if not exists cantidad_faltante integer not null default 0,
  add column if not exists cantidad_sobrante integer not null default 0,
  add column if not exists estado_linea      text    not null default 'pendiente';

comment on column public.transferencia_stock_items.cantidad is
  'Unidades ENVIADAS: lo que salió del origen al despachar.';
comment on column public.transferencia_stock_items.cantidad_recibida is
  'Unidades que llegaron en buen estado y entraron al inventario del destino.';
comment on column public.transferencia_stock_items.cantidad_danada is
  'Unidades que llegaron dañadas. NO entran al inventario disponible; los IMEI van a cuarentena.';
comment on column public.transferencia_stock_items.cantidad_faltante is
  'Unidades que nunca llegaron. Se fija al cerrar la transferencia.';
comment on column public.transferencia_stock_items.cantidad_sobrante is
  'Unidades recibidas por encima de lo enviado. Derivado, no se escribe a mano.';

alter table public.transferencia_stock_items drop constraint if exists tsi_cantidades_no_negativas;
alter table public.transferencia_stock_items add constraint tsi_cantidades_no_negativas
  check (cantidad_recibida >= 0 and cantidad_danada >= 0
     and cantidad_faltante >= 0 and cantidad_sobrante >= 0);

-- El sobrante no es un campo libre: es exactamente el exceso sobre lo enviado.
-- Con esta comprobación, cualquier escritura que intente inventar un sobrante
-- —o que olvide recalcularlo— revienta en la base, no en la aplicación.
alter table public.transferencia_stock_items drop constraint if exists tsi_sobrante_derivado;
alter table public.transferencia_stock_items add constraint tsi_sobrante_derivado
  check (cantidad_sobrante = greatest(0, cantidad_recibida + cantidad_danada - cantidad));

alter table public.transferencia_stock_items drop constraint if exists tsi_faltante_acotado;
alter table public.transferencia_stock_items add constraint tsi_faltante_acotado
  check (cantidad_faltante <= cantidad);

alter table public.transferencia_stock_items drop constraint if exists tsi_estado_linea_check;
alter table public.transferencia_stock_items add constraint tsi_estado_linea_check
  check (estado_linea in ('pendiente','parcial','completa','con_diferencia'));

-- ---------------------------------------------------------------------------
-- 2 · ESTADO DE CABECERA: se añade 'recibida_parcial'
-- El nombre del check es el que PostgreSQL generó al crear la tabla inline; se
-- descubre en vez de asumirse, para que la migración no dependa de ese detalle.
-- ---------------------------------------------------------------------------

do $$
declare c text;
begin
  select conname into c
  from pg_constraint
  where conrelid = 'public.transferencias_stock'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%borrador%';
  if c is not null then
    execute format('alter table public.transferencias_stock drop constraint %I', c);
  end if;
end $$;

alter table public.transferencias_stock add constraint transferencias_stock_estado_check
  check (estado in ('borrador','en_transito','recibida_parcial','recibida','cancelada'));

alter table public.transferencias_stock
  add column if not exists tiene_diferencias boolean not null default false;

comment on column public.transferencias_stock.tiene_diferencias is
  'True si al cerrar hubo faltante, sobrante o dañado en alguna línea.';

-- ---------------------------------------------------------------------------
-- 3 · SERIALES: resultado por unidad y unicidad SÓLO EN VUELO (D3)
-- ---------------------------------------------------------------------------

alter table public.transferencia_stock_serials
  add column if not exists resultado text;

alter table public.transferencia_stock_serials drop constraint if exists tss_resultado_check;
alter table public.transferencia_stock_serials add constraint tss_resultado_check
  check (resultado is null or resultado in ('ok','danado','faltante'));

comment on column public.transferencia_stock_serials.resultado is
  'NULL = la unidad sigue EN VUELO (reservada por esta transferencia). ok/danado/faltante = ya conciliada.';

-- Se retira la unicidad de por vida y se sustituye por la unicidad entre las
-- transferencias abiertas. Se descubre el nombre en vez de asumirlo.
do $$
declare c text;
begin
  select conname into c
  from pg_constraint
  where conrelid = 'public.transferencia_stock_serials'::regclass
    and contype = 'u'
    and pg_get_constraintdef(oid) = 'UNIQUE (serial_id)';
  if c is not null then
    execute format('alter table public.transferencia_stock_serials drop constraint %I', c);
  end if;
end $$;

-- UN IMEI NO PUEDE ESTAR EN DOS UBICACIONES: no puede estar en vuelo en dos
-- transferencias a la vez. Este índice lo impide en la base, no en el código.
create unique index if not exists tss_serial_en_vuelo
  on public.transferencia_stock_serials(serial_id) where resultado is null;

-- ---------------------------------------------------------------------------
-- 4 · RECEPCIONES: el evento, y con él la clave de idempotencia
-- ---------------------------------------------------------------------------

create table if not exists public.transferencia_recepciones(
  id uuid primary key default gen_random_uuid(),
  transferencia_id uuid not null references public.transferencias_stock(id) on delete cascade,
  client_transaction_id uuid not null,
  recibido_por uuid not null references public.staff(id),
  fecha timestamptz not null default now(),
  observacion text,
  es_cierre boolean not null default false,
  -- T2 · huella de la petición. Sin ella, la misma clave con OTRO contenido se
  -- tomaba por reintento: la recepción nueva no se aplicaba y el cliente recibía
  -- el detalle como si hubiera entrado.
  payload_hash text not null,
  unique (transferencia_id, client_transaction_id)
);

comment on table public.transferencia_recepciones is
  'Una fila por recepción aplicada. UNIQUE(transferencia_id, client_transaction_id) es la idempotencia; payload_hash distingue un reintento legítimo (mismo contenido) de una clave reutilizada con contenido distinto, que se rechaza.';

-- T2 · huella canónica de una PETICIÓN de recepción de transferencia.
-- Se ordenan las líneas por item_id y los seriales por serial_id, y se
-- normalizan los valores por omisión, para que el mismo envío dé siempre la
-- misma huella. p_items NULL ("recibir todo lo pendiente") lleva su propia marca
-- y no se confunde con '[]', que es lo que manda cerrar_transferencia_stock.
create or replace function private.hash_transferencia_recepcion(
  p_items jsonb, p_cerrar boolean, p_observacion text
) returns text
language sql
immutable
set search_path to 'public', 'private'
as $function$
  select md5(jsonb_build_object(
    'cerrar', coalesce(p_cerrar, false),
    'observacion', nullif(btrim(coalesce(p_observacion, '')), ''),
    'items', case
      when p_items is null then to_jsonb('todo_lo_pendiente'::text)
      else coalesce((
        select jsonb_agg(jsonb_build_object(
                 'item_id', e->>'item_id',
                 'cantidad_ok', coalesce(e->>'cantidad_ok', '0'),
                 'cantidad_danada', coalesce(e->>'cantidad_danada', '0'),
                 'serials', coalesce((
                   select jsonb_agg(jsonb_build_object(
                            'serial_id', sj->>'serial_id',
                            'resultado', coalesce(sj->>'resultado', 'ok'))
                          order by sj->>'serial_id')
                   from jsonb_array_elements(coalesce(e->'serials', '[]'::jsonb)) sj), '[]'::jsonb))
               order by e->>'item_id')
        from jsonb_array_elements(p_items) e), '[]'::jsonb)
    end
  )::text)
$function$;

-- Sólo se invoca desde recibir_transferencia_parcial (SECURITY DEFINER). Basta con
-- quitar el EXECUTE heredado por PUBLIC: anon y authenticated no tienen USAGE
-- sobre `private`.
revoke all on function private.hash_transferencia_recepcion(jsonb, boolean, text) from public;

create table if not exists public.transferencia_recepcion_items(
  id uuid primary key default gen_random_uuid(),
  recepcion_id uuid not null references public.transferencia_recepciones(id) on delete cascade,
  item_id uuid not null references public.transferencia_stock_items(id) on delete cascade,
  cantidad_ok integer not null default 0 check (cantidad_ok >= 0),
  cantidad_danada integer not null default 0 check (cantidad_danada >= 0),
  unique (recepcion_id, item_id)
);

create table if not exists public.transferencia_recepcion_serials(
  recepcion_id uuid not null references public.transferencia_recepciones(id) on delete cascade,
  serial_id uuid not null references public.product_serials(id),
  resultado text not null check (resultado in ('ok','danado','faltante')),
  primary key (recepcion_id, serial_id)
);

create index if not exists idx_transf_recepciones_transferencia
  on public.transferencia_recepciones(transferencia_id);

alter table public.transferencia_recepciones       enable row level security;
alter table public.transferencia_recepcion_items   enable row level security;
alter table public.transferencia_recepcion_serials enable row level security;

-- Sólo lectura, y sólo para las sucursales implicadas. Toda escritura pasa por
-- las funciones SECURITY DEFINER de más abajo.
drop policy if exists transf_recepciones_read on public.transferencia_recepciones;
create policy transf_recepciones_read on public.transferencia_recepciones
  for select to authenticated using (exists(
    select 1 from public.transferencias_stock t
    where t.id = transferencia_id
      and (private.auth_is_admin() or t.origen_id = private.auth_location_id()
           or t.destino_id = private.auth_location_id())));

drop policy if exists transf_recepcion_items_read on public.transferencia_recepcion_items;
create policy transf_recepcion_items_read on public.transferencia_recepcion_items
  for select to authenticated using (exists(
    select 1 from public.transferencia_recepciones r
    join public.transferencias_stock t on t.id = r.transferencia_id
    where r.id = recepcion_id
      and (private.auth_is_admin() or t.origen_id = private.auth_location_id()
           or t.destino_id = private.auth_location_id())));

drop policy if exists transf_recepcion_serials_read on public.transferencia_recepcion_serials;
create policy transf_recepcion_serials_read on public.transferencia_recepcion_serials
  for select to authenticated using (exists(
    select 1 from public.transferencia_recepciones r
    join public.transferencias_stock t on t.id = r.transferencia_id
    where r.id = recepcion_id
      and (private.auth_is_admin() or t.origen_id = private.auth_location_id()
           or t.destino_id = private.auth_location_id())));

-- Grants a NIVEL DE TABLA, no por columna. products usa grants por columna y
-- por eso allí una columna nueva nace invisible para authenticated; estas
-- tablas no, y se dejan explícitamente a nivel de tabla para que siga así.
grant select on public.transferencia_recepciones       to authenticated;
grant select on public.transferencia_recepcion_items   to authenticated;
grant select on public.transferencia_recepcion_serials to authenticated;
grant select on public.transferencia_stock_items       to authenticated;
grant select on public.transferencia_stock_serials     to authenticated;
grant select on public.transferencias_stock            to authenticated;

-- Auditoría del evento de recepción y de los acumuladores de cada línea.
drop trigger if exists audit_transferencia_recepciones on public.transferencia_recepciones;
create trigger audit_transferencia_recepciones
  after insert or update or delete on public.transferencia_recepciones
  for each row execute function private.registrar_auditoria();

drop trigger if exists audit_transferencia_stock_items on public.transferencia_stock_items;
create trigger audit_transferencia_stock_items
  after insert or update or delete on public.transferencia_stock_items
  for each row execute function private.registrar_auditoria();

-- ---------------------------------------------------------------------------
-- 5 · DESPACHO (firma EXACTA de producción: p_transferencia_id uuid ->
--     public.transferencias_stock). Cierra D1.
-- ---------------------------------------------------------------------------

create or replace function public.despachar_transferencia_stock(p_transferencia_id uuid)
returns public.transferencias_stock
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  s public.staff;
  t public.transferencias_stock;
  i public.transferencia_stock_items;
  v_loc uuid;
  v_control boolean;
  v_movidos int;
  v_manifiesto int;
begin
  select * into s from public.staff where user_id = auth.uid() and activo = true limit 1;
  if s.id is null or not(s.rol = 'administrador' or coalesce(s.puesto,'') in ('tecnico','encargado','jefa')) then
    raise exception 'Sin permiso' using errcode = '42501';
  end if;
  v_loc := coalesce(private.auth_location_id(), s.location_id);

  -- Punto de serialización. Todo lo demás ocurre con la cabecera bloqueada.
  select * into t from public.transferencias_stock where id = p_transferencia_id for update;
  if t.id is null then
    raise exception 'Transferencia inexistente' using errcode = 'P0001';
  end if;

  -- PERMISO POR SUCURSAL EN SERVIDOR: despacha el ORIGEN.
  -- Fallo CERRADO. `<>` con v_loc NULL da NULL, el IF no salta y un operativo
  -- sin sucursal despacharía cualquier transferencia (T1).
  if v_loc is null or t.origen_id is distinct from v_loc then
    raise exception 'Solo la sucursal de origen puede despachar la transferencia #%', t.numero
      using errcode = '42501';
  end if;

  -- IDEMPOTENCIA del despacho: un segundo clic no vuelve a descontar stock.
  if t.estado in ('en_transito','recibida_parcial','recibida') then
    return t;
  end if;
  if t.estado <> 'borrador' then
    raise exception 'Transferencia no despachable (estado %)', t.estado using errcode = 'P0001';
  end if;

  for i in select * from public.transferencia_stock_items where transferencia_id = t.id order by id loop
    select coalesce(p.control_serial, false) into v_control
    from public.product_variants pv join public.products p on p.id = pv.product_id
    where pv.id = i.variant_id;

    if v_control then
      select count(*)::int into v_manifiesto
      from public.transferencia_stock_serials ts
      join public.product_serials ps on ps.id = ts.serial_id
      where ts.transferencia_id = t.id and ps.variant_id = i.variant_id;

      -- Se mueven las unidades EXACTAS del manifiesto y se cuenta cuántas se
      -- movieron de verdad. Sin este conteo vivía D1.
      with movidos as (
        update public.product_serials ps
           set estado = 'en_transito', updated_at = now()
          from public.transferencia_stock_serials ts
         where ts.transferencia_id = t.id
           and ts.serial_id = ps.id
           and ts.resultado is null
           and ps.variant_id = i.variant_id
           and ps.location_id = t.origen_id
           and ps.estado = 'disponible'     -- estado anterior en el WHERE (matriz P0.3)
        returning ps.id
      )
      select count(*)::int into v_movidos from movidos;

      if v_manifiesto <> i.cantidad or v_movidos <> i.cantidad then
        raise exception
          'Transferencia #%: la línea pide % unidad(es) con IMEI, el manifiesto tiene % y sólo % siguen disponibles en el origen. Se aborta para no desincronizar inventory de product_serials.',
          t.numero, i.cantidad, v_manifiesto, v_movidos using errcode = 'P0001';
      end if;

      -- El stock serializado se DERIVA de product_serials, nunca de un delta
      -- fijo. Esta función bloquea inventory ANTES de contar (invariante P0.4)
      -- y registra el delta REAL.
      perform private.sincronizar_stock_serializado(
        i.variant_id, t.origen_id, s.id, 'Transferencia # ' || t.numero || ' despachada');
    else
      update public.inventory
         set cantidad = cantidad - i.cantidad, updated_at = now()
       where variant_id = i.variant_id and location_id = t.origen_id and cantidad >= i.cantidad;
      if not found then
        raise exception 'Stock insuficiente para la transferencia #% (variante %)', t.numero, i.variant_id
          using errcode = 'P0001';
      end if;
      insert into public.inventory_movements(variant_id, location_id, cantidad_delta, motivo, staff_id)
      values (i.variant_id, t.origen_id, -i.cantidad,
              'Transferencia # ' || t.numero || ' despachada', s.id);
    end if;
  end loop;

  update public.transferencias_stock
     set estado = 'en_transito', despachado_por = s.id, fecha_despacho = now()
   where id = t.id
  returning * into t;
  return t;
end
$function$;

-- ---------------------------------------------------------------------------
-- 6 · DETALLE: lo que la UI necesita para pintar enviada/recibida/faltante/
--     sobrante/dañada sin poder leer nada de otra sucursal.
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
        'pendiente', greatest(0, it.cantidad - it.cantidad_recibida - it.cantidad_danada),
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
-- 7 · RECEPCIÓN PARCIAL — el corazón de la fase
--
-- p_items: [{ item_id, cantidad_ok, cantidad_danada,
--             serials:[{serial_id, resultado:'ok'|'danado'|'faltante'}] }]
--   · Producto con IMEI: las cantidades se DERIVAN de `serials`; lo que mande
--     el cliente en cantidad_ok/cantidad_danada se ignora. El operador
--     identifica unidades, no números.
--   · Producto sin IMEI: mandan las cantidades.
--   · p_items NULL = "recibir todo lo pendiente como correcto".
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
  if s.id is null or not(s.rol = 'administrador' or coalesce(s.puesto,'') in ('tecnico','encargado','jefa')) then
    raise exception 'Sin permiso' using errcode = '42501';
  end if;
  v_loc := coalesce(private.auth_location_id(), s.location_id);

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
  if p_items is null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'item_id', it.id,
      'cantidad_ok', it.cantidad - it.cantidad_recibida - it.cantidad_danada,
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
      and it.cantidad > it.cantidad_recibida + it.cantidad_danada;
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

        -- El serial tiene que pertenecer a ESTA transferencia y seguir EN
        -- VUELO. Un IMEI ajeno, o ya conciliado, se rechaza: es la barrera
        -- contra recibir en el destino B una unidad que viaja hacia C.
        update public.transferencia_stock_serials
           set resultado = v_res
         where transferencia_id = t.id and serial_id = v_sid and resultado is null;
        if not found then
          raise exception 'El IMEI % no está en vuelo en la transferencia #%: no puede recibirse aquí', v_sid, t.numero
            using errcode = 'P0001';
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
      -- Sin IMEI: mandan las cantidades.
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
    -- abriría un hueco de lost update entre ambas.
    update public.transferencia_stock_items it
       set cantidad_recibida = it.cantidad_recibida + v_ok,
           cantidad_danada   = it.cantidad_danada + v_dan,
           cantidad_sobrante = greatest(0, it.cantidad_recibida + v_ok + it.cantidad_danada + v_dan - it.cantidad),
           estado_linea = case
             when it.cantidad_recibida + v_ok + it.cantidad_danada + v_dan = 0 then 'pendiente'
             when it.cantidad_recibida + v_ok + it.cantidad_danada + v_dan > it.cantidad then 'con_diferencia'
             when it.cantidad_danada + v_dan > 0 then
               case when it.cantidad_recibida + v_ok + it.cantidad_danada + v_dan = it.cantidad
                    then 'con_diferencia' else 'parcial' end
             when it.cantidad_recibida + v_ok = it.cantidad then 'completa'
             else 'parcial' end
     where it.id = i.id;
  end loop;

  -- ---------------------------------------------------------------------
  -- CIERRE CONSISTENTE
  -- ---------------------------------------------------------------------
  select count(*)::int into v_pendientes
  from public.transferencia_stock_items
  where transferencia_id = t.id and cantidad_recibida + cantidad_danada < cantidad;

  if p_cerrar or v_pendientes = 0 then
    -- Lo que no llegó es faltante, y se deja escrito.
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
-- 8 · CIERRE EXPLÍCITO: se da por perdido lo que falta.
-- ---------------------------------------------------------------------------

create or replace function public.cerrar_transferencia_stock(
  p_transferencia_id uuid,
  p_client_transaction_id uuid,
  p_observacion text default null
)
returns jsonb
language sql
security definer
set search_path to 'public', 'private'
as $function$
  select public.recibir_transferencia_parcial(
    p_transferencia_id, p_client_transaction_id, '[]'::jsonb, p_observacion, true);
$function$;

-- ---------------------------------------------------------------------------
-- 9 · COMPATIBILIDAD: recibir_transferencia_stock(uuid) conserva su firma
--     EXACTA —mismo nombre de parámetro, mismo tipo de retorno— para que esto
--     REEMPLACE la función y no cree una sobrecarga. Ahora delega en la
--     recepción parcial pidiendo el cierre: recibe todo lo pendiente y cierra.
-- ---------------------------------------------------------------------------

create or replace function public.recibir_transferencia_stock(p_transferencia_id uuid)
returns public.transferencias_stock
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare t public.transferencias_stock;
begin
  perform public.recibir_transferencia_parcial(
    p_transferencia_id, gen_random_uuid(), null, null, true);
  select * into t from public.transferencias_stock where id = p_transferencia_id;
  return t;
end
$function$;

-- Estas cinco son SECURITY DEFINER. Una función NUEVA nace con EXECUTE para
-- PUBLIC (y por tanto para anon). El ensayo compuesto lo detectó: tras esta
-- migración, anon podía ejecutar recibir_transferencia_parcial,
-- cerrar_transferencia_stock y transferencia_detalle con privilegios de dueño,
-- rompiendo el invariante de P0.4 "0 SECURITY DEFINER ejecutables por anon".
-- despachar/recibir_transferencia_stock ya existían con anon revocado y
-- CREATE OR REPLACE conserva su ACL; se revocan igual para no depender de ello.
-- Se revoca de PUBLIC (la vía por la que anon lo recibe) y se concede
-- explícitamente a authenticated.
revoke all on function public.despachar_transferencia_stock(uuid) from public;
revoke all on function public.recibir_transferencia_stock(uuid) from public;
revoke all on function public.recibir_transferencia_parcial(uuid, uuid, jsonb, text, boolean) from public;
revoke all on function public.cerrar_transferencia_stock(uuid, uuid, text) from public;
revoke all on function public.transferencia_detalle(uuid) from public;

grant execute on function public.despachar_transferencia_stock(uuid) to authenticated;
grant execute on function public.recibir_transferencia_stock(uuid) to authenticated;
grant execute on function public.recibir_transferencia_parcial(uuid, uuid, jsonb, text, boolean) to authenticated;
grant execute on function public.cerrar_transferencia_stock(uuid, uuid, text) to authenticated;
grant execute on function public.transferencia_detalle(uuid) to authenticated;
