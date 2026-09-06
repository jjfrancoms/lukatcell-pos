-- Permite a un administrador reabrir una jornada cuya salida se marcó por
-- error, sin tener que editar la tabla a mano desde el panel de Supabase.
-- Queda auditada igual que el resto de correcciones administrativas del sistema.

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'audit_asistencias' and tgrelid = 'public.asistencias'::regclass
  ) then
    create trigger audit_asistencias
      after insert or update or delete on public.asistencias
      for each row execute function private.registrar_auditoria();
  end if;
end $$;

create or replace function public.reabrir_asistencia(p_asistencia_id uuid, p_motivo text)
returns public.asistencias
language plpgsql
security invoker
set search_path = public, private
as $$
declare
  v_existente public.asistencias;
  v_resultado public.asistencias;
begin
  if not private.auth_is_admin() then
    raise exception 'Solo un administrador puede reabrir una jornada';
  end if;
  if length(trim(coalesce(p_motivo, ''))) < 3 then
    raise exception 'Ingresa un motivo para la corrección';
  end if;

  select * into v_existente from public.asistencias where id = p_asistencia_id;
  if v_existente.id is null then
    raise exception 'No se encontró el registro de asistencia';
  end if;
  if v_existente.salida is null then
    raise exception 'Esta jornada no tiene una salida registrada para reabrir';
  end if;

  update public.asistencias
  set salida = null,
      observacion = trim(coalesce(observacion || ' | ', '') || 'Reabierta por administrador: ' || trim(p_motivo)),
      updated_at = now()
  where id = p_asistencia_id
  returning * into v_resultado;

  return v_resultado;
end;
$$;

revoke all on function public.reabrir_asistencia(uuid, text) from public;
revoke execute on function public.reabrir_asistencia(uuid, text) from anon;
grant execute on function public.reabrir_asistencia(uuid, text) to authenticated;
