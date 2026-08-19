-- El trigger descontar_inventario() rechaza la venta si no existe una fila en
-- inventory para esa variante+location (0 filas afectadas = "stock insuficiente").
-- "Servicio técnico" no es un producto físico, así que se le da una cantidad muy
-- alta en cada local existente para que nunca "se agote".
insert into inventory (variant_id, location_id, cantidad, stock_minimo)
select pv.id, l.id, 999999, 0
from product_variants pv
join products p on p.id = pv.product_id
cross join locations l
where p.nombre = 'Servicio técnico'
  and not exists (
    select 1 from inventory i where i.variant_id = pv.id and i.location_id = l.id
  );
