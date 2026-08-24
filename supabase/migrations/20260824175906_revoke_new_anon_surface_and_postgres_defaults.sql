revoke all privileges on table public.personal_documentos, public.personal_solicitudes, public.whatsapp_envios, public.whatsapp_plantillas from anon;
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke execute on functions from anon;
