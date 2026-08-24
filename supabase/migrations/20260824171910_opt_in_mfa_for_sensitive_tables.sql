create or replace function private.auth_mfa_satisfied()
returns boolean
language sql
stable
security definer
set search_path='auth'
as $$
  select case
    when exists(select 1 from auth.mfa_factors f where f.user_id=auth.uid() and f.status='verified')
      then coalesce(auth.jwt()->>'aal','aal1')='aal2'
    else true
  end;
$$;
revoke execute on function private.auth_mfa_satisfied() from public,anon;
grant execute on function private.auth_mfa_satisfied() to authenticated;

do $$
declare t text;
begin
  foreach t in array array['staff','configuracion','autorizaciones_operativas','cierres_diarios','conciliaciones_pago','facturas_proveedor','pagos_proveedor','pagos_digitales','auditoria_eventos'] loop
    execute format('drop policy if exists mfa_opt_in_guard on public.%I',t);
    execute format('create policy mfa_opt_in_guard on public.%I as restrictive for all to authenticated using (private.auth_mfa_satisfied()) with check (private.auth_mfa_satisfied())',t);
  end loop;
end$$;
