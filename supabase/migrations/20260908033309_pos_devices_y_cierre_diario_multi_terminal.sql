-- ============================================================================
-- P0.2 bloque 9+10: registro server-side de terminales POS, para que el
-- cierre diario deje de ser ciego a las ventas offline pendientes de OTRO
-- dispositivo.
--
-- El problema: cada navegador conoce sus ventas offline pendientes en su
-- propio IndexedDB. Un admin en otra PC no tiene forma de saberlo, aprueba
-- el día, y cuando el POS vuelve online su venta legítima es rechazada para
-- siempre por bloquear_ventas_dia_aprobado (el día quedó bloqueado). La
-- venta queda atrapada en la cola local reintentando eternamente.
--
-- La solución: cada terminal reporta server-side cuántas ventas tiene
-- pendientes y fallidas (heartbeat), y el cierre diario consulta eso antes
-- de dejar aprobar.
--
-- Política post-cierre (bloque 10), decidida explícitamente:
--   A) Mientras haya terminales con pendientes/fallidas, el cierre NO se
--      puede aprobar. Es la defensa principal.
--   B) Si llega una venta tardía y el cierre existe pero NO está aprobado,
--      la venta entra normal — el cierre se recalcula al aprobarse, porque
--      resumen_cierre_diario se evalúa en ese momento.
--   C) Si el cierre YA está aprobado, la venta se sigue rechazando (el
--      trigger existente no se toca: NO se altera en silencio una cifra
--      aprobada). La diferencia con hoy es que ahora eso es casi imposible
--      de alcanzar por accidente, y cuando pasa queda registrado como
--      incidencia consultable en vez de un reintento infinito invisible.
-- ============================================================================

create table if not exists public.pos_devices (
  id uuid primary key default gen_random_uuid(),
  device_id text not null unique,
  location_id uuid not null references public.locations(id),
  staff_id uuid references public.staff(id),
  nombre text,
  activo boolean not null default true,
  fuera_de_servicio boolean not null default false,
  fuera_de_servicio_motivo text,
  fuera_de_servicio_por uuid references public.staff(id),
  fuera_de_servicio_at timestamptz,
  last_seen_at timestamptz,
  last_sync_at timestamptz,
  pending_sales_count integer not null default 0,
  failed_sales_count integer not null default 0,
  app_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pos_devices_location_idx on public.pos_devices(location_id) where not fuera_de_servicio;

alter table public.pos_devices enable row level security;

-- Lectura: admin, o personal de la misma sucursal (necesitan ver por qué no
-- pueden cerrar el día). Sin policy de escritura: todo pasa por RPC.
create policy pos_devices_read on public.pos_devices
  for select using (private.auth_is_admin() or location_id = private.auth_location_id());

-- ----------------------------------------------------------------------------
-- Heartbeat: lo llama el POS periódicamente cuando está online, y al
-- terminar de sincronizar. El device_id lo genera el navegador una vez y lo
-- persiste; la sucursal y el staff NO se toman del cliente, salen de
-- auth.uid() -> staff (mismo criterio de "actor real" de P0.1 bloque 2).
-- ----------------------------------------------------------------------------
create or replace function public.registrar_heartbeat_pos(
  p_device_id text,
  p_pending_sales integer default 0,
  p_failed_sales integer default 0,
  p_app_version text default null,
  p_nombre text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  s public.staff;
  v_device text := nullif(btrim(coalesce(p_device_id, '')), '');
begin
  select * into s from public.staff where user_id = auth.uid() and activo = true limit 1;
  if s.id is null then raise exception 'Personal no válido'; end if;
  if v_device is null then raise exception 'device_id requerido'; end if;
  if s.location_id is null then raise exception 'El personal no tiene sucursal asignada'; end if;

  insert into public.pos_devices as d (
    device_id, location_id, staff_id, nombre, last_seen_at, last_sync_at,
    pending_sales_count, failed_sales_count, app_version, updated_at
  )
  values (
    v_device, s.location_id, s.id, nullif(btrim(coalesce(p_nombre, '')), ''), now(),
    case when coalesce(p_pending_sales, 0) = 0 then now() else null end,
    greatest(0, coalesce(p_pending_sales, 0)), greatest(0, coalesce(p_failed_sales, 0)),
    nullif(btrim(coalesce(p_app_version, '')), ''), now()
  )
  on conflict (device_id) do update set
    location_id = s.location_id,
    staff_id = s.id,
    nombre = coalesce(nullif(btrim(coalesce(p_nombre, '')), ''), d.nombre),
    last_seen_at = now(),
    -- Solo cuenta como "sincronizado" cuando efectivamente no queda nada
    -- pendiente; si todavía hay cola, se conserva el último sync real.
    last_sync_at = case when greatest(0, coalesce(p_pending_sales, 0)) = 0 then now() else d.last_sync_at end,
    pending_sales_count = greatest(0, coalesce(p_pending_sales, 0)),
    failed_sales_count = greatest(0, coalesce(p_failed_sales, 0)),
    app_version = coalesce(nullif(btrim(coalesce(p_app_version, '')), ''), d.app_version),
    -- Un dispositivo que vuelve a reportar deja de estar fuera de servicio:
    -- si el equipo revivió, la marca administrativa ya no describe la
    -- realidad y no debe seguir ocultando sus pendientes.
    fuera_de_servicio = false,
    fuera_de_servicio_motivo = null,
    fuera_de_servicio_por = null,
    fuera_de_servicio_at = null,
    activo = true,
    updated_at = now();
end$function$;

grant execute on function public.registrar_heartbeat_pos(text, integer, integer, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- Marcar un terminal fuera de servicio (equipo robado, roto, reemplazado).
-- Con auditoría: queda quién y por qué. Es la válvula de escape para que un
-- dispositivo viejo no bloquee el cierre para siempre.
-- ----------------------------------------------------------------------------
create or replace function public.marcar_dispositivo_fuera_de_servicio(p_device_id text, p_motivo text)
returns void
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  s public.staff;
  d public.pos_devices;
begin
  select * into s from public.staff where user_id = auth.uid() and activo = true limit 1;
  if s.id is null or not (s.rol = 'administrador' or coalesce(s.puesto, '') in ('encargado', 'jefa')) then
    raise exception 'Sin permiso';
  end if;
  if p_motivo is null or length(btrim(p_motivo)) < 5 then
    raise exception 'Indica por qué este terminal queda fuera de servicio';
  end if;
  select * into d from public.pos_devices where device_id = p_device_id for update;
  if d.id is null then raise exception 'Terminal no encontrado'; end if;
  if not private.auth_is_admin() and d.location_id <> s.location_id then
    raise exception 'Ese terminal es de otra sucursal';
  end if;

  update public.pos_devices set
    fuera_de_servicio = true,
    fuera_de_servicio_motivo = btrim(p_motivo),
    fuera_de_servicio_por = s.id,
    fuera_de_servicio_at = now(),
    activo = false,
    updated_at = now()
  where id = d.id;
end$function$;

grant execute on function public.marcar_dispositivo_fuera_de_servicio(text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- Clasificación del estado de los terminales de una sucursal. La usan tanto
-- el gate del cierre como la UI (para poder explicar por qué está bloqueado
-- en vez de solo fallar).
-- ----------------------------------------------------------------------------
create or replace function private.estado_dispositivos_cierre(p_location_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'private'
as $function$
  with d as (
    select * from public.pos_devices
    where location_id = p_location_id and not fuera_de_servicio
  )
  select jsonb_build_object(
    'con_ventas_pendientes', coalesce((
      select jsonb_agg(jsonb_build_object('device_id', device_id, 'nombre', nombre, 'pendientes', pending_sales_count, 'last_seen_at', last_seen_at))
      from d where pending_sales_count > 0
    ), '[]'::jsonb),
    'con_ventas_fallidas', coalesce((
      select jsonb_agg(jsonb_build_object('device_id', device_id, 'nombre', nombre, 'fallidas', failed_sales_count, 'last_seen_at', last_seen_at))
      from d where failed_sales_count > 0
    ), '[]'::jsonb),
    'sin_reportar', coalesce((
      select jsonb_agg(jsonb_build_object('device_id', device_id, 'nombre', nombre, 'last_seen_at', last_seen_at))
      from d where last_seen_at is null or last_seen_at < now() - interval '2 hours'
    ), '[]'::jsonb),
    'total_terminales', (select count(*)::int from d)
  );
$function$;

-- ----------------------------------------------------------------------------
-- Versión pública para la UI del cierre diario.
-- ----------------------------------------------------------------------------
create or replace function public.estado_terminales_sucursal()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'private'
as $function$
declare s public.staff;
begin
  select * into s from public.staff where user_id = auth.uid() and activo = true limit 1;
  if s.id is null then raise exception 'Personal no válido'; end if;
  return private.estado_dispositivos_cierre(s.location_id);
end$function$;

grant execute on function public.estado_terminales_sucursal() to authenticated;

-- ----------------------------------------------------------------------------
-- El gate en sí: aprobar_cierre_diario es el paso que congela el día
-- (bloquear_ventas_dia_aprobado lo usa para rechazar cualquier venta
-- posterior). Ahí es donde no se puede permitir que quede una terminal con
-- trabajo sin sincronizar.
-- ----------------------------------------------------------------------------
create or replace function public.aprobar_cierre_diario(p_cierre_id uuid, p_firma text, p_observacion text default null, p_autorizacion_id uuid default null)
returns cierres_diarios
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  s public.staff; c public.cierres_diarios; umbral numeric:=20; pendientes int:=0;
  a public.autorizaciones_operativas; rep jsonb; disp jsonb;
begin
  if not private.auth_is_admin() then raise exception 'Solo administración puede aprobar cierres'; end if;
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  select * into c from public.cierres_diarios where id=p_cierre_id for update;
  if c.id is null or c.location_id<>s.location_id then raise exception 'Cierre inválido'; end if;
  if c.estado_aprobacion='aprobado' then return c; end if;
  if length(btrim(coalesce(p_firma,'')))<3 then raise exception 'Ingresa nombre/firma responsable'; end if;

  -- P0.2 bloque 9: ninguna terminal de esta sucursal puede quedar con
  -- ventas sin sincronizar cuando el día se congela.
  disp := private.estado_dispositivos_cierre(c.location_id);
  if jsonb_array_length(disp->'con_ventas_pendientes') > 0 then
    raise exception 'Hay % terminal(es) con ventas sin sincronizar: %. Sincronízalas antes de aprobar el cierre.',
      jsonb_array_length(disp->'con_ventas_pendientes'), disp->'con_ventas_pendientes' using errcode = 'P0001';
  end if;
  if jsonb_array_length(disp->'con_ventas_fallidas') > 0 then
    raise exception 'Hay % terminal(es) con ventas fallidas sin resolver: %. Resuélvelas antes de aprobar el cierre.',
      jsonb_array_length(disp->'con_ventas_fallidas'), disp->'con_ventas_fallidas' using errcode = 'P0001';
  end if;
  if jsonb_array_length(disp->'sin_reportar') > 0 then
    raise exception 'Hay % terminal(es) que no reportan hace más de 2 horas: %. Conéctalas o márcalas fuera de servicio antes de aprobar.',
      jsonb_array_length(disp->'sin_reportar'), disp->'sin_reportar' using errcode = 'P0001';
  end if;

  select coalesce(diferencia_caja_critica,20) into umbral from public.configuracion where id=1;
  select count(*) into pendientes from public.conciliaciones_pago cp where cp.location_id=c.location_id and cp.fecha_venta=c.fecha and cp.estado in('pendiente','diferencia','rechazado');
  if abs(c.diferencia_cajas)>=umbral then
    if p_autorizacion_id is null then raise exception 'Diferencia crítica: requiere autorización operativa'; end if;
    select * into a from public.autorizaciones_operativas where id=p_autorizacion_id for update;
    if a.id is null or a.estado<>'aprobada' or a.location_id<>c.location_id or a.tipo<>'otro' or a.recurso_tipo<>'cierre_diario' or a.recurso_id<>c.id::text then raise exception 'Autorización de cierre inválida'; end if;
    update public.autorizaciones_operativas set estado='consumida',consumed_at=now() where id=a.id;
  end if;
  rep:=c.snapshot || jsonb_build_object('aprobado_at',now(),'firma_responsable',btrim(p_firma),'conciliaciones_pendientes',pendientes,'diferencia_critica',abs(c.diferencia_cajas)>=umbral,'terminales',disp);
  update public.cierres_diarios set estado_aprobacion='aprobado',aprobado_por=s.id,aprobado_at=now(),firma_responsable=btrim(p_firma),observacion_aprobacion=nullif(btrim(coalesce(p_observacion,'')),''),diferencia_critica=(abs(diferencia_cajas)>=umbral),conciliaciones_pendientes=pendientes,reporte_final=rep where id=c.id returning * into c;
  return c;
end$function$;

-- cerrar_dia solo CREA el borrador del cierre (todavía recalculable al
-- aprobar), así que aquí basta con advertir a nivel de datos: no se bloquea
-- para no impedir que el encargado prepare el cierre mientras una terminal
-- termina de sincronizar. El bloqueo duro vive en la aprobación.
