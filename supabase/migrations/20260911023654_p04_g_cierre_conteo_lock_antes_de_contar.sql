-- ============================================================================
-- P0.4 / R7 — El cierre de conteo podía resucitar stock ya vendido.
--
-- La rama SERIALIZADA de cerrar_inventario_fisico hacía, en este orden:
--     1) select count(*) from product_serials ... estado='disponible'  -> v_disponibles
--     2) select cantidad from inventory ... for update                 -> v_actual
--     3) update inventory set cantidad = v_disponibles
--
-- Bajo READ COMMITTED cada sentencia toma su propio snapshot. El paso 1 lee
-- ANTES de bloquear nada; el paso 2 se queda esperando el lock que tiene una
-- venta en curso y, cuando ésta hace commit, re-lee la fila ya actualizada.
-- Resultado: v_disponibles es de antes de la venta y v_actual de después.
--
--     inventory = 10, seriales disponibles = 10
--     T_venta   marca un serial como 'vendido' y baja inventory 10 -> 9 (sin commit)
--     T_cierre  cuenta 10 seriales disponibles (aún no ve la venta)
--     T_cierre  pide el lock de inventory y espera
--     T_venta   commit
--     T_cierre  obtiene v_actual = 9 y escribe cantidad = 10
--     -> la unidad vendida REAPARECE en stock, con un movimiento +1 falso
--
-- Por qué sólo afecta a la rama serializada: la NO serializada aplica un
-- DELTA (v_actual + v_real_diff) sobre el valor recién bloqueado, así que una
-- venta concurrente se absorbe sola. La serializada asigna un ABSOLUTO
-- (cantidad = v_disponibles), y ahí una lectura obsoleta es destructiva.
--
-- Corrección: delegar en private.sincronizar_stock_serializado, que ya nació
-- en P0.4 con el orden seguro — bloquea inventory ANTES de contar los
-- seriales, de modo que cuando obtiene el lock la venta concurrente ya hizo
-- commit y el conteo posterior sí la ve. Contratos que se conservan:
--   * escribe sólo si el delta es distinto de 0 (equivale al
--     `if v_disponibles <> v_actual` anterior);
--   * registra UN solo movimiento, con delta real cantidad_nueva - anterior;
--   * crea la fila de inventory si no existía;
--   * mismo motivo y mismo staff_id que antes.
-- No introduce doble movimiento: es la única escritura de esa iteración, igual
-- que el bloque que sustituye.
--
-- ÚNICA diferencia de comportamiento, deliberada y acotada: cuando la variante
-- serializada NO tiene fila en `inventory` y hay 0 seriales disponibles, el
-- bloque anterior no escribía nada (0 <> 0 es falso) y éste deja la fila creada
-- en 0, porque la función hace `insert ... on conflict do nothing` antes de
-- comparar. En la práctica es inalcanzable desde aquí: los
-- `inventario_fisico_items` se siembran DESDE `inventory`, así que para estar
-- en el bucle la fila ya existe. Se documenta porque el efecto observable
-- sería una fila a 0 que cuenta como "stock crítico" (0 <= stock_minimo).
--
-- La guarda de control_serial de esa función se cumple por construcción: esta
-- rama sólo se ejecuta dentro de `if coalesce(v_control,false)`.
--
-- Se añade además `order by variant_id` al bucle para que el orden de locks
-- sea determinista. NO es una garantía anti-deadlock (una venta multi-línea
-- sigue bloqueando en el orden de sus sale_items), pero elimina la
-- arbitrariedad del lado del cierre y hace el comportamiento reproducible.
--
-- Forward-only: NO se edita 20260909015208, que ya está aplicada.
-- ============================================================================

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
  v_pendientes int;
  v_bloqueantes int;
begin
  select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
  if s.id is null or not(s.rol='administrador' or coalesce(s.puesto,'') in('encargado','jefa')) then
    raise exception 'Solo administración/encargado puede cerrar conteo';
  end if;
  select * into f from public.inventarios_fisicos where id=p_inventario_id for update;
  if f.id is null or f.location_id<>s.location_id or f.estado<>'abierto' then
    raise exception 'Conteo no cerrable';
  end if;

  -- Sólo las NO serializadas requieren una cantidad escrita: las
  -- serializadas se rigen por la reconciliación unidad por unidad.
  if exists(
    select 1 from public.inventario_fisico_items ifi
    join public.product_variants pv on pv.id = ifi.variant_id
    join public.products p on p.id = pv.product_id
    where ifi.inventario_id=f.id and ifi.cantidad_contada is null and not coalesce(p.control_serial,false)
  ) then
    raise exception 'Faltan productos por contar';
  end if;

  for i in select * from public.inventario_fisico_items where inventario_id=f.id order by variant_id loop
    select p.control_serial into v_control from public.product_variants pv join public.products p on p.id=pv.product_id where pv.id=i.variant_id;

    select coalesce(sum(im.cantidad_delta),0) into v_movimientos_hasta_conteo
    from public.inventory_movements im
    where im.variant_id=i.variant_id and im.location_id=f.location_id
      and im.created_at > f.fecha_inicio and im.created_at <= coalesce(i.counted_at, now());
    v_esperado_al_contar := i.cantidad_sistema + v_movimientos_hasta_conteo;

    if coalesce(v_control,false) then
      select count(*) into v_pendientes from public.inventario_fisico_seriales
      where inventario_id=f.id and variant_id=i.variant_id
        and estado_reconciliacion not in ('coincide','resuelto');
      if v_pendientes > 0 then
        raise exception 'Quedan % serial(es) sin reconciliar en un producto serializado', v_pendientes using errcode = 'P0001';
      end if;

      select count(*) into v_bloqueantes from public.inventario_fisico_seriales
      where inventario_id=f.id and variant_id=i.variant_id
        and estado_reconciliacion='resuelto'
        and coalesce(tipo_resolucion,'') in ('investigacion','recepcion_omitida');
      if v_bloqueantes > 0 then
        raise exception 'Hay % serial(es) en investigación o pendientes de una recepción real: resuélvelos con un tipo definitivo antes de cerrar', v_bloqueantes using errcode = 'P0001';
      end if;

      -- R7: el bloque que había aquí contaba los seriales ANTES de bloquear
      -- inventory. Esta función hace lo contrario, que es lo correcto.
      perform private.sincronizar_stock_serializado(
        i.variant_id, f.location_id, s.id,
        'Conteo físico: stock alineado a los IMEI/serie realmente disponibles');
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
