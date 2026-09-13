-- ============================================================================
-- P2.J — FASE 18 · Terminal de conciliación y reembolsos a través del proveedor
-- ============================================================================
-- Datos reales (sólo lectura, 2026-09-13): payments(metodo) sin restricción, con
-- efectivo / yape / tarjeta; conciliaciones_pago sin terminal; ningún estado ni
-- tabla representaba un reembolso devuelto por el proveedor (Yape, POS de tarjeta,
-- Culqi). Un reembolso digital se gestionaba fuera del sistema, sin rastro.
--
-- 1. Terminal: conciliaciones_pago.terminal, informada al conciliar contra el lote
--    del datáfono. registrar_venta (P0) NO se toca: la venta no conoce el
--    terminal; la conciliación sí.
-- 2. Reembolsos a proveedor: cabecera inmutable + eventos append-only
--    (solicitado → enviado → confirmado, o rechazado). Nada se edita ni se borra;
--    el estado vigente es el último evento. Cada estado aparece como mucho una vez.
--      · clave idempotente con huella de contenido (misma clave, otro contenido →
--        error; misma clave y contenido → devuelve el existente);
--      · la suma de reembolsos no rechazados nunca supera el monto del pago
--        (serializado con la fila de la venta bloqueada);
--      · un pago en efectivo no se reembolsa por proveedor (va por caja);
--      · sucursal activa con fallo cerrado, actor desde auth.uid().
-- 3. Adaptadores automáticos (API de reembolso de Culqi, POS externo): NO se
--    crean. Sin credenciales reales serían un éxito simulado. El proveedor se
--    opera fuera y aquí se registra la referencia que devuelve. Bloqueo externo.
-- ============================================================================

alter table public.conciliaciones_pago add column if not exists terminal text;

create table if not exists public.reembolsos_proveedor (
  id                     uuid primary key default gen_random_uuid(),
  payment_id             uuid not null references public.payments(id),
  sale_id                uuid not null references public.sales(id),
  location_id            uuid not null references public.locations(id),
  devolucion_id          uuid references public.devoluciones(id),
  metodo                 text not null,
  monto                  numeric(12,2) not null check (monto > 0),
  motivo                 text not null,
  client_transaction_id  uuid not null unique,
  payload_hash           text not null,
  creado_por             uuid not null references public.staff(id),
  created_at             timestamptz not null default now()
);
create index if not exists reembolsos_proveedor_payment on public.reembolsos_proveedor (payment_id);
create index if not exists reembolsos_proveedor_location on public.reembolsos_proveedor (location_id, created_at);

create table if not exists public.reembolso_proveedor_eventos (
  id                    bigserial primary key,
  reembolso_id          uuid not null references public.reembolsos_proveedor(id),
  estado                text not null check (estado in ('solicitado', 'enviado', 'confirmado', 'rechazado')),
  referencia_proveedor  text,
  nota                  text,
  actor_staff_id        uuid references public.staff(id),
  created_at            timestamptz not null default now(),
  constraint reembolso_proveedor_estado_unico unique (reembolso_id, estado)
);

create or replace function private.reembolsos_proveedor_append_only()
returns trigger
language plpgsql
as $function$
begin
  raise exception '% es de sólo inserción', tg_table_name using errcode = 'P0001';
end
$function$;
revoke all on function private.reembolsos_proveedor_append_only() from public;

drop trigger if exists reembolsos_proveedor_append_only on public.reembolsos_proveedor;
create trigger reembolsos_proveedor_append_only before update or delete on public.reembolsos_proveedor
  for each row execute function private.reembolsos_proveedor_append_only();
drop trigger if exists reembolso_proveedor_eventos_append_only on public.reembolso_proveedor_eventos;
create trigger reembolso_proveedor_eventos_append_only before update or delete on public.reembolso_proveedor_eventos
  for each row execute function private.reembolsos_proveedor_append_only();

alter table public.reembolsos_proveedor enable row level security;
alter table public.reembolso_proveedor_eventos enable row level security;

drop policy if exists reembolsos_proveedor_lectura on public.reembolsos_proveedor;
create policy reembolsos_proveedor_lectura on public.reembolsos_proveedor for select to authenticated
  using (private.auth_is_admin() or location_id = private.auth_location_id());
drop policy if exists reembolso_proveedor_eventos_lectura on public.reembolso_proveedor_eventos;
create policy reembolso_proveedor_eventos_lectura on public.reembolso_proveedor_eventos for select to authenticated
  using (exists (select 1 from public.reembolsos_proveedor r where r.id = reembolso_proveedor_eventos.reembolso_id
                 and (private.auth_is_admin() or r.location_id = private.auth_location_id())));

revoke insert, update, delete, truncate, references, trigger on public.reembolsos_proveedor, public.reembolso_proveedor_eventos from authenticated;
revoke all on public.reembolsos_proveedor, public.reembolso_proveedor_eventos from anon;
revoke all on sequence public.reembolso_proveedor_eventos_id_seq from authenticated, anon;

-- Estado vigente = último evento.
create or replace function private.estado_reembolso_proveedor(p_reembolso_id uuid)
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select e.estado from public.reembolso_proveedor_eventos e where e.reembolso_id = p_reembolso_id order by e.id desc limit 1;
$function$;
revoke all on function private.estado_reembolso_proveedor(uuid) from public;

-- ---------------------------------------------------------------------------
create or replace function public.solicitar_reembolso_proveedor_admin(
  p_payment_id uuid, p_monto numeric, p_motivo text, p_client_transaction_id uuid, p_devolucion_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_staff  uuid := private.auth_staff_id();
  v_loc    uuid := private.auth_location_id();
  v_pay    public.payments;
  v_venta  public.sales;
  v_dev    public.devoluciones;
  v_prev   public.reembolsos_proveedor;
  v_hash   text;
  v_total  numeric;
  v_monto  numeric;
  v_id     uuid;
begin
  if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
  if p_client_transaction_id is null then raise exception 'Falta la clave de la operación'; end if;
  if p_monto is null or p_monto <= 0 then raise exception 'Monto inválido'; end if;
  if length(btrim(coalesce(p_motivo, ''))) < 5 then raise exception 'Indica el motivo del reembolso (mínimo 5 caracteres)'; end if;
  v_monto := round(p_monto, 2);

  select * into v_pay from public.payments where id = p_payment_id;
  if v_pay.id is null then raise exception 'Pago inexistente'; end if;

  -- Serializa todos los reembolsos de la misma venta.
  select * into v_venta from public.sales where id = v_pay.sale_id for update;
  if v_venta.id is null or v_loc is null or v_venta.location_id is distinct from v_loc then
    raise exception 'El pago pertenece a otra sucursal';
  end if;

  -- Huella calculada tras validar permisos: cubre todo lo que decide el reembolso.
  v_hash := md5(jsonb_build_object('payment', p_payment_id, 'monto', v_monto, 'motivo', btrim(p_motivo), 'devolucion', p_devolucion_id)::text);
  select * into v_prev from public.reembolsos_proveedor where client_transaction_id = p_client_transaction_id;
  if v_prev.id is not null then
    if v_prev.payload_hash is distinct from v_hash or v_prev.creado_por is distinct from v_staff then
      raise exception 'Ese client_transaction_id ya se usó con un contenido distinto. Genera una clave nueva.';
    end if;
    return jsonb_build_object('id', v_prev.id, 'estado', private.estado_reembolso_proveedor(v_prev.id), 'repetido', true);
  end if;

  if lower(v_pay.metodo) = 'efectivo' then
    raise exception 'Un pago en efectivo no se reembolsa por el proveedor: registra la devolución en caja';
  end if;
  if p_devolucion_id is not null then
    select * into v_dev from public.devoluciones where id = p_devolucion_id;
    if v_dev.id is null or v_dev.sale_id is distinct from v_venta.id then
      raise exception 'La devolución no corresponde a la venta de este pago';
    end if;
  end if;

  select coalesce(sum(r.monto), 0) into v_total
    from public.reembolsos_proveedor r
   where r.payment_id = p_payment_id and private.estado_reembolso_proveedor(r.id) is distinct from 'rechazado';
  if v_total + v_monto > v_pay.monto + 0.005 then
    raise exception 'El reembolso supera el monto del pago (%; ya comprometido %)', v_pay.monto, v_total;
  end if;

  insert into public.reembolsos_proveedor (payment_id, sale_id, location_id, devolucion_id, metodo, monto, motivo,
                                           client_transaction_id, payload_hash, creado_por)
  values (v_pay.id, v_venta.id, v_venta.location_id, p_devolucion_id, lower(v_pay.metodo), v_monto, btrim(p_motivo),
          p_client_transaction_id, v_hash, v_staff)
  returning id into v_id;
  insert into public.reembolso_proveedor_eventos (reembolso_id, estado, actor_staff_id) values (v_id, 'solicitado', v_staff);

  return jsonb_build_object('id', v_id, 'estado', 'solicitado', 'repetido', false);
end
$function$;

-- ---------------------------------------------------------------------------
create or replace function public.registrar_evento_reembolso_proveedor_admin(
  p_reembolso_id uuid, p_estado text, p_referencia_proveedor text default null, p_nota text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_staff  uuid := private.auth_staff_id();
  v_loc    uuid := private.auth_location_id();
  v_r      public.reembolsos_proveedor;
  v_actual text;
  v_ref    text := nullif(btrim(coalesce(p_referencia_proveedor, '')), '');
  v_nota   text := nullif(btrim(coalesce(p_nota, '')), '');
  v_previo public.reembolso_proveedor_eventos;
begin
  if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
  if p_estado is null or p_estado not in ('enviado', 'confirmado', 'rechazado') then raise exception 'Estado inválido'; end if;

  -- La cabecera es inmutable: el bloqueo sólo serializa eventos concurrentes.
  select * into v_r from public.reembolsos_proveedor where id = p_reembolso_id for update;
  if v_r.id is null or v_loc is null or v_r.location_id is distinct from v_loc then raise exception 'Reembolso inexistente o de otra sucursal'; end if;
  v_actual := private.estado_reembolso_proveedor(v_r.id);

  if v_actual = p_estado then
    select * into v_previo from public.reembolso_proveedor_eventos where reembolso_id = v_r.id and estado = p_estado;
    if v_ref is not null and v_previo.referencia_proveedor is distinct from v_ref then
      raise exception 'El reembolso ya está % con otra referencia (%)', p_estado, v_previo.referencia_proveedor;
    end if;
    return jsonb_build_object('id', v_r.id, 'estado', v_actual, 'repetido', true);
  end if;

  if not ((v_actual = 'solicitado' and p_estado in ('enviado', 'rechazado'))
       or (v_actual = 'enviado' and p_estado in ('confirmado', 'rechazado'))) then
    raise exception 'Transición inválida: % → %', v_actual, p_estado;
  end if;
  if p_estado = 'confirmado' and (v_ref is null or length(v_ref) < 3) then
    raise exception 'Para confirmar indica la referencia que devolvió el proveedor';
  end if;
  if p_estado = 'rechazado' and (v_nota is null or length(v_nota) < 5) then
    raise exception 'Indica por qué se rechazó (mínimo 5 caracteres)';
  end if;

  insert into public.reembolso_proveedor_eventos (reembolso_id, estado, referencia_proveedor, nota, actor_staff_id)
  values (v_r.id, p_estado, v_ref, v_nota, v_staff);
  return jsonb_build_object('id', v_r.id, 'estado', p_estado, 'repetido', false);
end
$function$;

-- ---------------------------------------------------------------------------
create or replace function public.reembolsos_proveedor_admin(p_estado text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_loc uuid := private.auth_location_id();
begin
  if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
  return coalesce((
    select jsonb_agg(x order by x->>'created_at' desc)
    from (
      select to_jsonb(r) || jsonb_build_object(
               'estado', private.estado_reembolso_proveedor(r.id),
               'eventos', (select jsonb_agg(to_jsonb(e) order by e.id) from public.reembolso_proveedor_eventos e where e.reembolso_id = r.id)) as x
      from public.reembolsos_proveedor r
      where r.location_id = v_loc
    ) q
    where p_estado is null or q.x->>'estado' = p_estado
  ), '[]'::jsonb);
end
$function$;

-- ---------------------------------------------------------------------------
create or replace function public.registrar_terminal_conciliacion_admin(p_conciliacion_id uuid, p_terminal text)
returns public.conciliaciones_pago
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_loc      uuid := private.auth_location_id();
  v_c        public.conciliaciones_pago;
  v_terminal text := nullif(btrim(coalesce(p_terminal, '')), '');
begin
  if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
  if v_terminal is null or length(v_terminal) > 60 then raise exception 'Terminal inválido'; end if;
  select * into v_c from public.conciliaciones_pago where id = p_conciliacion_id for update;
  if v_c.id is null or v_loc is null or v_c.location_id is distinct from v_loc then raise exception 'Conciliación inexistente o de otra sucursal'; end if;
  update public.conciliaciones_pago set terminal = v_terminal, updated_at = now() where id = v_c.id returning * into v_c;
  return v_c;
end
$function$;

revoke all on function public.solicitar_reembolso_proveedor_admin(uuid, numeric, text, uuid, uuid) from public;
revoke all on function public.registrar_evento_reembolso_proveedor_admin(uuid, text, text, text) from public;
revoke all on function public.reembolsos_proveedor_admin(text) from public;
revoke all on function public.registrar_terminal_conciliacion_admin(uuid, text) from public;
grant execute on function public.solicitar_reembolso_proveedor_admin(uuid, numeric, text, uuid, uuid) to authenticated, service_role;
grant execute on function public.registrar_evento_reembolso_proveedor_admin(uuid, text, text, text) to authenticated, service_role;
grant execute on function public.reembolsos_proveedor_admin(text) to authenticated, service_role;
grant execute on function public.registrar_terminal_conciliacion_admin(uuid, text) to authenticated, service_role;
