-- Agente conversacional de WhatsApp: tablas, FAQs iniciales y trigger de notificación de estado.
-- Corre esto en el SQL Editor de tu proyecto Supabase o vía `supabase db push`.

-- ============================================================
-- Tabla: conversaciones
-- Guarda el historial de chat (máx. 20 mensajes) por teléfono.
-- ============================================================
create table if not exists conversaciones (
  id uuid primary key default gen_random_uuid(),
  telefono text not null unique,
  mensajes jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table conversaciones enable row level security;

drop policy if exists "Conversaciones acceso service_role" on conversaciones;
create policy "Conversaciones acceso service_role" on conversaciones
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ============================================================
-- Tabla: faqs
-- Preguntas frecuentes que el agente puede consultar.
-- ============================================================
create table if not exists faqs (
  id uuid primary key default gen_random_uuid(),
  pregunta text not null,
  respuesta text not null,
  categoria text not null,
  created_at timestamptz not null default now()
);

alter table faqs enable row level security;

drop policy if exists "FAQs lectura publica" on faqs;
create policy "FAQs lectura publica" on faqs
  for select using (true);

drop policy if exists "FAQs acceso service_role" on faqs;
create policy "FAQs acceso service_role" on faqs
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- FAQs iniciales
insert into faqs (pregunta, respuesta, categoria) values
  (
    '¿Dónde está ubicada la tienda?',
    'Estamos en Av. Jardines Este 388, San Juan de Lurigancho (SJL), Lima.',
    'ubicacion'
  ),
  (
    '¿Cuál es el horario de atención?',
    'Atendemos de lunes a sábado de 9:00 a.m. a 8:00 p.m. Domingos de 10:00 a.m. a 2:00 p.m.',
    'horario'
  ),
  (
    '¿Hacen envíos?',
    'Sí, hacemos envíos dentro de Lima mediante delivery. El costo y tiempo de entrega depende de la zona; un asesor te confirmará el monto exacto.',
    'envios'
  ),
  (
    '¿Qué métodos de pago aceptan?',
    'Aceptamos efectivo, Yape, Plin y tarjetas de crédito/débito.',
    'pagos'
  ),
  (
    '¿Cuánto demora una reparación?',
    'La mayoría de reparaciones (pantallas, baterías, puertos de carga) toman entre 30 minutos y 24 horas, dependiendo del modelo y la disponibilidad del repuesto. El diagnóstico inicial suele tomar menos de 1 hora.',
    'reparaciones'
  ),
  (
    '¿Las reparaciones tienen garantía?',
    'Sí, todas nuestras reparaciones tienen garantía de 30 días por defectos del repuesto o de la instalación.',
    'garantia'
  )
on conflict do nothing;

-- ============================================================
-- Trigger: notificar cambio de estado de orden de servicio
-- Llama a la Edge Function "notificar-estado" vía pg_net cuando
-- cambia la columna `estado` de una orden de servicio.
-- ============================================================
create extension if not exists pg_net with schema extensions;

-- Configura estos valores una sola vez por proyecto (reemplaza con los tuyos):
--   alter database postgres set app.settings.supabase_url = 'https://TU_PROYECTO.supabase.co';
--   alter database postgres set app.settings.service_role_key = 'TU_SERVICE_ROLE_KEY';
-- (Ver supabase/WHATSAPP_SETUP.md para el detalle completo.)

create or replace function notificar_cambio_estado()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supabase_url text;
  v_service_role_key text;
  v_cliente_nombre text;
begin
  if new.estado is distinct from old.estado then
    v_supabase_url := current_setting('app.settings.supabase_url', true);
    v_service_role_key := current_setting('app.settings.service_role_key', true);

    if v_supabase_url is null or v_service_role_key is null then
      raise warning 'notificar_cambio_estado: app.settings.supabase_url / service_role_key no configurados; se omite la notificación';
      return new;
    end if;

    if new.cliente_telefono is null then
      return new;
    end if;

    select nombre into v_cliente_nombre from clientes where id = new.cliente_id;
    v_cliente_nombre := coalesce(v_cliente_nombre, new.cliente_nombre);

    perform net.http_post(
      url := v_supabase_url || '/functions/v1/notificar-estado',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_service_role_key
      ),
      body := jsonb_build_object(
        'telefono', new.cliente_telefono,
        'estado', new.estado,
        'numero_orden', new.numero,
        'cliente_nombre', v_cliente_nombre,
        'equipo', trim(both ' ' from coalesce(new.equipo_marca, '') || ' ' || coalesce(new.equipo_modelo, ''))
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists on_estado_change on ordenes_servicio;
create trigger on_estado_change
  after update of estado on ordenes_servicio
  for each row
  execute function notificar_cambio_estado();
