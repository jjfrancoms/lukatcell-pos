drop index if exists public.staff_turnos_unico_activo_idx;

create unique index staff_turnos_unico_activo_idx
  on public.staff_turnos (staff_id, dia_semana)
  where activo = true;
