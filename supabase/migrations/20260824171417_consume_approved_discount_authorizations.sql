create or replace function public.consumir_autorizacion_descuento(p_variant_id uuid,p_porcentaje numeric,p_descuento_unitario numeric)
returns boolean
language plpgsql
security definer
set search_path='public','private'
as $$
declare
 v_staff public.staff;
 v_limite numeric;
 v_auth_id uuid;
begin
 select * into v_staff from public.staff where user_id=auth.uid() and activo=true limit 1;
 if v_staff.id is null then raise exception 'Personal no válido'; end if;
 if p_porcentaje is null or p_porcentaje<0 or p_porcentaje>100 then raise exception 'Porcentaje inválido'; end if;
 if p_descuento_unitario is null or p_descuento_unitario<0 then raise exception 'Descuento inválido'; end if;
 if private.auth_is_admin() then return true; end if;
 select coalesce(descuento_vendedor_max_pct,0) into v_limite from public.configuracion where id=1;
 if p_porcentaje<=coalesce(v_limite,0)+0.0001 then return true; end if;
 select a.id into v_auth_id
 from public.autorizaciones_operativas a
 where a.tipo='descuento'
   and a.solicitado_por=v_staff.id
   and a.location_id=private.auth_location_id()
   and a.recurso_tipo='variant'
   and a.recurso_id=p_variant_id::text
   and a.estado='aprobado'
   and a.consumed_at is null
   and coalesce((a.payload->>'porcentaje')::numeric,0)>=p_porcentaje-0.0001
   and coalesce((a.payload->>'descuento_unitario')::numeric,0)>=p_descuento_unitario-0.01
 order by a.resolved_at desc nulls last,a.created_at desc
 limit 1
 for update;
 if v_auth_id is null then return false; end if;
 update public.autorizaciones_operativas set consumed_at=now() where id=v_auth_id;
 return true;
end$$;
revoke execute on function public.consumir_autorizacion_descuento(uuid,numeric,numeric) from public,anon;
grant execute on function public.consumir_autorizacion_descuento(uuid,numeric,numeric) to authenticated;
