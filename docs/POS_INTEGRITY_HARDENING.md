# Hardening de integridad del POS — LUKATCELL

Documento vivo del hardening de integridad/seguridad transaccional iniciado 2026-09-06.
Cubre lo implementado, decisiones tomadas, y lo que sigue abierto. Se actualiza a medida
que avanzan las fases restantes (P1).

## Estado: P0 (integridad) completo y verificado. P1 (operación) pendiente.

Todas las correcciones de esta fase fueron probadas con `curl` + JWT real contra la base
de datos de producción (Supabase), usando una cuenta de staff temporal (`qa_temp_hard@lukatcell.test`,
staff id `a37c8004-c57e-4eb0-bf71-e1e174415be3`) — no solo introspección SQL — para
ejercer `auth.uid()`/RLS/triggers tal como los vería un cajero real. Todos los datos de
prueba (productos, variantes, seriales, ventas, cajas, movimientos) se crearon y
eliminaron explícitamente después de cada verificación.

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
