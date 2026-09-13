-- ============================================================================
-- P2.G — FASE 23 · Reimpresión de recibos con rastro y número de copia
-- ============================================================================
-- Auditoría (2026-09-13): Reportes → "Reimprimir" reconstruía el recibo de
-- cualquier venta desde el navegador y lo imprimía sin dejar rastro en el
-- servidor ni marca en el papel. Una copia era indistinguible del original:
-- vector clásico de fraude con recibos duplicados (devoluciones o reclamos
-- sobre una "segunda" venta que nunca existió).
--
-- Ahora cada reimpresión se registra ANTES de imprimir (fallo cerrado en la UI),
-- recibe un número de copia correlativo por venta y el recibo lo imprime.
--   · reimpresiones_venta es append-only; (sale_id, copia) único.
--   · El número de copia se asigna con la fila de la venta bloqueada: dos
--     reimpresiones simultáneas no reciben el mismo número.
--   · El personal sólo reimprime ventas de su sucursal activa (misma regla que la
--     RLS de ventas); administración, cualquiera.
--   · Una venta anulada no se reimprime.
-- ============================================================================

create table if not exists public.reimpresiones_venta (
  id           bigserial primary key,
  sale_id      uuid not null references public.sales(id),
  location_id  uuid references public.locations(id),
  staff_id     uuid references public.staff(id),
  copia        integer not null check (copia >= 1),
  motivo       text,
  created_at   timestamptz not null default now(),
  constraint reimpresiones_venta_copia_unica unique (sale_id, copia)
);
create index if not exists reimpresiones_venta_location_fecha on public.reimpresiones_venta (location_id, created_at);

create or replace function private.reimpresiones_venta_append_only()
returns trigger
language plpgsql
as $function$
begin
  raise exception 'reimpresiones_venta es de sólo inserción' using errcode = 'P0001';
end
$function$;
revoke all on function private.reimpresiones_venta_append_only() from public;

drop trigger if exists reimpresiones_venta_append_only on public.reimpresiones_venta;
create trigger reimpresiones_venta_append_only
  before update or delete on public.reimpresiones_venta
  for each row execute function private.reimpresiones_venta_append_only();

alter table public.reimpresiones_venta enable row level security;

drop policy if exists reimpresiones_venta_lectura on public.reimpresiones_venta;
create policy reimpresiones_venta_lectura on public.reimpresiones_venta for select to authenticated
  using (private.auth_is_admin() or location_id = private.auth_location_id());

revoke insert, update, delete, truncate, references, trigger on public.reimpresiones_venta from authenticated;
revoke all on public.reimpresiones_venta from anon;
revoke all on sequence public.reimpresiones_venta_id_seq from authenticated, anon;

create or replace function public.registrar_reimpresion_venta(p_sale_id uuid, p_motivo text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_staff  uuid := private.auth_staff_id();
  v_venta  public.sales;
  v_copia  integer;
begin
  if v_staff is null then raise exception 'Personal no válido o inactivo'; end if;

  select * into v_venta from public.sales where id = p_sale_id for update;
  if v_venta.id is null then raise exception 'Venta inexistente'; end if;
  if not private.auth_is_admin() and v_venta.location_id is distinct from private.auth_location_id() then
    raise exception 'La venta pertenece a otra sucursal';
  end if;
  if v_venta.estado = 'anulada' then raise exception 'Una venta anulada no se reimprime'; end if;

  select coalesce(max(r.copia), 0) + 1 into v_copia from public.reimpresiones_venta r where r.sale_id = v_venta.id;

  insert into public.reimpresiones_venta (sale_id, location_id, staff_id, copia, motivo)
  values (v_venta.id, v_venta.location_id, v_staff, v_copia, nullif(btrim(coalesce(p_motivo, '')), ''));

  return jsonb_build_object('sale_id', v_venta.id, 'numero', v_venta.numero, 'copia', v_copia);
end
$function$;

revoke all on function public.registrar_reimpresion_venta(uuid, text) from public;
grant execute on function public.registrar_reimpresion_venta(uuid, text) to authenticated, service_role;
