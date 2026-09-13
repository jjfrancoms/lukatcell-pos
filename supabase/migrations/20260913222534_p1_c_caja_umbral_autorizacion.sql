-- ============================================================================
-- P1-C · CAJA: umbral configurable, autorización obligatoria por encima del
-- umbral, actor real desde auth.uid(), sucursal validada en servidor e
-- idempotencia de los movimientos de caja.
--
-- ESTADO PREVIO VERIFICADO EN PRODUCCIÓN (fbwkclpgnsxuqycazumj):
--   · `configuracion` tiene diferencia_caja_critica y descuento_vendedor_max_pct,
--     pero NINGÚN umbral para egresos/ajustes grandes: un cajero podía retirar
--     cualquier importe mientras hubiera fondo en el cajón.
--   · `cash_movements` NO tiene clave idempotente: un doble clic, un reintento
--     del navegador o un doble POST duplicaba el retiro/gasto, y la tabla es
--     append-only (no hay UPDATE/DELETE), así que el duplicado sólo se puede
--     "corregir" con una reversión manual del administrador.
--   · `public.registrar_movimiento_caja(uuid,text,numeric,text)` existe con UNA
--     sola firma (verificado con pg_get_function_identity_arguments).
--
-- LO QUE NO SE HACE AQUÍ, A PROPÓSITO:
--   · No se construye un segundo motor de autorizaciones. Se reutiliza
--     `autorizaciones_operativas` con su flujo existente
--     (solicitar_autorizacion → resolver_autorizacion → private.consumir_autorizacion),
--     exactamente igual que hace hoy el cierre diario:
--         tipo='otro', recurso_tipo='movimiento_caja', recurso_id=<cash_session_id>
--     Ni la tabla, ni su CHECK de `tipo`, ni solicitar/resolver se modifican.
--
-- SOBRECARGAS (lección de P0.2): `create or replace function` con una lista de
-- parámetros distinta NO reemplaza, CREA UNA SOBRECARGA, y con dos sobrecargas
-- PostgREST no sabe a cuál llamar. Por eso las dos funciones cuya firma cambia
-- se DROPEAN por su firma exacta antes de recrearse, y
-- scripts/verify-caja-autorizacion.mjs comprueba que después queda exactamente
-- una entrada en pg_proc para cada una.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1 · Umbral configurable (singleton `configuracion`, igual que el resto de
--     umbrales del sistema). Por encima de este importe, un egreso o un ajuste
--     exige una autorización aprobada. Default S/ 200: el administrador lo sube
--     o lo baja desde Configuración. 0 = todo egreso requiere autorización.
-- ----------------------------------------------------------------------------
alter table public.configuracion
  add column if not exists caja_egreso_max_sin_autorizacion numeric(14,2) not null default 200;

-- El CHECK se añade aparte porque `add column if not exists` no lo aplicaría
-- si la columna ya existiese.
alter table public.configuracion drop constraint if exists configuracion_caja_umbral_check;
alter table public.configuracion
  add constraint configuracion_caja_umbral_check
  check (caja_egreso_max_sin_autorizacion >= 0);

comment on column public.configuracion.caja_egreso_max_sin_autorizacion is
  'Importe máximo (S/) de un egreso o ajuste de caja que se puede registrar sin autorización aprobada. Por encima, registrar_movimiento_caja exige una autorizacion_operativa aprobada y la consume.';

-- ----------------------------------------------------------------------------
-- 2 · Idempotencia y trazabilidad del movimiento de caja.
--     · client_transaction_id: lo genera el cliente ANTES de enviar. El doble
--       clic reenvía el MISMO id y el servidor devuelve el movimiento que ya
--       existe en vez de duplicarlo. Mismo patrón que `sales`.
--     · autorizacion_id: deja escrito qué autorización respaldó el movimiento.
--       El índice único es la segunda línea de defensa contra el doble consumo:
--       aunque el motor de autorizaciones fallara, una autorización no puede
--       respaldar dos movimientos.
-- ----------------------------------------------------------------------------
alter table public.cash_movements
  add column if not exists client_transaction_id uuid;

alter table public.cash_movements
  add column if not exists autorizacion_id uuid references public.autorizaciones_operativas(id);

create unique index if not exists cash_movements_client_transaction_id_key
  on public.cash_movements(client_transaction_id)
  where client_transaction_id is not null;

create unique index if not exists cash_movements_autorizacion_id_key
  on public.cash_movements(autorizacion_id)
  where autorizacion_id is not null;

-- La tabla sigue siendo append-only también para las columnas nuevas.
revoke update, delete on public.cash_movements from authenticated, anon;

-- ----------------------------------------------------------------------------
-- 3 · private.insertar_movimiento_caja: MISMO cuerpo que la versión vigente
--     (20260906210423, incluida la excepción deliberada de 'venta_efectivo'
--     contra caja cerrada) más dos parámetros al final, ambos con default, para
--     que los siete llamadores existentes —registrar_venta, anular_venta,
--     confirmar_reembolso_devolucion, registrar_pago_proveedor,
--     reversar_movimiento_caja…— sigan resolviendo con sus 5 o 7 argumentos
--     posicionales sin tocarlos.
--     DROP explícito de la firma exacta anterior: si sólo se hiciera CREATE OR
--     REPLACE quedarían DOS funciones y las llamadas de 5 argumentos serían
--     ambiguas (42725).
-- ----------------------------------------------------------------------------
drop function if exists private.insertar_movimiento_caja(uuid, text, numeric, text, uuid, text, uuid, uuid);

create function private.insertar_movimiento_caja(
  p_cash_session_id uuid,
  p_tipo text,
  p_monto_firmado numeric,
  p_motivo text,
  p_staff_id uuid,
  p_referencia_tipo text default null,
  p_referencia_id uuid default null,
  p_reversa_de uuid default null,
  p_client_transaction_id uuid default null,
  p_autorizacion_id uuid default null
)
returns public.cash_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sesion public.cash_sessions;
  v_mov public.cash_movements;
begin
  select * into v_sesion from public.cash_sessions where id = p_cash_session_id for update;
  if v_sesion.id is null then
    raise exception 'La caja indicada no existe' using errcode = 'P0001';
  end if;
  -- Excepción deliberada: una venta en efectivo que ocurrió mientras la caja
  -- estaba abierta (su fecha ya fue validada contra esa ventana) puede
  -- sincronizar después de que el cajero cerró, sin perderse.
  if v_sesion.cierre is not null and p_tipo <> 'venta_efectivo' then
    raise exception 'No se pueden registrar movimientos en una caja ya cerrada' using errcode = 'P0001';
  end if;

  insert into public.cash_movements (cash_session_id, tipo, monto, motivo, referencia_tipo, referencia_id, staff_id, reversa_de, client_transaction_id, autorizacion_id)
  values (p_cash_session_id, p_tipo, p_monto_firmado, nullif(btrim(coalesce(p_motivo, '')), ''), p_referencia_tipo, p_referencia_id, p_staff_id, p_reversa_de, p_client_transaction_id, p_autorizacion_id)
  returning * into v_mov;

  return v_mov;
end;
$$;

revoke all on function private.insertar_movimiento_caja(uuid, text, numeric, text, uuid, text, uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4 · public.registrar_movimiento_caja
--
--     ACTOR: sale exclusivamente de auth.uid(). No hay —ni puede haber— un
--     parámetro de cajero: el cliente no tiene forma de decir "esto lo registró
--     otro". Si no hay sesión autenticada (service_role, psql directo, cron) la
--     función se niega en seco en vez de registrar un movimiento sin dueño.
--
--     SUCURSAL: se compara la sucursal de la caja contra la del actor leída del
--     servidor (public.staff), nunca contra nada que venga en la llamada.
--
--     IDEMPOTENCIA: se comprueba dos veces. La primera es la vía rápida. La
--     segunda es DESPUÉS de tomar el lock de la caja, que es lo que serializa
--     el doble POST simultáneo: cuando el segundo obtiene el lock ya ve el
--     movimiento que el primero acaba de confirmar y lo devuelve tal cual, sin
--     insertar nada y —crítico— sin quemar una segunda autorización.
--
--     UMBRAL: se aplica a los egresos (monto firmado negativo: retiro, gasto,
--     depósito a banco) y a TODO ajuste, en cualquier signo, porque un ajuste
--     positivo grande es exactamente el mecanismo con el que se tapa un
--     faltante. Los ingresos de efectivo no consumen autorización.
--
--     Se dropea la firma exacta de 4 argumentos: dejar las dos versiones haría
--     ambigua la llamada desde PostgREST y, peor, dejaría viva una puerta sin
--     umbral ni idempotencia.
-- ----------------------------------------------------------------------------
drop function if exists public.registrar_movimiento_caja(uuid, text, numeric, text);

create function public.registrar_movimiento_caja(
  p_cash_session_id uuid,
  p_tipo text,
  p_monto numeric,
  p_motivo text,
  p_client_transaction_id uuid default null,
  p_autorizacion_id uuid default null
)
returns public.cash_movements
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_staff public.staff;
  v_sesion public.cash_sessions;
  v_es_elevado boolean;
  v_signo numeric;
  v_monto_firmado numeric;
  v_monto_abs numeric;
  v_saldo_actual numeric;
  v_umbral numeric;
  v_requiere_auth boolean;
  v_auth public.autorizaciones_operativas;
  v_auth_monto numeric;
  v_auth_usada uuid;
  v_previo public.cash_movements;
begin
  -- El actor NO es un parámetro. Sin sesión autenticada no se registra nada.
  if auth.uid() is null then
    raise exception 'Un movimiento de caja sólo lo puede registrar un usuario autenticado' using errcode = 'P0001';
  end if;

  select * into v_staff from public.staff where user_id = auth.uid() and activo = true limit 1;
  if v_staff.id is null then
    raise exception 'Personal no válido o inactivo' using errcode = 'P0001';
  end if;

  -- C1 · compatibilidad hacia atrás. El frontend desplegado antes de P1 llama
  -- con 4 argumentos nombrados y no conoce la clave. Como el POS funciona
  -- offline, un bundle viejo en caché puede seguir haciéndolo durante días
  -- después del deploy: exigir la clave rompería Caja en esas terminales.
  -- Sin clave se genera una en el servidor y se pierde SÓLO la protección
  -- contra doble clic (el comportamiento previo a P1). El umbral, la
  -- autorización obligatoria, el actor y la sucursal se validan más abajo
  -- exactamente igual con o sin clave: omitirla nunca salta un control.
  if p_client_transaction_id is null then
    p_client_transaction_id := gen_random_uuid();
  end if;

  -- Idempotencia, vía rápida: reintento de algo ya registrado.
  select * into v_previo from public.cash_movements where client_transaction_id = p_client_transaction_id;
  if v_previo.id is not null then
    if v_previo.staff_id is distinct from v_staff.id or v_previo.cash_session_id is distinct from p_cash_session_id then
      raise exception 'Ese identificador de transacción ya se usó en otro movimiento de caja' using errcode = 'P0001';
    end if;
    -- Un reintento legítimo repite el contenido. Si la misma clave llega con otro
    -- tipo, importe o motivo es OTRA operación: devolver el movimiento anterior
    -- dejaría la nueva sin registrar mientras el cliente recibe éxito, una
    -- pérdida silenciosa en el libro. El importe se compara CON SIGNO (un ajuste
    -- de +20 y otro de -20 no son el mismo) y el motivo sin espacios de borde.
    -- La autorización NO se compara: tras consumirse deja de estar aprobada, y el
    -- reintento de un éxito cuya respuesta se perdió la manda nula con razón.
    if v_previo.tipo is distinct from p_tipo
       or v_previo.monto is distinct from (case
            when p_tipo = 'ajuste' then round(p_monto, 2)
            when p_tipo in ('ingreso', 'retiro_banco') then round(abs(p_monto), 2)
            else -round(abs(p_monto), 2) end)
       or btrim(coalesce(v_previo.motivo, '')) is distinct from btrim(coalesce(p_motivo, '')) then
      raise exception 'Ese identificador de transacción ya se usó con un contenido distinto. Genera una clave nueva para un movimiento distinto.' using errcode = 'P0001';
    end if;
    return v_previo;
  end if;

  v_es_elevado := v_staff.rol = 'administrador' or coalesce(v_staff.puesto, '') in ('encargado', 'jefa');

  if p_tipo not in ('ingreso', 'retiro', 'deposito_banco', 'retiro_banco', 'gasto', 'ajuste') then
    raise exception 'Tipo de movimiento inválido' using errcode = 'P0001';
  end if;

  if p_tipo in ('deposito_banco', 'retiro_banco', 'gasto', 'ajuste') and not v_es_elevado then
    raise exception 'Solo administración, encargado o jefa pueden registrar este tipo de movimiento' using errcode = 'P0001';
  end if;

  if nullif(btrim(coalesce(p_motivo, '')), '') is null then
    raise exception 'Debes indicar un motivo para el movimiento de caja' using errcode = 'P0001';
  end if;

  select * into v_sesion from public.cash_sessions where id = p_cash_session_id for update;
  if v_sesion.id is null or v_sesion.cierre is not null then
    raise exception 'La caja indicada no está abierta' using errcode = 'P0001';
  end if;

  -- Idempotencia, comprobación serializada: ya tenemos el lock de la caja, así
  -- que un doble POST simultáneo ve aquí lo que confirmó el primero.
  select * into v_previo from public.cash_movements where client_transaction_id = p_client_transaction_id;
  if v_previo.id is not null then
    if v_previo.staff_id is distinct from v_staff.id or v_previo.cash_session_id is distinct from p_cash_session_id then
      raise exception 'Ese identificador de transacción ya se usó en otro movimiento de caja' using errcode = 'P0001';
    end if;
    -- Un reintento legítimo repite el contenido. Si la misma clave llega con otro
    -- tipo, importe o motivo es OTRA operación: devolver el movimiento anterior
    -- dejaría la nueva sin registrar mientras el cliente recibe éxito, una
    -- pérdida silenciosa en el libro. El importe se compara CON SIGNO (un ajuste
    -- de +20 y otro de -20 no son el mismo) y el motivo sin espacios de borde.
    -- La autorización NO se compara: tras consumirse deja de estar aprobada, y el
    -- reintento de un éxito cuya respuesta se perdió la manda nula con razón.
    if v_previo.tipo is distinct from p_tipo
       or v_previo.monto is distinct from (case
            when p_tipo = 'ajuste' then round(p_monto, 2)
            when p_tipo in ('ingreso', 'retiro_banco') then round(abs(p_monto), 2)
            else -round(abs(p_monto), 2) end)
       or btrim(coalesce(v_previo.motivo, '')) is distinct from btrim(coalesce(p_motivo, '')) then
      raise exception 'Ese identificador de transacción ya se usó con un contenido distinto. Genera una clave nueva para un movimiento distinto.' using errcode = 'P0001';
    end if;
    return v_previo;
  end if;

  -- Sucursal: la del actor según el servidor, contra la de la caja.
  if not v_staff.rol = 'administrador' then
    if v_sesion.location_id is distinct from v_staff.location_id then
      raise exception 'La caja no pertenece a tu sucursal' using errcode = 'P0001';
    end if;
    if p_tipo in ('ingreso', 'retiro') and v_sesion.cajero_id is distinct from v_staff.id then
      raise exception 'Solo puedes registrar ingresos/retiros en tu propia caja' using errcode = 'P0001';
    end if;
  end if;

  if p_tipo = 'ajuste' then
    if coalesce(p_monto, 0) = 0 then
      raise exception 'El monto del ajuste no puede ser cero' using errcode = 'P0001';
    end if;
    v_monto_firmado := round(p_monto, 2);
  else
    if coalesce(p_monto, 0) <= 0 then
      raise exception 'El monto debe ser mayor a cero' using errcode = 'P0001';
    end if;
    v_signo := case when p_tipo in ('ingreso', 'retiro_banco') then 1 else -1 end;
    v_monto_firmado := round(p_monto, 2) * v_signo;
  end if;
  v_monto_abs := round(abs(v_monto_firmado), 2);

  -- --- Umbral y autorización -------------------------------------------------
  select caja_egreso_max_sin_autorizacion into v_umbral from public.configuracion where id = 1;
  v_umbral := coalesce(v_umbral, 0);

  v_requiere_auth := (v_monto_firmado < 0 or p_tipo = 'ajuste') and v_monto_abs > v_umbral;

  if v_requiere_auth then
    if p_autorizacion_id is null then
      raise exception 'Este movimiento de S/ % supera el umbral de S/ % permitido sin autorización. Solicita autorización a un administrador y vuelve a intentarlo.', v_monto_abs, v_umbral using errcode = 'P0001';
    end if;

    select * into v_auth from public.autorizaciones_operativas where id = p_autorizacion_id for update;
    if v_auth.id is null then
      raise exception 'La autorización indicada no existe' using errcode = 'P0001';
    end if;
    if v_auth.location_id is distinct from v_sesion.location_id then
      raise exception 'La autorización pertenece a otra sucursal' using errcode = 'P0001';
    end if;
    if coalesce(v_auth.payload->>'tipo', '') is distinct from p_tipo then
      raise exception 'La autorización aprobada es para otro tipo de movimiento de caja' using errcode = 'P0001';
    end if;
    -- El payload lo escribe el cliente al solicitar, así que se exige un número
    -- JSON de verdad: cualquier otra cosa es una autorización que no dice
    -- cuánto se aprobó y no sirve para autorizar nada.
    v_auth_monto := case when jsonb_typeof(v_auth.payload->'monto') = 'number'
                         then round((v_auth.payload->>'monto')::numeric, 2) end;
    if v_auth_monto is null or v_auth_monto <= 0 then
      raise exception 'La autorización no indica el monto aprobado' using errcode = 'P0001';
    end if;
    if v_monto_abs > v_auth_monto then
      raise exception 'El movimiento de S/ % supera el monto autorizado de S/ %', v_monto_abs, v_auth_monto using errcode = 'P0001';
    end if;

    -- Motor existente. Comprueba en la MISMA transacción, con la fila ya
    -- bloqueada, que la autorización esté 'aprobada', sea del tipo pedido, la
    -- haya solicitado ESTE actor y apunte a ESTA caja; y la marca 'consumida'.
    -- Devuelve false —y aquí se aborta— si ya se usó.
    if not private.consumir_autorizacion(p_autorizacion_id, 'otro', v_staff.id, 'movimiento_caja', v_sesion.id::text) then
      raise exception 'La autorización no está aprobada, no es tuya, no corresponde a esta caja o ya fue usada' using errcode = 'P0001';
    end if;
    v_auth_usada := p_autorizacion_id;
  end if;
  -- Si el movimiento NO requiere autorización, una autorización que venga en la
  -- llamada se ignora: no se consume ni se vincula.

  if v_monto_firmado < 0 then
    select coalesce(v_sesion.monto_inicial, 0) + coalesce(sum(monto), 0) into v_saldo_actual
    from public.cash_movements where cash_session_id = v_sesion.id;

    if v_saldo_actual + v_monto_firmado < 0 then
      raise exception 'Fondo insuficiente en caja. Disponible: S/ %, intentaste retirar: S/ %', round(v_saldo_actual, 2), v_monto_abs using errcode = 'P0001';
    end if;
  end if;

  return private.insertar_movimiento_caja(
    v_sesion.id, p_tipo, v_monto_firmado, p_motivo, v_staff.id,
    null, null, null, p_client_transaction_id, v_auth_usada
  );
end;
$$;

revoke all on function public.registrar_movimiento_caja(uuid, text, numeric, text, uuid, uuid) from public, anon;
grant execute on function public.registrar_movimiento_caja(uuid, text, numeric, text, uuid, uuid) to authenticated;

comment on function public.registrar_movimiento_caja(uuid, text, numeric, text, uuid, uuid) is
  'Registra un movimiento manual de caja. El actor sale de auth.uid(); la sucursal se valida en servidor; p_client_transaction_id hace la operación idempotente; por encima de configuracion.caja_egreso_max_sin_autorizacion exige y consume una autorizacion_operativa aprobada (tipo=otro, recurso_tipo=movimiento_caja, recurso_id=<cash_session_id>).';
