-- ============================================================================
-- P2.F — FASE 21 · Centro de incidencias
-- ============================================================================
-- Producción tenía piezas sueltas (notificaciones por persona, alertas
-- operativas, auditoría, RPC de salud e invariantes) pero ninguna entidad con
-- ciclo de vida: quién atiende un problema, en qué estado está, cómo se resolvió
-- y cuándo volvió a aparecer.
--
-- Modelo:
--   incidencias         una fila por problema; como máximo UNA abierta o en
--                       revisión por clave de deduplicación (índice único parcial).
--   incidencia_eventos  historial append-only (trigger impide UPDATE/DELETE).
--
-- Fuente de detección: private.checks_cierre_diario (P2.E), la misma que decide
-- el cierre diario. Así el centro de incidencias y el cierre no pueden discrepar.
--
-- Reglas que evitan ocultar fallos:
--   · una incidencia P0 no se puede descartar: sólo resolver corrigiendo la causa;
--   · resolver o descartar exige una nota;
--   · una incidencia cerrada no se reabre ni se edita: si la condición persiste,
--     la siguiente detección abre una NUEVA y queda visible que volvió;
--   · la auto-resolución sólo aplica a condiciones de estado (sin fecha) de la
--     sucursal analizada que ya no se detectan, y queda como evento.
--
-- Acceso: lectura para administración y para el personal de la sucursal activa;
-- escritura sólo mediante RPC de administración.
-- ============================================================================

create table if not exists public.incidencias (
  id                   uuid primary key default gen_random_uuid(),
  location_id          uuid references public.locations(id),
  codigo               text not null,
  severidad            text not null check (severidad in ('P0', 'P1', 'warning')),
  estado               text not null default 'abierta' check (estado in ('abierta', 'en_revision', 'resuelta', 'descartada')),
  origen               text not null default 'detector' check (origen in ('detector', 'manual')),
  titulo               text not null,
  detalle              jsonb not null default '{}'::jsonb,
  accion_sugerida      text,
  clave_dedup          text not null,
  fecha_operativa      date,
  veces                integer not null default 1 check (veces >= 1),
  detectada_at         timestamptz not null default now(),
  ultima_deteccion_at  timestamptz not null default now(),
  asignada_a           uuid references public.staff(id),
  resuelta_por         uuid references public.staff(id),
  resuelta_at          timestamptz,
  resolucion           text,
  updated_at           timestamptz not null default now(),
  constraint incidencias_cierre_coherente check (
    (estado in ('resuelta', 'descartada')) = (resuelta_at is not null)
  )
);

create unique index if not exists incidencias_una_abierta_por_clave
  on public.incidencias (clave_dedup) where estado in ('abierta', 'en_revision');
create index if not exists incidencias_location_estado on public.incidencias (location_id, estado);

create table if not exists public.incidencia_eventos (
  id               bigserial primary key,
  incidencia_id    uuid not null references public.incidencias(id) on delete restrict,
  accion           text not null check (accion in ('detectada', 'redetectada', 'estado', 'asignada', 'auto_resuelta')),
  estado_anterior  text,
  estado_nuevo     text,
  nota             text,
  actor_staff_id   uuid references public.staff(id),
  created_at       timestamptz not null default now()
);
create index if not exists incidencia_eventos_incidencia on public.incidencia_eventos (incidencia_id, created_at);

create or replace function private.incidencia_eventos_append_only()
returns trigger
language plpgsql
as $function$
begin
  raise exception 'incidencia_eventos es de sólo inserción' using errcode = 'P0001';
end
$function$;
revoke all on function private.incidencia_eventos_append_only() from public;

drop trigger if exists incidencia_eventos_append_only on public.incidencia_eventos;
create trigger incidencia_eventos_append_only
  before update or delete on public.incidencia_eventos
  for each row execute function private.incidencia_eventos_append_only();

alter table public.incidencias enable row level security;
alter table public.incidencia_eventos enable row level security;

drop policy if exists incidencias_lectura on public.incidencias;
create policy incidencias_lectura on public.incidencias for select to authenticated
  using (private.auth_is_admin() or location_id = private.auth_location_id());

drop policy if exists incidencia_eventos_lectura on public.incidencia_eventos;
create policy incidencia_eventos_lectura on public.incidencia_eventos for select to authenticated
  using (exists (select 1 from public.incidencias i
                 where i.id = incidencia_eventos.incidencia_id
                   and (private.auth_is_admin() or i.location_id = private.auth_location_id())));

-- Los privilegios por defecto de public dan ALL a authenticated: se retiran las escrituras.
revoke insert, update, delete, truncate, references, trigger on public.incidencias, public.incidencia_eventos from authenticated;
revoke all on public.incidencias, public.incidencia_eventos from anon;
revoke all on sequence public.incidencia_eventos_id_seq from authenticated, anon;

-- ---------------------------------------------------------------------------
create or replace function public.detectar_incidencias_admin(p_fecha date default ((now() at time zone 'America/Lima'::text))::date)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_staff   uuid := private.auth_staff_id();
  v_loc     uuid := private.auth_location_id();
  v_checks  jsonb;
  x         jsonb;
  v_clave   text;
  v_scope   date;
  v_inc     public.incidencias;
  v_claves  text[] := '{}';
  v_nuevas  integer := 0;
  v_redet   integer := 0;
  v_auto    integer := 0;
begin
  if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
  if v_loc is null then raise exception 'Sin sucursal activa'; end if;
  if p_fecha is null or p_fecha > (now() at time zone 'America/Lima')::date then raise exception 'Fecha inválida'; end if;

  v_checks := private.checks_cierre_diario(v_loc, p_fecha);

  for x in select * from jsonb_array_elements(v_checks) loop
    -- Condiciones de un día concreto llevan la fecha en la clave; las de estado, no.
    v_scope := case when x->>'codigo' in ('DIFERENCIA_CRITICA', 'CONCILIACIONES_PENDIENTES', 'COMPROBANTES_NO_EMITIDOS') then p_fecha end;
    v_clave := concat_ws(':', x->>'codigo', v_loc::text, v_scope::text);
    v_claves := v_claves || v_clave;

    insert into public.incidencias (location_id, codigo, severidad, titulo, detalle, accion_sugerida, clave_dedup, fecha_operativa)
    values (v_loc, x->>'codigo', x->>'nivel', x->>'titulo', x, x->>'accion', v_clave, v_scope)
    on conflict (clave_dedup) where estado in ('abierta', 'en_revision') do nothing
    returning * into v_inc;

    if v_inc.id is not null then
      insert into public.incidencia_eventos (incidencia_id, accion, estado_nuevo, actor_staff_id)
      values (v_inc.id, 'detectada', 'abierta', v_staff);
      v_nuevas := v_nuevas + 1;
    else
      update public.incidencias
         set veces = veces + 1, ultima_deteccion_at = now(), detalle = x, severidad = x->>'nivel', updated_at = now()
       where clave_dedup = v_clave and estado in ('abierta', 'en_revision')
       returning * into v_inc;
      insert into public.incidencia_eventos (incidencia_id, accion, actor_staff_id)
      values (v_inc.id, 'redetectada', v_staff);
      v_redet := v_redet + 1;
    end if;
    v_inc := null;
  end loop;

  for v_inc in
    select * from public.incidencias i
     where i.location_id = v_loc and i.origen = 'detector' and i.fecha_operativa is null
       and i.estado in ('abierta', 'en_revision') and not (i.clave_dedup = any (v_claves))
     for update
  loop
    update public.incidencias
       set estado = 'resuelta', resuelta_at = now(), resolucion = 'La condición ya no se detecta', updated_at = now()
     where id = v_inc.id;
    insert into public.incidencia_eventos (incidencia_id, accion, estado_anterior, estado_nuevo, nota, actor_staff_id)
    values (v_inc.id, 'auto_resuelta', v_inc.estado, 'resuelta', 'La condición ya no se detecta', v_staff);
    v_auto := v_auto + 1;
  end loop;

  return jsonb_build_object('fecha', p_fecha, 'location_id', v_loc, 'detectadas', jsonb_array_length(v_checks),
                            'nuevas', v_nuevas, 'redetectadas', v_redet, 'auto_resueltas', v_auto);
end
$function$;

-- ---------------------------------------------------------------------------
create or replace function public.incidencias_admin(p_estado text default null, p_limite integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'private'
as $function$
begin
  if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(q) - 'orden' order by q.orden, q.ultima_deteccion_at desc)
    from (
      select i.*, l.nombre as sucursal, st.nombre as asignada_nombre,
             case i.severidad when 'P0' then 0 when 'P1' then 1 else 2 end as orden
      from public.incidencias i
      left join public.locations l on l.id = i.location_id
      left join public.staff st on st.id = i.asignada_a
      where p_estado is null or i.estado = p_estado
      order by case i.severidad when 'P0' then 0 when 'P1' then 1 else 2 end, i.ultima_deteccion_at desc
      limit greatest(1, least(coalesce(p_limite, 100), 500))
    ) q
  ), '[]'::jsonb);
end
$function$;

-- ---------------------------------------------------------------------------
create or replace function public.actualizar_incidencia_admin(p_id uuid, p_estado text, p_nota text default null, p_asignada_a uuid default null)
returns public.incidencias
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_inc    public.incidencias;
  v_prev   text;
  v_staff  uuid := private.auth_staff_id();
  v_nota   text := nullif(btrim(coalesce(p_nota, '')), '');
  v_cierra boolean;
begin
  if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
  select * into v_inc from public.incidencias where id = p_id for update;
  if v_inc.id is null then raise exception 'Incidencia inexistente'; end if;
  if p_estado is null or p_estado not in ('abierta', 'en_revision', 'resuelta', 'descartada') then raise exception 'Estado inválido'; end if;
  if v_inc.estado in ('resuelta', 'descartada') then
    raise exception 'La incidencia ya está cerrada; si la condición persiste, la próxima detección abrirá una nueva';
  end if;
  v_cierra := p_estado in ('resuelta', 'descartada');
  if v_cierra and (v_nota is null or length(v_nota) < 5) then
    raise exception 'Indica cómo se resolvió o por qué se descarta (mínimo 5 caracteres)';
  end if;
  if p_estado = 'descartada' and v_inc.severidad = 'P0' then
    raise exception 'Una incidencia P0 no se descarta: se resuelve corrigiendo la causa';
  end if;
  if p_asignada_a is not null and not exists (select 1 from public.staff where id = p_asignada_a and activo) then
    raise exception 'Responsable inválido';
  end if;

  v_prev := v_inc.estado;
  update public.incidencias
     set estado = p_estado,
         asignada_a = coalesce(p_asignada_a, asignada_a),
         resuelta_por = case when v_cierra then v_staff end,
         resuelta_at = case when v_cierra then now() end,
         resolucion = case when v_cierra then v_nota else resolucion end,
         updated_at = now()
   where id = p_id
   returning * into v_inc;

  if p_estado is distinct from v_prev then
    insert into public.incidencia_eventos (incidencia_id, accion, estado_anterior, estado_nuevo, nota, actor_staff_id)
    values (v_inc.id, 'estado', v_prev, p_estado, v_nota, v_staff);
  end if;
  if p_asignada_a is not null then
    insert into public.incidencia_eventos (incidencia_id, accion, nota, actor_staff_id)
    values (v_inc.id, 'asignada', p_asignada_a::text, v_staff);
  end if;
  return v_inc;
end
$function$;

revoke all on function public.detectar_incidencias_admin(date) from public;
revoke all on function public.incidencias_admin(text, integer) from public;
revoke all on function public.actualizar_incidencia_admin(uuid, text, text, uuid) from public;
grant execute on function public.detectar_incidencias_admin(date) to authenticated, service_role;
grant execute on function public.incidencias_admin(text, integer) to authenticated, service_role;
grant execute on function public.actualizar_incidencia_admin(uuid, text, text, uuid) to authenticated, service_role;
