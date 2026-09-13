-- P1.D — Fase 18: pagos y conciliación.
--
-- Estado de partida (verificado contra producción `fbwkclpgnsxuqycazumj`,
-- leyendo pg_get_functiondef; las tres funciones vivas coinciden byte a byte
-- con 20260824145525 / 20260824151006 / 20260824151437, no hay deriva):
--
--   G1  `conciliar_pago_admin` NO comprueba el estado previo. Una fila ya
--       'conciliado' se vuelve a escribir entera —monto_confirmado,
--       referencia_proveedor, conciliado_por, conciliado_at— cuantas veces se
--       llame. El requisito duro "un pago no puede conciliarse dos veces" no
--       estaba implementado en ninguna parte.
--   G2  `referencia_proveedor` es texto libre SIN unicidad. La misma referencia
--       de Culqi/POS se podía aceptar en dos conciliaciones distintas: es
--       exactamente el doble cobro que la conciliación existe para detectar.
--   G3  `fecha_venta` se recalcula como `(sales.fecha at time zone 'America/Lima')::date`
--       en cada sincronización, en paralelo a `sales.business_date` (que P0.2
--       ya calcula por trigger). Dos fuentes de verdad para el mismo día
--       comercial: si una venta se corrige, divergen sin avisar.
--   G4  La sincronización no distingue `sales.is_test`. Las ventas QA de P0.4
--       entraban en las cifras de conciliación como ventas reales.
--   G5  `estado='rechazado'` escribía `monto_confirmado = monto_esperado` (por
--       el `coalesce`), o sea: "el proveedor confirmó el importe completo" en
--       un pago RECHAZADO. El importe esperado se conservaba, pero el
--       confirmado mentía y `monto_diferencia` salía 0.
--   G6  `conciliar_pago_admin` y `sincronizar_...` filtran por `staff.location_id`
--       mientras la policy RLS de la tabla filtra por `private.auth_location_id()`
--       (que prefiere `active_location_id`). Un admin multi-sucursal escribía
--       filas de una sucursal que después no podía leer.
--   G7  `conciliar_pago_admin` barría 365 días de ventas (`sincronizar_...`) en
--       CADA llamada, antes de tomar el lock, y ese barrido hacía
--       `on conflict do update set fecha_venta` sobre filas ya conciliadas.
--   G8  El auto-conciliador de Culqi podía aplicar el MISMO `culqi_order_id` a
--       varias conciliaciones dentro del mismo lote.
--   G9  Pago mixto: `registrar_venta` no valida que la suma de `payments`
--       cuadre con `sales.total`. No se toca aquí (no es de este squad), pero
--       la conciliación ahora lo DETECTA y lo reporta.
--
-- Invariantes que esta migración establece:
--   I1  Un pago aceptado no se concilia dos veces: reintento idéntico ->
--       idempotente (devuelve la fila sin reescribirla); reintento distinto ->
--       excepción. Bajo concurrencia lo garantiza el `for update` de la fila.
--   I2  La misma (proveedor, referencia) no se acepta dos veces: comprobación
--       explícita con mensaje útil + índice único parcial como respaldo duro,
--       que es el que aguanta la carrera entre dos transacciones.
--   I3  `fecha_venta` SIEMPRE = `sales.business_date` (America/Lima, calculado
--       server-side por el trigger de P0.2). Lo impone un trigger BEFORE que
--       ignora lo que mande el cliente. Nunca `created_at`, nunca la fecha UTC
--       del navegador.
--   I4  Las ventas `is_test` quedan fuera de todas las cifras.
--   I5  `monto_esperado` es inmutable en rechazo y en diferencia.
--
-- Forward-only. No toca ninguna migración ya aplicada.

-- ---------------------------------------------------------------------------
-- 1. Columnas derivadas de la venta.
-- ---------------------------------------------------------------------------
-- Todas se rellenan server-side desde `sales`; ninguna es editable por el
-- cliente. `venta_at` da la HORA real de la venta (la pantalla la necesita
-- para cotejar contra el voucher del POS, y es lo que distingue dos pagos del
-- mismo importe en el mismo día). `cash_session_id` es la mejor atribución de
-- terminal/turno disponible hoy: `sales` no tiene `pos_device_id` (ver el
-- informe: queda como gap abierto, no se inventa aquí).

alter table public.conciliaciones_pago
  add column if not exists is_test boolean not null default false,
  add column if not exists venta_at timestamptz,
  add column if not exists cash_session_id uuid references public.cash_sessions(id),
  add column if not exists monto_venta numeric(14,2);

comment on column public.conciliaciones_pago.fecha_venta is
  'Día comercial (America/Lima) copiado de sales.business_date por trigger. NUNCA created_at ni la fecha UTC del cliente.';
comment on column public.conciliaciones_pago.is_test is
  'Espejo de sales.is_test. Las filas en true se excluyen de todas las cifras (P0.4).';
comment on column public.conciliaciones_pago.monto_venta is
  'Total de la venta, para cuadrar pago mixto: sum(payments.monto) debe igualar este total.';

-- ---------------------------------------------------------------------------
-- 2. I3 + I4 — el día comercial y la marca QA se derivan, no se reciben.
-- ---------------------------------------------------------------------------
create or replace function private.conciliacion_pago_deriva_venta()
returns trigger
language plpgsql
security definer
set search_path='public','private'
as $function$
declare v public.sales;
begin
  -- SECURITY DEFINER: el trigger tiene que poder leer `sales` aunque quien
  -- escriba sea `authenticated` con RLS activo.
  select * into v from public.sales where id = new.sale_id;
  if v.id is null then
    raise exception 'Conciliación sin venta asociada (sale_id=%)', new.sale_id;
  end if;

  -- Fuente de verdad única. Si alguien intenta insertar/actualizar con otra
  -- fecha_venta (un cliente con el reloj en UTC, por ejemplo), se descarta.
  new.location_id     := v.location_id;
  new.fecha_venta     := v.business_date;
  new.venta_at        := v.fecha;
  new.is_test         := v.is_test;
  new.cash_session_id := v.cash_session_id;
  new.monto_venta     := v.total;
  return new;
end
$function$;

revoke all on function private.conciliacion_pago_deriva_venta() from public, anon;

drop trigger if exists trg_conciliacion_pago_deriva_venta on public.conciliaciones_pago;
create trigger trg_conciliacion_pago_deriva_venta
  before insert or update on public.conciliaciones_pago
  for each row execute function private.conciliacion_pago_deriva_venta();

-- Realineación única de las filas ya existentes contra la venta. NO toca
-- `estado` de nadie: sólo copia business_date/is_test/hora/total. Sobre las 2
-- conciliaciones pendientes de producción es un no-op comprobado
-- (fecha_venta ya coincide con business_date en ambas).
update public.conciliaciones_pago c
set updated_at = c.updated_at
from public.sales s
where s.id = c.sale_id;

-- ---------------------------------------------------------------------------
-- 3. I2 — una referencia de proveedor no se acepta dos veces.
-- ---------------------------------------------------------------------------
-- Parcial y sólo sobre estados ACEPTADOS: un pago rechazado no consume la
-- referencia, y las filas pendientes (referencia nula) no entran. La unicidad
-- es global, no por sucursal, a propósito: un `culqi_order_id` es único en el
-- mundo del proveedor, y limitarla a la sucursal permitiría cobrar la misma
-- operación en dos tiendas.
create unique index if not exists conciliaciones_pago_referencia_proveedor_uniq
  on public.conciliaciones_pago (
    lower(btrim(coalesce(proveedor,''))),
    upper(btrim(referencia_proveedor))
  )
  where referencia_proveedor is not null
    and btrim(referencia_proveedor) <> ''
    and estado in ('conciliado','diferencia');

create index if not exists conciliaciones_pago_fecha_negocio_idx
  on public.conciliaciones_pago (location_id, fecha_venta, estado)
  where not is_test;

-- ---------------------------------------------------------------------------
-- 4. Alta de conciliaciones. MISMA FIRMA (timestamptz, timestamptz).
-- ---------------------------------------------------------------------------
-- Firma verificada en producción:
--   sincronizar_conciliaciones_pago_admin(timestamp with time zone, timestamp with time zone)
-- Un CREATE OR REPLACE con otra lista de parámetros crearía una SOBRECARGA
-- nueva y dejaría la vieja viva (lección de P0.2). No se cambia.
create or replace function public.sincronizar_conciliaciones_pago_admin(
  p_desde timestamptz default now()-interval '30 days',
  p_hasta timestamptz default now()+interval '1 day')
returns integer
language plpgsql
security definer
set search_path='public','private'
as $function$
declare v_loc uuid; n integer;
begin
  if not private.auth_is_admin() then raise exception 'Solo administradores'; end if;
  -- G6: la misma fuente de sucursal que usa la policy RLS de la tabla.
  v_loc := private.auth_location_id();
  if v_loc is null then raise exception 'El usuario no tiene sucursal activa'; end if;

  insert into public.conciliaciones_pago(
    payment_id, sale_id, location_id, metodo, monto_esperado,
    referencia_venta, proveedor, estado, fecha_venta)
  select p.id, sa.id, sa.location_id, lower(p.metodo), p.monto, p.referencia,
         case when lower(p.metodo) in ('yape','plin','tarjeta') then 'culqi' else 'manual' end,
         'pendiente',
         sa.business_date              -- el trigger lo vuelve a imponer igual
  from public.payments p
  join public.sales sa on sa.id = p.sale_id
  where sa.location_id = v_loc
    and sa.fecha >= p_desde and sa.fecha < p_hasta
    and lower(p.metodo) <> 'efectivo'
  -- G7: `do nothing`. La versión anterior hacía `do update set fecha_venta`,
  -- que reescribía filas YA conciliadas en cada carga de la pantalla.
  on conflict (payment_id) do nothing;

  get diagnostics n = row_count;
  return n;
end
$function$;

-- ---------------------------------------------------------------------------
-- 5. I1 + I2 + I5 — conciliar. MISMA FIRMA (uuid, text, numeric, text, text).
-- ---------------------------------------------------------------------------
create or replace function public.conciliar_pago_admin(
  p_payment_id uuid,
  p_estado text,
  p_monto_confirmado numeric default null,
  p_referencia_proveedor text default null,
  p_observacion text default null)
returns public.conciliaciones_pago
language plpgsql
security definer
set search_path='public','private'
as $function$
declare
  s public.staff;
  c public.conciliaciones_pago;
  v_loc uuid;
  v_estado text;
  v_ref text;
  v_prov text;
  v_monto numeric;
  v_dup uuid;
begin
  if not private.auth_is_admin() then raise exception 'Solo administradores'; end if;
  select * into s from public.staff where user_id = auth.uid() and activo = true limit 1;
  v_loc := private.auth_location_id();
  if v_loc is null then raise exception 'El usuario no tiene sucursal activa'; end if;

  -- G7: alta perezosa SÓLO del pago pedido, en vez del barrido de 365 días
  -- que la versión anterior lanzaba antes de tomar el lock.
  insert into public.conciliaciones_pago(
    payment_id, sale_id, location_id, metodo, monto_esperado,
    referencia_venta, proveedor, estado, fecha_venta)
  select p.id, sa.id, sa.location_id, lower(p.metodo), p.monto, p.referencia,
         case when lower(p.metodo) in ('yape','plin','tarjeta') then 'culqi' else 'manual' end,
         'pendiente', sa.business_date
  from public.payments p
  join public.sales sa on sa.id = p.sale_id
  where p.id = p_payment_id
    and sa.location_id = v_loc
    and lower(p.metodo) <> 'efectivo'
  on conflict (payment_id) do nothing;

  -- Serialización real: dos admins conciliando el mismo pago a la vez, el
  -- segundo espera aquí y al entrar RELEE la fila ya conciliada (READ
  -- COMMITTED revalida la tupla tras conceder el lock).
  select * into c from public.conciliaciones_pago where payment_id = p_payment_id for update;
  -- Fallo CERRADO (T1): con `<>`, una sucursal NULL daba NULL y dejaba conciliar
  -- pagos de cualquier sucursal.
  if c.id is null or v_loc is null or c.location_id is distinct from v_loc then raise exception 'Pago no conciliable'; end if;

  v_estado := lower(btrim(coalesce(p_estado,'')));
  if v_estado not in ('conciliado','diferencia','rechazado') then raise exception 'Estado inválido'; end if;
  v_ref  := nullif(btrim(coalesce(p_referencia_proveedor,'')),'');
  v_prov := coalesce(nullif(btrim(coalesce(c.proveedor,'')),''), 'manual');

  -- I1 — un pago aceptado no se concilia dos veces.
  if c.estado = 'conciliado' then
    if v_estado = 'conciliado'
       and coalesce(upper(btrim(c.referencia_proveedor)),'') = coalesce(upper(v_ref),'')
       and abs(coalesce(c.monto_confirmado, c.monto_esperado)
               - coalesce(p_monto_confirmado, c.monto_esperado)) <= 0.005 then
      -- Reintento idéntico (doble clic, reenvío del webhook, reintento de red):
      -- idempotente. No se reescribe conciliado_por/conciliado_at.
      return c;
    end if;
    raise exception 'El pago ya fue conciliado el %. Una conciliación aceptada no se sobrescribe; revierte primero.', c.conciliado_at;
  end if;

  if v_estado = 'diferencia' and p_monto_confirmado is null then
    raise exception 'Una diferencia exige el monto realmente confirmado por el proveedor';
  end if;

  -- I5/G5 — en un rechazo el proveedor no confirmó NADA. La versión anterior
  -- escribía monto_confirmado = monto_esperado y el rechazo quedaba contado
  -- como cobrado. `monto_esperado` no se toca nunca: es el importe en disputa.
  if v_estado = 'rechazado' then
    v_monto := 0;
  else
    v_monto := coalesce(p_monto_confirmado, c.monto_esperado);
  end if;

  -- Un 'conciliado' cuyo importe no cuadra es una diferencia, se pida lo que se pida.
  if v_estado = 'conciliado' and abs(v_monto - c.monto_esperado) > 0.005 then
    v_estado := 'diferencia';
  end if;

  -- I2 — comprobación explícita, para dar un mensaje útil. El índice único
  -- parcial es el que realmente aguanta la carrera (esto es check-then-act).
  if v_ref is not null and v_estado in ('conciliado','diferencia') then
    select cp.id into v_dup
    from public.conciliaciones_pago cp
    where cp.id <> c.id
      and cp.referencia_proveedor is not null
      and upper(btrim(cp.referencia_proveedor)) = upper(v_ref)
      and lower(btrim(coalesce(cp.proveedor,''))) = lower(v_prov)
      and cp.estado in ('conciliado','diferencia')
    limit 1;
    if v_dup is not null then
      raise exception 'La referencia de proveedor "%" ya fue aceptada en la conciliación %', v_ref, v_dup;
    end if;
  end if;

  update public.conciliaciones_pago set
    estado             = v_estado,
    monto_confirmado   = v_monto,
    referencia_proveedor = coalesce(v_ref, referencia_proveedor),
    observacion        = nullif(btrim(coalesce(p_observacion,'')),''),
    conciliado_por     = s.id,
    conciliado_at      = now(),
    updated_at         = now()
  where id = c.id
  returning * into c;

  return c;
end
$function$;

-- ---------------------------------------------------------------------------
-- 6. Resumen del día comercial. MISMA FIRMA (date).
-- ---------------------------------------------------------------------------
create or replace function public.resumen_conciliacion_pagos_admin(
  p_fecha date default ((now() at time zone 'America/Lima')::date))
returns jsonb
language plpgsql
stable
security definer
set search_path='public','private'
as $function$
declare
  v_loc uuid;
  r jsonb;
  v_descuadres int := 0;
  v_monto_descuadre numeric := 0;
begin
  if not private.auth_is_admin() then raise exception 'Solo administradores'; end if;
  v_loc := private.auth_location_id();
  if v_loc is null then raise exception 'El usuario no tiene sucursal activa'; end if;

  -- G9 — pago mixto: la suma de los pagos de cada venta del día comercial
  -- tiene que igualar el total de la venta. Se agrupa por business_date, no
  -- por created_at ni por la fecha UTC del cliente.
  select count(*)::int, coalesce(sum(abs(d.pagado - d.total)), 0)
    into v_descuadres, v_monto_descuadre
  from (
    select sa.id, sa.total, coalesce(sum(p.monto), 0) as pagado
    from public.sales sa
    left join public.payments p on p.sale_id = sa.id
    where sa.location_id = v_loc
      and sa.business_date = p_fecha
      and sa.is_test = false
      and sa.estado = 'completada'
    group by sa.id, sa.total
  ) d
  where abs(d.pagado - d.total) > 0.005;

  select jsonb_build_object(
    'fecha', p_fecha,
    'pendientes',   count(*) filter (where c.estado='pendiente'),
    'conciliados',  count(*) filter (where c.estado='conciliado'),
    'diferencias',  count(*) filter (where c.estado='diferencia'),
    'rechazados',   count(*) filter (where c.estado='rechazado'),
    'monto_pendiente',  coalesce(sum(c.monto_esperado) filter (where c.estado='pendiente'), 0),
    'monto_conciliado', coalesce(sum(coalesce(c.monto_confirmado, c.monto_esperado)) filter (where c.estado='conciliado'), 0),
    -- I5: el rechazo se contabiliza por su importe ESPERADO, que es el que
    -- queda por reclamar. monto_confirmado en un rechazo es 0 por definición.
    'monto_rechazado',  coalesce(sum(c.monto_esperado) filter (where c.estado='rechazado'), 0),
    'monto_diferencia', coalesce(sum(coalesce(c.monto_confirmado,0) - c.monto_esperado) filter (where c.estado='diferencia'), 0),
    'ventas_descuadradas', v_descuadres,
    'monto_descuadre', v_monto_descuadre
  ) into r
  from public.conciliaciones_pago c
  where c.location_id = v_loc
    and c.fecha_venta = p_fecha
    and c.is_test = false;   -- I4

  return r;
end
$function$;

-- ---------------------------------------------------------------------------
-- 7. Detalle de cuadre de pago mixto (nuevo).
-- ---------------------------------------------------------------------------
create or replace function public.cuadre_pagos_venta_admin(
  p_fecha date default ((now() at time zone 'America/Lima')::date))
returns jsonb
language plpgsql
stable
security definer
set search_path='public','private'
as $function$
declare v_loc uuid; r jsonb;
begin
  if not private.auth_is_admin() then raise exception 'Solo administradores'; end if;
  v_loc := private.auth_location_id();
  if v_loc is null then raise exception 'El usuario no tiene sucursal activa'; end if;

  select coalesce(jsonb_agg(x order by x->>'numero'), '[]'::jsonb) into r
  from (
    select jsonb_build_object(
      'sale_id', sa.id,
      'numero', sa.numero,
      'venta_at', sa.fecha,
      'total', sa.total,
      'pagado', coalesce(sum(p.monto), 0),
      'diferencia', coalesce(sum(p.monto), 0) - sa.total,
      'mixto', count(distinct lower(p.metodo)) > 1,
      'metodos', coalesce(jsonb_agg(distinct lower(p.metodo)) filter (where p.id is not null), '[]'::jsonb),
      'cuadra', abs(coalesce(sum(p.monto), 0) - sa.total) <= 0.005
    ) as x
    from public.sales sa
    left join public.payments p on p.sale_id = sa.id
    where sa.location_id = v_loc
      and sa.business_date = p_fecha
      and sa.is_test = false
      and sa.estado = 'completada'
    group by sa.id, sa.numero, sa.fecha, sa.total
  ) q;

  return r;
end
$function$;

-- ---------------------------------------------------------------------------
-- 8. Auto-conciliación Culqi. MISMA FIRMA (timestamptz, timestamptz).
-- ---------------------------------------------------------------------------
create or replace function public.auto_conciliar_pagos_digitales_admin(
  p_desde timestamptz default now()-interval '30 days',
  p_hasta timestamptz default now()+interval '1 day')
returns integer
language plpgsql
security definer
set search_path='public','private'
as $function$
declare s public.staff; v_loc uuid; n integer := 0;
begin
  if not private.auth_is_admin() then raise exception 'Solo administradores'; end if;
  select * into s from public.staff where user_id = auth.uid() and activo = true limit 1;
  v_loc := private.auth_location_id();
  if v_loc is null then raise exception 'El usuario no tiene sucursal activa'; end if;

  perform public.sincronizar_conciliaciones_pago_admin(p_desde, p_hasta);

  with usados as (
    -- Referencias de proveedor YA aceptadas en cualquier conciliación.
    select upper(btrim(referencia_proveedor)) as ref
    from public.conciliaciones_pago
    where referencia_proveedor is not null
      and btrim(referencia_proveedor) <> ''
      and estado in ('conciliado','diferencia')
  ),
  matches as (
    select c.id as conciliacion_id,
           pd.monto,
           pd.culqi_order_id,
           -- una conciliación recibe como mucho un pago digital...
           row_number() over (partition by c.id
                              order by pd.updated_at desc, pd.created_at desc) as rn_conc,
           -- ...y G8: un culqi_order_id se aplica como mucho a una conciliación.
           row_number() over (partition by upper(btrim(pd.culqi_order_id))
                              order by pd.updated_at desc, pd.created_at desc, c.id) as rn_ref
    from public.conciliaciones_pago c
    join public.pagos_digitales pd
      on pd.sale_id = c.sale_id
     and lower(pd.metodo) = lower(c.metodo)
    where c.location_id = v_loc
      and c.estado = 'pendiente'
      and pd.estado = 'pagado'
      -- Sin referencia del proveedor no hay nada contra qué conciliar: dar por
      -- bueno un pago porque "existe una fila" sería fingir la integración.
      and pd.culqi_order_id is not null
      and btrim(pd.culqi_order_id) <> ''
      and pd.created_at >= p_desde and pd.created_at < p_hasta
      and abs(pd.monto - c.monto_esperado) <= 0.005
      and upper(btrim(pd.culqi_order_id)) not in (select ref from usados)
  )
  update public.conciliaciones_pago c set
    estado = 'conciliado',
    monto_confirmado = m.monto,
    referencia_proveedor = m.culqi_order_id,
    proveedor = 'culqi',
    observacion = 'Auto-conciliado desde pagos_digitales',
    conciliado_por = s.id,
    conciliado_at = now(),
    updated_at = now()
  from matches m
  where c.id = m.conciliacion_id
    and m.rn_conc = 1
    and m.rn_ref = 1;

  get diagnostics n = row_count;
  return n;
end
$function$;

-- ---------------------------------------------------------------------------
-- 9. ADAPTADOR de confirmación de proveedor externo (Culqi / POS externo).
-- ---------------------------------------------------------------------------
-- Esta es la costura por la que entra una confirmación que viene de FUERA:
-- el webhook de Culqi (que ya deja la evidencia en `pagos_digitales`) o un
-- lote del POS externo. NO inventa nada: exige proveedor y referencia reales;
-- una confirmación sin referencia no es una confirmación.
--
-- Idempotente por (proveedor, referencia): reenviar el mismo webhook devuelve
-- la misma fila sin volver a aplicarla. Si esa referencia ya está aceptada en
-- OTRO pago, se rechaza — es el caso de doble cobro.
create or replace function public.registrar_confirmacion_proveedor_admin(
  p_payment_id uuid,
  p_proveedor text,
  p_referencia_proveedor text,
  p_monto_confirmado numeric,
  p_observacion text default null)
returns public.conciliaciones_pago
language plpgsql
security definer
set search_path='public','private'
as $function$
declare
  v_loc uuid;
  v_prov text;
  v_ref text;
  v_existente public.conciliaciones_pago;
begin
  if not private.auth_is_admin() then raise exception 'Solo administradores'; end if;
  v_loc := private.auth_location_id();
  if v_loc is null then raise exception 'El usuario no tiene sucursal activa'; end if;

  v_prov := lower(nullif(btrim(coalesce(p_proveedor,'')),''));
  v_ref  := nullif(btrim(coalesce(p_referencia_proveedor,'')),'');
  if v_prov is null then raise exception 'Indica el proveedor que confirma el pago'; end if;
  if v_ref  is null then raise exception 'Una confirmación de proveedor sin referencia no es una confirmación'; end if;
  if p_monto_confirmado is null then raise exception 'Indica el monto confirmado por el proveedor'; end if;

  -- Reenvío del mismo evento: misma referencia, mismo pago -> no se reaplica.
  select * into v_existente
  from public.conciliaciones_pago
  where upper(btrim(referencia_proveedor)) = upper(v_ref)
    and lower(btrim(coalesce(proveedor,''))) = v_prov
    and estado in ('conciliado','diferencia')
  limit 1;

  if v_existente.id is not null then
    if v_existente.payment_id = p_payment_id then
      -- Reenvío del MISMO evento sólo si el importe confirmado coincide. Con otra
      -- cantidad es una corrección o un error del proveedor, no un reenvío:
      -- devolver la fila existente perdería el importe nuevo en silencio mientras
      -- el llamador recibe éxito (T2). Mismo criterio que el reintento idéntico
      -- de conciliar_pago_admin.
      if abs(coalesce(v_existente.monto_confirmado, v_existente.monto_esperado)
             - p_monto_confirmado) > 0.005 then
        raise exception 'La referencia "%" de % ya se registró para este pago con un contenido distinto (S/ % frente a S/ %). Una confirmación aceptada no se sobrescribe; revierte primero.',
          v_ref, v_prov, coalesce(v_existente.monto_confirmado, v_existente.monto_esperado), p_monto_confirmado
          using errcode = 'P0001';
      end if;
      return v_existente;
    end if;
    raise exception 'La referencia "%" de % ya fue aceptada para otro pago (conciliación %)',
      v_ref, v_prov, v_existente.id;
  end if;

  update public.conciliaciones_pago
    set proveedor = v_prov, updated_at = now()
  where payment_id = p_payment_id and estado = 'pendiente';

  -- Toda la validación dura (doble conciliación, unicidad, diferencia) vive en
  -- un solo sitio; aquí no se duplica.
  return public.conciliar_pago_admin(
    p_payment_id, 'conciliado', p_monto_confirmado, v_ref,
    coalesce(nullif(btrim(coalesce(p_observacion,'')),''), 'Confirmación de ' || v_prov));
end
$function$;

-- ---------------------------------------------------------------------------
-- 10. Privilegios. Sin GRANT, `authenticated` recibe 42501 (lección de P0.4:
--     validar sólo como `postgres`, que es dueño, oculta exactamente esto).
-- ---------------------------------------------------------------------------
revoke all on function public.sincronizar_conciliaciones_pago_admin(timestamptz,timestamptz) from public, anon;
revoke all on function public.conciliar_pago_admin(uuid,text,numeric,text,text) from public, anon;
revoke all on function public.resumen_conciliacion_pagos_admin(date) from public, anon;
revoke all on function public.cuadre_pagos_venta_admin(date) from public, anon;
revoke all on function public.auto_conciliar_pagos_digitales_admin(timestamptz,timestamptz) from public, anon;
revoke all on function public.registrar_confirmacion_proveedor_admin(uuid,text,text,numeric,text) from public, anon;

grant execute on function public.sincronizar_conciliaciones_pago_admin(timestamptz,timestamptz) to authenticated;
grant execute on function public.conciliar_pago_admin(uuid,text,numeric,text,text) to authenticated;
grant execute on function public.resumen_conciliacion_pagos_admin(date) to authenticated;
grant execute on function public.cuadre_pagos_venta_admin(date) to authenticated;
grant execute on function public.auto_conciliar_pagos_digitales_admin(timestamptz,timestamptz) to authenticated;
grant execute on function public.registrar_confirmacion_proveedor_admin(uuid,text,text,numeric,text) to authenticated;

-- La tabla sigue siendo de sólo lectura para `authenticated`: toda escritura
-- pasa por las funciones SECURITY DEFINER de arriba.
revoke insert, update, delete on public.conciliaciones_pago from authenticated;
revoke all on public.conciliaciones_pago from anon;
grant select on public.conciliaciones_pago to authenticated;
