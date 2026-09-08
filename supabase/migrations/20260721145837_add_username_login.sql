-- ============================================================================
-- Reconstruida desde el historial de migraciones de producción
-- (supabase_migrations.schema_migrations, versión 20260721145837).
--
-- Esta migración se aplicó en su momento sin dejar archivo en el repositorio.
-- El SQL de abajo es EXACTAMENTE el que quedó registrado en producción; no se
-- reejecutó nada al recuperarlo. Ver docs/POS_INTEGRITY_HARDENING.md (P0.2
-- bloque 11) para el mapeo completo.
-- ============================================================================

alter table staff add column username varchar;
update staff set username = 'admin' where username is null;
alter table staff alter column username set not null;
create unique index staff_username_unique on staff (lower(username));

create or replace function public.email_por_username(p_username text)
returns text
language sql
stable security definer
as $$
  select u.email
  from staff s
  join auth.users u on u.id = s.user_id
  where lower(s.username) = lower(p_username) and s.activo = true
  limit 1;
$$;
grant execute on function public.email_por_username(text) to anon, authenticated;

drop function if exists public.crear_primer_admin(text);

create or replace function public.crear_primer_admin(p_nombre text, p_username text)
returns staff
language plpgsql
security definer
as $$
declare
  v_location_id uuid;
  v_staff staff;
begin
  if exists (select 1 from staff) then
    raise exception 'Ya existe personal registrado, no se puede usar el bootstrap';
  end if;
  if auth.uid() is null then
    raise exception 'Debes iniciar sesión antes de crear la cuenta de administrador';
  end if;
  if exists (select 1 from staff where lower(username) = lower(p_username)) then
    raise exception 'Ese nombre de usuario ya está en uso';
  end if;
  select id into v_location_id from locations order by created_at limit 1;
  insert into staff (user_id, nombre, rol, location_id, activo, username)
  values (auth.uid(), p_nombre, 'administrador', v_location_id, true, p_username)
  returning * into v_staff;
  return v_staff;
end;
$$;

grant execute on function public.crear_primer_admin(text, text) to authenticated;
;
