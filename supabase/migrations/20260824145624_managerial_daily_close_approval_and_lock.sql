alter table public.configuracion add column if not exists diferencia_caja_critica numeric(14,2) not null default 20;

alter table public.cierres_diarios
 add column if not exists estado_aprobacion text not null default 'pendiente',
 add column if not exists aprobado_por uuid references public.staff(id),
 add column if not exists aprobado_at timestamptz,
 add column if not exists firma_responsable text,
 add column if not exists observacion_aprobacion text,
 add column if not exists diferencia_critica boolean not null default false,
 add column if not exists conciliaciones_pendientes integer not null default 0,
 add column if not exists reporte_final jsonb not null default '{}'::jsonb;

do $$ begin
 if not exists(select 1 from pg_constraint where conname='cierres_diarios_estado_aprobacion_check') then
  alter table public.cierres_diarios add constraint cierres_diarios_estado_aprobacion_check check(estado_aprobacion in('pendiente','aprobado'));
 end if;
end $$;

create or replace function private.cierre_aprobado(p_location_id uuid,p_fecha date)
returns boolean language sql stable security definer set search_path='public' as $$
 select exists(select 1 from public.cierres_diarios c where c.location_id=p_location_id and c.fecha=p_fecha and c.estado_aprobacion='aprobado');
$$;
revoke all on function private.cierre_aprobado(uuid,date) from public,anon,authenticated;

create or replace function public.aprobar_cierre_diario(p_cierre_id uuid,p_firma text,p_observacion text default null,p_autorizacion_id uuid default null)
returns public.cierres_diarios language plpgsql security definer set search_path='public','private' as $$
declare s public.staff; c public.cierres_diarios; umbral numeric:=20; pendientes int:=0; a public.autorizaciones_operativas; rep jsonb;
begin
 if not private.auth_is_admin() then raise exception 'Solo administración puede aprobar cierres'; end if;
 select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
 select * into c from public.cierres_diarios where id=p_cierre_id for update;
 if c.id is null or c.location_id<>s.location_id then raise exception 'Cierre inválido'; end if;
 if c.estado_aprobacion='aprobado' then return c; end if;
 if length(btrim(coalesce(p_firma,'')))<3 then raise exception 'Ingresa nombre/firma responsable'; end if;
 select coalesce(diferencia_caja_critica,20) into umbral from public.configuracion where id=1;
 select count(*) into pendientes from public.conciliaciones_pago cp where cp.location_id=c.location_id and (cp.created_at at time zone 'America/Lima')::date=c.fecha and cp.estado in('pendiente','diferencia','rechazado');
 if abs(c.diferencia_cajas)>=umbral then
   if p_autorizacion_id is null then raise exception 'Diferencia crítica: requiere autorización operativa'; end if;
   select * into a from public.autorizaciones_operativas where id=p_autorizacion_id for update;
   if a.id is null or a.estado<>'aprobada' or a.location_id<>c.location_id or a.tipo<>'otro' or a.recurso_tipo<>'cierre_diario' or a.recurso_id<>c.id::text then raise exception 'Autorización de cierre inválida'; end if;
   update public.autorizaciones_operativas set estado='consumida',consumed_at=now() where id=a.id;
 end if;
 rep:=c.snapshot || jsonb_build_object('aprobado_at',now(),'firma_responsable',btrim(p_firma),'conciliaciones_pendientes',pendientes,'diferencia_critica',abs(c.diferencia_cajas)>=umbral);
 update public.cierres_diarios set estado_aprobacion='aprobado',aprobado_por=s.id,aprobado_at=now(),firma_responsable=btrim(p_firma),observacion_aprobacion=nullif(btrim(coalesce(p_observacion,'')),''),diferencia_critica=(abs(diferencia_cajas)>=umbral),conciliaciones_pendientes=pendientes,reporte_final=rep where id=c.id returning * into c;
 return c;
end$$;

create or replace function private.bloquear_ventas_dia_aprobado()
returns trigger language plpgsql security definer set search_path='public','private' as $$
declare loc uuid; f date;
begin
 if tg_op='DELETE' then loc:=old.location_id; f:=(old.fecha at time zone 'America/Lima')::date; else loc:=new.location_id; f:=(new.fecha at time zone 'America/Lima')::date; end if;
 if private.cierre_aprobado(loc,f) then raise exception 'El día % está aprobado y bloqueado para modificaciones financieras',f; end if;
 if tg_op='DELETE' then return old; end if; return new;
end$$;
revoke all on function private.bloquear_ventas_dia_aprobado() from public,anon,authenticated;
drop trigger if exists trg_bloquear_sales_cierre_aprobado on public.sales;
create trigger trg_bloquear_sales_cierre_aprobado before insert or update or delete on public.sales for each row execute function private.bloquear_ventas_dia_aprobado();

create or replace function private.bloquear_payments_dia_aprobado()
returns trigger language plpgsql security definer set search_path='public','private' as $$
declare sid uuid; loc uuid; f date;
begin
 sid:=case when tg_op='DELETE' then old.sale_id else new.sale_id end;
 select location_id,(fecha at time zone 'America/Lima')::date into loc,f from public.sales where id=sid;
 if loc is not null and private.cierre_aprobado(loc,f) then raise exception 'El día % está aprobado y bloqueado para modificaciones de pagos',f; end if;
 if tg_op='DELETE' then return old; end if; return new;
end$$;
revoke all on function private.bloquear_payments_dia_aprobado() from public,anon,authenticated;
drop trigger if exists trg_bloquear_payments_cierre_aprobado on public.payments;
create trigger trg_bloquear_payments_cierre_aprobado before insert or update or delete on public.payments for each row execute function private.bloquear_payments_dia_aprobado();

revoke all on function public.aprobar_cierre_diario(uuid,text,text,uuid) from public,anon;
grant execute on function public.aprobar_cierre_diario(uuid,text,text,uuid) to authenticated;