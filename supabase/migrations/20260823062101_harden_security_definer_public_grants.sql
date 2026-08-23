do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as fn, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef = true
  loop
    execute format('revoke execute on function %s from public', r.fn);
    execute format('grant execute on function %s to authenticated', r.fn);
    if r.proname in ('hay_staff', 'email_por_username') then
      execute format('grant execute on function %s to anon', r.fn);
    else
      execute format('revoke execute on function %s from anon', r.fn);
    end if;
  end loop;
end;
$$;
