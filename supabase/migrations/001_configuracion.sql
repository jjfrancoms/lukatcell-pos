-- Tabla de configuración del negocio (fila única / singleton).
-- Corre esto en el SQL Editor de tu proyecto Supabase:
-- https://supabase.com/dashboard/project/fbwkclpgnsxuqycazumj/sql/new

create table if not exists configuracion (
  id smallint primary key default 1,
  igv_activo boolean not null default true,
  igv_porcentaje numeric(5,2) not null default 18.00,
  negocio_nombre text not null default 'LUKATCELL',
  negocio_ruc text,
  negocio_direccion text,
  stock_minimo_default integer not null default 5,
  updated_at timestamptz not null default now(),
  constraint configuracion_singleton check (id = 1)
);

insert into configuracion (id) values (1) on conflict (id) do nothing;

alter table configuracion enable row level security;

drop policy if exists "Configuracion lectura publica" on configuracion;
create policy "Configuracion lectura publica" on configuracion
  for select using (true);

drop policy if exists "Configuracion solo admin actualiza" on configuracion;
create policy "Configuracion solo admin actualiza" on configuracion
  for update using (
    exists (
      select 1 from staff
      where staff.user_id = auth.uid()
        and staff.rol = 'administrador'
        and staff.activo = true
    )
  );
