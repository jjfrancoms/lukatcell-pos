-- Catálogo general de marcas/modelos de celular, cubriendo lo más común en el
-- mercado peruano (para fundas, mica/protectores, y reparación técnica).
insert into modelos_celular (marca, modelo) values
  -- Apple
  ('Apple', 'iPhone SE (2022)'),
  ('Apple', 'iPhone 11'),
  ('Apple', 'iPhone 12'),
  ('Apple', 'iPhone 12 Pro'),
  ('Apple', 'iPhone 13'),
  ('Apple', 'iPhone 13 Pro'),
  ('Apple', 'iPhone 14'),
  ('Apple', 'iPhone 14 Plus'),
  ('Apple', 'iPhone 14 Pro'),
  ('Apple', 'iPhone 14 Pro Max'),
  ('Apple', 'iPhone 15'),
  ('Apple', 'iPhone 15 Plus'),
  ('Apple', 'iPhone 15 Pro'),
  ('Apple', 'iPhone 15 Pro Max'),
  ('Apple', 'iPhone 16'),
  ('Apple', 'iPhone 16 Plus'),
  ('Apple', 'iPhone 16 Pro'),
  ('Apple', 'iPhone 16 Pro Max'),
  -- Samsung
  ('Samsung', 'Galaxy A04'),
  ('Samsung', 'Galaxy A14'),
  ('Samsung', 'Galaxy A15'),
  ('Samsung', 'Galaxy A24'),
  ('Samsung', 'Galaxy A34'),
  ('Samsung', 'Galaxy A54'),
  ('Samsung', 'Galaxy A55'),
  ('Samsung', 'Galaxy S21'),
  ('Samsung', 'Galaxy S22'),
  ('Samsung', 'Galaxy S23'),
  ('Samsung', 'Galaxy S24'),
  ('Samsung', 'Galaxy S24 Ultra'),
  ('Samsung', 'Galaxy Note 20'),
  ('Samsung', 'Galaxy Z Flip 5'),
  -- Xiaomi
  ('Xiaomi', 'Redmi 10'),
  ('Xiaomi', 'Redmi 12'),
  ('Xiaomi', 'Redmi Note 11'),
  ('Xiaomi', 'Redmi Note 12'),
  ('Xiaomi', 'Redmi Note 13'),
  ('Xiaomi', 'Poco X5'),
  ('Xiaomi', 'Poco M5'),
  ('Xiaomi', 'Mi 11'),
  -- Motorola
  ('Motorola', 'Moto G22'),
  ('Motorola', 'Moto G54'),
  ('Motorola', 'Moto G84'),
  ('Motorola', 'Moto Edge 40'),
  -- Huawei
  ('Huawei', 'P30'),
  ('Huawei', 'P40'),
  ('Huawei', 'Y9'),
  -- Otros / genérico
  ('Genérico', 'Otro modelo')
on conflict (marca, modelo) do nothing;
