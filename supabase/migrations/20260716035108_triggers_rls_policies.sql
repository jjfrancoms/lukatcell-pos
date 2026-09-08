-- ============================================================================
-- Reconstruida desde el historial de migraciones de producción
-- (supabase_migrations.schema_migrations, versión 20260716035108).
--
-- Esta migración se aplicó en su momento sin dejar archivo en el repositorio.
-- El SQL de abajo es EXACTAMENTE el que quedó registrado en producción; no se
-- reejecutó nada al recuperarlo. Ver docs/POS_INTEGRITY_HARDENING.md (P0.2
-- bloque 11) para el mapeo completo.
-- ============================================================================


-- Habilitar RLS
alter table locations enable row level security;
alter table staff enable row level security;
alter table categorias enable row level security;
alter table modelos_celular enable row level security;
alter table products enable row level security;
alter table product_variants enable row level security;
alter table inventory enable row level security;
alter table cash_sessions enable row level security;
alter table sales enable row level security;
alter table sale_items enable row level security;
alter table payments enable row level security;
alter table inventory_movements enable row level security;

-- Helper: obtener location_id del usuario autenticado
create or replace function auth_location_id()
returns uuid
language sql
security definer
stable
as $$
  select location_id from staff where user_id = auth.uid() limit 1;
$$;

create or replace function auth_staff_id()
returns uuid
language sql
security definer
stable
as $$
  select id from staff where user_id = auth.uid() limit 1;
$$;

create or replace function auth_is_admin()
returns boolean
language sql
security definer
stable
as $$
  select exists (select 1 from staff where user_id = auth.uid() and rol = 'administrador');
$$;

-- Políticas: lectura general para usuarios autenticados en catálogo
create policy catalogo_lectura on products for select using (auth.role() = 'authenticated');
create policy variantes_lectura on product_variants for select using (auth.role() = 'authenticated');
create policy categorias_lectura on categorias for select using (auth.role() = 'authenticated');
create policy modelos_lectura on modelos_celular for select using (auth.role() = 'authenticated');
create policy locations_lectura on locations for select using (auth.role() = 'authenticated');

-- Solo administradores escriben catálogo
create policy catalogo_escritura on products for all using (auth_is_admin()) with check (auth_is_admin());
create policy variantes_escritura on product_variants for all using (auth_is_admin()) with check (auth_is_admin());

-- Inventario: lectura filtrada por ubicación del usuario (o todo si admin)
create policy inventario_lectura on inventory for select using (
  auth_is_admin() or location_id = auth_location_id()
);
create policy inventario_escritura on inventory for all using (
  auth_is_admin() or location_id = auth_location_id()
) with check (
  auth_is_admin() or location_id = auth_location_id()
);

-- Cash sessions: cajero solo ve/modifica su propia sesión activa; admin ve todo
create policy caja_propia on cash_sessions for all using (
  auth_is_admin() or cajero_id = auth_staff_id()
) with check (
  auth_is_admin() or cajero_id = auth_staff_id()
);

-- Ventas: filtradas por ubicación del staff
create policy ventas_por_ubicacion on sales for select using (
  auth_is_admin() or location_id = auth_location_id()
);
create policy ventas_insercion on sales for insert with check (
  auth.role() = 'authenticated'
);

create policy sale_items_lectura on sale_items for select using (
  auth.role() = 'authenticated'
);
create policy sale_items_insercion on sale_items for insert with check (
  auth.role() = 'authenticated'
);

create policy payments_lectura on payments for select using (auth.role() = 'authenticated');
create policy payments_insercion on payments for insert with check (auth.role() = 'authenticated');

create policy staff_propio on staff for select using (
  auth_is_admin() or user_id = auth.uid()
);

create policy movimientos_lectura on inventory_movements for select using (
  auth_is_admin() or location_id = auth_location_id()
);
create policy movimientos_insercion on inventory_movements for insert with check (
  auth.role() = 'authenticated'
);

-- Función: validar stock disponible antes de vender
create or replace function validar_stock(p_variant_id uuid, p_location_id uuid, p_cantidad integer)
returns boolean
language plpgsql
security definer
as $$
declare
  v_stock integer;
begin
  select cantidad into v_stock from inventory
    where variant_id = p_variant_id and location_id = p_location_id;

  if v_stock is null then
    return false;
  end if;

  return v_stock >= p_cantidad;
end;
$$;

-- Trigger: descontar inventario automáticamente al insertar sale_items
create or replace function descontar_inventario()
returns trigger
language plpgsql
security definer
as $$
declare
  v_location_id uuid;
  v_stock_disponible boolean;
begin
  select location_id into v_location_id from sales where id = new.sale_id;

  select validar_stock(new.variant_id, v_location_id, new.cantidad) into v_stock_disponible;

  if not v_stock_disponible then
    raise exception 'Stock insuficiente para la variante %', new.variant_id;
  end if;

  update inventory
    set cantidad = cantidad - new.cantidad,
        updated_at = now()
    where variant_id = new.variant_id and location_id = v_location_id;

  return new;
end;
$$;

create trigger trg_descontar_inventario
  after insert on sale_items
  for each row execute function descontar_inventario();

-- Trigger: calcular diferencia al cerrar caja
create or replace function calcular_diferencia_caja()
returns trigger
language plpgsql
as $$
begin
  if new.cierre is not null and new.monto_final_contado is not null then
    new.diferencia = new.monto_final_contado - coalesce(new.monto_final_esperado, 0);
  end if;
  return new;
end;
$$;

create trigger trg_calcular_diferencia
  before update on cash_sessions
  for each row execute function calcular_diferencia_caja();
;
