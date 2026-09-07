# Hardening de integridad del POS — LUKATCELL

Documento vivo del hardening de integridad/seguridad transaccional iniciado 2026-09-06.
Cubre lo implementado, decisiones tomadas, y lo que sigue abierto. Se actualiza a medida
que avanzan las fases restantes (P1).

## Estado: P0 CERRADO (pase P0.1 de corrección de regresiones incluido). P1 pendiente.

La sección **"P0.1 — Corrección de regresiones y cierre real del hardening"** (más abajo)
documenta una segunda pasada realizada después de que la primera ronda de P0 (secciones
1-10 de este documento) se declarara completa: una auditoría independiente encontró que
varias de esas correcciones no estaban conectadas end-to-end con el frontend, o tenían
bugs de lógica que las hacían inoperantes en la práctica (ver detalle sección P0.1,
bloques 1-10). Ese hallazgo es la razón de que el estado ya no diga simplemente "P0
completo" sin calificación: la sección P0.1 es la que sostiene esa afirmación con
evidencia verificada bloque por bloque, no la primera pasada por sí sola.

Todas las correcciones de ambas pasadas fueron probadas con `curl` + JWT real contra la
base de datos de producción (Supabase) — no solo introspección SQL — para ejercer
`auth.uid()`/RLS/triggers tal como los vería un cajero real. Todos los datos de prueba
(productos, variantes, seriales, ventas, cajas, movimientos) se crearon con nombres
identificables (`QA-INTEGRITY-*`) y se limpiaron o desactivaron explícitamente después de
cada verificación (ver "Residuos de prueba conocidos" en la sección P0.1 para el detalle
de qué no puede borrarse por diseño y por qué).

---

## 1. Fecha real de ventas / negocio en hora de Lima (Fase 1-2)

**Problema:** no existía forma de distinguir cuándo ocurrió realmente una venta offline
de cuándo se sincronizó, y no había un campo de "día operativo" en hora de Perú.

**Solución** (`20260906130000_business_date_and_registrar_venta_hardening.sql`):
- `sales.business_date` (date, calculado por trigger `calcular_business_date_lima()` desde
  `fecha at time zone 'America/Lima'`, nunca enviado por el cliente).
- `sales.synced_at`, `sales.offline_origin`.
- `registrar_venta` gana `p_occurred_at`, `p_offline_origin`, `p_orden_servicio_id`.
- Guardas: `p_occurred_at` no puede ser futuro (+5 min de tolerancia) ni tener más de 30
  días de antigüedad; si es offline, requiere `client_transaction_id`.
- `validar_contexto_venta_autenticada` exige que `fecha` caiga dentro de la ventana de
  apertura/cierre de la caja indicada (±2 min de tolerancia de reloj) — esto es lo que
  permite sincronizar una venta offline horas después SIN permitir backdating arbitrario.

**Frontend** (`src/lib/offline.ts`, `src/components/ModalPago.tsx`): `registrarVenta()`
ahora acepta `occurredAt`/`offlineOrigin`/`ordenServicioId` y los reenvía; el sync
(`sincronizarVentasPendientes`, `reintentarVentaManual`) pasa `occurredAt: v.createdAt,
offlineOrigin: true`. Antes de este cambio, **ninguna** venta offline enviaba su fecha
real: todas terminaban con `fecha`/`business_date` del momento de sincronizar.

## 2. Cobro de taller atómico (Fase 10-11)

**Problema:** `ModalPago.tsx` hacía `registrar_venta()` y LUEGO un `update` aparte sobre
`ordenes_servicio.venta_id`. Si el segundo paso fallaba (red, doble clic, dos cobros
concurrentes), la venta quedaba creada sin vínculo, o dos ventas competían por la misma
orden.

**Solución:** `registrar_venta` recibe `p_orden_servicio_id`, hace `select ... for update`
de la orden, valida que no tenga ya `venta_id`, y al final del mismo `plpgsql` function
actualiza `ordenes_servicio.venta_id` — todo en una sola transacción con rollback
completo si cualquier paso falla. `ModalPago.tsx` ya no hace el `update` separado.

Offline: `VentaPendiente.ordenServicioId` viaja en el registro encolado y se reenvía al
sincronizar — antes se perdía por completo si el cobro ocurría sin conexión.

## 3. Descuentos con límite y autorización server-side (Fase 3)

**Problema:** el límite de descuento por vendedor y la validación de autorización sólo
existían en el frontend (`Venta.tsx`); un cliente HTTP directo podía enviar cualquier
descuento a `registrar_venta`.

**Solución** (`validar_linea_venta_catalogo`, trigger BEFORE INSERT/UPDATE en `sale_items`):
recalcula el límite permitido server-side (`configuracion.descuento_vendedor_max_pct`),
evalúa promociones aplicables (`promociones`/`promocion_items`, replicando las fórmulas de
`resolver_promociones_carrito` por tipo), y si el descuento excede lo permitido exige una
`autorizaciones_operativas` real (aprobada, no consumida, del mismo cajero/variante). El
vínculo autorización↔línea se hace en un trigger **AFTER INSERT** separado
(`vincular_autorizacion_descuento`) porque intentarlo en el BEFORE INSERT viola la FK (la
fila de `sale_items` no existe físicamente todavía en ese punto).

## 4. Libro de movimientos de caja — `cash_movements` (Fase 4-5, 15, 17)

**Problema:** no existía ningún mecanismo para registrar ingresos, retiros,
depósito/retiro de banco, gastos, ni pago a proveedor en efectivo desde caja. El cálculo
de diferencia (`calcular_diferencia_caja`) leía `payments`/`devoluciones` directamente, sin
libro de por medio.

**Solución** (`20260906140000_cash_movements_ledger.sql`):
- Tabla `cash_movements` append-only (sin políticas UPDATE/DELETE — ni para admin).
  Tipos: `venta_efectivo, devolucion_efectivo, ingreso, retiro, deposito_banco,
  retiro_banco, gasto, pago_proveedor, ajuste`. `monto` siempre firmado.
- `registrar_movimiento_caja`: ingreso/retiro para el propio cajero sobre su caja
  abierta; gasto/depósito/retiro de banco/ajuste requieren admin/encargado/jefa. Valida
  que el retiro no deje el saldo negativo.
- `reversar_movimiento_caja` (admin): única forma de "corregir" un movimiento manual —
  inserta el opuesto, nunca edita el original.
- `registrar_venta`, `confirmar_reembolso_devolucion` y `registrar_pago_proveedor` generan
  su movimiento (venta/reembolso/pago a proveedor en efectivo) **dentro de la misma
  transacción** — trazabilidad completa factura/venta/devolución ↔ movimiento de caja.
- `calcular_diferencia_caja` reconstruye `monto_final_esperado` exclusivamente desde
  `monto_inicial + sum(cash_movements)`.
- Backfill idempotente (`not exists` sobre `referencia_tipo/id`) sólo para cajas
  **actualmente abiertas** — ninguna caja cerrada ni su diferencia histórica se toca.
- **UI** (`src/pages/Caja.tsx`): formulario de movimiento manual + lista de movimientos de
  la sesión activa; "esperado ahora" se calcula igual que el servidor.

### 4.1 Caja cerrada con venta offline pendiente (`20260906143000_...sql`)

Bug autoinducido por el punto anterior: `insertar_movimiento_caja` rechazaba **cualquier**
movimiento sobre una caja cerrada, incluida una venta en efectivo que ya había ocurrido
válidamente mientras la caja SÍ estaba abierta y recién sincroniza después del cierre —
`registrar_venta` revertía la transacción completa y la venta se perdía para siempre.
Corregido: la excepción se acota a `p_tipo <> 'venta_efectivo'`; `validar_contexto_caja`
se relaja para permitir que **sólo** `monto_final_esperado`/`diferencia` cambien en una
caja cerrada (apertura, cierre, montos contados e identidad siguen inmutables); nuevo
trigger `recalcular_caja_tras_movimiento` recalcula y marca `recalculado_tras_cierre` para
que quede visible que ese cierre ya no representa el arqueo original. `Caja.tsx` bloquea
el botón "Cerrar caja" mientras el dispositivo tenga ventas propias sin sincronizar.

## 5. `ajustar_stock` (Fase 6)

Ya no clampa a 0 un retiro mayor al disponible (antes: `greatest(0, cantidad+delta)`,
dejando el movimiento registrado con un delta que no cuadraba con el resultado). Ahora
rechaza explícitamente. Prohíbe el ajuste genérico sobre productos `control_serial=true`
(deben moverse por el flujo de seriales).

## 6. Bug sistémico de permisos: `puesto IS NULL` (hallazgo de auditoría)

`v_staff.puesto in ('encargado','jefa')` con `puesto IS NULL` evalúa a `NULL` (no
`false`) en SQL de tres valores; `not(false or null)` también da `NULL`, que PL/pgSQL
trata como "no lanzar la excepción". Cualquier staff sin puesto asignado se saltaba el
control por puesto. Corregido con `coalesce(puesto,'')` en **12 funciones**:
`ajustar_stock`, `actualizar_orden_servicio_tecnica` (×2 instancias), `agregar_repuesto_orden`,
`cerrar_inventario_fisico`, `despachar_transferencia_stock`, `iniciar_inventario_fisico`,
`recibir_orden_compra`, `recibir_transferencia_stock`, `registrar_conteo_fisico`,
`registrar_foto_orden`, `registrar_seriales`, `retirar_repuesto_orden`.

## 7. Conteo físico concurrente (Fase 12)

`cerrar_inventario_fisico` hacía `cantidad = excluded.cantidad` (sobrescritura absoluta
con el valor contado al iniciar el conteo). Cualquier venta/compra/transferencia del mismo
SKU ocurrida entre apertura y cierre del conteo se borraba en silencio. `diferencia`
(columna generada = `cantidad_contada - cantidad_sistema`, no editable por el cliente) ya
es el ajuste correcto independiente de lo que pasó mientras tanto — ahora se aplica como
**delta relativo** sobre el `inventory.cantidad` actual al cerrar (snapshot + movimientos
posteriores). Si el resultado sería negativo, se deja en 0 (nunca negativo) con nota
explícita en el motivo, sin bloquear el cierre del resto de líneas. Diferencia en un
producto serializado sigue bloqueando el cierre (reconciliar por IMEI, no numéricamente).

## 8. IMEI/serie por transacción — reservas (Fase 8)

**Hallazgo de auditoría (no reportado por el usuario):** la pantalla de venta real
(`Venta.tsx`/`ModalPago.tsx`) **nunca** usaba `control_serial`, `product_serials`,
`reservar_seriales_carrito` ni `registrar_venta_serializada`. La única forma de vender un
producto serializado era entrar primero a `/seriales` (página de administración de
inventario, sin relación visible con el carrito) y reservar ahí manualmente la cantidad
exacta — un cajero normal no lo habría descubierto, y el checkout fallaba con un error
genérico de backend.

Además, las reservas se guardaban solo por `staff_id + variant_id`: si el mismo cajero
tenía dos carritos en curso con el mismo producto (dos pestañas), reservar en uno borraba
en silencio la reserva del otro.

**Solución:**
- `serial_reservations.client_transaction_id`: reservar/liberar ahora reemplazan sólo las
  reservas de ESE carrito, no todas las del cajero para esa variante.
- `reservar_seriales_carrito` purga reservas vencidas antes de reservar; el
  `unique_violation` de `serial_id` ya reservado se traduce a un mensaje claro.
- `asignar_seriales_venta` (trigger que consume la reserva al vender) exige también que
  coincida el `client_transaction_id` de la venta.
- `control_serial` ahora se expone en `variantes_actualizadas_desde`,
  `variantes_por_categoria`, `buscar_por_barcode`, `obtener_favoritos`, `buscar_variantes`
  y en `mapVarianteRow` (offline.ts).
- **Frontend:** nuevo componente `SelectorSeriales.tsx` — al agregar un producto
  serializado al carrito se abre un selector (usa la RPC ya existente
  `seriales_disponibles`) y reserva la elección con el `cartTransactionId` del carrito
  (generado una vez por carrito en `Venta.tsx`, persistido junto al carrito recuperable,
  y reutilizado como `client_transaction_id` final de la venta). Las líneas serializadas
  muestran "Editar IMEI" en vez del contador +/-. Quitar la línea libera la reserva.

  Verificado en navegador real (Playwright): buscar el producto, elegir su IMEI, ver
  "Editar IMEI" en el carrito, cobrar en efectivo, y confirmar en base de datos que
  exactamente el serial elegido queda `vendido` (el otro permanece `disponible`).

## 9. IMEI y offline (Fase 9 — opción A, la más segura)

Sin conexión no se puede abrir el selector de IMEI (`agregarAlCarrito` lo bloquea con un
mensaje explícito). Si la conexión se cae a mitad de un cobro con un producto serializado
en el carrito, `ModalPago.tsx` **nunca** lo encola sin conexión — no hay forma segura de
garantizar que ese IMEI siga disponible cuando sincronice horas después; se le pide al
cajero recuperar la conexión.

## 10. Devoluciones y anulaciones con IMEI (Fase 10-11)

**Problema:** tanto `ejecutar_devolucion` como `ejecutar_anulacion_venta` reponían stock
sumando la cantidad directo a `inventory`, sin mirar `product_serials`/`sale_item_serials`
en absoluto — el IMEI real quedaba `vendido` para siempre mientras el conteo agregado
subía igual (stock e IMEI permanentemente desincronizados).

**Devolución** (`20260906153000_devolucion_con_imei.sql`): exige el/los IMEI exactos
devueltos, valida contra `sale_item_serials` que pertenezcan a esa línea, y los deja en un
nuevo estado `cuarentena` (no vendibles) — **no** asume devuelto=disponible.
`inventory.cantidad` no sube hasta que `resolver_cuarentena_serial` (admin/encargado/jefa)
decide `disponible` (ahí sí entra a inventory), `servicio` o `baja`.

**Anulación:** los IMEI vuelven directo a `disponible` (a diferencia de una devolución de
cliente, el equipo nunca salió de la tienda). Se bloquea anular una venta que ya tiene una
devolución completada (evitaba duplicar la reposición). Un pago en efectivo genera su
reversión en `cash_movements` — antes la caja seguía "esperando" un dinero que ya no
correspondía a ninguna venta vigente.

**Frontend** (`Devoluciones.tsx`): para líneas serializadas, checkboxes de IMEI exacto en
vez de sólo una cantidad numérica.

---

## Migraciones creadas (en orden)

1. `20260906130000_business_date_and_registrar_venta_hardening.sql`
2. `20260906131500_fix_vinculo_autorizacion_descuento.sql`
3. `20260906133000_fix_ajustar_stock.sql`
4. `20260906134500_fix_null_puesto_bypass.sql`
5. `20260906140000_cash_movements_ledger.sql`
6. `20260906143000_cierre_caja_con_ventas_offline_pendientes.sql`
7. `20260906150000_reservas_imei_por_transaccion.sql`
8. `20260906150500_control_serial_en_buscar_variantes.sql`
9. `20260906153000_devolucion_con_imei.sql`
10. `20260906154500_cierre_conteo_fisico_no_pisa_concurrencia.sql`

## Tablas/columnas nuevas

- `cash_movements` (nueva tabla, append-only).
- `sales`: `business_date`, `synced_at`, `offline_origin`.
- `sale_items`: `descuento_origen`, `autorizacion_id`, `promocion_id`.
- `autorizaciones_operativas`: `sale_item_id`.
- `cash_sessions`: `recalculado_tras_cierre`.
- `serial_reservations`: `client_transaction_id`.
- `product_serials.estado`: nuevo valor permitido `cuarentena`.

## RPC/triggers nuevos o reescritos (backend)

Nuevos: `registrar_movimiento_caja`, `reversar_movimiento_caja`, `resolver_cuarentena_serial`,
`private.insertar_movimiento_caja`, `private.recalcular_caja_tras_movimiento`,
`private.vincular_autorizacion_descuento`.

Reescritos (preservando su lógica previa + el fix): `registrar_venta`,
`validar_linea_venta_catalogo`, `validar_contexto_venta_autenticada`, `ajustar_stock`,
`calcular_diferencia_caja`, `validar_contexto_caja`, `confirmar_reembolso_devolucion`,
`registrar_pago_proveedor`, `private.ejecutar_devolucion`, `private.ejecutar_anulacion_venta`,
`cerrar_inventario_fisico`, `private.asignar_seriales_venta`, `reservar_seriales_carrito`,
`liberar_seriales_carrito`, `variantes_actualizadas_desde`, `variantes_por_categoria`,
`buscar_por_barcode`, `obtener_favoritos`, `buscar_variantes`, y las 11 funciones del
punto 6 (bug de `puesto`).

## Archivos frontend modificados/creados

- `src/lib/offline.ts` — `registrarVenta()` con `occurredAt`/`offlineOrigin`/
  `ordenServicioId`; `mapVarianteRow` con `control_serial`; `CarritoActivo` con
  `cartTransactionId`.
- `src/components/ModalPago.tsx` — usa `p_orden_servicio_id` atómico; acepta
  `cartTransactionId`; bloquea encolar offline un carrito con IMEI.
- `src/pages/Venta.tsx` — `cartTransactionId` persistente por carrito; selector de IMEI en
  el flujo de agregar al carrito; UI "Editar IMEI"; bloqueo de cobro offline con IMEI.
- `src/components/SelectorSeriales.tsx` — nuevo.
- `src/pages/Devoluciones.tsx` — selector de IMEI por checkbox en devoluciones.
- `src/pages/Seriales.tsx` — sección "Unidades en cuarentena" (admin/encargado/jefa)
  para resolver con `resolver_cuarentena_serial`.
- `src/pages/Caja.tsx` — formulario de movimientos de caja, lista de movimientos, bloqueo
  de cierre con ventas offline pendientes, marca de recálculo tardío.
- `src/types/index.ts` — `CashMovement`/`CashMovementTipo`, `CashSession.recalculado_tras_cierre`.

## Pruebas ejecutadas

- `npm run build` (tsc -b && vite build) — sin errores, después de cada cambio.
- `npm run lint` (oxlint) — 0 errores en todas las pasadas; sólo warnings preexistentes
  (`exhaustive-deps`, mismo patrón en decenas de archivos no tocados).
- `npm test` (suite completa de scripts `verify-*.mjs`) — sin regresiones en ninguna pasada.
- Pruebas en vivo con `curl` + JWT real (cuenta QA temporal) para cada corrección: ver
  detalle en cada sección arriba. Todas exitosas.
- Prueba en navegador real (Playwright contra `npm run dev`) del flujo completo de venta
  con selección de IMEI: agregar producto → seleccionar serial → ver "Editar IMEI" en el
  carrito → cobrar en efectivo → ticket emitido → serial correcto marcado `vendido` en BD.

## Problemas conocidos que quedan abiertos (P1 — no implementados en esta pasada)

- **Transferencias parciales** (Fase 13): `despachar_transferencia_stock`/
  `recibir_transferencia_stock` siguen siendo todo-o-nada; falta registrar cantidad
  recibida vs. enviada, faltante/sobrante/dañado por línea (y por IMEI en serializados).
- **Idempotencia de recepción de compras** (Fase 14): `recibir_orden_compra` no tiene un
  identificador tipo `client_transaction_id` — un doble envío del mismo POST podría
  duplicar la recepción. No incidencias de faltante/sobrante/producto equivocado.
- **Umbral + autorización obligatoria para gastos/ajustes de caja grandes**: hoy
  `registrar_movimiento_caja` sólo exige puesto elevado (admin/encargado/jefa), sin
  integrarse con el motor de autorizaciones (`autorizaciones_operativas`) por monto. Sería
  natural extenderlo reutilizando ese mismo motor, no uno paralelo.
- **Arqueo por denominaciones** (Fase 5, opcional): no implementado — el cierre de caja
  sigue siendo un solo monto contado, no desglose de billetes/monedas.
- **Conciliación de pagos mejorada** (Fase 18): duplicidad de referencia entre proveedores,
  terminal, hora — no auditado en esta pasada (Culqi sigue auto-conciliando como antes).
- **Cierre diario con clasificación P0/P1/warning** (Fase 20): no implementado.
- **Centro de incidencias en Estado del Sistema** (Fase 21): no implementado — las nuevas
  categorías de incidencia (caja recalculada tras cierre, seriales en cuarentena sin
  resolver, ventas offline agotando reintentos) no tienen un panel central todavía; hoy
  sólo son visibles entrando a cada pantalla.
- **Reportes con business_date** (Fase 22): no auditado si los reportes existentes ya usan
  `business_date`/`occurred_at` correctamente o siguen usando `fecha`/`created_at` crudos.
- **Permisos centralizados** (Fase 24): no se creó una capa conceptual de capacidades
  (`sale.create`, `cash.open`, etc.); los checks siguen siendo por `rol`/`puesto` inline,
  ahora corregidos pero no reorganizados.
- **Hardware/reimpresión** (Fase 23): no verificado en esta pasada — el código existente
  (`ReciboVenta.tsx`, bridge de impresión) no fue tocado ni auditado; se asume que sigue
  funcionando según lo documentado en trabajo previo del proyecto.

## Riesgos de despliegue

- Las funciones que ganaron parámetros nuevos (`registrar_venta`, `registrar_pago_proveedor`,
  `reservar_seriales_carrito`, `liberar_seriales_carrito`) tuvieron su firma anterior
  eliminada explícitamente (`drop function`) para evitar que PostgREST quede con dos
  sobrecargas ambiguas — si algún cliente externo (fuera de este repo) llama a estas RPC
  directamente con la firma vieja, dejará de funcionar. Dentro de este repo ya se
  actualizaron todos los call sites conocidos.
- El nuevo estado `cuarentena` en `product_serials` requiere que el personal (admin/
  encargado/jefa) revise activamente `/seriales` tras cada devolución de un producto
  serializado — si nadie lo hace, esas unidades quedan indefinidamente fuera de stock
  vendible (no es un bug, pero si sale sin capacitar al equipo se puede leer como "el
  stock bajó solo").
- El backfill de `cash_movements` sólo corrió sobre cajas abiertas al momento de aplicar
  la migración; cualquier caja que ya estaba cerrada antes de esa migración conserva su
  `diferencia` histórica calculada con el método viejo (no se tocó a propósito).

## Qué debe validar el usuario en producción

- Abrir/cerrar una caja real con ventas mixtas (efectivo + otros métodos) y confirmar que
  "esperado" coincide con lo esperado manualmente.
- Vender un producto con IMEI real desde la pantalla de venta (no desde `/seriales`) y
  confirmar que el ticket y la base de datos coinciden en el serial vendido.
- Probar una devolución de un producto con IMEI y confirmar que el encargado ve la unidad
  en la sección "Unidades en cuarentena" de `/seriales` y puede resolverla (disponible/
  servicio/baja) desde ahí.
- Revisar que el equipo de caja entienda el nuevo flujo de ingreso/retiro/gasto en
  `Caja.tsx` antes de depender de él para el arqueo diario.

---

# P0.1 — Corrección de regresiones y cierre real del hardening

Fecha: 2026-09-06/07. Ejecutado tras una auditoría independiente que encontró que varias
de las correcciones de la sección P0 (arriba) no estaban realmente conectadas end-to-end,
o tenían bugs de lógica que las neutralizaban en la práctica. Cada bloque se verificó con
`curl` + JWT real contra producción (proyecto `fbwkclpgnsxuqycazumj`), usando una cuenta
de staff temporal (`qa_p01@lukatcell.test`, staff id `5b7694df-be37-4e0f-bb7f-d33cb13a470f`,
promovida temporalmente a `rol='administrador'` para poder escribir catálogo/inventario
directo por REST donde la RPC no bastaba — ver "Residuos de prueba conocidos" sobre su
estado final).

## Bloque 1 — Conteo físico concurrente (matemáticamente incorrecto)

**Problema confirmado:** `cerrar_inventario_fisico` aplicaba
`diferencia = cantidad_contada - cantidad_sistema_snapshot` como delta sobre el stock
actual. Ejemplo real: snapshot al abrir = 10, venta concurrente de -2 antes de contar
(stock real = 8), conteo físico = 9 unidades. El sistema calculaba
`diferencia = 9 - 10 = -1` y aplicaba `8 - 1 = 7` — un resultado matemáticamente
incorrecto: si al contar físicamente había 9 unidades cuando el sistema esperaba 8 en ese
instante, la diferencia real es **+1**, no -1.

**Causa raíz:** la fórmula comparaba lo contado contra el snapshot del momento de
*apertura* del conteo, ignorando los movimientos ocurridos entre la apertura y el
instante real en que esa línea se contó.

**Solución** (`20260906224923_conteo_fisico_expectativa_por_instante.sql`):
- `inventario_fisico_items.counted_at timestamptz`, seteado por `registrar_conteo_fisico`
  en cada conteo.
- `cerrar_inventario_fisico` reconstruye, por línea, el stock esperado en el instante en
  que se contó: `esperado_al_contar = cantidad_sistema + sum(inventory_movements entre
  fecha_inicio del conteo y counted_at)`. La diferencia real es
  `cantidad_contada - esperado_al_contar`, aplicada como delta sobre `inventory.cantidad`
  actual (no sobre el snapshot).
- Verificado end-to-end contra los 4 casos exactos planteados: snapshot 10 sin
  movimientos → final 9; snapshot 10, venta -2 antes de contar, conteo 9 → diferencia
  real +1 (coherente, no el -1 anterior); snapshot 10, conteo 10, venta -2 después →
  final 8; snap(10, venta -2, conteo 8, compra +5 después) → final 13. Reproducido
  también en `scripts/verify-integrity-invariants.mjs` (Escenario 5, ver Bloque 10).
- Un resultado negativo se clampa a 0 con nota explícita en el motivo, sin bloquear el
  cierre de las demás líneas. Diferencia en un producto serializado sigue bloqueando el
  cierre para reconciliar por IMEI, nunca ajustando la cantidad agregada a ciegas.

## Bloque 2 — `ajustar_stock`: sucursal ajena y actor falso

**Problema confirmado:** `v_location := coalesce(p_location_id, v_staff.location_id)` y
`coalesce(p_staff_id, v_staff.id)` permitían que un no-admin enviara **cualquier**
`p_location_id`/`p_staff_id` explícito — la función solo caía al valor por defecto cuando
el cliente omitía el parámetro, pero nunca rechazaba uno enviado sin autorización. Un
cajero podía ajustar stock de una sucursal que no era la suya, o atribuir el ajuste a
otro empleado.

**Solución** (`20260906231547_ajustar_stock_sucursal_y_actor_real.sql`):
- `p_staff_id` se elimina del parámetro público — el actor sale siempre de
  `auth.uid() → staff.id`, sin excepción, sin firma alternativa que lo acepte.
- `p_location_id` para un no-admin debe ser la sucursal propia del staff o una donde
  tenga `staff_locations.puede_inventario=true` (reutiliza el primitivo multi-sucursal
  existente, no uno nuevo); admin no tiene esa restricción.
- Firma anterior (`ajustar_stock(uuid,uuid,int,text,uuid)`) eliminada explícitamente con
  `drop function` para que PostgREST no quede con dos sobrecargas ambiguas.
- Verificado: rechazo de stock negativo (curl real, integrado también en
  `verify-integrity-invariants.mjs`); el escenario "sucursal ajena para un no-admin"
  específicamente requiere una segunda identidad no-admin real — verificado manualmente
  con dos cuentas de staff durante el hardening (un admin bypasea la restricción por
  diseño, así que no se automatiza con una sola cuenta QA admin).

## Bloque 3 — Descuentos, promociones y autorizaciones no llegaban end-to-end

**Problema confirmado:** el backend esperaba `promocion_id`/`autorizacion_id` por línea
en `sale_items`, pero el frontend solo enviaba `variant_id, cantidad, precio_unitario,
descuento, subtotal` — nunca el origen del descuento. Además, un bug independiente en
`validar_linea_venta_catalogo` comprobaba `estado='aprobada' AND consumed_at IS NOT NULL`
para una autorización, pero `private.consumir_autorizacion` marca `estado='consumida'` al
consumirla — esa combinación de estados **nunca ocurre simultáneamente**, así que
absolutamente ninguna autorización de descuento podía usarse en una venta real,
independientemente de qué enviara el frontend.

**Solución** (`20260906232219_descuentos_autorizacion_end_to_end.sql` +
`src/types/index.ts`, `src/pages/Venta.tsx`, `src/lib/offline.ts`):
- `validar_linea_venta_catalogo` corregido a `estado='consumida'` (el bug real que
  anulaba el flujo completo).
- `consumir_autorizacion_descuento` cambia de `boolean` a
  `jsonb {autorizada, autorizacion_id}` — el backend identifica sin ambigüedad qué
  autorización se consumió, en vez de que el frontend tuviera que inventar o adivinar un
  ID.
- `CartItem` gana `promocionId?`, `autorizacionId?`, `descuentoOrigen?:
  'manual'|'promocion'|'autorizacion'|'ninguno'` — sin usar `any`.
- `Venta.tsx`: `applyDisc` captura el jsonb de consumo; el remapeo de carrito en
  `prepararCobro` captura `promocion_id` de `resolver_promociones_carrito` por línea.
- `offline.ts`: `registrarVenta()` envía `promocion_id`/`autorizacion_id` reales por
  línea a `registrar_venta`, no solo el monto ya calculado.
- El backend sigue siendo la fuente de verdad: valida que la autorización pertenezca al
  cajero autenticado, misma variante, mismo % de descuento, estado `consumida`, no
  reutilizada por otra línea — el cliente nunca puede inventar un `autorizacion_id` y que
  el servidor lo acepte sin validar.

## Bloque 4 — Pago a proveedor en efectivo sin caja

**Problema confirmado:** `registrar_pago_proveedor` exige `p_cash_session_id` cuando
`p_metodo='efectivo'` (hardening previo), pero `CuentasPorPagar.tsx` nunca lo enviaba —
todo pago en efectivo a proveedor fallaba en producción.

**Solución** (`20260906233406_pago_proveedor_valida_sucursal_caja.sql` +
`CuentasPorPagar.tsx`):
- UI: selector de caja (solo sesiones abiertas) cuando el método es efectivo, con la
  fila de la factura ampliada con `location_id`; el submit se bloquea sin selección; si
  el método no es efectivo, se envía `null` explícito.
- Backend: `registrar_pago_proveedor` ahora valida además que
  `caja.location_id = factura.location_id` — una caja de otra sucursal se rechaza aunque
  esté abierta y sea del mismo cajero.
- El `cash_movement` del pago se sigue generando dentro de la misma transacción
  (rollback atómico si algo falla).

## Bloque 5 — Fecha comercial UTC en vez de America/Lima

**Problema confirmado:** `sales.business_date` (backend) ya calculaba correctamente en
hora de Lima, pero múltiples pantallas de negocio seguían usando
`new Date().toISOString().slice(0, 10)` (UTC) para filtros/valores por defecto — el "día"
cambia ~19:00 hora Perú en vez de medianoche local.

**Solución:** `src/lib/businessDate.ts` (nuevo) —
`getBusinessDateLima()`/`formatBusinessDateLima()`/`addDaysBusinessDateLima()`/
`startOfBusinessDayLima()`, usando `Intl.DateTimeFormat('en-CA', {timeZone:
'America/Lima'})` (Perú no tiene horario de verano, UTC-5 fijo). Reemplazado en
`CambiosTurno.tsx`, `ReportesAvanzados.tsx`, `MisSolicitudes.tsx`, `PermisosPersonal.tsx`,
`DashboardAdmin.tsx`, `ConciliacionPagos.tsx`, `CierreDiario.tsx`, `Reportes.tsx` (este
último tenía además un bug de medianoche-local separado, corregido con
`startOfBusinessDayLima()`). **No** se tocaron timestamps técnicos (`created_at`,
`updated_at`, `synced_at`) — solo conceptos de día operativo/comercial.
`scripts/verify-security.mjs` verifica estáticamente que ninguno de estos 8 archivos
contenga el patrón UTC crudo.

## Bloque 6 — Reserva manual de IMEI en `/seriales` incompatible con la arquitectura real

**Problema confirmado:** la reserva de IMEI correcta se ancla a
`client_transaction_id` del carrito (hardening previo), pero `/seriales` seguía
ofreciendo "Reservar venta" sin ningún carrito real detrás — un flujo huérfano que
prometía un comportamiento que ya no existía.

**Solución** (`Seriales.tsx` + `20260906235008_seriales_disponibles_excluye_
reservados.sql`):
- Eliminados `reservar()`, el botón "Reservar venta", el banner de reserva y el import
  no usado; `/seriales` queda dedicada a alta, consulta, cuarentena, servicio, baja y
  trazabilidad — la única forma de reservar para una venta es `SelectorSeriales.tsx`
  dentro del carrito real.
- `seriales_disponibles` gana `p_client_transaction_id` opcional y excluye seriales con
  una reserva viva de OTRO carrito — ya no depende únicamente de que el INSERT falle
  después con un IMEI ya tomado; `SelectorSeriales.tsx` lo envía siempre.

## Bloque 7 — IGV no validado server-side

**Problema confirmado:** `registrar_venta` validaba aritmética de subtotal/total/pagos,
pero confiaba en el `p_impuesto` enviado por el cliente sin compararlo contra la
configuración real del negocio.

**Solución** (`20260906235627_validar_igv_server_side.sql`): `validar_totales_venta_
diferido` recalcula el impuesto esperado desde `configuracion.igv_activo`/
`igv_porcentaje` (fuente de verdad única) y lo compara contra lo enviado, preservando la
semántica de precios existente (IGV incluido vs. separado) — un cliente que envía
impuesto 0, un valor falso, o un total manipulado, es rechazado server-side.

## Bloque 8 — Reconciliación del historial de migraciones local ↔ Supabase

**Hallazgo confirmado:** las migraciones de hardening se aplicaron primero vía MCP
(quedando en el historial de Supabase con el timestamp real de aplicación) y se
escribieron localmente después con un timestamp "de borrador" distinto — `supabase
migration list` mostraba versiones que no correspondían 1:1 con los nombres de archivo en
GitHub.

**Resolución:** cada archivo local de la tanda de hardening (P0 original + los 7 nuevos
de este pase P0.1) fue renombrado (`git mv`, contenido sin tocar) para que su timestamp
coincida EXACTAMENTE con la versión real registrada en `supabase_migrations.schema_
migrations`. Tabla de equivalencia para la tanda de hardening (Fase P0 + P0.1):

| Archivo GitHub (actual) | Versión Supabase | Estado |
|---|---|---|
| `20260906200849_business_date_and_registrar_venta_hardening.sql` | `20260906200849` | ✅ coincide |
| `20260906202322_fix_vinculo_autorizacion_descuento.sql` | `20260906202322` | ✅ coincide |
| `20260906202647_fix_ajustar_stock.sql` | `20260906202647` | ✅ coincide |
| `20260906203818_fix_null_puesto_bypass.sql` | `20260906203818` | ✅ coincide |
| `20260906205005_cash_movements_ledger.sql` | `20260906205005` | ✅ coincide |
| `20260906210423_cierre_caja_con_ventas_offline_pendientes.sql` | `20260906210423` | ✅ coincide |
| `20260906211444_reservas_imei_por_transaccion.sql` | `20260906211444` | ✅ coincide |
| `20260906212529_control_serial_en_buscar_variantes.sql` | `20260906212529` | ✅ coincide |
| `20260906214129_devolucion_anulacion_con_imei.sql` | `20260906214129` | ✅ coincide |
| `20260906215004_cierre_conteo_fisico_no_pisa_concurrencia.sql` | `20260906215004` | ✅ coincide |
| `20260906224923_conteo_fisico_expectativa_por_instante.sql` | `20260906224923` | ✅ coincide |
| `20260906231547_ajustar_stock_sucursal_y_actor_real.sql` | `20260906231547` | ✅ coincide |
| `20260906232219_descuentos_autorizacion_end_to_end.sql` | `20260906232219` | ✅ coincide |
| `20260906233406_pago_proveedor_valida_sucursal_caja.sql` | `20260906233406` | ✅ coincide |
| `20260906235008_seriales_disponibles_excluye_reservados.sql` | `20260906235008` | ✅ coincide |
| `20260906235627_validar_igv_server_side.sql` | `20260906235627` | ✅ coincide |
| `20260907000702_revoca_registrar_venta_serializada_obsoleta.sql` | `20260907000702` | ✅ coincide |

**Residual, fuera de alcance de esta pasada:** ~16 migraciones **anteriores** al 2026-09-06
(rango 2026-08-19 a 2026-08-23, previas a todo este esfuerzo de hardening P0/P0.1) tienen
el mismo tipo de desfase de timestamp entre el nombre de archivo en GitHub y la versión
registrada en Supabase. No se tocaron en esta pasada: no forman parte de las migraciones
de hardening que el usuario pidió reconciliar explícitamente, y renombrarlas a ciegas sin
verificar el contenido exacto de cada una de las 16 sería precisamente el tipo de "arreglo
riesgoso" que esta fase prohíbe. **Riesgo real:** un `supabase db push` desde un clon
limpio del repo intentaría reaplicar esos ~16 archivos con nombres que no coinciden con
ninguna versión ya registrada, fallando por objetos duplicados. Mitigación actual: no usar
`supabase db push`; seguir aplicando cambios vía migración nueva + MCP como se ha hecho en
toda esta pasada. Queda como ítem P1 recomendado: reconciliarlas con `supabase migration
repair` una por una, verificando antes el contenido exacto de cada archivo contra la
definición real en producción.

## Bloque 9 — Auditoría selectiva de SECURITY DEFINER

Supabase Advisor reporta `authenticated_security_definer_function_executable` en 87
funciones (88 antes de este bloque). Se auditaron puntualmente las que modifican
ventas/caja/stock/compras/proveedores/devoluciones/IMEI/promociones/autorizaciones/
cierres: todas verifican `auth.uid()` → staff activo → rol/puesto/sucursal/ownership antes
de escribir. Ninguna quedó sin protección interna real, **excepto** una:
`registrar_venta_serializada` — código muerto confirmado (Venta.tsx/ModalPago.tsx nunca la
llaman, usan `registrar_venta` + `SelectorSeriales`), y además desactualizada respecto al
hardening de IMEI de este mismo pase (llama a `reservar_seriales_carrito` sin
`client_transaction_id`, reintroduciendo el problema de "dos carritos se pisan un mismo
IMEI" que el Bloque 6 acaba de cerrar). Seguía siendo invocable por cualquier
`authenticated` vía REST. No se eliminó (podría haber integraciones externas
desconocidas) — se revocó `EXECUTE` de `anon`/`authenticated`
(`20260907000702_revoca_registrar_venta_serializada_obsoleta.sql`), el remedio que el
propio advisor recomienda para una función SECURITY DEFINER que no debería ser invocable
por usuarios finales. **No** se convirtió ninguna función a SECURITY INVOKER solo para
silenciar el advisor — el resto de los 87 warnings restantes son legítimos (necesitan
SECURITY DEFINER para escribir atómicamente across tablas que RLS no puede orquestar) y
ya estaban protegidos internamente antes de este pase.

## Bloque 10 — Tests de regresión

- `scripts/verify-security.mjs` (parte de `npm test`): assertions estáticas nuevas para
  los bloques 3, 4, 5 y 6 de este pase (ver arriba) — falla el build si alguien revierte
  la propagación de `promocionId`/`autorizacionId`, el selector de caja de pago a
  proveedor, el uso de `businessDate` en vez de UTC crudo, o si `Seriales.tsx` vuelve a
  llamar `reservar_seriales_carrito` directamente.
- `scripts/verify-integrity-invariants.mjs` (nuevo, `npm run test:integration`, no forma
  parte de `npm test` porque necesita credenciales vivas y escribe/lee contra producción
  real): reproduce con `curl`/`fetch` + JWT real, no mocks, contra el proyecto de
  producción:
  - Venta: idempotencia real por `client_transaction_id` (dos envíos → misma venta).
  - Caja: un retiro que excede el saldo se rechaza (nunca negativa).
  - Stock: `ajustar_stock` rechaza un retiro mayor al disponible.
  - IMEI: dos carritos no pueden reservar el mismo serial; `seriales_disponibles` no
    ofrece a un carrito un serial ya tomado por otro.
  - Conteo físico (Bloque 1, opt-in con `QA_RUN_CONTEO_FISICO=1` — ver más abajo):
    reproduce el Caso B exacto del hardening (snapshot 10, venta -2 concurrente, conteo
    9 → resultado final 9, no el 7 que daba la fórmula anterior).
  - El escenario "`ajustar_stock` rechaza sucursal ajena para un no-admin" (Bloque 2) NO
    se automatizó: requiere una segunda identidad no-admin real, que la cuenta QA (admin,
    necesaria para poder escribir catálogo/inventario directo vía REST donde no hay RPC)
    bypasea por diseño. Queda verificado manualmente (curl con dos cuentas reales durante
    el hardening), documentado aquí como limitación conocida de la suite automatizada, no
    como caso sin probar.
  - `QA_RUN_CONTEO_FISICO`: `iniciar_inventario_fisico` abre un conteo para **toda la
    sucursal** (catálogo real incluido, no solo la variante de prueba) — correrlo en cada
    `npm run test:integration` dejaría una entrada sintética de "conteo físico completo"
    en el historial real de esa sucursal en cada ejecución, y puede chocar con un conteo
    físico real en curso. Por eso el Escenario 5 queda detrás de ese flag explícito;
    verificado manualmente en esta pasada (ver resultado arriba), no en el flujo por
    defecto.

### Residuos de prueba conocidos (por diseño, no un bug)

`sales`, `sale_items`, `payments`, `cash_movements`, `inventory_movements`,
`product_serials`, `serial_reservations`, `inventarios_fisicos`/`inventario_fisico_items`
**no tienen policy de DELETE para ningún rol** (ni siquiera administrador) — son
historiales de auditoría inmutables por diseño, el mismo principio que "`cash_movements`
append-only" del hardening original. Cualquier corrida de
`verify-integrity-invariants.mjs` deja necesariamente algunas filas de prueba ahí (con
nombre `QA-INTEGRITY-*` o atadas al staff QA), imposibles de borrar vía REST por
cualquier rol de aplicación. El script ya no intenta ese DELETE condenado a fallar: los
productos/variantes asociados se **desactivan** (`activo=false`, un UPDATE sí permitido)
para que dejen de aparecer en catálogo/reportes/conteos físicos futuros, y el resto queda
documentado en la salida del script bajo "Residuos ESPERADOS" con los IDs exactos de esa
corrida. Purgarlos definitivamente requiere una conexión de administrador de base de
datos fuera del rol de aplicación — nunca una vía que la propia app o un usuario
`authenticated` puedan alcanzar.

## Archivos modificados en este pase (P0.1)

Backend (migraciones nuevas, en orden — el nombre de archivo YA es la versión real
aplicada, ver Bloque 8):
1. `20260906224923_conteo_fisico_expectativa_por_instante.sql`
2. `20260906231547_ajustar_stock_sucursal_y_actor_real.sql`
3. `20260906232219_descuentos_autorizacion_end_to_end.sql`
4. `20260906233406_pago_proveedor_valida_sucursal_caja.sql`
5. `20260906235008_seriales_disponibles_excluye_reservados.sql`
6. `20260906235627_validar_igv_server_side.sql`
7. `20260907000702_revoca_registrar_venta_serializada_obsoleta.sql`

Frontend:
- `src/types/index.ts` — `DescuentoOrigen`, `CartItem.promocionId/autorizacionId/
  descuentoOrigen`.
- `src/pages/Venta.tsx` — captura de `promocion_id`/autorización consumida por línea.
- `src/lib/offline.ts` — `registrarVenta()` envía `promocion_id`/`autorizacion_id` reales.
- `src/pages/CuentasPorPagar.tsx` — selector de caja para pago a proveedor en efectivo,
  scoping por sucursal de la factura.
- `src/lib/businessDate.ts` (nuevo) — helper central de fecha comercial America/Lima.
- `src/pages/CambiosTurno.tsx`, `ReportesAvanzados.tsx`, `MisSolicitudes.tsx`,
  `PermisosPersonal.tsx`, `DashboardAdmin.tsx`, `ConciliacionPagos.tsx`,
  `CierreDiario.tsx`, `Reportes.tsx` — migrados a `businessDate.ts`.
- `src/pages/Seriales.tsx` — elimina "Reservar venta" y el flujo huérfano asociado.
- `src/components/SelectorSeriales.tsx` — envía `client_transaction_id` a
  `seriales_disponibles`.

Tests:
- `scripts/verify-security.mjs` — assertions estáticas nuevas del pase P0.1.
- `scripts/verify-integrity-invariants.mjs` (nuevo) — suite de integración real.
- `package.json` — `test:integration`.

## Commits de este pase (rama `main`)

`5d5a8a4` (bloque 1) → `40ca7cd` (2) → `8f39b2d` (3) → `60e426c` (4) → `d29490d` (5) →
`24a24a1` (6) → `ecc92b5` (7) → `57216a1` (8) → `8063623` (9) → `901d9af` (10).

## Riesgos residuales tras P0.1

- Las ~16 migraciones pre-P0 (2026-08-19 a 2026-08-23) con desfase de timestamp local vs.
  Supabase quedan sin reconciliar (ver Bloque 8) — evitar `supabase db push` desde un
  clon limpio hasta resolverlas.
- El aviso `auth_leaked_password_protection` del Security Advisor es preexistente, no
  relacionado con este hardening (es una opción de configuración de Supabase Auth, no una
  función/tabla de la aplicación) — no auditado en esta pasada.
- El escenario "`ajustar_stock` rechaza sucursal ajena" (Bloque 2) y el conteo físico
  (Bloque 1, vía `QA_RUN_CONTEO_FISICO=1`) no corren en un `npm test`/`npm run
  test:integration` por defecto — quedan verificados manualmente/opt-in, no en CI
  continuo, por las razones de alcance/seguridad explicadas en cada bloque.
- Este pase no tocó transferencias parciales, idempotencia de recepción de compras,
  centro de incidencias, ni ningún otro ítem ya listado como P1 en la sección P0 original
  — siguen igual de pendientes que antes.

## P1 ahora habilitado para empezar

Con este bloque cerrado, los ítems de P1 listados en la sección P0 original
("Problemas conocidos que quedan abiertos") pueden empezar en cualquier orden — ninguno
de ellos depende de una corrección de este pase P0.1. En particular, transferencias
parciales, conciliación avanzada, centro de incidencias y reportes avanzados (los cuatro
que motivaron detener P1 al inicio de este pase) no chocan con ningún cambio de
descuentos/autorizaciones, stock, conteo físico, caja, IMEI, IGV o fecha comercial hecho
aquí.
