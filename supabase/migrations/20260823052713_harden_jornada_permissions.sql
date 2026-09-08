-- Endurecimiento de permisos para jornada y asistencia.

-- Las funciones SECURITY DEFINER se invocan solo por usuarios autenticados.
revoke all on function public.mi_estado_jornada() from public, anon;
revoke all on function public.registrar_mi_entrada() from public, anon;
revoke all on function public.registrar_mi_salida() from public, anon;
revoke all on function public.personal_activo_hoy() from public, anon;

grant execute on function public.mi_estado_jornada() to authenticated;
grant execute on function public.registrar_mi_entrada() to authenticated;
grant execute on function public.registrar_mi_salida() to authenticated;
grant execute on function public.personal_activo_hoy() to authenticated;

-- Cada trabajador ve únicamente su propia programación, salvo administradores.
drop policy if exists "staff_turnos_select_authenticated" on public.staff_turnos;
create policy "staff_turnos_select_own_or_admin"
  on public.staff_turnos for select to authenticated
  using (
    exists (
      select 1 from public.staff me
      where me.user_id = (select auth.uid())
        and me.activo = true
        and (me.id = staff_turnos.staff_id or me.rol = 'administrador')
    )
  );

-- Cada trabajador ve únicamente su propia asistencia, salvo administradores.
drop policy if exists "asistencias_select_authenticated" on public.asistencias;
create policy "asistencias_select_own_or_admin"
  on public.asistencias for select to authenticated
  using (
    exists (
      select 1 from public.staff me
      where me.user_id = (select auth.uid())
        and me.activo = true
        and (me.id = asistencias.staff_id or me.rol = 'administrador')
    )
  );
