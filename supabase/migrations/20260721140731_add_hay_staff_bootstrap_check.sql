-- ============================================================================
-- Reconstruida desde el historial de migraciones de producción
-- (supabase_migrations.schema_migrations, versión 20260721140731).
--
-- Esta migración se aplicó en su momento sin dejar archivo en el repositorio.
-- El SQL de abajo es EXACTAMENTE el que quedó registrado en producción; no se
-- reejecutó nada al recuperarlo. Ver docs/POS_INTEGRITY_HARDENING.md (P0.2
-- bloque 11) para el mapeo completo.
-- ============================================================================

create or replace function public.hay_staff()
returns boolean
language sql
stable security definer
as $$
  select exists (select 1 from staff);
$$;

grant execute on function public.hay_staff() to anon, authenticated;

create or replace function public.crear_primer_admin(p_nombre text)
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
  select id into v_location_id from locations order by created_at limit 1;
  insert into staff (user_id, nombre, rol, location_id, activo)
  values (auth.uid(), p_nombre, 'administrador', v_location_id, true)
  returning * into v_staff;
  return v_staff;
end;
$$;

grant execute on function public.crear_primer_admin(text) to authenticated;
;
