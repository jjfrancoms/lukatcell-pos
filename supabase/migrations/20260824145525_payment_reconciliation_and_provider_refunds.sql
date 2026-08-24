create table if not exists public.conciliaciones_pago(
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete cascade,
  sale_id uuid not null references public.sales(id) on delete cascade,
  location_id uuid not null references public.locations(id),
  metodo text not null,
  monto_esperado numeric(14,2) not null,
  monto_confirmado numeric(14,2),
  referencia_venta text,
  referencia_proveedor text,
  proveedor text,
  estado text not null default 'pendiente' check(estado in('pendiente','conciliado','diferencia','rechazado')),
  observacion text,
  conciliado_por uuid references public.staff(id),
  conciliado_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(payment_id)
);
create index if not exists conciliaciones_pago_location_estado_idx on public.conciliaciones_pago(location_id,estado,created_at desc);
alter table public.conciliaciones_pago enable row level security;
create policy conciliaciones_pago_admin on public.conciliaciones_pago for all to authenticated using(private.auth_is_admin() and location_id=private.auth_location_id()) with check(private.auth_is_admin() and location_id=private.auth_location_id());
revoke all on public.conciliaciones_pago from anon;
grant select on public.conciliaciones_pago to authenticated;

create or replace function public.sincronizar_conciliaciones_pago_admin(p_desde timestamptz default now()-interval '30 days',p_hasta timestamptz default now()+interval '1 day')
returns integer language plpgsql security definer set search_path='public','private' as $$
declare s public.staff; n integer;
begin
 if not private.auth_is_admin() then raise exception 'Solo administradores'; end if;
 select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
 insert into public.conciliaciones_pago(payment_id,sale_id,location_id,metodo,monto_esperado,referencia_venta,proveedor,estado)
 select p.id,p.sale_id,sa.location_id,lower(p.metodo),p.monto,p.referencia,
        case when lower(p.metodo) in('yape','plin','tarjeta') then 'manual/culqi' else 'manual' end,
        'pendiente'
 from public.payments p join public.sales sa on sa.id=p.sale_id
 where sa.location_id=s.location_id and sa.fecha>=p_desde and sa.fecha<p_hasta and lower(p.metodo)<>'efectivo'
 on conflict(payment_id) do nothing;
 get diagnostics n=row_count;
 return n;
end$$;

create or replace function public.conciliar_pago_admin(p_payment_id uuid,p_estado text,p_monto_confirmado numeric default null,p_referencia_proveedor text default null,p_observacion text default null)
returns public.conciliaciones_pago language plpgsql security definer set search_path='public','private' as $$
declare s public.staff; c public.conciliaciones_pago; v_estado text;
begin
 if not private.auth_is_admin() then raise exception 'Solo administradores'; end if;
 select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
 perform public.sincronizar_conciliaciones_pago_admin(now()-interval '365 days',now()+interval '1 day');
 select * into c from public.conciliaciones_pago where payment_id=p_payment_id for update;
 if c.id is null or c.location_id<>s.location_id then raise exception 'Pago no conciliable'; end if;
 v_estado:=lower(trim(p_estado)); if v_estado not in('conciliado','diferencia','rechazado') then raise exception 'Estado inválido'; end if;
 if v_estado='conciliado' and p_monto_confirmado is not null and abs(p_monto_confirmado-c.monto_esperado)>0.005 then v_estado:='diferencia'; end if;
 update public.conciliaciones_pago set estado=v_estado,monto_confirmado=coalesce(p_monto_confirmado,c.monto_esperado),referencia_proveedor=nullif(trim(p_referencia_proveedor),''),observacion=nullif(trim(p_observacion),''),conciliado_por=s.id,conciliado_at=now(),updated_at=now() where id=c.id returning * into c;
 return c;
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
 ) into r from public.conciliaciones_pago c where c.location_id=s.location_id and (c.created_at at time zone 'America/Lima')::date=p_fecha;
 return r;
end$$;

revoke all on function public.sincronizar_conciliaciones_pago_admin(timestamptz,timestamptz) from public,anon;
revoke all on function public.conciliar_pago_admin(uuid,text,numeric,text,text) from public,anon;
revoke all on function public.resumen_conciliacion_pagos_admin(date) from public,anon;
grant execute on function public.sincronizar_conciliaciones_pago_admin(timestamptz,timestamptz) to authenticated;
grant execute on function public.conciliar_pago_admin(uuid,text,numeric,text,text) to authenticated;
grant execute on function public.resumen_conciliacion_pagos_admin(date) to authenticated;
create trigger audit_conciliaciones_pago after insert or update or delete on public.conciliaciones_pago for each row execute function private.registrar_auditoria();