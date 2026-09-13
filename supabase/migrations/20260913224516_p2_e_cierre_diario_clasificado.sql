-- ============================================================================
-- P2.E — FASE 20 · Cierre diario con verificaciones clasificadas P0 / P1 / warning
-- ============================================================================
-- Estado previo (auditoría 2026-09-13, sólo lectura):
--   · cerrar_dia sólo bloqueaba si había cajas abiertas ABIERTAS ESE DÍA:
--     resumen_cierre_diario filtraba cajas por apertura = p_fecha, así que una
--     caja olvidada de días anteriores no impedía cerrar (producción tiene una
--     abierta desde hace 7 días).
--   · aprobar_cierre_diario bloqueaba por terminales y exigía autorización por
--     diferencia crítica, pero las conciliaciones pendientes sólo se contaban.
--   · Nada revisaba inventario negativo, comprobantes no emitidos, reservas IMEI
--     vencidas ni seriales en cuarentena/investigación/faltante.
--   · stock_critico contaba productos de prueba (is_test).
--
-- Modelo:
--   P0       bloquea. `bloquea = 'cierre'` impide crear el cierre y aprobarlo;
--            `bloquea = 'aprobacion'` sólo impide aprobarlo (el día se congela
--            al aprobar, no al cerrar: flujo de P0.2).
--   P1       requiere autorización operativa (diferencia crítica de cajas).
--   warning  no bloquea; queda registrado en el snapshot y en el reporte final.
--
-- Compatibilidad: firmas intactas; previsualizar_cierre_diario sólo AÑADE
-- claves (checks, bloquea_cierre, bloquea_aprobacion, requiere_autorizacion);
-- los mensajes existentes de cerrar/aprobar se conservan.
-- ============================================================================

create or replace function private.checks_cierre_diario(p_location_id uuid, p_fecha date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_checks jsonb := '[]'::jsonb;
  v_n      integer;
  v_disp   jsonb;
  v_umbral numeric;
  v_dif    numeric;
begin
  -- P0 · cajas abiertas de esta fecha o anteriores ------------------------------
  select count(*) into v_n from public.cash_sessions c
   where c.location_id = p_location_id and not c.is_test and c.cierre is null
     and (c.apertura at time zone 'America/Lima')::date <= p_fecha;
  if v_n > 0 then
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'codigo', 'CAJAS_ABIERTAS', 'nivel', 'P0', 'bloquea', 'cierre', 'cantidad', v_n,
      'titulo', 'Cajas abiertas',
      'detalle', format('%s caja(s) abiertas de esta fecha o de días anteriores', v_n),
      'accion', 'Cierra cada caja con su arqueo antes de cerrar el día'));
  end if;

  -- P0 · inventario negativo ----------------------------------------------------
  select count(*) into v_n from public.inventory i where i.location_id = p_location_id and i.cantidad < 0;
  if v_n > 0 then
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'codigo', 'INVENTARIO_NEGATIVO', 'nivel', 'P0', 'bloquea', 'cierre', 'cantidad', v_n,
      'titulo', 'Inventario negativo',
      'detalle', format('%s variante(s) con stock menor que cero', v_n),
      'accion', 'Revisa los movimientos y corrige con un ajuste auditado'));
  end if;

  -- P0 · terminales (mismas reglas que aprobar_cierre_diario de P0.2) ------------
  v_disp := private.estado_dispositivos_cierre(p_location_id);
  if jsonb_array_length(v_disp->'con_ventas_pendientes') > 0 then
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'codigo', 'TERMINALES_VENTAS_PENDIENTES', 'nivel', 'P0', 'bloquea', 'aprobacion',
      'cantidad', jsonb_array_length(v_disp->'con_ventas_pendientes'), 'titulo', 'Terminales con ventas sin sincronizar',
      'detalle', v_disp->'con_ventas_pendientes', 'accion', 'Sincroniza esas terminales antes de aprobar'));
  end if;
  if jsonb_array_length(v_disp->'con_ventas_fallidas') > 0 then
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'codigo', 'TERMINALES_VENTAS_FALLIDAS', 'nivel', 'P0', 'bloquea', 'aprobacion',
      'cantidad', jsonb_array_length(v_disp->'con_ventas_fallidas'), 'titulo', 'Terminales con ventas fallidas',
      'detalle', v_disp->'con_ventas_fallidas', 'accion', 'Resuelve las ventas fallidas antes de aprobar'));
  end if;
  if jsonb_array_length(v_disp->'sin_reportar') > 0 then
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'codigo', 'TERMINALES_SIN_REPORTAR', 'nivel', 'P0', 'bloquea', 'aprobacion',
      'cantidad', jsonb_array_length(v_disp->'sin_reportar'), 'titulo', 'Terminales sin reportar hace más de 2 horas',
      'detalle', v_disp->'sin_reportar', 'accion', 'Conéctalas o márcalas fuera de servicio'));
  end if;

  -- P1 · diferencia crítica de cajas del día --------------------------------------
  select coalesce(diferencia_caja_critica, 20) into v_umbral from public.configuracion where id = 1;
  v_umbral := coalesce(v_umbral, 20);
  select coalesce(sum(c.diferencia), 0) into v_dif from public.cash_sessions c
   where c.location_id = p_location_id and not c.is_test and c.cierre is not null
     and (c.apertura at time zone 'America/Lima')::date = p_fecha;
  if abs(v_dif) >= v_umbral then
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'codigo', 'DIFERENCIA_CRITICA', 'nivel', 'P1', 'bloquea', null, 'cantidad', null,
      'titulo', 'Diferencia crítica de cajas',
      'detalle', format('Diferencia neta %s; umbral %s', round(v_dif, 2), round(v_umbral, 2)),
      'accion', 'Solicita la autorización operativa del cierre'));
  end if;

  -- warnings ------------------------------------------------------------------------
  select count(*) into v_n from public.conciliaciones_pago cp
   where cp.location_id = p_location_id and cp.fecha_venta = p_fecha and cp.estado in ('pendiente', 'diferencia', 'rechazado');
  if v_n > 0 then
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'codigo', 'CONCILIACIONES_PENDIENTES', 'nivel', 'warning', 'bloquea', null, 'cantidad', v_n,
      'titulo', 'Pagos no efectivo sin conciliar', 'detalle', format('%s pago(s) del día pendientes, con diferencia o rechazados', v_n),
      'accion', 'Concilia contra el extracto del proveedor'));
  end if;

  select count(*) into v_n from public.comprobantes_electronicos ce
    join public.sales s on s.id = ce.sale_id
   where s.location_id = p_location_id and s.business_date = p_fecha and not s.is_test and ce.estado in ('pendiente', 'error');
  if v_n > 0 then
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'codigo', 'COMPROBANTES_NO_EMITIDOS', 'nivel', 'warning', 'bloquea', null, 'cantidad', v_n,
      'titulo', 'Comprobantes electrónicos no emitidos', 'detalle', format('%s comprobante(s) del día en pendiente o error', v_n),
      'accion', 'Reintenta la emisión desde Reportes'));
  end if;

  select count(*) into v_n from public.serial_reservations r
    join public.product_serials ps on ps.id = r.serial_id
   where ps.location_id = p_location_id and r.expires_at < now();
  if v_n > 0 then
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'codigo', 'RESERVAS_IMEI_VENCIDAS', 'nivel', 'warning', 'bloquea', null, 'cantidad', v_n,
      'titulo', 'Reservas de IMEI vencidas', 'detalle', format('%s reserva(s) vencidas sin liberar', v_n),
      'accion', 'Se liberan solas al reservar de nuevo; revisa si alguna oculta una venta abandonada'));
  end if;

  select count(*) into v_n from public.product_serials ps
   where ps.location_id = p_location_id and ps.estado in ('cuarentena', 'investigacion', 'faltante');
  if v_n > 0 then
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'codigo', 'SERIALES_EN_REVISION', 'nivel', 'warning', 'bloquea', null, 'cantidad', v_n,
      'titulo', 'Seriales en cuarentena, investigación o faltantes', 'detalle', format('%s serial(es) sin resolver', v_n),
      'accion', 'Resuélvelos desde Inventario físico'));
  end if;

  select count(*) into v_n from public.ordenes_servicio o
   where o.location_id = p_location_id and coalesce(o.estado, '') not in ('entregado', 'cancelado');
  if v_n > 0 then
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'codigo', 'ORDENES_ABIERTAS', 'nivel', 'warning', 'bloquea', null, 'cantidad', v_n,
      'titulo', 'Órdenes de servicio abiertas', 'detalle', format('%s orden(es) sin entregar ni cancelar', v_n),
      'accion', 'Revisa las órdenes estancadas'));
  end if;

  select count(*) into v_n from public.inventory i
    join public.product_variants pv on pv.id = i.variant_id
    join public.products p on p.id = pv.product_id
   where i.location_id = p_location_id and not p.is_test and i.cantidad <= i.stock_minimo;
  if v_n > 0 then
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'codigo', 'STOCK_CRITICO', 'nivel', 'warning', 'bloquea', null, 'cantidad', v_n,
      'titulo', 'Stock crítico', 'detalle', format('%s variante(s) en o bajo el mínimo', v_n),
      'accion', 'Genera órdenes de compra'));
  end if;

  return v_checks;
end
$function$;

revoke all on function private.checks_cierre_diario(uuid, date) from public;

-- ---------------------------------------------------------------------------
-- Resumen: cajas abiertas incluye las de días anteriores; stock crítico sin QA.
-- ---------------------------------------------------------------------------
create or replace function private.resumen_cierre_diario(p_location_id uuid, p_fecha date)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
with ventas as (
 select coalesce(sum(s.total),0)::numeric total,count(*)::int cantidad
 from public.sales s where s.location_id=p_location_id and s.estado='completada' and not s.is_test and (s.fecha at time zone 'America/Lima')::date=p_fecha
), pagos as (
 select coalesce(sum(p.monto) filter(where p.metodo='efectivo'),0)::numeric efectivo,
        coalesce(sum(p.monto) filter(where p.metodo in('yape','plin')),0)::numeric digital,
        coalesce(sum(p.monto) filter(where p.metodo not in('efectivo','yape','plin')),0)::numeric otros
 from public.payments p join public.sales s on s.id=p.sale_id
 where s.location_id=p_location_id and s.estado='completada' and not s.is_test and (s.fecha at time zone 'America/Lima')::date=p_fecha
), reembolsos as (
 select coalesce(sum(d.monto),0)::numeric total from public.devoluciones d
 where d.location_id=p_location_id and d.estado='completada' and d.reembolso_estado='completado' and (d.reembolsado_at at time zone 'America/Lima')::date=p_fecha
), cajas as (
 select count(*) filter(where c.cierre is null and (c.apertura at time zone 'America/Lima')::date<=p_fecha)::int abiertas,
        count(*) filter(where c.cierre is not null and (c.apertura at time zone 'America/Lima')::date=p_fecha)::int cerradas,
        coalesce(sum(c.diferencia) filter(where c.cierre is not null and (c.apertura at time zone 'America/Lima')::date=p_fecha),0)::numeric diferencia
 from public.cash_sessions c where c.location_id=p_location_id and not c.is_test and (c.apertura at time zone 'America/Lima')::date<=p_fecha
), ordenes as (
 select count(*) filter(where coalesce(o.estado,'') not in('entregado','cancelado'))::int abiertas from public.ordenes_servicio o where o.location_id=p_location_id
), stock as (
 select count(*) filter(where i.cantidad<=i.stock_minimo)::int critico
 from public.inventory i join public.product_variants pv on pv.id=i.variant_id join public.products p on p.id=pv.product_id
 where i.location_id=p_location_id and not p.is_test
)
select jsonb_build_object(
 'fecha',p_fecha,'location_id',p_location_id,
 'total_ventas',(select total from ventas),'cantidad_ventas',(select cantidad from ventas),
 'efectivo',(select efectivo from pagos),'digital',(select digital from pagos),'otros_pagos',(select otros from pagos),
 'total_reembolsos',(select total from reembolsos),
 'cajas_abiertas',(select abiertas from cajas),'cajas_cerradas',(select cerradas from cajas),'diferencia_cajas',(select diferencia from cajas),
 'ordenes_abiertas',(select abiertas from ordenes),'stock_critico',(select critico from stock)
); $function$;

-- ---------------------------------------------------------------------------
create or replace function public.previsualizar_cierre_diario(p_fecha date default ((now() at time zone 'America/Lima'::text))::date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_admin  public.staff;
  v_checks jsonb;
begin
  select * into v_admin from public.staff where user_id=auth.uid() and activo=true and rol='administrador' limit 1;
  if v_admin.id is null then raise exception 'Solo administración puede consultar el cierre diario'; end if;
  v_checks := private.checks_cierre_diario(private.auth_location_id(), p_fecha);
  return private.resumen_cierre_diario(private.auth_location_id(), p_fecha) || jsonb_build_object(
    'checks', v_checks,
    'bloquea_cierre', exists (select 1 from jsonb_array_elements(v_checks) x where x->>'bloquea' = 'cierre'),
    'bloquea_aprobacion', exists (select 1 from jsonb_array_elements(v_checks) x where x->>'nivel' = 'P0'),
    'requiere_autorizacion', exists (select 1 from jsonb_array_elements(v_checks) x where x->>'nivel' = 'P1'));
end
$function$;

-- ---------------------------------------------------------------------------
create or replace function public.cerrar_dia(p_fecha date default ((now() at time zone 'America/Lima'::text))::date, p_observacion text default null::text)
returns cierres_diarios
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_admin  public.staff;
  v_r      jsonb;
  v_row    public.cierres_diarios;
  v_checks jsonb;
  v_bloqueo jsonb;
begin
  select * into v_admin from public.staff where user_id=auth.uid() and activo=true and rol='administrador' limit 1;
  if v_admin.id is null then raise exception 'Solo un administrador activo puede cerrar el día'; end if;
  if p_fecha>(now() at time zone 'America/Lima')::date then raise exception 'No se puede cerrar una fecha futura'; end if;
  select * into v_row from public.cierres_diarios where location_id=private.auth_location_id() and fecha=p_fecha;
  if v_row.id is not null then return v_row; end if;

  v_checks := private.checks_cierre_diario(private.auth_location_id(), p_fecha);
  select x into v_bloqueo from jsonb_array_elements(v_checks) x where x->>'bloquea' = 'cierre' limit 1;
  if v_bloqueo is not null then
    if v_bloqueo->>'codigo' = 'CAJAS_ABIERTAS' then
      raise exception 'No puedes cerrar el día mientras existan cajas abiertas' using errcode = 'P0001';
    end if;
    raise exception '%: %. %', v_bloqueo->>'titulo', v_bloqueo->>'detalle', v_bloqueo->>'accion' using errcode = 'P0001';
  end if;

  v_r := private.resumen_cierre_diario(private.auth_location_id(), p_fecha) || jsonb_build_object('checks', v_checks);
  insert into public.cierres_diarios(location_id,fecha,total_ventas,cantidad_ventas,efectivo,digital,otros_pagos,total_reembolsos,diferencia_cajas,cajas_cerradas,ordenes_abiertas,stock_critico,observacion,snapshot,cerrado_por)
  values(private.auth_location_id(),p_fecha,coalesce((v_r->>'total_ventas')::numeric,0),coalesce((v_r->>'cantidad_ventas')::int,0),coalesce((v_r->>'efectivo')::numeric,0),coalesce((v_r->>'digital')::numeric,0),coalesce((v_r->>'otros_pagos')::numeric,0),coalesce((v_r->>'total_reembolsos')::numeric,0),coalesce((v_r->>'diferencia_cajas')::numeric,0),coalesce((v_r->>'cajas_cerradas')::int,0),coalesce((v_r->>'ordenes_abiertas')::int,0),coalesce((v_r->>'stock_critico')::int,0),nullif(trim(coalesce(p_observacion,'')),''),v_r,v_admin.id) returning * into v_row;
  return v_row;
end
$function$;

-- ---------------------------------------------------------------------------
-- Aprobación: conserva íntegros los bloqueos y mensajes de P0.2 y la
-- autorización por diferencia crítica; añade el bloqueo por verificaciones de
-- nivel 'cierre' surgidas después de cerrar y registra todas en el reporte.
-- ---------------------------------------------------------------------------
create or replace function public.aprobar_cierre_diario(p_cierre_id uuid, p_firma text, p_observacion text default null::text, p_autorizacion_id uuid default null::uuid)
returns cierres_diarios
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  s public.staff; c public.cierres_diarios; umbral numeric:=20; pendientes int:=0;
  a public.autorizaciones_operativas; rep jsonb; disp jsonb; v_checks jsonb; v_bloqueo jsonb;
begin
  if not private.auth_is_admin() then raise exception 'Solo administración puede aprobar cierres'; end if;
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  select * into c from public.cierres_diarios where id=p_cierre_id for update;
  if c.id is null or c.location_id<>private.auth_location_id() then raise exception 'Cierre inválido'; end if;
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

  -- P2.E: verificaciones clasificadas. Las de nivel 'cierre' que aparecieron
  -- después de cerrar (p. ej. inventario negativo) también impiden congelar el día.
  v_checks := private.checks_cierre_diario(c.location_id, c.fecha);
  select x into v_bloqueo from jsonb_array_elements(v_checks) x where x->>'bloquea' = 'cierre' limit 1;
  if v_bloqueo is not null then
    raise exception 'No se puede aprobar: %: %. %', v_bloqueo->>'titulo', v_bloqueo->>'detalle', v_bloqueo->>'accion' using errcode = 'P0001';
  end if;

  select coalesce(diferencia_caja_critica,20) into umbral from public.configuracion where id=1;
  select count(*) into pendientes from public.conciliaciones_pago cp where cp.location_id=c.location_id and cp.fecha_venta=c.fecha and cp.estado in('pendiente','diferencia','rechazado');
  if abs(c.diferencia_cajas)>=umbral then
    if p_autorizacion_id is null then raise exception 'Diferencia crítica: requiere autorización operativa'; end if;
    select * into a from public.autorizaciones_operativas where id=p_autorizacion_id for update;
    if a.id is null or a.estado<>'aprobada' or a.location_id<>c.location_id or a.tipo<>'otro' or a.recurso_tipo<>'cierre_diario' or a.recurso_id<>c.id::text then raise exception 'Autorización de cierre inválida'; end if;
    update public.autorizaciones_operativas set estado='consumida',consumed_at=now() where id=a.id;
  end if;
  rep:=c.snapshot || jsonb_build_object('aprobado_at',now(),'firma_responsable',btrim(p_firma),'conciliaciones_pendientes',pendientes,'diferencia_critica',abs(c.diferencia_cajas)>=umbral,'terminales',disp,'checks',v_checks);
  update public.cierres_diarios set estado_aprobacion='aprobado',aprobado_por=s.id,aprobado_at=now(),firma_responsable=btrim(p_firma),observacion_aprobacion=nullif(btrim(coalesce(p_observacion,'')),''),diferencia_critica=(abs(diferencia_cajas)>=umbral),conciliaciones_pendientes=pendientes,reporte_final=rep where id=c.id returning * into c;
  return c;
end
$function$;
