create table if not exists public.staff_turno_excepciones (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff(id) on delete cascade,
  fecha date not null,
  turno_id uuid null references public.turnos(id) on delete restrict,
  motivo text not null,
  activo boolean not null default true,
  registrado_por uuid null references public.staff(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists staff_turno_excepciones_unica_activa
on public.staff_turno_excepciones(staff_id,fecha) where activo;

alter table public.staff_turno_excepciones enable row level security;

drop policy if exists turno_excepciones_select_own_or_admin on public.staff_turno_excepciones;
create policy turno_excepciones_select_own_or_admin on public.staff_turno_excepciones
for select to authenticated
using (private.auth_is_admin() or staff_id=private.auth_staff_id());

drop policy if exists turno_excepciones_admin_write on public.staff_turno_excepciones;
create policy turno_excepciones_admin_write on public.staff_turno_excepciones
for all to authenticated
using (private.auth_is_admin()) with check (private.auth_is_admin());

revoke all on public.staff_turno_excepciones from anon;
grant select,insert,update,delete on public.staff_turno_excepciones to authenticated;

drop trigger if exists audit_staff_turno_excepciones on public.staff_turno_excepciones;
create trigger audit_staff_turno_excepciones after insert or update or delete on public.staff_turno_excepciones
for each row execute function private.registrar_auditoria();

create or replace function public.registrar_excepcion_turno(p_staff_id uuid,p_fecha date,p_turno_id uuid,p_motivo text)
returns public.staff_turno_excepciones
language plpgsql security invoker set search_path=public,private
as $$
declare v_result public.staff_turno_excepciones;
begin
  if not private.auth_is_admin() then raise exception 'Solo administración puede cambiar turnos por fecha'; end if;
  if p_staff_id is null or p_fecha is null then raise exception 'Personal y fecha son obligatorios'; end if;
  if length(trim(coalesce(p_motivo,'')))<3 then raise exception 'Ingresa el motivo del cambio'; end if;
  if p_turno_id is not null and not exists(select 1 from public.turnos where id=p_turno_id and activo=true) then raise exception 'Turno no válido o inactivo'; end if;
  update public.staff_turno_excepciones set activo=false,updated_at=now() where staff_id=p_staff_id and fecha=p_fecha and activo=true;
  insert into public.staff_turno_excepciones(staff_id,fecha,turno_id,motivo,registrado_por)
  values(p_staff_id,p_fecha,p_turno_id,trim(p_motivo),private.auth_staff_id()) returning * into v_result;
  return v_result;
end; $$;

create or replace function public.cancelar_excepcion_turno(p_excepcion_id uuid)
returns boolean language plpgsql security invoker set search_path=public,private
as $$
declare v_count integer;
begin
  if not private.auth_is_admin() then raise exception 'Solo administración puede cancelar cambios de turno'; end if;
  update public.staff_turno_excepciones set activo=false,updated_at=now() where id=p_excepcion_id and activo=true;
  get diagnostics v_count=row_count; return v_count>0;
end; $$;

create or replace function public.excepciones_turno_admin(p_desde date default (now() at time zone 'America/Lima')::date,p_hasta date default ((now() at time zone 'America/Lima')::date+30))
returns table(excepcion_id uuid,staff_id uuid,nombre text,username text,fecha date,turno_id uuid,turno_nombre text,hora_inicio time,hora_fin time,motivo text,activo boolean,registrado_por_nombre text)
language sql stable security invoker set search_path=public,private
as $$
select e.id,e.staff_id,s.nombre::text,s.username::text,e.fecha,e.turno_id,t.nombre::text,t.hora_inicio,t.hora_fin,e.motivo,e.activo,r.nombre::text
from public.staff_turno_excepciones e join public.staff s on s.id=e.staff_id left join public.turnos t on t.id=e.turno_id left join public.staff r on r.id=e.registrado_por
where private.auth_is_admin() and e.fecha between p_desde and p_hasta order by e.fecha desc,s.nombre,e.created_at desc; $$;

revoke all on function public.registrar_excepcion_turno(uuid,date,uuid,text) from public,anon;
revoke all on function public.cancelar_excepcion_turno(uuid) from public,anon;
revoke all on function public.excepciones_turno_admin(date,date) from public,anon;
grant execute on function public.registrar_excepcion_turno(uuid,date,uuid,text) to authenticated;
grant execute on function public.cancelar_excepcion_turno(uuid) to authenticated;
grant execute on function public.excepciones_turno_admin(date,date) to authenticated;

create or replace function private.resolver_turno_programado(p_staff_id uuid,p_momento timestamp without time zone)
returns table(jornada_fecha date,turno_id uuid)
language sql stable set search_path=public,private
as $$
with reloj as(select p_momento::date hoy,(p_momento::date-1) ayer),
ex_ayer as(select r.ayer jornada_fecha,e.turno_id,0 prioridad from reloj r join public.staff_turno_excepciones e on e.staff_id=p_staff_id and e.fecha=r.ayer and e.activo=true left join public.turnos t on t.id=e.turno_id where e.turno_id is not null and t.activo=true and(t.cruza_medianoche=true or t.hora_fin<=t.hora_inicio) and p_momento>=(r.ayer::timestamp+t.hora_inicio) and p_momento<=(r.hoy::timestamp+t.hora_fin)),
ex_hoy as(select r.hoy jornada_fecha,e.turno_id,1 prioridad from reloj r join public.staff_turno_excepciones e on e.staff_id=p_staff_id and e.fecha=r.hoy and e.activo=true),
normal_ayer as(select r.ayer jornada_fecha,st.turno_id,2 prioridad from reloj r join public.staff_turnos st on st.staff_id=p_staff_id join public.turnos t on t.id=st.turno_id and t.activo=true where not exists(select 1 from public.staff_turno_excepciones e where e.staff_id=p_staff_id and e.fecha=r.ayer and e.activo=true) and st.activo=true and(t.cruza_medianoche=true or t.hora_fin<=t.hora_inicio) and st.dia_semana=extract(dow from r.ayer)::smallint and coalesce(st.fecha_desde,(st.created_at at time zone 'America/Lima')::date)<=r.ayer and(st.fecha_hasta is null or st.fecha_hasta>=r.ayer) and p_momento>=(r.ayer::timestamp+t.hora_inicio) and p_momento<=(r.hoy::timestamp+t.hora_fin)),
normal_hoy as(select r.hoy jornada_fecha,st.turno_id,3 prioridad from reloj r join public.staff_turnos st on st.staff_id=p_staff_id join public.turnos t on t.id=st.turno_id and t.activo=true where not exists(select 1 from public.staff_turno_excepciones e where e.staff_id=p_staff_id and e.fecha=r.hoy and e.activo=true) and st.activo=true and st.dia_semana=extract(dow from r.hoy)::smallint and coalesce(st.fecha_desde,(st.created_at at time zone 'America/Lima')::date)<=r.hoy and(st.fecha_hasta is null or st.fecha_hasta>=r.hoy)),
candidatos as(select * from ex_ayer union all select * from ex_hoy union all select * from normal_ayer union all select * from normal_hoy)
select c.jornada_fecha,c.turno_id from candidatos c order by c.prioridad limit 1; $$;
