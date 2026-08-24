create or replace function public.actualizar_limite_descuento_admin(p_porcentaje numeric)
returns numeric language plpgsql security definer set search_path='public','private' as $$
begin
 if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
 if p_porcentaje<0 or p_porcentaje>100 then raise exception 'Porcentaje inválido'; end if;
 update public.configuracion set descuento_vendedor_max_pct=p_porcentaje,updated_at=now() where id=1;
 return p_porcentaje;
end$$;
create or replace function public.cambiar_estado_promocion_admin(p_id uuid,p_activo boolean)
returns void language plpgsql security definer set search_path='public','private' as $$
begin
 if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
 update public.promociones set activo=coalesce(p_activo,false),updated_at=now() where id=p_id;
 if not found then raise exception 'Promoción inexistente'; end if;
end$$;
revoke execute on function public.actualizar_limite_descuento_admin(numeric) from public,anon;
revoke execute on function public.cambiar_estado_promocion_admin(uuid,boolean) from public,anon;
grant execute on function public.actualizar_limite_descuento_admin(numeric) to authenticated;
grant execute on function public.cambiar_estado_promocion_admin(uuid,boolean) to authenticated;
