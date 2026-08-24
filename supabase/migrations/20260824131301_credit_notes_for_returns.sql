alter table public.configuracion
  add column if not exists nubefact_serie_nc_boleta text,
  add column if not exists nubefact_serie_nc_factura text;

create sequence if not exists nota_credito_boleta_seq start 1;
create sequence if not exists nota_credito_factura_seq start 1;

create table if not exists public.notas_credito (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id),
  devolucion_id uuid unique references public.devoluciones(id),
  comprobante_id uuid not null references public.comprobantes_electronicos(id),
  tipo_nota integer not null check (tipo_nota between 1 and 13),
  sustento text not null,
  serie text not null,
  numero integer not null,
  monto numeric not null check (monto >= 0),
  estado text not null default 'pendiente' check (estado in ('pendiente','emitido','error')),
  enlace_pdf text,
  enlace_xml text,
  enlace_cdr text,
  aceptada_por_sunat boolean,
  sunat_description text,
  respuesta_error text,
  intentos integer not null default 0,
  creado_por uuid not null references public.staff(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (serie, numero)
);

alter table public.notas_credito enable row level security;
drop policy if exists notas_credito_admin_select on public.notas_credito;
create policy notas_credito_admin_select on public.notas_credito for select to authenticated using (private.auth_is_admin());
revoke all on public.notas_credito from anon;
revoke insert,update,delete on public.notas_credito from authenticated;
grant select on public.notas_credito to authenticated;

drop trigger if exists audit_notas_credito on public.notas_credito;
create trigger audit_notas_credito after insert or update or delete on public.notas_credito for each row execute function private.registrar_auditoria();

create or replace function public.crear_nota_credito_devolucion(p_devolucion_id uuid)
returns public.notas_credito
language plpgsql
security definer
set search_path='public','private'
as $$
declare
  v_actor public.staff;
  v_dev public.devoluciones;
  v_sale public.sales;
  v_comp public.comprobantes_electronicos;
  v_config public.configuracion;
  v_serie text;
  v_numero integer;
  v_tipo integer;
  v_nc public.notas_credito;
begin
  select * into v_actor from public.staff where user_id=auth.uid() and activo=true limit 1;
  if v_actor.id is null or v_actor.rol <> 'administrador' then raise exception 'Solo un administrador activo puede crear notas de crédito'; end if;
  select * into v_dev from public.devoluciones where id=p_devolucion_id and estado='completada';
  if v_dev.id is null then raise exception 'Devolución no encontrada o cancelada'; end if;
  if exists(select 1 from public.notas_credito where devolucion_id=v_dev.id) then select * into v_nc from public.notas_credito where devolucion_id=v_dev.id; return v_nc; end if;
  select * into v_sale from public.sales where id=v_dev.sale_id;
  select * into v_comp from public.comprobantes_electronicos where sale_id=v_sale.id and estado='emitido' order by created_at desc limit 1;
  if v_comp.id is null then raise exception 'La venta no tiene un comprobante electrónico emitido'; end if;
  select * into v_config from public.configuracion where id=1;
  if v_sale.tipo_comprobante='factura' then
    v_serie:=nullif(trim(v_config.nubefact_serie_nc_factura),'');
    v_numero:=nextval('nota_credito_factura_seq');
  else
    v_serie:=nullif(trim(v_config.nubefact_serie_nc_boleta),'');
    v_numero:=nextval('nota_credito_boleta_seq');
  end if;
  if v_serie is null or length(v_serie)<>4 then raise exception 'Configura una serie válida de nota de crédito para este tipo de comprobante'; end if;
  if v_sale.tipo_comprobante='factura' and left(upper(v_serie),1)<>'F' then raise exception 'La serie de nota de crédito de factura debe iniciar con F'; end if;
  if v_sale.tipo_comprobante='boleta' and left(upper(v_serie),1)<>'B' then raise exception 'La serie de nota de crédito de boleta debe iniciar con B'; end if;
  v_tipo:=case when v_dev.tipo='total' then 6 else 7 end;
  insert into public.notas_credito(sale_id,devolucion_id,comprobante_id,tipo_nota,sustento,serie,numero,monto,creado_por)
  values(v_sale.id,v_dev.id,v_comp.id,v_tipo,v_dev.motivo,upper(v_serie),v_numero,v_dev.monto,v_actor.id)
  returning * into v_nc;
  return v_nc;
end;
$$;

create or replace function public.emitir_nota_credito_trigger()
returns trigger
language plpgsql
security definer
set search_path='public'
as $$
declare v_supabase_url text; v_service_role_key text;
begin
  v_supabase_url:=current_setting('app.settings.supabase_url',true);
  v_service_role_key:=current_setting('app.settings.service_role_key',true);
  if v_supabase_url is null or v_service_role_key is null then
    raise warning 'emitir_nota_credito_trigger: settings no configurados; se omite emisión'; return new;
  end if;
  perform net.http_post(
    url:=v_supabase_url||'/functions/v1/emitir-nota-credito',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_service_role_key),
    body:=jsonb_build_object('nota_credito_id',new.id)
  );
  return new;
end;
$$;

drop trigger if exists on_nota_credito_pendiente on public.notas_credito;
create trigger on_nota_credito_pendiente after insert on public.notas_credito for each row when (new.estado='pendiente') execute function public.emitir_nota_credito_trigger();

revoke all on function public.crear_nota_credito_devolucion(uuid) from public,anon;
grant execute on function public.crear_nota_credito_devolucion(uuid) to authenticated;
revoke all on function public.emitir_nota_credito_trigger() from public,anon,authenticated;
