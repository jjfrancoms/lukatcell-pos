-- El formulario de "Nuevo producto"/"Editar producto" mostraba "Modelo de celular"
-- para cualquier categoría (ej. un teclado gamer en "Accesorios de PC"), aunque solo
-- tiene sentido para categorías cuyas variantes realmente dependen del modelo
-- (fundas, mica/protectores, reparación técnica). Se marca eso en la propia categoría
-- en vez de una lista fija en el frontend, para que sea editable sin tocar código.
alter table categorias
  add column if not exists requiere_modelo_celular boolean not null default false;

update categorias set requiere_modelo_celular = true
where nombre in ('Fundas', 'Mica y protectores', 'Reparación técnica');
