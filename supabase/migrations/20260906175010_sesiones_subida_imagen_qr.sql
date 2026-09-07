-- Subida de foto de producto por QR: el admin genera un token desde la
-- computadora, lo escanea con el celular, toma la foto ahí, y al confirmar
-- la Edge Function (con service role) sube el archivo y marca la sesión
-- como completada. La computadora escucha esa fila y aplica la URL sola.
create table if not exists public.sesiones_subida_imagen (
  id uuid primary key default gen_random_uuid(),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'completado', 'expirado')),
  url text,
  creado_por uuid references public.staff(id) on delete set null,
  created_at timestamptz not null default now(),
  expira_at timestamptz not null default (now() + interval '10 minutes')
);

alter table public.sesiones_subida_imagen enable row level security;

-- El admin en la computadora crea la sesión y lee su estado; nadie más
-- (ni siquiera el propio celular sin sesión) puede leer o escribir vía API
-- normal — la Edge Function usa la service role key, que ignora RLS.
drop policy if exists sesiones_subida_imagen_crear on public.sesiones_subida_imagen;
create policy sesiones_subida_imagen_crear on public.sesiones_subida_imagen
  for insert to authenticated with check (creado_por = private.auth_staff_id());

drop policy if exists sesiones_subida_imagen_leer on public.sesiones_subida_imagen;
create policy sesiones_subida_imagen_leer on public.sesiones_subida_imagen
  for select to authenticated using (creado_por = private.auth_staff_id());

revoke all on public.sesiones_subida_imagen from anon;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sesiones_subida_imagen'
  ) then
    alter publication supabase_realtime add table public.sesiones_subida_imagen;
  end if;
end $$;
