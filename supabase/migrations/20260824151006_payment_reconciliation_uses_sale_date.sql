alter table public.conciliaciones_pago add column if not exists fecha_venta date;

update public.conciliaciones_pago c
set fecha_venta=(s.fecha at time zone 'America/Lima')::date
from public.sales s
where s.id=c.sale_id and c.fecha_venta is null;

alter table public.conciliaciones_pago alter column fecha_venta set not null;
create index if not exists conciliaciones_pago_location_fecha_estado_idx on public.conciliaciones_pago(location_id,fecha_venta,estado);

create or replace function public.sincronizar_conciliaciones_pago_admin(p_desde timestamptz default now()-interval '30 days',p_hasta timestamptz default now()+interval '1 day')
returns integer language plpgsql security definer set search_path='public','private' as $$
declare s public.staff; n integer;
begin
 if not private.auth_is_admin() then raise exception 'Solo administradores'; end if;
 select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
 insert into public.conciliaciones_pago(payment_id,sale_id,location_id,metodo,monto_esperado,referencia_venta,proveedor,estado,fecha_venta)
 select p.id,p.sale_id,sa.location_id,lower(p.metodo),p.monto,p.referencia,
        case when lower(p.metodo) in('yape','plin','tarjeta') then 'manual/culqi' else 'manual' end,
        'pendiente',(sa.fecha at time zone 'America/Lima')::date
 from public.payments p join public.sales sa on sa.id=p.sale_id
 where sa.location_id=s.location_id and sa.fecha>=p_desde and sa.fecha<p_hasta and lower(p.metodo)<>'efectivo'
 on conflict(payment_id) do update set fecha_venta=excluded.fecha_venta;
 get diagnostics n=row_count;
 return n;
end$$;

create or replace function public.resumen_conciliacion_pagos_admin(p_fecha date default ((now() at time zone 'America/Lima')::date))
returns jsonb language plpgsql stable security definer set search_path='public','private' as $$
declare s public.staff; r jsonb;
begin
 if not private.auth_is_admin() then raise exception 'Solo administradores'; end if;
 select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
 select jsonb_build_object(
  'fecha',p_fecha,
  'pendientes',count(*) filter(where c.estado='pendiente'),
  'conciliados',count(*) filter(where c.estado='conciliado'),
  'diferencias',count(*) filter(where c.estado='diferencia'),
  'rechazados',count(*) filter(where c.estado='rechazado'),
  'monto_pendiente',coalesce(sum(c.monto_esperado) filter(where c.estado='pendiente'),0),
  'monto_diferencia',coalesce(sum(coalesce(c.monto_confirmado,0)-c.monto_esperado) filter(where c.estado='diferencia'),0)
 ) into r from public.conciliaciones_pago c where c.location_id=s.location_id and c.fecha_venta=p_fecha;
 return r;
end$$;

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
 select count(*) into pendientes from public.conciliaciones_pago cp where cp.location_id=c.location_id and cp.fecha_venta=c.fecha and cp.estado in('pendiente','diferencia','rechazado');
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