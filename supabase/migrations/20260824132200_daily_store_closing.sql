create table if not exists public.cierres_diarios (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id),
  fecha date not null,
  total_ventas numeric not null default 0,
  cantidad_ventas integer not null default 0,
  efectivo numeric not null default 0,
  digital numeric not null default 0,
  otros_pagos numeric not null default 0,
  total_reembolsos numeric not null default 0,
  diferencia_cajas numeric not null default 0,
  cajas_cerradas integer not null default 0,
  ordenes_abiertas integer not null default 0,
  stock_critico integer not null default 0,
  observacion text,
  snapshot jsonb not null default '{}'::jsonb,
  cerrado_por uuid not null references public.staff(id),
  closed_at timestamptz not null default now(),
  unique(location_id,fecha)
);

alter table public.cierres_diarios enable row level security;
drop policy if exists cierres_diarios_admin_select on public.cierres_diarios;
create policy cierres_diarios_admin_select on public.cierres_diarios for select to authenticated using (private.auth_is_admin() and location_id=private.auth_location_id());
revoke all on public.cierres_diarios from anon;
revoke insert,update,delete on public.cierres_diarios from authenticated;
grant select on public.cierres_diarios to authenticated;
drop trigger if exists audit_cierres_diarios on public.cierres_diarios;
create trigger audit_cierres_diarios after insert or update or delete on public.cierres_diarios for each row execute function private.registrar_auditoria();

create or replace function private.resumen_cierre_diario(p_location_id uuid,p_fecha date)
returns jsonb language sql stable security definer set search_path='public'
as $$
with ventas as (
 select coalesce(sum(s.total),0)::numeric total,count(*)::int cantidad from public.sales s where s.location_id=p_location_id and s.estado='completada' and (s.fecha at time zone 'America/Lima')::date=p_fecha
), pagos as (
 select coalesce(sum(p.monto) filter(where p.metodo='efectivo'),0)::numeric efectivo,
        coalesce(sum(p.monto) filter(where p.metodo in('yape','plin')),0)::numeric digital,
        coalesce(sum(p.monto) filter(where p.metodo not in('efectivo','yape','plin')),0)::numeric otros
 from public.payments p join public.sales s on s.id=p.sale_id where s.location_id=p_location_id and s.estado='completada' and (s.fecha at time zone 'America/Lima')::date=p_fecha
), reembolsos as (
 select coalesce(sum(d.monto),0)::numeric total from public.devoluciones d where d.location_id=p_location_id and d.estado='completada' and d.reembolso_estado='completado' and (d.reembolsado_at at time zone 'America/Lima')::date=p_fecha
), cajas as (
 select count(*) filter(where c.cierre is null)::int abiertas,count(*) filter(where c.cierre is not null)::int cerradas,coalesce(sum(c.diferencia) filter(where c.cierre is not null),0)::numeric diferencia from public.cash_sessions c where c.location_id=p_location_id and (c.apertura at time zone 'America/Lima')::date=p_fecha
), ordenes as (
 select count(*) filter(where coalesce(o.estado,'') not in('entregado','cancelado'))::int abiertas from public.ordenes_servicio o where o.location_id=p_location_id
), stock as (
 select count(*) filter(where i.cantidad<=i.stock_minimo)::int critico from public.inventory i where i.location_id=p_location_id
)
select jsonb_build_object('fecha',p_fecha,'location_id',p_location_id,'total_ventas',(select total from ventas),'cantidad_ventas',(select cantidad from ventas),'efectivo',(select efectivo from pagos),'digital',(select digital from pagos),'otros_pagos',(select otros from pagos),'total_reembolsos',(select total from reembolsos),'cajas_abiertas',(select abiertas from cajas),'cajas_cerradas',(select cerradas from cajas),'diferencia_cajas',(select diferencia from cajas),'ordenes_abiertas',(select abiertas from ordenes),'stock_critico',(select critico from stock));
$$;

create or replace function public.previsualizar_cierre_diario(p_fecha date default ((now() at time zone 'America/Lima')::date))
returns jsonb language plpgsql stable security definer set search_path='public','private'
as $$ declare v_admin public.staff; begin
 select * into v_admin from public.staff where user_id=auth.uid() and activo=true and rol='administrador' limit 1;
 if v_admin.id is null then raise exception 'Solo administración puede consultar el cierre diario'; end if;
 return private.resumen_cierre_diario(v_admin.location_id,p_fecha);
end $$;

create or replace function public.cerrar_dia(p_fecha date default ((now() at time zone 'America/Lima')::date),p_observacion text default null)
returns public.cierres_diarios language plpgsql security definer set search_path='public','private'
as $$ declare v_admin public.staff; v_r jsonb; v_row public.cierres_diarios; begin
 select * into v_admin from public.staff where user_id=auth.uid() and activo=true and rol='administrador' limit 1;
 if v_admin.id is null then raise exception 'Solo un administrador activo puede cerrar el día'; end if;
 if p_fecha>(now() at time zone 'America/Lima')::date then raise exception 'No se puede cerrar una fecha futura'; end if;
 select * into v_row from public.cierres_diarios where location_id=v_admin.location_id and fecha=p_fecha;
 if v_row.id is not null then return v_row; end if;
 v_r:=private.resumen_cierre_diario(v_admin.location_id,p_fecha);
 if coalesce((v_r->>'cajas_abiertas')::integer,0)>0 then raise exception 'No puedes cerrar el día mientras existan cajas abiertas'; end if;
 insert into public.cierres_diarios(location_id,fecha,total_ventas,cantidad_ventas,efectivo,digital,otros_pagos,total_reembolsos,diferencia_cajas,cajas_cerradas,ordenes_abiertas,stock_critico,observacion,snapshot,cerrado_por)
 values(v_admin.location_id,p_fecha,coalesce((v_r->>'total_ventas')::numeric,0),coalesce((v_r->>'cantidad_ventas')::int,0),coalesce((v_r->>'efectivo')::numeric,0),coalesce((v_r->>'digital')::numeric,0),coalesce((v_r->>'otros_pagos')::numeric,0),coalesce((v_r->>'total_reembolsos')::numeric,0),coalesce((v_r->>'diferencia_cajas')::numeric,0),coalesce((v_r->>'cajas_cerradas')::int,0),coalesce((v_r->>'ordenes_abiertas')::int,0),coalesce((v_r->>'stock_critico')::int,0),nullif(trim(coalesce(p_observacion,'')),''),v_r,v_admin.id) returning * into v_row;
 return v_row;
end $$;

revoke all on function private.resumen_cierre_diario(uuid,date) from public,anon,authenticated;
revoke all on function public.previsualizar_cierre_diario(date) from public,anon;
revoke all on function public.cerrar_dia(date,text) from public,anon;
grant execute on function public.previsualizar_cierre_diario(date) to authenticated;
grant execute on function public.cerrar_dia(date,text) to authenticated;
