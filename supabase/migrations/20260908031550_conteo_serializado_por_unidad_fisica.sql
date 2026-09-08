-- ============================================================================
-- P0.2 bloque 3+4+5: conteo físico serializado usa el stock esperado real
-- (no el snapshot de apertura), reconcilia por UNIDAD (IMEI/serie), y expone
-- al frontend la diferencia real ya calculada por el backend.
--
-- Bloque 3: cerrar_inventario_fisico comparaba, para productos serializados,
-- `cantidad_contada <> cantidad_sistema` (snapshot de apertura) en vez de
-- `cantidad_contada <> esperado_al_contar` (snapshot + movimientos hasta el
-- instante del conteo) — el mismo bug matemático que ya se había corregido
-- para productos normales en P0.1 bloque 1, pero que sobrevivía sin corregir
-- en la rama de productos serializados.
--
-- Bloque 4: aunque la CANTIDAD coincida, contar solo un número no garantiza
-- que sean las mismas unidades físicas (sistema: A,B · físico: A,C -> 2=2
-- pero B falta y C es inesperado). Se agrega inventario_fisico_seriales
-- para reconciliar por serial real, con una RPC de "escanear" en vez de
-- tipear una cantidad para productos con control_serial.
--
-- Bloque 5: ConteoInventario.tsx recalculaba visualmente `contado -
-- cantidad_sistema` en React (la fórmula VIEJA), mientras el backend ya usa
-- esperado_al_contar — se expone una función de solo lectura con el desglose
-- real para que la UI deje de recalcular por su cuenta.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tabla de reconciliación por serial.
-- ----------------------------------------------------------------------------
create table public.inventario_fisico_seriales (
  id uuid primary key default gen_random_uuid(),
  inventario_id uuid not null references public.inventarios_fisicos(id),
  variant_id uuid not null references public.product_variants(id),
  serial_id uuid references public.product_serials(id),
  serial_number text not null,
  esperado boolean not null default false,
  encontrado boolean not null default false,
  estado_reconciliacion text not null default 'pendiente'
    check (estado_reconciliacion in ('pendiente','coincide','inesperado','resuelto')),
  resolucion text,
  resuelto_por uuid references public.staff(id),
  resuelto_at timestamptz,
  counted_at timestamptz,
  counted_by uuid references public.staff(id),
  created_at timestamptz not null default now()
);

create index inventario_fisico_seriales_lookup on public.inventario_fisico_seriales(inventario_id, variant_id);
-- Evita duplicar la fila "esperada" del mismo serial dentro del mismo conteo.
create unique index inventario_fisico_seriales_esperado_uniq
  on public.inventario_fisico_seriales(inventario_id, serial_id)
  where esperado and serial_id is not null;

alter table public.inventario_fisico_seriales enable row level security;

-- Mismo criterio de lectura que inventario_fisico_items (invfis_items_read):
-- admin o personal de la sucursal del conteo. Sin policy de escritura: toda
-- mutación pasa por RPC SECURITY DEFINER, igual que el resto de tablas de
-- inventario/catálogo/auditoría.
create policy invfis_seriales_read on public.inventario_fisico_seriales
  for select using (
    exists (
      select 1 from public.inventarios_fisicos f
      where f.id = inventario_fisico_seriales.inventario_id
        and (private.auth_is_admin() or f.location_id = private.auth_location_id())
    )
  );

-- ----------------------------------------------------------------------------
-- 2. iniciar_inventario_fisico: además del snapshot de cantidades, snapshotea
--    los seriales ESPERADOS (product_serials en 'disponible' en esa sucursal)
--    de cada variante serializada — es la lista contra la que se reconcilia
--    cada escaneo.
-- ----------------------------------------------------------------------------
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
  insert into public.inventario_fisico_items(inventario_id,variant_id,cantidad_sistema)
    select f.id,i.variant_id,i.cantidad from public.inventory i where i.location_id=s.location_id;

  insert into public.inventario_fisico_seriales(inventario_id, variant_id, serial_id, serial_number, esperado)
  select f.id, ps.variant_id, ps.id, ps.serial_number, true
  from public.product_serials ps
  join public.product_variants pv on pv.id = ps.variant_id
  join public.products p on p.id = pv.product_id
  where p.control_serial and ps.location_id = s.location_id and ps.estado = 'disponible';

  return f;
end$function$;

-- ----------------------------------------------------------------------------
-- 3. registrar_conteo_fisico: ya no acepta una cantidad tipeada a mano para
--    un producto serializado — debe reconciliarse por unidad, vía
--    registrar_serial_contado.
-- ----------------------------------------------------------------------------
create or replace function public.registrar_conteo_fisico(p_inventario_id uuid, p_variant_id uuid, p_cantidad integer)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  s public.staff;
  f public.inventarios_fisicos;
  v_control boolean;
begin
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  if s.id is null or not(s.rol='administrador' or coalesce(s.puesto,'') in('tecnico','encargado','jefa')) then
    raise exception 'Sin permiso';
  end if;
  if p_cantidad<0 then raise exception 'Cantidad inválida'; end if;
  select * into f from public.inventarios_fisicos where id=p_inventario_id;
  if f.id is null or f.location_id<>s.location_id or f.estado<>'abierto' then
    raise exception 'Conteo no editable';
  end if;

  select p.control_serial into v_control
  from public.product_variants pv join public.products p on p.id=pv.product_id
  where pv.id=p_variant_id;
  if coalesce(v_control,false) then
    raise exception 'Este producto tiene IMEI/serie: escanea cada unidad en vez de escribir una cantidad' using errcode = 'P0001';
  end if;

  update public.inventario_fisico_items set cantidad_contada=p_cantidad, counted_at=now() where inventario_id=f.id and variant_id=p_variant_id;
  if not found then
    insert into public.inventario_fisico_items(inventario_id,variant_id,cantidad_sistema,cantidad_contada,counted_at) values(f.id,p_variant_id,0,p_cantidad,now());
  end if;
  return true;
end$function$;

-- ----------------------------------------------------------------------------
-- 4. registrar_serial_contado: "escanear" un IMEI/serie durante el conteo.
--    Si coincide con uno esperado (product_serials 'disponible' en esa
--    sucursal al abrir el conteo) lo marca 'coincide'. Si no, lo registra
--    como 'inesperado' — NUNCA crea un product_serials nuevo automáticamente,
--    requiere resolución explícita (resolver_reconciliacion_serial).
--    La cantidad_contada del ítem se deriva del conteo real de escaneos, no
--    de un número aparte que alguien pueda desincronizar.
-- ----------------------------------------------------------------------------
create or replace function public.registrar_serial_contado(p_inventario_id uuid, p_variant_id uuid, p_serial_number text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  s public.staff;
  f public.inventarios_fisicos;
  v_norm text := upper(trim(coalesce(p_serial_number, '')));
  v_row public.inventario_fisico_seriales;
  v_serial_id uuid;
begin
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  if s.id is null or not(s.rol='administrador' or coalesce(s.puesto,'') in('tecnico','encargado','jefa')) then
    raise exception 'Sin permiso';
  end if;
  select * into f from public.inventarios_fisicos where id=p_inventario_id;
  if f.id is null or f.location_id<>s.location_id or f.estado<>'abierto' then
    raise exception 'Conteo no editable';
  end if;
  if v_norm = '' then raise exception 'Serial vacío'; end if;

  select * into v_row from public.inventario_fisico_seriales
  where inventario_id = p_inventario_id and variant_id = p_variant_id
    and upper(serial_number) = v_norm and esperado and not encontrado
  for update;

  if v_row.id is not null then
    update public.inventario_fisico_seriales
    set encontrado = true, estado_reconciliacion = 'coincide', counted_at = now(), counted_by = s.id
    where id = v_row.id;
  else
    if exists (
      select 1 from public.inventario_fisico_seriales
      where inventario_id = p_inventario_id and variant_id = p_variant_id
        and upper(serial_number) = v_norm and encontrado
    ) then
      raise exception 'Este serial ya fue escaneado en este conteo' using errcode = 'P0001';
    end if;
    select id into v_serial_id from public.product_serials where upper(serial_number) = v_norm limit 1;
    insert into public.inventario_fisico_seriales(inventario_id, variant_id, serial_id, serial_number, esperado, encontrado, estado_reconciliacion, counted_at, counted_by)
    values (p_inventario_id, p_variant_id, v_serial_id, v_norm, false, true, 'inesperado', now(), s.id);
  end if;

  update public.inventario_fisico_items
  set cantidad_contada = (
        select count(*) from public.inventario_fisico_seriales
        where inventario_id = p_inventario_id and variant_id = p_variant_id and encontrado
      ),
      counted_at = now()
  where inventario_id = p_inventario_id and variant_id = p_variant_id;

  return jsonb_build_object('coincide', v_row.id is not null, 'serial_conocido', v_serial_id is not null);
end$function$;

-- ----------------------------------------------------------------------------
-- 5. resolver_reconciliacion_serial: resolución explícita administrativa de
--    un serial faltante ('pendiente', esperado pero nunca escaneado) o
--    inesperado (escaneado pero no en la lista esperada). Nunca automático.
-- ----------------------------------------------------------------------------
create or replace function public.resolver_reconciliacion_serial(p_item_id uuid, p_resolucion text)
returns void
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  s public.staff;
  v_row public.inventario_fisico_seriales;
  f public.inventarios_fisicos;
begin
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  if s.id is null or not(s.rol='administrador' or coalesce(s.puesto,'') in('encargado','jefa')) then
    raise exception 'Sin permiso';
  end if;
  if p_resolucion is null or length(trim(p_resolucion)) < 3 then
    raise exception 'Debes indicar cómo se resolvió (ubicación corregida, recepción omitida, cuarentena, error de escaneo, etc.)';
  end if;
  select * into v_row from public.inventario_fisico_seriales where id = p_item_id for update;
  if v_row.id is null then raise exception 'Registro no encontrado'; end if;
  if v_row.estado_reconciliacion = 'coincide' then raise exception 'Este serial ya coincide, no requiere resolución'; end if;
  select * into f from public.inventarios_fisicos where id = v_row.inventario_id;
  if f.id is null or f.location_id <> s.location_id or f.estado <> 'abierto' then
    raise exception 'Conteo no editable';
  end if;
  update public.inventario_fisico_seriales
  set estado_reconciliacion = 'resuelto', resolucion = trim(p_resolucion), resuelto_por = s.id, resuelto_at = now()
  where id = p_item_id;
end$function$;

grant execute on function public.registrar_serial_contado(uuid, uuid, text) to authenticated;
grant execute on function public.resolver_reconciliacion_serial(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 6. detalle_inventario_fisico: desglose de solo lectura con la diferencia
--    REAL ya calculada por el backend (misma fórmula que cerrar_inventario_
--    fisico) — la UI deja de recalcular `contado - cantidad_sistema` (la
--    fórmula vieja) por su cuenta.
-- ----------------------------------------------------------------------------
create or replace function public.detalle_inventario_fisico(p_inventario_id uuid)
returns table(
  item_id uuid,
  variant_id uuid,
  control_serial boolean,
  cantidad_sistema integer,
  movimientos_hasta_contar integer,
  cantidad_esperada integer,
  cantidad_contada integer,
  diferencia_real integer,
  counted_at timestamptz,
  seriales_esperados integer,
  seriales_encontrados integer,
  seriales_pendientes_reconciliar integer
)
language plpgsql
stable
security definer
set search_path to 'public', 'private'
as $function$
declare f public.inventarios_fisicos;
begin
  select * into f from public.inventarios_fisicos where id = p_inventario_id;
  if f.id is null or not (private.auth_is_admin() or f.location_id = private.auth_location_id()) then
    raise exception 'Sin permiso';
  end if;

  return query
  select
    i.id,
    i.variant_id,
    coalesce(p.control_serial, false),
    i.cantidad_sistema,
    coalesce((
      select sum(im.cantidad_delta)::integer from public.inventory_movements im
      where im.variant_id = i.variant_id and im.location_id = f.location_id
        and im.created_at > f.fecha_inicio and im.created_at <= coalesce(i.counted_at, now())
    ), 0),
    i.cantidad_sistema + coalesce((
      select sum(im.cantidad_delta)::integer from public.inventory_movements im
      where im.variant_id = i.variant_id and im.location_id = f.location_id
        and im.created_at > f.fecha_inicio and im.created_at <= coalesce(i.counted_at, now())
    ), 0),
    i.cantidad_contada,
    case when i.cantidad_contada is null then null
      else i.cantidad_contada - (i.cantidad_sistema + coalesce((
        select sum(im.cantidad_delta)::integer from public.inventory_movements im
        where im.variant_id = i.variant_id and im.location_id = f.location_id
          and im.created_at > f.fecha_inicio and im.created_at <= coalesce(i.counted_at, now())
      ), 0))
    end,
    i.counted_at,
    (select count(*)::integer from public.inventario_fisico_seriales s where s.inventario_id = i.inventario_id and s.variant_id = i.variant_id and s.esperado),
    (select count(*)::integer from public.inventario_fisico_seriales s where s.inventario_id = i.inventario_id and s.variant_id = i.variant_id and s.encontrado),
    (select count(*)::integer from public.inventario_fisico_seriales s where s.inventario_id = i.inventario_id and s.variant_id = i.variant_id and s.estado_reconciliacion not in ('coincide','resuelto'))
  from public.inventario_fisico_items i
  left join public.product_variants pv on pv.id = i.variant_id
  left join public.products p on p.id = pv.product_id
  where i.inventario_id = p_inventario_id;
end$function$;

grant execute on function public.detalle_inventario_fisico(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 7. cerrar_inventario_fisico: para serializados, compara contra el
--    esperado REAL (Bloque 3) y exige cero seriales sin reconciliar
--    (Bloque 4) — coincidir en cantidad ya no es suficiente por sí solo.
--    Productos serializados nunca ajustan inventory.cantidad numéricamente
--    aquí (su stock real ya lo gobiernan product_serials/movimientos reales,
--    no un ajuste agregado a ciegas).
-- ----------------------------------------------------------------------------
create or replace function public.cerrar_inventario_fisico(p_inventario_id uuid)
returns inventarios_fisicos
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  s public.staff;
  f public.inventarios_fisicos;
  i public.inventario_fisico_items;
  v_control boolean;
  v_movimientos_hasta_conteo integer;
  v_esperado_al_contar integer;
  v_real_diff integer;
  v_actual integer;
  v_nuevo integer;
  v_motivo text;
begin
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  if s.id is null or not(s.rol='administrador' or coalesce(s.puesto,'') in('encargado','jefa')) then
    raise exception 'Solo administración/encargado puede cerrar conteo';
  end if;
  select * into f from public.inventarios_fisicos where id=p_inventario_id for update;
  if f.id is null or f.location_id<>s.location_id or f.estado<>'abierto' then
    raise exception 'Conteo no cerrable';
  end if;
  if exists(select 1 from public.inventario_fisico_items where inventario_id=f.id and cantidad_contada is null) then
    raise exception 'Faltan productos por contar';
  end if;

  for i in select * from public.inventario_fisico_items where inventario_id=f.id loop
    select p.control_serial into v_control from public.product_variants pv join public.products p on p.id=pv.product_id where pv.id=i.variant_id;

    select coalesce(sum(im.cantidad_delta),0) into v_movimientos_hasta_conteo
    from public.inventory_movements im
    where im.variant_id=i.variant_id and im.location_id=f.location_id
      and im.created_at > f.fecha_inicio and im.created_at <= coalesce(i.counted_at, now());
    v_esperado_al_contar := i.cantidad_sistema + v_movimientos_hasta_conteo;

    if coalesce(v_control,false) then
      if i.cantidad_contada <> v_esperado_al_contar then
        raise exception 'Producto serializado con diferencia: reconcilia IMEI/series antes de cerrar (esperado %, contado %)', v_esperado_al_contar, i.cantidad_contada;
      end if;
      if exists (
        select 1 from public.inventario_fisico_seriales
        where inventario_id = f.id and variant_id = i.variant_id
          and estado_reconciliacion not in ('coincide','resuelto')
      ) then
        raise exception 'Quedan seriales sin reconciliar para un producto serializado (faltantes o inesperados)';
      end if;
      continue;
    end if;

    v_real_diff := i.cantidad_contada - v_esperado_al_contar;

    if v_real_diff <> 0 then
      select cantidad into v_actual from public.inventory where variant_id=i.variant_id and location_id=f.location_id for update;
      v_actual := coalesce(v_actual, 0);
      v_nuevo := v_actual + v_real_diff;
      v_motivo := 'Ajuste conteo físico';
      if v_nuevo < 0 then
        v_motivo := v_motivo || ' (ajustado a 0: movimientos posteriores ya redujeron más de lo esperado)';
        v_nuevo := 0;
      end if;

      insert into public.inventory(variant_id,location_id,cantidad,updated_at) values(i.variant_id,f.location_id,v_nuevo,now())
      on conflict(variant_id,location_id) do update set cantidad=v_nuevo,updated_at=now();
      insert into public.inventory_movements(variant_id,location_id,cantidad_delta,motivo,staff_id) values(i.variant_id,f.location_id,v_nuevo-v_actual,v_motivo,s.id);
    end if;
  end loop;

  update public.inventarios_fisicos set estado='cerrado',cerrado_por=s.id,fecha_cierre=now() where id=f.id returning * into f;
  return f;
end$function$;
