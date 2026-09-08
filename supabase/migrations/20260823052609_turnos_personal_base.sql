-- Base operativa para puestos, turnos y asistencia del personal.
-- Mantiene staff.rol como nivel de permisos de la app (cajero/administrador)
-- y añade staff.puesto para representar la función real en tienda.

alter table if exists public.staff
  add column if not exists puesto text;

alter table if exists public.staff
  drop constraint if exists staff_puesto_check;

alter table if exists public.staff
  add constraint staff_puesto_check
  check (puesto is null or puesto in ('jefa', 'vendedor', 'tecnico', 'encargado'));

create table if not exists public.turnos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  hora_inicio time not null,
  hora_fin time not null,
  cruza_medianoche boolean not null default false,
  tolerancia_minutos integer not null default 10 check (tolerancia_minutos between 0 and 180),
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.staff_turnos (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff(id) on delete cascade,
  turno_id uuid not null references public.turnos(id) on delete restrict,
  dia_semana smallint not null check (dia_semana between 0 and 6),
  fecha_desde date,
  fecha_hasta date,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  constraint staff_turnos_rango_fechas_check
    check (fecha_hasta is null or fecha_desde is null or fecha_hasta >= fecha_desde)
);

create unique index if not exists staff_turnos_unico_activo_idx
  on public.staff_turnos(staff_id, turno_id, dia_semana, coalesce(fecha_desde, date '1900-01-01'))
  where activo = true;

create table if not exists public.asistencias (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff(id) on delete cascade,
  turno_id uuid references public.turnos(id) on delete set null,
  fecha date not null default current_date,
  entrada timestamptz,
  salida timestamptz,
  estado text not null default 'pendiente'
    check (estado in ('pendiente', 'presente', 'tarde', 'ausente', 'justificado')),
  minutos_tarde integer not null default 0 check (minutos_tarde >= 0),
  observacion text,
  registrado_por uuid references public.staff(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (staff_id, fecha)
);

create index if not exists asistencias_fecha_idx on public.asistencias(fecha desc);
create index if not exists asistencias_staff_fecha_idx on public.asistencias(staff_id, fecha desc);

-- Turnos iniciales basados en la operación descrita. Se pueden editar luego desde UI.
insert into public.turnos (nombre, hora_inicio, hora_fin, cruza_medianoche, tolerancia_minutos)
select * from (
  values
    ('Apertura', time '08:00', time '18:00', false, 10),
    ('Completo', time '09:00', time '21:00', false, 10),
    ('Cierre', time '12:00', time '23:00', false, 10)
) as seed(nombre, hora_inicio, hora_fin, cruza_medianoche, tolerancia_minutos)
where not exists (
  select 1 from public.turnos t where lower(t.nombre) = lower(seed.nombre)
);

alter table public.turnos enable row level security;
alter table public.staff_turnos enable row level security;
alter table public.asistencias enable row level security;

-- Lectura para personal autenticado.
drop policy if exists "turnos_select_authenticated" on public.turnos;
create policy "turnos_select_authenticated"
  on public.turnos for select to authenticated using (true);

drop policy if exists "staff_turnos_select_authenticated" on public.staff_turnos;
create policy "staff_turnos_select_authenticated"
  on public.staff_turnos for select to authenticated using (true);

drop policy if exists "asistencias_select_authenticated" on public.asistencias;
create policy "asistencias_select_authenticated"
  on public.asistencias for select to authenticated using (true);

-- Escritura limitada a administradores según staff.rol.
drop policy if exists "turnos_admin_write" on public.turnos;
create policy "turnos_admin_write"
  on public.turnos for all to authenticated
  using (exists (
    select 1 from public.staff s
    where s.user_id = auth.uid() and s.rol = 'administrador' and s.activo = true
  ))
  with check (exists (
    select 1 from public.staff s
    where s.user_id = auth.uid() and s.rol = 'administrador' and s.activo = true
  ));

drop policy if exists "staff_turnos_admin_write" on public.staff_turnos;
create policy "staff_turnos_admin_write"
  on public.staff_turnos for all to authenticated
  using (exists (
    select 1 from public.staff s
    where s.user_id = auth.uid() and s.rol = 'administrador' and s.activo = true
  ))
  with check (exists (
    select 1 from public.staff s
    where s.user_id = auth.uid() and s.rol = 'administrador' and s.activo = true
  ));

drop policy if exists "asistencias_admin_write" on public.asistencias;
create policy "asistencias_admin_write"
  on public.asistencias for all to authenticated
  using (exists (
    select 1 from public.staff s
    where s.user_id = auth.uid() and s.rol = 'administrador' and s.activo = true
  ))
  with check (exists (
    select 1 from public.staff s
    where s.user_id = auth.uid() and s.rol = 'administrador' and s.activo = true
  ));
