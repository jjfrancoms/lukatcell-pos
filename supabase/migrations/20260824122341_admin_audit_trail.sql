create table if not exists public.auditoria_eventos (
  id bigserial primary key,
  fecha timestamptz not null default now(),
  actor_user_id uuid null,
  actor_staff_id uuid null references public.staff(id) on delete set null,
  accion text not null check (accion in ('INSERT','UPDATE','DELETE')),
  tabla text not null,
  registro_id text null,
  datos_anteriores jsonb null,
  datos_nuevos jsonb null
);

create index if not exists auditoria_eventos_fecha_idx on public.auditoria_eventos(fecha desc);
create index if not exists auditoria_eventos_tabla_idx on public.auditoria_eventos(tabla, fecha desc);
create index if not exists auditoria_eventos_actor_idx on public.auditoria_eventos(actor_staff_id, fecha desc);

alter table public.auditoria_eventos enable row level security;

drop policy if exists auditoria_solo_admin on public.auditoria_eventos;
create policy auditoria_solo_admin
on public.auditoria_eventos
for select
to authenticated
using (private.auth_is_admin());

revoke all on public.auditoria_eventos from anon;
revoke insert, update, delete on public.auditoria_eventos from authenticated;
grant select on public.auditoria_eventos to authenticated;

create or replace function private.registrar_auditoria()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_user_id uuid := auth.uid();
  v_staff_id uuid;
  v_old jsonb;
  v_new jsonb;
  v_registro_id text;
begin
  if v_user_id is not null then
    select id into v_staff_id from public.staff where user_id = v_user_id limit 1;
  end if;

  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_new := null;
    v_registro_id := coalesce(v_old->>'id', v_old->>'staff_id', v_old->>'variant_id');
  elsif tg_op = 'INSERT' then
    v_old := null;
    v_new := to_jsonb(new);
    v_registro_id := coalesce(v_new->>'id', v_new->>'staff_id', v_new->>'variant_id');
  else
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    v_registro_id := coalesce(v_new->>'id', v_new->>'staff_id', v_new->>'variant_id');
    if v_old = v_new then return new; end if;
  end if;

  insert into public.auditoria_eventos(
    actor_user_id, actor_staff_id, accion, tabla, registro_id, datos_anteriores, datos_nuevos
  ) values (
    v_user_id, v_staff_id, tg_op, tg_table_name, v_registro_id, v_old, v_new
  );

  return coalesce(new, old);
end;
$$;

revoke all on function private.registrar_auditoria() from public, anon, authenticated;

drop trigger if exists audit_staff on public.staff;
create trigger audit_staff after insert or update or delete on public.staff for each row execute function private.registrar_auditoria();

drop trigger if exists audit_staff_turnos on public.staff_turnos;
create trigger audit_staff_turnos after insert or update or delete on public.staff_turnos for each row execute function private.registrar_auditoria();

drop trigger if exists audit_asistencias on public.asistencias;
create trigger audit_asistencias after insert or update or delete on public.asistencias for each row execute function private.registrar_auditoria();

drop trigger if exists audit_cash_sessions on public.cash_sessions;
create trigger audit_cash_sessions after insert or update or delete on public.cash_sessions for each row execute function private.registrar_auditoria();

drop trigger if exists audit_ordenes_servicio on public.ordenes_servicio;
create trigger audit_ordenes_servicio after insert or update or delete on public.ordenes_servicio for each row execute function private.registrar_auditoria();

drop trigger if exists audit_products on public.products;
create trigger audit_products after insert or update or delete on public.products for each row execute function private.registrar_auditoria();

drop trigger if exists audit_product_variants on public.product_variants;
create trigger audit_product_variants after insert or update or delete on public.product_variants for each row execute function private.registrar_auditoria();

create or replace function public.auditoria_reciente_admin(p_limite integer default 100)
returns table(
  id bigint,
  fecha timestamptz,
  actor_nombre text,
  accion text,
  tabla text,
  registro_id text,
  datos_anteriores jsonb,
  datos_nuevos jsonb
)
language sql
stable
security invoker
set search_path = public, private
as $$
  select
    ae.id,
    ae.fecha,
    coalesce(s.nombre::text, 'Sistema') as actor_nombre,
    ae.accion,
    ae.tabla,
    ae.registro_id,
    ae.datos_anteriores,
    ae.datos_nuevos
  from public.auditoria_eventos ae
  left join public.staff s on s.id = ae.actor_staff_id
  where private.auth_is_admin()
  order by ae.fecha desc
  limit greatest(1, least(coalesce(p_limite,100),500));
$$;

revoke all on function public.auditoria_reciente_admin(integer) from public, anon;
grant execute on function public.auditoria_reciente_admin(integer) to authenticated;
