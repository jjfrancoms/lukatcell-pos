-- ============================================================================
-- P2.D — CRM: alcance del perfil, actualización y columnas escribibles
-- ============================================================================
-- Auditoría (2026-09-13, sólo lectura contra producción):
--
-- C1. perfil_cliente_crm es SECURITY DEFINER y sólo exigía staff vinculado.
--     Devolvía TODAS las compras, reparaciones y movimientos de puntos del
--     cliente, de todas las sucursales: se saltaba la RLS `ventas_por_ubicacion`
--     y la de puntos (corregida en _p2_c). Ahora un no-administrador ve sólo lo
--     de su sucursal activa (puntos: mismo criterio que la policy). Los datos
--     maestros del cliente siguen visibles para todos: `clientes` es un maestro
--     compartido a propósito (RLS SELECT true).
-- C2. total_gastado / compras incluían ventas is_test (rompe el invariante de
--     P0.4 "las ventas de prueba no cuentan en finanzas"). Se excluyen.
-- C3. actualizar_cliente_crm sólo exigía staff vinculado: cualquier vendedor
--     podía cambiar documento, segmento y CONSENTIMIENTOS de WhatsApp/email de
--     cualquier cliente. Su único llamador es /crm (AdminRoute). Ahora exige
--     administrador. Además: null = sin cambio (antes null ponía los
--     consentimientos en false y el segmento en 'general'), y
--     consentimiento_at se fecha en todo cambio de consentimiento, también el
--     retiro (antes sólo al otorgar, y se re-fechaba en cada guardado).
-- C4. `authenticated` tenía INSERT/UPDATE sobre TODAS las columnas de clientes
--     (privilegios por defecto) con RLS `true`: cualquiera podía fijar `puntos`
--     por PostgREST saltándose ajustar_puntos_cliente_admin y su ledger, o
--     marcar consentimientos. El frontend sólo escribe nombre, teléfono, email
--     y notas (Clientes.tsx, OrdenesServicio.tsx). Las únicas funciones que
--     escriben puntos/consentimientos son SECURITY DEFINER y no se ven
--     afectadas. Se reemplaza el privilegio de tabla por privilegios de columna.
--
-- Producción: 1 cliente, 0 movimientos de puntos.
-- ============================================================================

create or replace function public.perfil_cliente_crm(p_cliente_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  c        public.clientes;
  v_admin  boolean;
  v_loc    uuid;
begin
  if private.auth_staff_id() is null then raise exception 'Usuario no vinculado'; end if;
  v_admin := private.auth_is_admin();
  v_loc   := private.auth_location_id();

  select * into c from public.clientes where id = p_cliente_id;
  if c.id is null then raise exception 'Cliente inexistente'; end if;

  return jsonb_build_object(
    'cliente', to_jsonb(c),
    'resumen', (
      select jsonb_build_object(
        'total_gastado', coalesce(sum(s.total) filter (where s.estado = 'completada'), 0),
        'compras',       count(*) filter (where s.estado = 'completada'),
        'ultima_compra', max(s.fecha) filter (where s.estado = 'completada'),
        'reparaciones',  (select count(*) from public.ordenes_servicio o
                           where o.cliente_id = c.id and (v_admin or o.location_id = v_loc)))
      from public.sales s
      where s.cliente_id = c.id and not s.is_test and (v_admin or s.location_id = v_loc)
    ),
    'compras', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'numero', s.numero, 'fecha', s.fecha, 'total', s.total, 'estado', s.estado)
                       order by s.fecha desc)
      from public.sales s
      where s.cliente_id = c.id and not s.is_test and (v_admin or s.location_id = v_loc)
    ), '[]'::jsonb),
    'reparaciones', coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'numero', o.numero, 'equipo', concat_ws(' ', o.equipo_marca, o.equipo_modelo),
                                          'estado', o.estado, 'fecha_recepcion', o.fecha_recepcion, 'costo_final', o.costo_final)
                       order by o.fecha_recepcion desc)
      from public.ordenes_servicio o
      where o.cliente_id = c.id and (v_admin or o.location_id = v_loc)
    ), '[]'::jsonb),
    -- Mismo criterio que la policy cliente_puntos_read (_p2_c).
    'puntos_movimientos', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'puntos', m.puntos, 'motivo', m.motivo, 'created_at', m.created_at)
                       order by m.created_at desc)
      from public.cliente_puntos_movimientos m
      where m.cliente_id = c.id
        and (v_admin or exists (select 1 from public.sales s where s.cliente_id = c.id and s.location_id = v_loc))
    ), '[]'::jsonb)
  );
end
$function$;

create or replace function public.actualizar_cliente_crm(
  p_cliente_id uuid, p_documento text, p_direccion text, p_segmento text,
  p_consentimiento_whatsapp boolean, p_consentimiento_email boolean)
returns void
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  c public.clientes;
begin
  if not private.auth_is_admin() then raise exception 'Solo administración'; end if;

  select * into c from public.clientes where id = p_cliente_id for update;
  if c.id is null then raise exception 'Cliente inexistente'; end if;

  update public.clientes set
    documento = case when p_documento is null then documento else nullif(trim(p_documento), '') end,
    direccion = case when p_direccion is null then direccion else nullif(trim(p_direccion), '') end,
    segmento  = case when p_segmento  is null then segmento  else coalesce(nullif(trim(p_segmento), ''), 'general') end,
    consentimiento_whatsapp = coalesce(p_consentimiento_whatsapp, consentimiento_whatsapp),
    consentimiento_email    = coalesce(p_consentimiento_email, consentimiento_email),
    consentimiento_at = case
      when coalesce(p_consentimiento_whatsapp, c.consentimiento_whatsapp) is distinct from c.consentimiento_whatsapp
        or coalesce(p_consentimiento_email, c.consentimiento_email) is distinct from c.consentimiento_email
      then now() else consentimiento_at end
  where id = p_cliente_id;
end
$function$;

-- C4: privilegios de columna. RLS de clientes no cambia.
revoke insert, update on public.clientes from authenticated;
grant insert (nombre, telefono, email, notas, documento, direccion) on public.clientes to authenticated;
grant update (nombre, telefono, email, notas, documento, direccion) on public.clientes to authenticated;
