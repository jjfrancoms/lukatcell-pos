-- ============================================================================
-- P0.4 — Identidad canónica de catálogo de prueba y saneamiento del inventario
-- QA que seguía contando como stock real.
--
-- Situación encontrada: 18 productos 'QA-INTEGRITY-%' de corridas de la suite
-- de integración, con 8 filas de inventory y 66 unidades (S/3300 por costo),
-- todas en la sucursal eb66cebb (SJL). Los productos ya estaban activo=false,
-- pero iniciar_inventario_fisico siembra desde inventory sin mirar `activo`,
-- así que esas 66 unidades entraban en cualquier conteo físico futuro.
--
-- Por qué NO se resuelve con `activo`: un producto descontinuado con stock
-- físico real es un escenario legítimo del negocio y DEBE seguir contándose.
-- Inactivo no significa de prueba. Hace falta una marca propia.
--
-- Fuente canónica única: products.is_test. No se desnormaliza a
-- product_variants ni a inventory — el join es sobre PKs indexadas en tablas
-- de decenas de filas, y las policies de products/product_variants son
-- `authenticated` para SELECT, así que un join desde una función nunca puede
-- devolver un falso negativo por RLS. Dos copias sólo añadirían desincronía.
-- ============================================================================

-- R1 (hallazgo del red team): product_variants.product_id era NULLABLE. Todos
-- los filtros de is_test —y los embeds !inner del frontend— hacen join a
-- products; una variante sin producto habría desaparecido silenciosamente del
-- conteo físico, de la valorización y del listado de inventario, ocultando
-- stock real. Hoy hay 0 filas así (44 variantes), de modo que la restricción
-- entra sin migrar datos y elimina la clase de bug de raíz: una variante sin
-- producto no tiene nombre ni precio, no es representable en el negocio.
alter table public.product_variants alter column product_id set not null;

alter table public.products add column if not exists is_test boolean not null default false;

comment on column public.products.is_test is
  'Producto sintético de QA. Fuente canónica de identidad de prueba para catálogo, variantes e inventario (por join). NO confundir con activo=false, que es un producto descontinuado legítimo y sí debe contarse.';

create index if not exists products_is_test_idx on public.products(id) where is_test;

-- Los 18 productos QA históricos. Se usa ILIKE dentro de esta migración
-- administrativa tras haber verificado uno por uno los IDs afectados; NO es
-- una regla permanente de seguridad.
update public.products set is_test = true where nombre ilike 'QA-INTEGRITY-%';

-- Saneamiento de las 66 unidades. No se borra ninguna fila: se llevan a 0
-- registrando el delta REAL (0 - cantidad_anterior), nunca un delta fijo.
-- El CTE `qa` fotografía la cantidad previa antes del UPDATE, así que el
-- movimiento registrado es exactamente lo que se descontó.
with qa as (
  select i.variant_id, i.location_id, i.cantidad as cantidad_anterior
  from public.inventory i
  join public.product_variants pv on pv.id = i.variant_id
  join public.products p on p.id = pv.product_id
  where p.is_test and i.cantidad <> 0
),
mov as (
  insert into public.inventory_movements (variant_id, location_id, cantidad_delta, motivo, staff_id)
  select qa.variant_id, qa.location_id, (0 - qa.cantidad_anterior),
         'Saneamiento administrativo de datos QA históricos', null
  from qa
  returning variant_id, location_id
)
update public.inventory i
set cantidad = 0, updated_at = now()
from mov
where i.variant_id = mov.variant_id and i.location_id = mov.location_id;

-- ----------------------------------------------------------------------------
-- Consumidores que deben excluir catálogo de prueba.
-- ----------------------------------------------------------------------------

-- 1) El conteo físico: es el riesgo declarado. Se excluye tanto de las líneas
--    de cantidad como del snapshot de seriales esperados.
create or replace function public.iniciar_inventario_fisico(p_observacion text default null)
returns inventarios_fisicos
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare s public.staff; f public.inventarios_fisicos;
begin
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  if s.id is null or not(s.rol='administrador' or coalesce(s.puesto,'') in('tecnico','encargado','jefa')) then
    raise exception 'Sin permiso';
  end if;
  if exists(select 1 from public.inventarios_fisicos where location_id=s.location_id and estado='abierto') then
    raise exception 'Ya existe un conteo abierto';
  end if;
  insert into public.inventarios_fisicos(location_id,creado_por,observacion) values(s.location_id,s.id,nullif(btrim(p_observacion),'')) returning * into f;

  -- Las serializadas arrancan en 0: su cantidad se deriva de los escaneos.
  -- Los productos de prueba no entran: no existen físicamente.
  insert into public.inventario_fisico_items(inventario_id,variant_id,cantidad_sistema,cantidad_contada)
    select f.id, i.variant_id, i.cantidad,
           case when coalesce(p.control_serial,false) then 0 else null end
    from public.inventory i
    join public.product_variants pv on pv.id = i.variant_id
    join public.products p on p.id = pv.product_id
    where i.location_id = s.location_id and not p.is_test;

  insert into public.inventario_fisico_seriales(inventario_id, variant_id, serial_id, serial_number, esperado)
  select f.id, ps.variant_id, ps.id, ps.serial_number, true
  from public.product_serials ps
  join public.product_variants pv on pv.id = ps.variant_id
  join public.products p on p.id = pv.product_id
  where p.control_serial and not p.is_test and ps.location_id = s.location_id and ps.estado = 'disponible';

  return f;
end$function$;

-- 2) Valorización de inventario: los S/3300 sintéticos no deben sumar.
--    (definición real leída de producción; sólo se añade el filtro)
create or replace function public.inventario_valorizado_admin(p_location_id uuid default null)
returns table(location_id uuid, variant_id uuid, producto text, sku text, color text, cantidad integer, costo_unitario numeric, valor_stock numeric)
language plpgsql
stable
security definer
set search_path to 'public', 'private'
as $function$
declare v_staff public.staff; v_location uuid;
begin
  select * into v_staff from public.staff where user_id=auth.uid() and activo=true and rol='administrador' limit 1;
  if v_staff.id is null then raise exception 'Solo administración'; end if;
  v_location:=coalesce(p_location_id,v_staff.location_id);
  return query
    select i.location_id,i.variant_id,p.nombre::text,p.sku::text,pv.color::text,i.cantidad,coalesce(p.costo,0)::numeric,round(i.cantidad*coalesce(p.costo,0),2)::numeric
    from public.inventory i join public.product_variants pv on pv.id=i.variant_id join public.products p on p.id=pv.product_id
    where i.location_id=v_location and not p.is_test order by p.nombre,pv.color;
end$function$;

-- 3) Reconciliación de seriales: los seriales QA producían diferencias fantasma.
create or replace function public.reconciliacion_seriales_admin(p_location_id uuid default null)
returns table(variant_id uuid, producto text, color text, stock_numerico integer, seriales_disponibles integer, diferencia integer)
language plpgsql
stable
security definer
set search_path to 'public', 'private'
as $function$
declare s public.staff; loc uuid;
begin
  if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  loc:=coalesce(p_location_id,s.location_id);
  return query
  select i.variant_id,p.nombre::text,pv.color::text,i.cantidad,
         count(ps.id) filter(where ps.estado='disponible' and ps.location_id=loc)::int,
         (i.cantidad-count(ps.id) filter(where ps.estado='disponible' and ps.location_id=loc))::int
  from public.inventory i
  join public.product_variants pv on pv.id=i.variant_id
  join public.products p on p.id=pv.product_id and p.control_serial=true
  left join public.product_serials ps on ps.variant_id=i.variant_id
  where i.location_id=loc and not p.is_test
  group by i.variant_id,p.nombre,pv.color,i.cantidad
  order by abs(i.cantidad-count(ps.id) filter(where ps.estado='disponible' and ps.location_id=loc)) desc,p.nombre;
end$function$;

-- 4) Alertas operativas: no debe emitirse "Stock crítico" de un producto QA.
--    Ya hace join a products, así que sólo se añade el filtro en esa rama.
create or replace function public.generar_alertas_operativas_admin()
returns integer
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare n integer:=0; x integer;
begin
 if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
 insert into public.notificaciones(location_id,tipo,titulo,mensaje,prioridad,recurso_tipo,recurso_id,event_key)
 select i.location_id,'stock_critico','Stock crítico',p.nombre||coalesce(' · '||pv.color,'')||': '||i.cantidad||' unidad(es), mínimo '||i.stock_minimo,
        case when i.cantidad<=0 then 'critica' else 'alta' end,'variant',i.variant_id,
        'stock:'||i.location_id||':'||i.variant_id||':'||current_date
 from public.inventory i join public.product_variants pv on pv.id=i.variant_id join public.products p on p.id=pv.product_id
 where i.cantidad<=i.stock_minimo and not p.is_test
 on conflict(event_key) do nothing; get diagnostics x=row_count; n:=n+x;

 insert into public.notificaciones(staff_id,location_id,tipo,titulo,mensaje,prioridad,recurso_tipo,recurso_id,event_key)
 select a.staff_id,s.location_id,'tardanza','Tardanza registrada',s.nombre||' registró '||coalesce(a.minutos_tarde,0)||' min de tardanza','alta','asistencia',a.id,'tarde:'||a.id
 from public.asistencias a join public.staff s on s.id=a.staff_id
 where a.fecha>=current_date-7 and coalesce(a.minutos_tarde,0)>0
 on conflict(event_key) do nothing; get diagnostics x=row_count; n:=n+x;

 insert into public.notificaciones(staff_id,location_id,tipo,titulo,mensaje,prioridad,recurso_tipo,recurso_id,event_key)
 select a.staff_id,s.location_id,'jornada_incompleta','Jornada sin salida',s.nombre||' tiene una entrada sin salida del '||a.fecha,'alta','asistencia',a.id,'sin-salida:'||a.id
 from public.asistencias a join public.staff s on s.id=a.staff_id
 where a.entrada is not null and a.salida is null and a.fecha<current_date
 on conflict(event_key) do nothing; get diagnostics x=row_count; n:=n+x;

 insert into public.notificaciones(location_id,tipo,titulo,mensaje,prioridad,recurso_tipo,recurso_id,event_key)
 select cs.location_id,'diferencia_caja','Diferencia de caja','Caja con diferencia de S/ '||coalesce(cs.diferencia,0)::text,
        case when abs(coalesce(cs.diferencia,0))>=coalesce((select diferencia_caja_critica from public.configuracion where id=1),20) then 'critica' else 'alta' end,
        'cash_session',cs.id,'caja-dif:'||cs.id
 from public.cash_sessions cs where cs.cierre is not null and not cs.is_test and abs(coalesce(cs.diferencia,0))>0 and cs.cierre>=now()-interval '30 days'
 on conflict(event_key) do nothing; get diagnostics x=row_count; n:=n+x;

 insert into public.notificaciones(staff_id,location_id,tipo,titulo,mensaje,prioridad,recurso_tipo,recurso_id,event_key)
 select pp.staff_id,s.location_id,'permiso_personal','Permiso / licencia registrado',s.nombre||': '||pp.tipo||' del '||pp.fecha_desde||' al '||pp.fecha_hasta,'media','personal_permiso',pp.id,'permiso:'||pp.id
 from public.personal_permisos pp join public.staff s on s.id=pp.staff_id
 where pp.activo and pp.created_at>=now()-interval '30 days'
 on conflict(event_key) do nothing; get diagnostics x=row_count; n:=n+x;
 return n;
end$function$;

-- El contador de "stock crítico" del dashboard leía public.inventory sin mirar
-- el catálogo. Sin este filtro el saneamiento lo EMPEORA: las 8 filas QA quedan
-- en cantidad=0, y 0 <= stock_minimo es cierto siempre, así que el indicador
-- pasaría de 1 crítico (hoy, también QA) a 8 críticos permanentes e
-- irresolubles — nadie puede reponer un producto que no existe. Con el filtro
-- queda en 0, que es el número real. Se replica la definición vigente y sólo
-- se añaden los dos joins y `not p.is_test`; el resto es idéntico.
create or replace function public.dashboard_operativo_admin()
returns jsonb
language sql
stable
set search_path to 'public', 'private'
as $function$
  with hoy as (select (now() at time zone 'America/Lima')::date fecha),
  ventas as (select coalesce(sum(s.total),0)::numeric total,count(*)::int cantidad from public.sales s,hoy h where private.auth_is_admin() and s.estado='completada' and not s.is_test and (s.fecha at time zone 'America/Lima')::date=h.fecha),
  cajas as (select count(*)::int abiertas from public.cash_sessions c where private.auth_is_admin() and c.cierre is null and not c.is_test),
  stock as (select count(*)::int criticos from public.inventory i
            join public.product_variants pv on pv.id=i.variant_id
            join public.products p on p.id=pv.product_id
            where private.auth_is_admin() and i.cantidad<=i.stock_minimo and not p.is_test),
  ordenes as (select count(*) filter(where coalesce(o.estado,'') not in('entregado','cancelado'))::int pendientes,count(*) filter(where o.estado='listo')::int listas from public.ordenes_servicio o where private.auth_is_admin()),
  personal as (
    select count(*)::int total,
      count(*) filter(where p.estado='descanso')::int descanso,
      count(*) filter(where p.estado='pendiente')::int pendientes,
      count(*) filter(where p.estado in('presente','tarde'))::int trabajando,
      count(*) filter(where p.estado='tarde')::int tarde,
      count(*) filter(where p.estado='salio')::int salieron,
      count(*) filter(where p.estado in('permiso','vacaciones','licencia'))::int permisos
    from public.personal_activo_hoy() p where private.auth_is_admin()
  ),
  config as (select count(*)::int incompletos from public.personal_configuracion_pendiente() where private.auth_is_admin())
  select case when not private.auth_is_admin() then null else jsonb_build_object(
    'fecha',(select fecha from hoy),'ventas_total',(select total from ventas),'ventas_cantidad',(select cantidad from ventas),
    'cajas_abiertas',(select abiertas from cajas),'stock_critico',(select criticos from stock),'ordenes_pendientes',(select pendientes from ordenes),'ordenes_listas',(select listas from ordenes),
    'personal_total',(select total from personal),'personal_descanso',(select descanso from personal),'personal_pendiente',(select pendientes from personal),'personal_trabajando',(select trabajando from personal),'personal_tarde',(select tarde from personal),'personal_salieron',(select salieron from personal),'personal_permisos',(select permisos from personal),
    'config_incompleta',(select incompletos from config)) end;
$function$;
