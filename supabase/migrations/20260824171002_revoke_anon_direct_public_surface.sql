do $$
declare r record;
begin
  for r in select schemaname,tablename from pg_tables where schemaname='public' loop
    execute format('revoke all privileges on table %I.%I from anon',r.schemaname,r.tablename);
  end loop;
  for r in select sequence_schema,sequence_name from information_schema.sequences where sequence_schema='public' loop
    execute format('revoke all privileges on sequence %I.%I from anon',r.sequence_schema,r.sequence_name);
  end loop;
end$$;

revoke execute on function public.autorizaciones_admin(text,integer) from public,anon;
revoke execute on function public.mis_autorizaciones(integer) from public,anon;
revoke execute on function public.seriales_disponibles(uuid) from public,anon;
revoke execute on function public.set_updated_at() from public,anon,authenticated;
grant execute on function public.autorizaciones_admin(text,integer) to authenticated;
grant execute on function public.mis_autorizaciones(integer) to authenticated;
grant execute on function public.seriales_disponibles(uuid) to authenticated;
