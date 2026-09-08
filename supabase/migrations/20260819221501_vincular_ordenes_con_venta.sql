-- Permite cobrar una orden de servicio como una venta real (con boleta/factura y
-- pago QR verificado, igual que cualquier venta), en vez del "costo final" suelto
-- que antes no generaba ningún registro de pago.
alter table ordenes_servicio
  add column if not exists venta_id uuid references sales(id);

-- Producto genérico para poder cobrar órdenes de servicio desde el catálogo — el
-- precio real cobrado siempre es el costo final de la orden, no el precio de este
-- producto (que solo existe para tener una fila válida en product_variants).
do $$
declare
  v_categoria_id uuid;
  v_product_id uuid;
begin
  select id into v_categoria_id from categorias where nombre = 'Reparación técnica';

  if not exists (select 1 from products where nombre = 'Servicio técnico') then
    insert into products (nombre, categoria_id, precio_base, costo, activo)
    values ('Servicio técnico', v_categoria_id, 0, 0, true)
    returning id into v_product_id;

    insert into product_variants (product_id) values (v_product_id);
  end if;
end $$;
