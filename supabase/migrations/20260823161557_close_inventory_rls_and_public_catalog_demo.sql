-- Cerrar políticas heredadas del modo demo: el POS requiere sesión para catálogo.
drop policy if exists anon_products on public.products;
drop policy if exists anon_variants on public.product_variants;
drop policy if exists anon_modelos on public.modelos_celular;
drop policy if exists anon_categorias on public.categorias;

-- Inventario: lectura por sucursal, pero escritura directa solo para administradores.
drop policy if exists inventario_escritura on public.inventory;
create policy inventario_escritura_admin
on public.inventory
for all
to authenticated
using (public.auth_is_admin())
with check (public.auth_is_admin());

-- Los movimientos directos también quedan solo para admin. Técnicos/encargados
-- usan ajustar_stock(), que valida actor, puesto y sucursal en servidor.
drop policy if exists movimientos_insercion on public.inventory_movements;
create policy movimientos_insercion_admin
on public.inventory_movements
for insert
to authenticated
with check (public.auth_is_admin());

-- Las RPC de lectura de catálogo no necesitan saltarse RLS.
alter function public.buscar_por_barcode(text) security invoker;
alter function public.buscar_variantes(text) security invoker;
alter function public.obtener_favoritos() security invoker;
alter function public.variantes_actualizadas_desde(timestamptz) security invoker;
alter function public.variantes_por_categoria(uuid) security invoker;
alter function public.validar_stock(uuid, uuid, integer) security invoker;
