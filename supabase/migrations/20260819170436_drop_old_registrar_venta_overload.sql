-- La migración anterior agregó parámetros nuevos a registrar_venta con
-- CREATE OR REPLACE, pero Postgres lo trató como una sobrecarga nueva en vez
-- de reemplazar la función (quedaron 2 versiones coexistiendo, causando
-- "function is not unique" en cualquier llamada con parámetros nombrados).
-- Se elimina la firma vieja de 11 parámetros; la app usa la de 16.
drop function if exists registrar_venta(jsonb, jsonb, numeric, numeric, numeric, uuid, uuid, text, uuid, uuid, uuid);
