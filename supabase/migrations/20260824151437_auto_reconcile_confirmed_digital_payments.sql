create or replace function public.auto_conciliar_pagos_digitales_admin(p_desde timestamptz default now()-interval '30 days',p_hasta timestamptz default now()+interval '1 day')
returns integer
language plpgsql
security definer
set search_path='public','private'
as $$
declare s public.staff; n integer:=0;
begin
 if not private.auth_is_admin() then raise exception 'Solo administradores'; end if;
 select * into s from public.staff where user_id=auth.uid() and activo=true limit 1;
 perform public.sincronizar_conciliaciones_pago_admin(p_desde,p_hasta);
 with matches as (
   select c.id as conciliacion_id,pd.id as pago_digital_id,pd.monto,pd.culqi_order_id,
          row_number() over(partition by c.id order by pd.updated_at desc,pd.created_at desc) rn
   from public.conciliaciones_pago c
   join public.pagos_digitales pd on pd.sale_id=c.sale_id and lower(pd.metodo)=lower(c.metodo)
   where c.location_id=s.location_id and c.estado='pendiente' and pd.estado='pagado'
     and pd.created_at>=p_desde and pd.created_at<p_hasta
     and abs(pd.monto-c.monto_esperado)<=0.005
 )
 update public.conciliaciones_pago c set estado='conciliado',monto_confirmado=m.monto,referencia_proveedor=m.culqi_order_id,proveedor='culqi',observacion='Auto-conciliado desde pagos_digitales',conciliado_por=s.id,conciliado_at=now(),updated_at=now()
 from matches m where c.id=m.conciliacion_id and m.rn=1;
 get diagnostics n=row_count;
 return n;
end$$;

revoke execute on function public.auto_conciliar_pagos_digitales_admin(timestamptz,timestamptz) from public,anon;
grant execute on function public.auto_conciliar_pagos_digitales_admin(timestamptz,timestamptz) to authenticated;
