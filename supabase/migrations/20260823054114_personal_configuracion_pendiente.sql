create or replace function public.personal_configuracion_pendiente()
returns table (
  staff_id uuid,
  nombre text,
  username text,
  puesto text,
  dias_programados integer,
  falta_puesto boolean,
  falta_horario boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.staff
    where user_id = auth.uid() and rol = 'administrador' and activo = true
  ) then
    raise exception 'Acceso restringido a administradores';
  end if;

  return query
  select s.id,
         s.nombre::text,
         s.username::text,
         s.puesto::text,
         count(st.id)::integer as dias_programados,
         (s.puesto is null) as falta_puesto,
         (count(st.id) = 0) as falta_horario
  from public.staff s
  left join public.staff_turnos st on st.staff_id = s.id and st.activo = true
  where s.activo = true
  group by s.id, s.nombre, s.username, s.puesto
  having s.puesto is null or count(st.id) = 0
  order by s.nombre;
end;
$$;

revoke all on function public.personal_configuracion_pendiente() from public;
revoke execute on function public.personal_configuracion_pendiente() from anon;
grant execute on function public.personal_configuracion_pendiente() to authenticated;
