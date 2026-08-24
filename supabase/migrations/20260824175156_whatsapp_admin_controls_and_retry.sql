create or replace function public.whatsapp_plantillas_admin()
returns setof public.whatsapp_plantillas language sql stable security definer set search_path='public','private' as $$
 select p.* from public.whatsapp_plantillas p where private.auth_is_admin() order by p.activo desc,p.nombre;
$$;
create or replace function public.guardar_plantilla_whatsapp_admin(p_id uuid,p_clave text,p_nombre text,p_meta_template_name text,p_idioma text,p_cuerpo_preview text,p_activo boolean default true)
returns uuid language plpgsql security definer set search_path='public','private' as $$
declare rid uuid;
begin
 if not private.auth_is_admin() then raise exception 'Solo administración'; end if;
 if length(trim(coalesce(p_clave,'')))<2 or length(trim(coalesce(p_nombre,'')))<2 or length(trim(coalesce(p_cuerpo_preview,'')))<2 then raise exception 'Clave, nombre y vista previa son obligatorios'; end if;
 if p_id is null then
  insert into public.whatsapp_plantillas(clave,nombre,meta_template_name,idioma,cuerpo_preview,activo)
  values(lower(trim(p_clave)),trim(p_nombre),nullif(trim(coalesce(p_meta_template_name,'')),''),coalesce(nullif(trim(coalesce(p_idioma,'')),''),'es'),trim(p_cuerpo_preview),coalesce(p_activo,true)) returning id into rid;
 else
  update public.whatsapp_plantillas set clave=lower(trim(p_clave)),nombre=trim(p_nombre),meta_template_name=nullif(trim(coalesce(p_meta_template_name,'')),''),idioma=coalesce(nullif(trim(coalesce(p_idioma,'')),''),'es'),cuerpo_preview=trim(p_cuerpo_preview),activo=coalesce(p_activo,true),updated_at=now() where id=p_id returning id into rid;
  if rid is null then raise exception 'Plantilla inexistente'; end if;
 end if;
 return rid;
end$$;
create or replace function public.reintentar_whatsapp_admin(p_id uuid)
returns boolean language plpgsql security definer set search_path='public','private' as $$
begin if not private.auth_is_admin() then raise exception 'Solo administración'; end if; update public.whatsapp_envios set estado='pendiente',error=null,procesado_at=null where id=p_id and estado in('fallido','cancelado'); return found; end$$;
create or replace function public.cancelar_whatsapp_admin(p_id uuid)
returns boolean language plpgsql security definer set search_path='public','private' as $$
begin if not private.auth_is_admin() then raise exception 'Solo administración'; end if; update public.whatsapp_envios set estado='cancelado',error=coalesce(error,'Cancelado por administración'),procesado_at=coalesce(procesado_at,now()) where id=p_id and estado='pendiente'; return found; end$$;
revoke execute on function public.whatsapp_plantillas_admin() from public,anon;
revoke execute on function public.guardar_plantilla_whatsapp_admin(uuid,text,text,text,text,text,boolean) from public,anon;
revoke execute on function public.reintentar_whatsapp_admin(uuid) from public,anon;
revoke execute on function public.cancelar_whatsapp_admin(uuid) from public,anon;
grant execute on function public.whatsapp_plantillas_admin() to authenticated;
grant execute on function public.guardar_plantilla_whatsapp_admin(uuid,text,text,text,text,text,boolean) to authenticated;
grant execute on function public.reintentar_whatsapp_admin(uuid) to authenticated;
grant execute on function public.cancelar_whatsapp_admin(uuid) to authenticated;