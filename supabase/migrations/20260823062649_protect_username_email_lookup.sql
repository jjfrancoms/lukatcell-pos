revoke all on function public.email_por_username(text) from public, anon, authenticated;
grant execute on function public.email_por_username(text) to service_role;
