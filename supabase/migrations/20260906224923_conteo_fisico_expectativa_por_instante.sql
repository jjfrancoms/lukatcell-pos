-- ============================================================================
-- P0.1 — Corrección matemática del conteo físico concurrente.
--
-- El fix anterior (cierre_conteo_fisico_no_pisa_concurrencia) calculaba
-- diferencia = cantidad_contada - cantidad_sistema (snapshot al ABRIR el
-- conteo) y aplicaba ese delta sobre el inventory.cantidad actual al
-- CERRAR. Eso es incorrecto si hay movimientos entre la apertura del conteo
-- y el instante en que se contó físicamente esa línea:
--
--   snapshot inicial = 10
--   venta concurrente = -2 (antes de contar)
--   conteo físico = 9
--
-- Diferencia real esperada: al momento de contar, el sistema "esperaba" 8
-- (10-2), y se encontraron 9 → sobran +1. El cálculo anterior daba
-- diferencia = 9-10 = -1 (comparando contra el snapshot de apertura, no
-- contra lo que realmente correspondía en el instante del conteo).
--
-- Fix: se registra `counted_at` por línea (el instante real en que se contó
-- ESA línea, no el cierre del conteo completo), y el "esperado" se
-- reconstruye como snapshot + movimientos de inventario ocurridos entre la
-- apertura del conteo y ese instante exacto. La diferencia real se aplica
-- como delta sobre el inventory.cantidad ACTUAL al cerrar (que ya incluye
-- cualquier movimiento posterior al conteo de esa línea).
--
-- Backfill: líneas de conteos ya en curso al desplegar esta migración no
-- tienen `counted_at` (no se inventa un valor histórico) — cerrar_inventario_
-- fisico usa `coalesce(counted_at, now())` como fallback explícito para esas
-- líneas puntuales, degradando (solo para ellas) al comportamiento del fix
-- anterior; todo conteo iniciado después de este despliegue queda con
-- `counted_at` exacto por línea.
-- ============================================================================

alter table public.inventario_fisico_items add column if not exists counted_at timestamptz;

create or replace function public.registrar_conteo_fisico(p_inventario_id uuid, p_variant_id uuid, p_cantidad integer)
returns boolean
language plpgsql
security definer
set search_path = public, private
as $function$
declare
  s public.staff;
  f public.inventarios_fisicos;
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
  update public.inventario_fisico_items set cantidad_contada=p_cantidad, counted_at=now() where inventario_id=f.id and variant_id=p_variant_id;
  if not found then
    insert into public.inventario_fisico_items(inventario_id,variant_id,cantidad_sistema,cantidad_contada,counted_at) values(f.id,p_variant_id,0,p_cantidad,now());
  end if;
  return true;
end$function$;

create or replace function public.cerrar_inventario_fisico(p_inventario_id uuid)
returns inventarios_fisicos
language plpgsql
security definer
set search_path = public, private
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
    if coalesce(v_control,false) and i.cantidad_contada <> i.cantidad_sistema then
      raise exception 'Producto serializado con diferencia: reconcilia IMEI/series antes de cerrar';
    end if;

    select coalesce(sum(im.cantidad_delta),0) into v_movimientos_hasta_conteo
    from public.inventory_movements im
    where im.variant_id=i.variant_id and im.location_id=f.location_id
      and im.created_at > f.fecha_inicio and im.created_at <= coalesce(i.counted_at, now());
    v_esperado_al_contar := i.cantidad_sistema + v_movimientos_hasta_conteo;
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
