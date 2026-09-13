# CURRENT_EXECUTION — punto de reanudación

> Este archivo manda sobre `STATE.md` y `BACKLOG.md`, que describen el 24 de agosto
> y se contradicen con P0.1–P0.4. Si hay conflicto, gana lo que diga aquí, y por
> encima de todo `main` + producción.

## Estado actual (2026-09-13, release OLA 1–4)

- **Producción:** las 15 migraciones de OLA 1–4 están aplicadas y verificadas (168 registradas;
  paridad producción ↔ repositorio: PASS). Detalle en «Release a producción» al final.
- **Nombres:** en este archivo, `_p1_a_….sql` … `_p2_j_….sql` son los nombres provisionales usados
  antes del release; hoy son `20260913HHMMSS_p1_a_….sql` … (tabla del paso 3).
- **Edge Function `agente-whatsapp`:** código versionado, **no desplegada** (decisión del dueño).

## Base

| Dato | Valor |
|---|---|
| SHA base | `70578db9022380f95941c9da8867b6be931860a6` |
| main == origin/main | sí, árbol limpio |
| Migraciones | 153 locales ↔ 153 producción, huella md5 idéntica |
| Tests locales | 378/378, lint y build en verde |
| Producción Supabase | `fbwkclpgnsxuqycazumj` |
| Terminales POS | 1 operativa, 0 pendientes, 0 fallidas |
| P0.1–P0.4 | cerrados; sus invariantes NO se tocan |

## FASE 0 — reconstrucción del estado (COMPLETA)

### `origin/elite/wave-2`: descartada, nada que cosechar

- Diverge en `bb9078c` (2026-08-24); su último commit es `d971742`, también del 24 de agosto.
- `git diff main origin/elite/wave-2` = **0 archivos añadidos**, 69 borrados, 37 modificados, 14 renombrados.
- Los 13 008 borrados incluyen **las 24 migraciones de P0.1–P0.4**. Fusionarla destruiría P0.
- Las 135 "inserciones" son la versión *anterior* de líneas que main reescribió después
  (verificado en `Layout.tsx`: imports de una sola línea que main reformateó).
- Rutas: 39 en main, 39 en wave-2, **ninguna exclusiva**.

**Conclusión: main la supera estrictamente. No se fusiona ni se cosecha nada.**

### Contradicciones documentales detectadas

1. `BACKLOG.md` declara `P1 POS crítico: DONE`. Falso como cierre de fase: quedan
   pendientes implementables en transferencias, compras, caja y pagos.
2. `BACKLOG.md` declara recepción de compras terminada. En producción **no hay
   ninguna clave idempotente** en `recepciones_compra`.
3. `STATE.md` lista ELITE-04/06/08/09 como "activos" desde el 24 de agosto, sin
   reflejar nada de P0.1–P0.4.
4. `ELITE-04 → Build/deploy final: BLOCKED: Vercel build-rate-limit` es obsoleto:
   Vercel desplegó `70578db` correctamente.

### Gaps reales verificados contra el esquema de producción

| Fase | Estado real | Evidencia |
|---|---|---|
| 13 · Transferencias parciales | **NO IMPLEMENTADO** | `transferencia_stock_items (id, transferencia_id, variant_id, cantidad)` — una sola cantidad; sin enviada/recibida/faltante/sobrante/dañado ni estado por línea. `transferencias_stock` sólo tiene `estado` de cabecera |
| 14 · Recepción de compras | **SIN IDEMPOTENCIA** | `recepciones_compra (id, orden_id, recibido_por, fecha, observacion, created_at, storage_path)` — sin `client_transaction_id`. `recepcion_compra_items (id, recepcion_id, orden_item_id, cantidad, costo_unitario)` — sin faltante/sobrante/dañado/producto equivocado |
| Caja · umbral y autorización | **NO IMPLEMENTADO** | `configuracion` tiene `diferencia_caja_critica` y `descuento_vendedor_max_pct`, pero ningún umbral para egresos/ajustes grandes. `cash_movements` sin clave idempotente |
| 18 · Pagos | **PARCIAL** | `conciliaciones_pago` existe con forma correcta (`fecha_venta`, `estado`, `proveedor`, `referencia_venta`, `referencia_proveedor`). Falta auditar duplicidad de referencia y reembolso de proveedor |
| 21 · Centro de incidencias | **NO EXISTE** | No hay tabla `incidencias`. `notificaciones` no tiene severidad, estado, responsable ni acción |
| 24 · Capacidades | **NO EXISTE** | No hay tabla de capacidades/permisos; los checks son inline por rol/puesto |
| Multi-sucursal | **BASE EXISTENTE** | `staff_locations (staff_id, location_id, puede_vender, puede_inventario, puede_taller)` |

Superficie real: 66 tablas, 153 migraciones, 13 edge functions, 41 pantallas, 39 rutas.

## Ola activa

**OLA 1 — P1 operativo prioritario.** Cuatro squads, propiedad exclusiva de archivos.

| Squad | Alcance | Migración propia | Frontend propio |
|---|---|---|---|
| ELITE-08 | Fase 13 transferencias parciales | `_p1_a_transferencias_parciales.sql` | `src/pages/Transferencias.tsx` |
| ELITE-09 | Fase 14 recepción idempotente | `_p1_b_recepcion_idempotente.sql` | `src/pages/Compras.tsx` |
| ELITE-04 | Caja: umbral + autorización | `_p1_c_caja_umbral_autorizacion.sql` | `src/pages/Caja.tsx` |
| ELITE-06 | Fase 18 pagos y conciliación | `_p1_d_pagos_conciliacion.sql` | `src/pages/ConciliacionPagos.tsx` |

### Archivos bloqueados (no tocar fuera del squad propietario)

- Ningún squad toca `supabase/migrations/2026*.sql` ya aplicadas — son forward-only.
- Ningún squad toca `scripts/verify-security.mjs` sin pasar por el coordinador.
- `src/App.tsx`, `src/components/Layout.tsx` y `package.json` los edita sólo el coordinador.

## Migraciones nuevas

Ninguna aplicada todavía a producción. **153 = 153 sigue siendo el estado.**

## OLA 1 — estado tras el primer límite de sesión (2026-09-12)

Los cuatro squads cayeron a la vez por `rate_limit` (HTTP 429). **Lección de coordinación:
cuatro agentes pesados en paralelo agotan la sesión. Relanzar como máximo dos a la vez.**

### Qué dejaron en disco

| Squad | Migración | Script | Frontend | Suite |
|---|---|---|---|---|
| ELITE-08 | `_p1_a` 747 l. | 782 l. | **no tocado** | 59/59 |
| ELITE-09 | `_p1_b` 800 l. | 1161 l. | **no tocado** | no cargaba (ver abajo) |
| ELITE-04 | `_p1_c` 332 l. | 648 l. | `Caja.tsx` +108 | 24/24 |
| ELITE-06 | `_p1_d` 569 l. | 634 l. | `ConciliacionPagos.tsx` +228 | 38/38 |

Sin colisiones de funciones entre migraciones P1. Ninguna redefine funciones de P0.
Puertos de prueba distintos (54333/54339/54341/54336): las suites corren en paralelo.

### Hallazgos de compatibilidad (el patrón de P0.4 otra vez)

Las suites prueban cada migración aislada, con esquema mínimo, sin cargar a las funciones
de producción que consumen lo que cambian. Por eso dieron verde con roturas reales.

**Regla nueva y obligatoria: este POS funciona offline.** Una terminal con el bundle viejo
en caché puede llamar a las firmas antiguas durante días. La compatibilidad hacia atrás
no es sólo la ventana base→Vercel: es permanente mientras exista un bundle viejo en caché.

| ID | Migración | Estado | Detalle |
|---|---|---|---|
| C1 | `_p1_c` | **ROTO** | `registrar_movimiento_caja` hace `DROP` de la firma de 4 args que llama el frontend en vivo y crea una de 6 con `p_client_transaction_id` **sin default**, y además lanza excepción si llega nulo. Caja falla al migrar. |
| C2 | `_p1_b` | **ROTO** | No borra `recibir_orden_compra(uuid, jsonb, text)`, pero pone `recepciones_compra.client_transaction_id` y `payload_hash` `NOT NULL` sin default. La vieja inserta `(orden_id, recibido_por, observacion)` → not-null violation en la primera recepción. |
| C3 | `_p1_c` | **COMPATIBLE** (por lectura; falta prueba ejecutada) | `insertar_movimiento_caja` 8→10 args: posiciones 1–8 idénticas, 9–10 con default. Las 5 llamadoras (`registrar_venta`, `ejecutar_anulacion_venta`, `confirmar_reembolso_devolucion`, `registrar_pago_proveedor` con 7 posicionales; `reversar_movimiento_caja` con 8) resuelven igual. |
| C4 | `_p1_a` | **COMPATIBLE** | Columnas nuevas `not null default` o nullable. Firmas de `despachar`/`recibir_transferencia_stock` idénticas a producción. `crear_transferencia_stock` sigue insertando. |

### Corrección decidida

- **C1**: `p_client_transaction_id uuid default null`; si llega nulo, el servidor genera la
  clave y sigue (comportamiento actual, sin idempotencia). **El umbral y la autorización se
  exigen siempre, con o sin clave.** Omitir la clave sólo pierde la protección contra doble
  clic propia, nunca salta un control.
- **C2**: la firma vieja de 3 args pasa a ser un envoltorio de compatibilidad con **firma y
  tipo de retorno idénticos** (`recepciones_compra`) que delega en la nueva con una clave
  generada. Queda como deuda P2 retirarla cuando no quede ningún bundle viejo en caché.

### Arnés roto

`verify-recepcion-compras.mjs` línea 263: un comentario SQL con `costo` entre backticks
cerraba la template string de JavaScript. Corregido.

### Progreso de correcciones

| ID | Estado | Nota |
|---|---|---|
| C1 | **DEMOSTRADA** · caja 29/29 | `p_client_transaction_id uuid default null`; si llega nula se genera en servidor. Probado con la forma exacta de PostgREST (4 args nombrados): funciona; sin clave un egreso de 650 **sigue exigiendo autorización**; sin clave otra sucursal **sigue rechazada**; sin clave dos envíos son dos movimientos (coste fijado a propósito). |
| C2 | **APLICADA** · prueba pendiente | Envoltorio `recibir_orden_compra(uuid, jsonb, text default null) → recepciones_compra`, `security definer`, delega en la de 5 args con clave generada y lee `recepcion_id`. B2–B4 reescritas; suite aún sin ejecutar tras el arreglo de `estado()`. |
| C5 | **COMPATIBLE** | `_p1_d`: sin DROP; las 4 funciones existentes conservan identidad y tipo de retorno idénticos a producción; 2 nuevas + helper `private` sin colisión. |
| C3 | **DEMOSTRADA** · caja 29/29 | Llamadas posicionales de 7 args (`registrar_venta` y 3 más) y de 8 args (`reversar_movimiento_caja`) ejecutadas contra la firma nueva tras el DROP+CREATE: insertan bien, guardan `reversa_de`, una sola firma. |

Sin ambigüedad de sobrecarga en recepción: `recibirSQL(3)` usa casts tipados
(`$2::jsonb`), y PostgREST llama con nombres; la firma de 5 exige `p_client_transaction_id`.

### Grants de las tablas que P1 amplía — riesgo R8 descartado

Verificado en producción: las 8 tablas a las que P1 añade columnas (`configuracion`,
`cash_movements`, `conciliaciones_pago`, `transferencias_stock`,
`transferencia_stock_items`, `recepciones_compra`, `recepcion_compra_items`,
`autorizaciones_operativas`) tienen SELECT **de tabla** para `authenticated`, así que
las columnas nuevas nacen visibles. Sólo `products` usa grants por columna, y P1 no le
añade columnas. Todas tienen RLS activa: el riesgo que queda es de filas, no de `42501`.

### Revisión de frontends heredados

- `Caja.tsx` — reutiliza el motor de autorizaciones. Dos hallazgos:
  - **Espejo del umbral incompleto — latente, no alcanzable.** El servidor exige
    autorización para `(monto_firmado < 0 or tipo = 'ajuste') and abs(monto) > umbral`;
    la UI omitía `ajuste` y comparaba sin valor absoluto. Pero el selector no ofrece
    `ajuste`, así que hoy ningún usuario llega al callejón. Corregido igualmente.
  - **Ciclo de vida de la clave — alcanzable.** Se renovaba sólo tras un éxito. Tras un
    éxito con respuesta perdida, cambiar el monto reenviaba una clave consumida con
    contenido distinto. Corregido: una clave por intención (se renueva al cambiar tipo,
    monto o motivo). **Corrección:** aquí se afirmó también que "al fallar se recargan los
    movimientos"; **era falso**, esa parte nunca se aplicó (la edición terminaba en
    `solicitarAutorizacion`). Lo detectó el E2E de navegador (hallazgo CAJA-RECARGA: 0 lecturas
    de `cash_movements` tras un error). Ahora sí se aplica, junto con una guarda síncrona
    `useRef` contra dos envíos en la misma tarea de JS (hallazgo CAJA-GUARDA).
  - **Servidor — bug P1 real en `_p1_c`, el peor de los dos casos posibles.** Con clave
    repetida, `registrar_movimiento_caja` sólo comprobaba actor y caja y devolvía el
    movimiento viejo **sin comparar tipo, importe ni motivo**. La misma clave con otro
    importe se tomaba por reintento: el movimiento nuevo **no se registraba** y el cliente
    recibía éxito. Pérdida silenciosa en el libro de caja, justo lo que ELITE-09 sí
    protegía en recepción con un hash de contenido. La suite de caja no lo cubría (sólo
    probaba mismo contenido y otra caja). Corregido en los dos puntos de idempotencia:
    tipo, importe **con signo** y motivo deben coincidir, o se rechaza. La autorización
    no se compara a propósito (tras consumirse, un reintento legítimo la manda nula).
    Añadidas 3 pruebas: otro monto, otro tipo/motivo, ajuste con signo invertido.

### Autocomprobación de `_p1_b` reescrita al diseño C2

Exige exactamente 2 versiones de `recibir_orden_compra`, la firma idempotente exacta, y
que la de 3 args sea el envoltorio que delega (`prosrc` llama a `recibir_orden_compra(` y
no contiene `insert into`). Se mantienen las comprobaciones de `anon`, índice único y
recepciones sin clave.

### UI de Transferencias (ELITE-08 relanzado) — GO en UI, NO-GO en backend `_p1_a`

UI terminada en `Transferencias.tsx`: detalle por línea (enviada/recibida/dañada/faltante/
sobrante/pendiente), recepción por IMEI unidad a unidad, clave por intención ligada al
contenido, bloqueo de doble clic y recarga tras error. Build y lint en verde. E2E de
navegador: **no disponible** (sin Playwright, Cypress ni Puppeteer instalados).

Defectos de backend que encontró en `_p1_a` (no los tocó, por ownership):

| # | Severidad | Defecto |
|---|---|---|
| T1 | **P0 · permiso cruzado** | Fallo abierto con sucursal nula: `t.destino_id <> v_loc` con `v_loc` NULL da NULL y el `IF` no salta → un operativo sin sucursal despacha o recibe cualquier transferencia (líneas 294/303, 471/484). Hoy 0 operativos activos sin sucursal, pero las columnas admiten NULL. |
| T2 | P1 · pérdida silenciosa | Misma clave con otro contenido devuelve el detalle como si se hubiera aplicado (líneas 499–508). **Mismo patrón que el bug de caja**, en otro squad. |
| T3 | P2 · funcional | IMEI marcados "no llegó" siguen contando como pendientes: la transferencia queda en `recibida_parcial` aunque todas las unidades estén identificadas. |
| T4 | P2 · residual previo | `crear_transferencia_stock` (fuera de P1) no tiene clave: un doble envío puede crear dos borradores. Mitigado en UI; un borrador no mueve stock hasta despacharse. |
| T5 | decisión de negocio | Sobrante sin IMEI entra al stock del destino sin contrapartida en origen. Aceptable sólo si queda marcado como diferencia; pendiente de verificar y de confirmar con el dueño. |
| T6 | menor | `es_cierre` en false al cerrarse sola; el detalle no trae nombre de producto ni `imei2`. |

**Lección de coordinación:** T2 repite en `_p1_a` el bug de caja; T1 es una clase de fallo
de permisos. Ninguna de las dos se corrige en un solo sitio: se cazan en **todas** las
migraciones P1.

### Resultado de la caza — el patrón T1 está en TRES migraciones, no en una

| Migración | Línea | Comparación insegura | Alcance si la sucursal es NULL |
|---|---|---|---|
| `_p1_a` | 303 | `t.origen_id <> v_loc` | despachar cualquier transferencia |
| `_p1_a` | 484 | `t.destino_id <> v_loc` | recibir cualquier transferencia |
| `_p1_b` | 480 | `v_orden.location_id <> v_staff.location_id` | recibir cualquier orden de compra |
| `_p1_d` | 235 | `c.location_id <> v_loc` | conciliar pagos de cualquier sucursal |

Sólo `_p1_c` está limpia: ELITE-04 usó `is distinct from` de forma sistemática (12 veces).
Tres de cuatro squads, trabajando por separado, escribieron el mismo fallo abierto.
Corrección: fallo cerrado, tras comprobar en producción que ningún usuario activo
legítimo depende hoy de tener la sucursal nula.

### Validación local #2

- Caja: **32/32** (incluye las 3 pruebas de misma clave con contenido distinto).
- Recepción: la migración **ya aplica** (B1 pasa) y **86/88** en verde. Los `ERROR` del log
  del servidor son los rechazos esperados de las pruebas negativas. Los 2 fallos:
  - **F3** · dos recepciones distintas y simultáneas: bloqueo real observado, la segunda se
    rechaza con "Orden no recepcionable (estado recibida)", `recibida=6 stock=6`, sin
    sobre-recepción. El comportamiento parece correcto: sospecha de expectativa mal
    especificada en la prueba. Por confirmar leyendo el test.
  - **H6** · sin identidad no se puede recibir: falla con `invalid input syntax for type
    json`, un error de cast en la llamada, antes de entrar a la función. Sospecha de arnés.

### T1 aplicada — fallo cerrado en los 4 sitios

Dato de producción que lo hace seguro: **0 personas activas con `location_id` nulo**. 4 de 5
tienen `active_location_id` nulo, pero `private.auth_location_id()` cae a `location_id`, así
que nadie activo obtiene una sucursal nula. Aplicado en `_p1_a:303`, `_p1_b:480`, `_p1_d:235`;
`_p1_a:484` va junto con T2 por ser contigua. Faltan pruebas de "operativo sin sucursal".

Inconsistencia anotada para la Ola 2 (multi-sucursal): `_p1_b` compara contra
`staff.location_id`, mientras `_p1_a` y `_p1_d` usan `auth_location_id()` (sucursal activa).
Un usuario multi-sucursal podría recibir transferencias en su sucursal activa pero compras
sólo en la de origen. No se cambia ahora para no alterar permisos fuera del alcance de T1.

### T2, T3, T5 — decisiones

- **T2** · el hash de la recepción de transferencias debe ser de **la petición tal como
  llegó**, no de las líneas que el servidor deriva: con `p_items` nulo ("recibir todo") el
  servidor calcula lo pendiente desde el estado actual, y el reintento de un "recibir todo"
  ya aplicado vería otra cosa pendiente y se rechazaría por error.
- **T3** · rebajado a **P2 y aplazado**. La transferencia sí puede cerrarse explícitamente
  con "cerrar con faltantes": es un hueco de automatización, no de integridad, y tocarlo
  implica cinco fórmulas de pendiente.
- **T5** · marcado, no silencioso: `cantidad_sobrante` derivado, línea `con_diferencia` y
  `tiene_diferencias` activo. Queda como decisión de negocio para el dueño.

### F3 y H6 — ambos del arnés, por motivos distintos

- **F3 · expectativa demasiado estrecha.** Exigía que saltara la guarda de sobrante, pero con
  dos recepciones de 6 sobre una orden de 6 la primera la completa y salta antes la guarda
  de estado. Ambas impiden sobre-recibir; el resultado es idéntico. Se reescribe con 4+4: la
  primera deja la orden `parcial` y la segunda TIENE que releer bajo el lock para ver que
  supera lo pedido. Prueba más fuerte que la original.
- **H6 · bug del stub `uid()` del arnés.** Hacía `current_setting(...)::jsonb` antes del
  `nullif`; tras un `set_config` local previo el GUC queda en `''` y el cast revienta. El
  `auth.uid()` real de Supabase aplica `nullif` antes del cast. **Corregido.**

### T2 en `_p1_a` — progreso

`cerrar_transferencia_stock` no inserta nada propio: delega en `recibir_transferencia_parcial`
con ítems vacíos y `cerrar = true`, así que el hash en esa función cubre ambos caminos.
**Aplicado el cuerpo** (junto con T1 en la línea 484): hash calculado tras comprobar
identidad y permiso; comparación en el camino de transferencia cerrada y en el `on conflict`.
**Aplicada también la segunda mitad:** columna `payload_hash not null` en
`transferencia_recepciones` (tabla nueva, sin relleno) y helper
`private.hash_transferencia_recepcion` (líneas ordenadas por `item_id`, seriales por
`serial_id`, valores por omisión normalizados; `p_items` NULL con marca propia distinta de
`'[]'`). Revocado sólo de `public`: el arnés de transferencias no crea el rol `anon`, y
`anon`/`authenticated` no tienen USAGE sobre `private`.

### Pruebas añadidas en esta ronda (sin ejecutar aún)

- Transferencias **T0**: operativo con puesto válido y sin sucursal no despacha ni recibe,
  y no mueve stock en ningún lado.
- Pagos **T9g**: admin sin sucursal no concilia; estado y referencia intactos. La guarda
  de sucursal precede a las de estado, así que debe rechazar aunque el pago ya estuviera
  conciliado.
- Recepción **F3** reescrita con 4+4.
- Pendiente: prueba de "sin sucursal" en recepción de compras (mismo archivo que F3).

### Validación local #3

```
Transferencias 58/58 · Recepción 87/88 · Caja 32/32 · Pagos 39/39
Assertions 378/378 · Lint PASS · Build PASS
```

- **Pagos T9g pasa**: el fallo cerrado en conciliación queda demostrado.
- **Recepción F3** falló por un error MÍO al editar la prueba: cambié el payload a 4+4 pero
  dejé la aserción esperando `recibida=6 stock=6`. El comportamiento es el buscado: el
  servidor responde "Llegaron 4 unidades y sólo quedaban 2 pendientes… reenvía con
  `acepta_sobrante = true`", es decir, la segunda recepción releyó bajo el lock lo ya
  recibido (6−4 = 2), con bloqueo real y `recibida=4 stock=4`. Aserción corregida, y se
  añade detrás la prueba T1 de "administrador sin sucursal no recibe".
- **Caza de la clase T2 cerrada** en las 4 migraciones: `_p1_a` y `_p1_c` corregidas, `_p1_b`
  ya comparaba hash, `_p1_d` sin el patrón (sus `on conflict do nothing` sólo crean la fila
  de conciliación; un pago ya conciliado sólo acepta un reintento idéntico y con otro
  importe o referencia se rechaza explícitamente).
- Transferencias no probaba "misma clave, contenido distinto": añadida **T0b**, incluido el
  reintento de "recibir todo", el caso que obligó a hashear la petición y no lo derivado.
- El total de transferencias (58) no es comparable con el 59 de la validación #1: aquel
  número salía de un regex mío que ya demostró no ser fiable. **Confirmado en el log:** T0
  son 4 comprobaciones y las 4 aparecen como `ok`.

### T2 encontrada también en pagos — y la lección de método

`registrar_confirmacion_proveedor_admin` (líneas 36–38 de la función): si ya existe una
conciliación con la misma referencia de proveedor **y el mismo pago**, hace
`return v_existente` **sin comparar el importe**. La misma referencia con otro importe se
toma por un reenvío del webhook: el importe nuevo se pierde y el llamador recibe éxito.
**P1 · dinero.** Prueba T9h escrita (reenvío idéntico idempotente; otro importe rechazado,
fila intacta). Corrección pendiente de aplicar.

**Mi caza anterior no la vio** porque buscaba nombres concretos (`return v_previo`,
`on conflict`) y esta función usa `return v_existente`. Una caza de clase tiene que buscar el
**comportamiento** —"encuentro algo por clave y lo devuelvo"—, no una variable. Se repite con
ese criterio en las cuatro migraciones.

**Caza por comportamiento completa.** Cada `return` de un registro existente clasificado:
todos comparan contenido o no reciben contenido (el despacho de `_p1_a` sólo recibe el id),
salvo la línea 531 de `_p1_d`. **Corregida:** mismo importe (±0,005) es reenvío; otro importe
se rechaza con "contenido distinto". Pendiente ejecutar T9h.

### Validación local #4

```
Transferencias 63/63 (con T0b) · Recepción 90/90 (F3 + T1 + T1b)
```

Con recepción en verde, el contrato de `recibir_orden_compra` de 5 argumentos queda
**validado**: se lanza el squad de UI de Compras (único agente activo).

### Alcance aclarado

- **Arqueo por denominaciones:** `POS_INTEGRITY_HARDENING.md:317` lo registra como
  "Fase 5, opcional: no implementado". No es requisito vigente → **no se construye**.
- **E2E de navegador:** Playwright no está en el proyecto, pero hay binarios de Chromium en
  caché (`~/Library/Caches/ms-playwright/chromium-1243`) y Chrome/Edge instalados. Camino
  viable sin descargar navegadores: `playwright-core` en el entorno aislado (mismo patrón que
  `embedded-postgres`). **Límite honesto:** no hay Supabase local, así que el backend iría
  simulado interceptando la red. Eso prueba la lógica de la UI contra el bundle real (ciclo
  de vida de la clave, doble clic, reintentos, errores), y se etiquetará como "E2E de
  navegador con backend simulado", nunca como E2E completo. El backend ya lo cubren las
  suites de PostgreSQL real.

### Gate que falta — ensayo COMPUESTO de las migraciones

Cada suite aplica **sólo su** migración sobre un esquema mínimo. Nadie ha aplicado las cuatro
juntas, en orden, sobre el esquema real. Es la lección de P0.4 a otra escala: lo que se
valida por separado puede romperse al componerse. Obligatorio antes de producción.

### Fase 18 — huecos reales (evaluación preliminar)

- `payments (id, sale_id, metodo, monto, referencia)`: sin terminal ni proveedor.
- `confirmar_reembolso_devolucion` es el reembolso **al cliente** en una devolución, no el
  reembolso **del proveedor** de pago. No se encontró ninguna función de reembolso a proveedor.
- POS externo: no hay adaptador. Culqi: hay `auto_conciliar_pagos_digitales_admin` y edge
  functions. Las integraciones con credenciales se dejan con adaptador y dobles locales, y la
  activación se clasifica como bloqueo externo.
- La venta sólo captura, por línea de pago no efectivo, un "código de operación (opcional)"
  en `payments.referencia` (`ModalPago.tsx`). **No se registra el terminal.**
- **Contradicción de nombre vs contenido:**
  `20260824145525_payment_reconciliation_and_provider_refunds.sql` promete reembolsos a
  proveedor en el nombre, pero sólo crea `conciliaciones_pago` y tres funciones. **Los
  reembolsos a proveedor nunca se implementaron.**

### Validación local #5

```
Pagos 41/41 (T9g fallo cerrado · T9h reenvío idéntico idempotente, otro importe rechazado)
```

Las cuatro suites P1 en verde con todas las correcciones de la ola:
**transferencias 63/63 · recepción 90/90 · caja 32/32 · pagos 41/41.**
El gate estático (assertions, lint, build) se corrió antes de las últimas ediciones de
migraciones: **no está vigente hasta repetirlo**.

### Agentes activos

| Squad | Alcance | Archivos propios |
|---|---|---|
| ELITE-09 UI | Recepción de compras | `src/pages/Compras.tsx` |
| E2E | Navegador con backend Supabase simulado | `.p1-e2e/`, `scripts/verify-e2e-ui.mjs` |

### Pendiente de coordinación

- `.gitignore`: añadir `.p1-e2e/`, versionando sólo su `package.json` y lock, antes del commit.
- **Diseño de Fase 18 — datos reales de producción.** `pagos_digitales` sólo admite
  `pendiente/pagado/expirado/fallido` y métodos `yape/plin` (0 filas). `conciliaciones_pago`
  sólo `pendiente/conciliado/diferencia/rechazado`. `payments`: efectivo 8, yape 1, tarjeta 1.
  **Ningún estado ni tabla representa un reembolso del proveedor.**

  Propuesta, para ejecutar cuando se libere un hueco de squad:
  1. **Terminal** — columna `terminal` en `conciliaciones_pago`, informada al conciliar contra
     el lote del datáfono. **No se toca `registrar_venta` (P0)**: capturar el terminal en la
     venta exigiría reescribirla. Límite documentado: la venta no sabe el terminal; la
     conciliación sí.
  2. **Reembolso a proveedor** — tabla append-only `reembolsos_proveedor` (pago, conciliación,
     devolución de origen opcional, importe, proveedor, referencia del proveedor, estado
     `solicitado/enviado/confirmado/rechazado`, clave idempotente con huella de contenido,
     actor desde `auth.uid()`, sucursal con fallo cerrado). Cada cambio de estado es un evento
     nuevo; nada se borra ni se edita.
  3. **Adaptadores** — POS externo y reembolso Culqi con doble local. Sin credenciales reales la
     activación es **bloqueo externo**; ningún adaptador devuelve un éxito simulado.
  4. Lecciones de la ola aplicadas desde el diseño: `is distinct from` en toda comparación de
     sucursal (T1), clave con huella de contenido (T2), pruebas como `authenticated`,
     compatibilidad con bundles offline.

- **Ensayo compuesto — factible.** `schema_migrations.statements` guarda las sentencias de 151
  de 153 migraciones. Plan: reproducir en PostgreSQL local las 153 desde los **archivos
  locales** con un shim para lo propio de Supabase (roles, `auth`, extensiones); **comparar la
  huella del esquema resultante con la de producción** por categoría (funciones por `prosrc`,
  columnas, constraints, policies, grants de funciones, RLS), que no depende de la versión de
  PostgreSQL; y sólo si coincide aplicar las 4 migraciones P1 encima y ejecutar las suites contra
  el esquema compuesto. Coincidir en versión no garantiza coincidir en esquema: una función
  cambiada a mano desde el panel no deja rastro en los archivos. **Una huella distinta sin
  explicación es deriva de producción y bloquea el deploy.**

### Huella de producción (PostgreSQL 17.6) — referencia del ensayo compuesto

| Categoría | Nº | md5 |
|---|---|---|
| funciones public/private (por `prosrc`) | 167 | `ed988c8a85460e0e956b42c1d1195b55` |
| columnas | 674 | `7aaead311dbd533a1813f40c4e311385` |
| constraints | 321 | `abad724db5ca022d5e7df8de18b8392d` |
| policies | 99 | `9fb4d1d46180af522f48f580d30720f8` |
| grants de funciones (anon/authenticated) | — | `3662a3f9571e5f825c37848cb61e9407` |
| RLS por tabla | 66 | `ee832627414c44e6f075f58aee8b5f6b` |

Extensiones: pg_net 0.20.3, pg_stat_statements, pgcrypto, plpgsql, supabase_vault, uuid-ossp.
Migraciones sin sentencias guardadas: `20260716035000_configuracion_singleton` y
`20260824171500_hide_product_cost_after_ui_migrated`. La segunda gobierna los grants por
columna de `products` (la clase de R8), así que se añade una **huella de privilegios de
columna** al ensayo.

**Local:** PostgreSQL 18.4 embebido con `uuid-ossp`, `pgcrypto`, `pg_stat_statements`;
**sin `pg_net` ni `supabase_vault`**. Consecuencias para el shim:
- `net.http_post` es un doble explícito que registra la llamada y **nunca** hace HTTP; el
  runner informa de que omite `create extension pg_net`.
- PG18 cataloga los NOT NULL en `pg_constraint` (`contype='n'`) y PG17 no: se excluyen de la
  huella de constraints en ambos lados.
- Las extensiones van al esquema `extensions`, como en Supabase: en `public` añadirían
  funciones y falsearían la huella.
- Supabase concede EXECUTE por privilegios por defecto: el shim reproduce `pg_default_acl`,
  o la huella de grants no coincidirá.
- Formas exactas que usan las migraciones: `auth.uid()`, `auth.role()` (comparado con
  `'service_role'` y `'authenticated'`), `auth.jwt()->>'aal'`, `auth.users(id)` (FK y join),
  `auth.mfa_factors(user_id, status)`, `storage.buckets(id, name, public, file_size_limit,
  allowed_mime_types)`, `storage.objects(bucket_id, name)`, publicación `supabase_realtime`,
  rol `service_role`.

### UI de Compras (ELITE-09 relanzado) — GO en UI, NO-GO en backend por B1

Build, lint (0 avisos en `Compras.tsx`) y `verify-security.mjs` 144/144 en verde. Defectos
de backend en `_p1_b`:

| # | Severidad | Defecto |
|---|---|---|
| B1 | **P1 · pérdida silenciosa** | La huella no cubre `p_observacion`, la observación de línea, `imei2`, `acepta_sobrante` ni `p_corrige_recepcion_id`: la misma clave con esos campos cambiados se devuelve como reintento y el cambio se pierde sin error. **Fallo de segundo orden de mi caza T2:** comprobé que se comparaba una huella, no que la huella cubriera todo lo enviado. |
| B2 | P2 | `recepcion_replay` ignora `p_staff_id`: otra persona con la misma clave recibe el resultado ajeno. |
| B3 | P2 · funcional | Una orden recibida no admite correcciones y una corrección sólo puede sumar. |
| B4 | P2 · funcional | Lo faltante deja la orden en `parcial` para siempre; no hay cierre con faltantes (misma clase que T3). |
| B5 | menor | `cantidad_faltante` sin tope; `"2.5"` rompe el cast `::int` de la huella antes del chequeo de permisos. |
| B6 | documental | La cabecera aún dice "exactamente una versión", contradiciendo C2. |
| B7 | ya anotado | Sucursal comparada contra `staff.location_id` y no contra la activa (Ola 2). |

Se corrigen B1, B2, B5 y B6. B3, B4 y B7 quedan como P2 documentados. Pruebas C7–C8 escritas.

**Validación #6 (gate estático tras la UI de Compras):** assertions 378/378 · lint exit 0 ·
build exit 0.

**Dos defectos más en la huella de recepción, peores que los reportados:**
- Se construía **concatenando con `:` y `|`**: una observación con esos caracteres podía hacer
  que dos envíos distintos produjeran la misma cadena y se tomaran por el mismo.
- Se calculaba **antes del chequeo de permisos** (línea 451 frente a 461).

**Corrección de B1 en dos pasos** (mismo archivo, se serializa):
1. **Aplicado:** helper `private.hash_recepcion` → huella canónica **jsonb** (sin separadores
   ambiguos ni cast a entero; `trim_scale` para que 3 y 3.0 coincidan) que incluye
   `acepta_sobrante`, observación de línea e `imei2`. Firma intacta, la migración sigue
   coherente entre pasos.
2. **Parcialmente aplicado:** B2 en `recepcion_replay` (quien no hizo el envío original no
   recibe su resultado; va tras la comprobación de orden y antes de la de contenido, para que
   C5, C8 y C7 reciban cada una su rechazo) y comparación de orden con `is distinct from`.
   **Pendiente:** en la RPC, combinar la cabecera (observación general, recepción corregida) y
   calcular la huella **después** del chequeo de permisos.

**Comentario falso corregido:** el bloque `DO` de `_p1_b` **borra todas las versiones** de
`recibir_orden_compra`, incluida la de 3 argumentos de producción, antes de recrearla como
envoltorio. El comentario de C2 decía que `CREATE OR REPLACE` "no pierde grants": falso, los
grants se borran con el DROP y se reaplican explicitamente. Queda dicho en el código.

### Huella de producción segura frente a collation — confirmada

Producción usa collation `en_US.UTF-8`. Recalculada con `COLLATE "C"` explícito en cada
`ORDER BY` de texto, la huella da **exactamente los mismos md5**: los valores de referencia
quedan demostrados independientes de la collation, no supuestos. El ensayo local usa esa
consulta literal. Privilegios de columna: 5169 filas, `a487b9e78cd244d17acfe76c1d27c498`.

### Agentes caídos otra vez (tercera vez) — cambio de método

E2E e INTEGRACIÓN cayeron por `rate_limit`. INTEGRACIÓN no dejó nada; E2E dejó
`scripts/verify-e2e-ui.mjs` (623 líneas) y `.p1-e2e/` sin validar. **Decisión:** el ensayo
compuesto lo escribe y ejecuta el coordinador (`scripts/verify-migraciones-compuestas.mjs`).
El script de E2E no se ejecuta sin revisar antes sus salvaguardas: el `.env` apunta a
producción.

### Validación local #7

```
Recepción 96/96 (C7–C7e huella completa · C8 otra persona rechazada)
Transferencias 63/63 · Caja 32/32 · Pagos 41/41
```

B1, B2 y B5 demostradas. **Las cuatro suites P1 en verde con todas las correcciones.**

### Ensayo compuesto — primeros resultados: DERIVA REAL DE PRODUCCIÓN

1. `20260716035000_configuracion_singleton` falla por orden: referencia `staff`, creada en
   `initial_schema_pos` (versión posterior). El archivo dice "Corre esto en el SQL Editor": se
   ejecutó a mano y quedó registrado con un timestamp anterior al real. Reordenado de forma
   explícita y declarada en la salida del ensayo.
2. **`private.resolver_turno_fecha(uuid, date)` existe en producción y NINGUNA migración la
   crea.** Sólo hay un `GRANT` (`20260824125442`) y una llamada (`20260824124052`). Se creó a mano
   desde el panel. **Hoy es imposible reconstruir producción desde el repositorio**: un entorno
   nuevo, un staging o una recuperación ante desastre fallarían en `124052`.
3. **La deriva es exactamente UNA función.** Cruzadas las 167 funciones `public/private` de
   producción contra las 153 migraciones: sólo `private.resolver_turno_fecha` no la crea ninguna.

**Resolución:** migración forward-only nueva `_p1_e_reconcilia_resolver_turno_fecha.sql` con la
definición **exacta** capturada de producción (`pg_get_functiondef`) y su ACL real (`EXECUTE`
para `postgres` y `authenticated`; sin `PUBLIC`, `anon` ni `service_role`). En producción es
un no-op idempotente. El ensayo la aplica antes de `124052`, declarado en la salida; la huella
tiene que cuadrar exactamente con producción.

**Descartado:** editar la migración ya aplicada (rompe forward-only) e insertar una versión
intermedia registrándola a mano en `schema_migrations` (prohibido: no se usa `execute_sql`
para fingir una migración registrada).

**Ensayo compuesto #3:** 153 aplicadas · huella **6/7 categorías idénticas a producción**
(columnas, constraints, policies, grants, RLS, privilegios de columna). Funciones: mismo
número (167) y md5 distinto; diagnóstico por volcado línea a línea en curso.

**Diagnóstico de la huella de funciones (resuelto con evidencia):** 42 de 167 funciones tienen
`md5(prosrc)` distinto al de producción; las 167 firmas y sus flags SECURITY DEFINER son
idénticas. Muestra a mano (`private.auth_jornada_activa`, `private.validar_permiso_sin_solape`):
producción tiene el mismo código con **otro formato** (p. ej. `select 1` / `from ...` en dos
líneas; el archivo del repo lo tiene en una). Producción ejecutó esas migraciones con un texto
reformateado respecto al archivo commiteado: deriva de **texto**, no de lógica. Referencias de
producción por función (consulta de sólo lectura, verificadas 167/167 contra la salida real) en
`.p04-pgtest/huella-prod-funciones.txt` (crudo) y `huella-prod-funciones-normalizada.txt`
(espacios colapsados / sin espacios). El ensayo acepta la diferencia **sólo** si cada función
coincide en firma, SECURITY DEFINER y cuerpo con espacios colapsados; si hace falta quitar todos
los espacios, FAIL para revisión manual (un espacio dentro de un literal puede ser un cambio).
Consecuencia para producción: ninguna. P1 sustituye su propio texto en las funciones que toca.

**Ensayo compuesto #6 — STATUS: PASS.** 153 migraciones · huella 7/7 (funciones PASS: 19 sólo
formato · 22 sólo comentarios/disposición; firma y SECURITY DEFINER exactos en las 167) · P1 4/4 ·
estructurales 22/22 (incluye 0 SECURITY DEFINER ejecutables por anon). Transferencias 63/63 tras el
revoke. Gate estático: test 0 · lint 0 · build 0.

## OLA 2 · Multi-sucursal — hallazgo sistémico (B7 reclasificado)

**Dos modelos de sucursal conviven.** El frontend usa la sucursal ACTIVA
(`auth.tsx`: `location_id = active_location_id ?? location_id`; `Caja.tsx` abre caja con ella). El
servidor, en ~20 funciones de producción, usa la sucursal BASE (`staff.location_id`): triggers
`validar_contexto_caja` y `validar_contexto_venta_autenticada`, `registrar_movimiento_caja`,
`crear_orden_compra`, `recibir_orden_compra`, `crear_transferencia_stock`, `registrar_seriales`,
`ajustar_stock`, `ajustar_stock_a_seriales_admin`, `iniciar_inventario_fisico` (P0 intocable),
`solicitar_autorizacion`, `inventario_valorizado_admin`… Sólo unas pocas usan
`private.auth_location_id()` (activa validada contra `staff_locations`). Consecuencia: quien cambia de
sucursal activa no puede abrir caja ni vender allí ("La caja debe pertenecer a tu sucursal").

**Regresión latente introducida por P1:** `_p1_a` pasó `despachar/recibir_transferencia_stock` a la
activa, pero `crear_transferencia_stock` (producción, no tocada) pone `origen_id` = base. Con activa ≠
base, el creador no podría despachar su propia transferencia.

**Exposición real hoy (sólo lectura): nula.** 1 sucursal, 5 staff activos con exactamente 1 acceso
cada uno, 0 con activa ≠ base, 0 transferencias, 0 órdenes de compra abiertas. Base y activa coinciden
para todos; ni el defecto sistémico ni la regresión pueden manifestarse con los datos actuales.

**Decisión:** no parchear a medias. Un único `_p2_b_sucursal_activa.sql` que haga que TODA decisión de
sucursal del actor use `private.auth_location_id()`, con prueba de negocio de dos sucursales en Fase 3
(incluida la excepción justificada al invariante de P0 intocables para `iniciar_inventario_fisico`).
**Bloqueo de release documentado:** no habilitar una segunda sucursal hasta que `_p2_b` esté
desplegada.

**Confirmación del modelo canónico:** las 30 policies RLS que filtran por sucursal usan TODAS
`private.auth_location_id()` (activa). Las funciones con sucursal base son las divergentes.
Otro caso concreto: `solicitar_autorizacion` guarda `location_id` = base, pero
`consultar/consumir_autorizacion_descuento` buscan por activa → con activa ≠ base una autorización
de descuento aprobada nunca se encuentra.

**Hallazgo de seguridad (RLS tautológica):** policy `cliente_puntos_read` de
`cliente_puntos_movimientos` compara `s.cliente_id = s.cliente_id` (siempre verdadero): cualquier
staff cuya sucursal tenga ≥1 venta lee los movimientos de puntos de TODOS los clientes. Corrección
en migración propia (`_p2_c`) con prueba negativa en Fase 3.

**`_p2_c_rls_puntos_cliente.sql`** (policy correlacionada con la fila; producción tiene 0 filas):
ensayo #11 PASS (negocio 30/30). **Mutación sin `_p2_c`: falla exactamente** "el vendedor NO ve los
puntos de un cliente de otra sucursal" (ve ambos); las otras 29 siguen verdes.

**`_p2_b_sucursal_activa.sql` — GENERADA** por `scripts/generar-p2b.mjs` desde las definiciones reales
del esquema compuesto (volcadas por el ensayo en `.p04-pgtest/defs-despues/`): **32 funciones, 50
sustituciones** `<var_staff>.location_id → private.auth_location_id()`. Aborta si el alias nombra otra
tabla, si quedan lecturas base o si hay dos variables de actor. Las 4 de conciliación ya estaban en
activa por `_p1_d` y no aparecen. Efecto cosmético aceptado: en `despachar_transferencia_stock` y
`recibir_transferencia_parcial` queda `coalesce(auth_location_id(), auth_location_id())`.
Storage (`ordenes-servicio`) ya usaba la activa; no hay vistas afectadas.
Ensayo ampliado: (a) las 3 P0 intocables afectadas sólo pueden diferir por esa sustitución exacta;
(b) invariante global: ninguna función decide con la sucursal base; (c) módulo de negocio
`sucursal_activa.mjs` (admin y vendedor multi-sucursal, activa sin acceso).
UI: `Layout.tsx` y `Sucursales.tsx` impiden cambiar de sucursal con ventas offline en cola (el
servidor las valida contra la activa al sincronizar). Gate estático: 0/0/0.

**Ensayo compuesto #12 — PASS:** huella 7/7 · 8/8 migraciones nuevas · estructurales 28/28 (incluye
sustitución exacta en las 3 P0 intocables e invariante global de sucursal) · negocio 39/39
(`reportes`, `puntos_cliente`, `sucursal_activa`).

**Mutación sin `_p2_b` — FAIL esperado, 34/39:** fallan exactamente las 5 de sucursal activa (abrir
caja en B → "La caja debe pertenecer a tu sucursal"; caja en A aceptada; transferencia → "Origen y
destino no pueden ser iguales"; autorización guardada en A; movimiento del vendedor → "La caja no
pertenece a tu sucursal"). Las 3 que deben pasar con ambas versiones (lectura de la activa, activa sin
acceso) siguen verdes.

## OLA 2 · Promociones y CRM — auditoría (en curso)

Promociones: todas las RPC de escritura exigen `auth_is_admin()`; vigencias en `timestamptz` comparadas
con `now()` (instantes, correcto; la UI ya convierte hora de pared de Lima). Sin hallazgos por ahora.
CRM (preliminar): `perfil_cliente_crm` y `actualizar_cliente_crm` sólo exigen staff vinculado — sin
rol ni sucursal. Un vendedor puede cambiar documento, dirección, segmento y **consentimientos de
WhatsApp/email** de cualquier cliente, y leer su perfil completo. Pendiente: comparar con lo que RLS de
`clientes`/`sales` ya le deja leer para distinguir exposición nueva de exposición existente.

Comparación con RLS (sólo lectura): `clientes` es un maestro compartido a propósito (SELECT/INSERT/
UPDATE `true` para `authenticated`), así que editar datos del cliente no es exposición nueva. Sí lo es
`perfil_cliente_crm`: es SECURITY DEFINER y devuelve TODAS las compras, reparaciones y movimientos de
puntos del cliente en todas las sucursales, saltándose `ventas_por_ubicacion` y la policy que `_p2_c`
acaba de corregir. Además `total_gastado`/`compras` incluyen ventas `is_test` (rompe P0.4). Y un retiro
de consentimiento no queda fechado (`consentimiento_at` sólo se fija al otorgar).

**Hallazgo adicional (integridad):** `authenticated` tenía INSERT/UPDATE en TODAS las columnas de
`clientes` (privilegios por defecto + RLS `true`): cualquiera podía fijar `puntos` por PostgREST
saltándose `ajustar_puntos_cliente_admin` y su ledger, o marcar consentimientos. El frontend sólo
escribe nombre/teléfono/email/notas; las únicas funciones que escriben `clientes` son SECURITY
DEFINER (`actualizar_cliente_crm`, `ajustar_puntos_cliente_admin`). Sin trigger de auditoría en
`clientes`.

**`_p2_d_crm_alcance.sql`:** perfil acotado a la sucursal activa para no-admin (puntos con el mismo
criterio que la policy) y sin ventas `is_test`; `actualizar_cliente_crm` sólo admin (único llamador:
`/crm`, AdminRoute), null = sin cambio, `consentimiento_at` en todo cambio de consentimiento; INSERT/
UPDATE de `clientes` pasan a privilegios de columna (nombre, telefono, email, notas, documento,
direccion). Módulo de negocio `crm.mjs`.

**Ensayo compuesto #13 — PASS:** 9/9 migraciones nuevas · estructurales 28/28 · negocio 53/53
(4 módulos). **Regresión de UI detectada al revisar el llamador:** `CRM.tsx` enviaba
`p_documento: f.documento||null`; con "null = sin cambio" un administrador ya no podría vaciar
documento/dirección. Corregido enviando el string tal cual (el servidor convierte `''` en NULL) y
añadida la prueba "un string vacío desde /crm vacía documento y dirección". Gate estático tras
`CRM.tsx`: 0/0/0.

**Ensayo compuesto #14 — PASS:** estructurales 28/28 · negocio **54/54** (4 módulos).
**Mutación sin `_p2_d` — FAIL esperado, 44/54:** fallan exactamente las 10 de CRM. Evidencia de la
exposición: con la función de producción el vendedor ve 3 compras y `total_gastado = 1300` (incluye la
venta de prueba de S/ 1000 y la de otra sucursal) y 2 reparaciones de ambas sedes; cambia
consentimientos por RPC; fija `puntos` y consentimientos por UPDATE/INSERT directo. Las que deben pasar
con ambas versiones (string vacío vacía el campo, alta y edición de notas/teléfono) siguen verdes.

## OLA 3 · Fase 20 / Fase 21 — auditoría inicial (sólo lectura)

Producción: 0 cierres diarios, 0 notificaciones, `auditoria_eventos` existe; **no hay tabla de
incidencias**. `aprobar_cierre_diario` hoy: BLOQUEA si hay terminales con ventas pendientes/fallidas o
sin reportar > 2 h; exige AUTORIZACIÓN si `|diferencia_cajas| ≥ configuracion.diferencia_caja_critica`
(20); sólo CUENTA conciliaciones pendientes/diferencia/rechazadas (no bloquea ni advierte). No revisa:
cajas aún abiertas del día (producción tiene una abierta hace 7 días), invariantes P0.4, reservas IMEI
vencidas, seriales en cuarentena ni comprobantes electrónicos fallidos.

Defectos concretos: `resumen_cierre_diario` sólo cuenta cajas abiertas con apertura = la fecha, así que
**`cerrar_dia` permite cerrar con una caja olvidada de días anteriores**; `stock_critico` incluye
productos `is_test`.

**`_p2_e_cierre_diario_clasificado.sql` (Fase 20):** `private.checks_cierre_diario(location, fecha)`
(sin EXECUTE para nadie) devuelve verificaciones `{codigo, nivel, bloquea, cantidad, titulo, detalle,
accion}`:
- **P0 · bloquea el cierre:** `CAJAS_ABIERTAS` (de la fecha o anteriores), `INVENTARIO_NEGATIVO`.
- **P0 · bloquea la aprobación:** `TERMINALES_VENTAS_PENDIENTES`, `_FALLIDAS`, `_SIN_REPORTAR` (reglas de
  P0.2, mensajes intactos).
- **P1 · requiere autorización:** `DIFERENCIA_CRITICA` (umbral de `configuracion`).
- **warning:** `CONCILIACIONES_PENDIENTES`, `COMPROBANTES_NO_EMITIDOS`, `RESERVAS_IMEI_VENCIDAS`,
  `SERIALES_EN_REVISION`, `ORDENES_ABIERTAS`, `STOCK_CRITICO` (sin QA).
`previsualizar_cierre_diario` añade `checks`, `bloquea_cierre`, `bloquea_aprobacion`,
`requiere_autorizacion`; `cerrar_dia` bloquea por P0 de cierre (mensaje de cajas conservado) y guarda
`checks` en el snapshot; `aprobar_cierre_diario` conserva bloqueos/mensajes/autorización y registra
`checks` en `reporte_final`. UI `CierreDiario.tsx`: lista ordenada por nivel y botón deshabilitado si
el servidor bloquea. **Impacto operativo al desplegar:** la caja abierta desde el 2026-09-07 bloqueará
el próximo cierre hasta que se cierre por el flujo normal (comportamiento correcto, a comunicar al
dueño). Módulo de negocio `cierre_diario.mjs`.

**Ensayo compuesto #16 — PASS:** 10/10 migraciones nuevas · estructurales 28/28 · negocio **68/68**
(5 módulos). Primer intento: el sembrado del módulo chocó con NOT NULL reales (`serie`/`numero` de
comprobantes, `payment_id` de conciliaciones); corregido tras consultar las columnas obligatorias de
producción. Gate estático tras `CierreDiario.tsx`: 0/0/0.

## OLA 3 · Fase 21 — Centro de incidencias (`_p2_f_incidencias.sql`, en curso)

Tablas `incidencias` (una abierta/en revisión por `clave_dedup`, índice único parcial) e
`incidencia_eventos` (append-only por trigger). Detector `detectar_incidencias_admin` sobre la MISMA
fuente que el cierre (`checks_cierre_diario`): abre, re-detecta (`veces`) y auto-resuelve sólo
condiciones de estado que ya no se detectan, dejando evento. `actualizar_incidencia_admin`: una P0 no
se descarta; resolver/descartar exige nota; una cerrada no se reabre (si persiste, se abre otra).
RLS lectura admin o sucursal activa; escrituras retiradas a `authenticated`/`anon`.
Módulo `scripts/compuesto/incidencias.mjs.pendiente` (se activa tras la mutación de `_p2_e`).

**Mutación sin `_p2_e` — FAIL esperado, 58/68:** fallan exactamente las 10 del cierre clasificado
(la caja olvidada cuenta 0 abiertas y `cerrar_dia` cierra igual; stock crítico 2 con el producto QA;
sin `checks`). Siguen verdes las del flujo de aprobación y mensajes existentes.
Módulo de incidencias activado; UI `Incidencias.tsx` + ruta admin `/incidencias` + enlace en
"Sistema / Administración".

**Ensayo compuesto #18 — PASS:** 11/11 migraciones nuevas · estructurales 28/28 · negocio **85/85**
(6 módulos; incidencias 17: detección, deduplicación con `veces`, P0 no descartable, nota obligatoria,
auto-resolución con evento en orden exacto, cerrada no reabrible, reaparición como incidencia nueva,
vendedor sin detector ni escritura directa, anon sin lectura, historial append-only incluso para el
dueño). **Mutación sin `_p2_f` — FAIL esperado, 68/80:** fallan exactamente las 12 de incidencias.
Gate estático tras página, ruta y enlace: 0/0/0.

## OLA 3 · Offline — auditoría y corrección (en curso)

- **O1 (P1) Venta huérfana en SYNCING.** `sincronizarVentasPendientes` marca SYNCING antes de llamar y
  sólo selecciona PENDING/FAILED; nada restablece SYNCING (ni el upgrade de IndexedDB ni la UI). Si la
  pestaña se cierra o recarga a mitad del envío, la venta queda **para siempre** sin reintentarse y
  contando como pendiente: bloquea el cambio de sucursal y, vía heartbeat, la aprobación del cierre.
- **O2 (P1) Cortes de red agotan ventas válidas.** Todo fallo incrementaba `intentos`, también los de
  red; cinco cortes dejaban la venta "agotada" (sin reintento automático).
- Seguridad del reenvío verificada en la definición desplegada: `registrar_venta` busca por
  `client_transaction_id` antes de insertar y captura `unique_violation` devolviendo la venta existente.
- Corrección en `src/lib/offline.ts`: `enviarVentaEncolada` única para el bucle y el reintento manual;
  SYNCING al inicio de una sincronización se reenvía (mutex en pestaña + lock entre pestañas); sólo un
  rechazo del servidor cuenta intento; un fallo de red vuelve a PENDING sin gastar intento y detiene el
  bucle.
- E2E en navegador (`scripts/verify-e2e-ui.mjs`, suite **Offline**, IndexedDB real contra el bundle
  construido): (1) venta sembrada en SYNCING se reenvía con su `client_transaction_id` y la cola queda
  vacía; (2) con dos ventas y la red abortada: la intentada queda PENDING con `intentos = 0` y la ronda
  se detiene tras 1 envío; (3) un rechazo del servidor deja FAILED con `intentos = 1` y el mensaje.
  Mutación: bundle construido con `offline.ts` de HEAD en `.p1-e2e/dist-mutante-offline` (archivo
  restaurado y verificado con `cmp` en el mismo comando).
- **Resultado:** gate estático 0/0/0 · E2E bundle actual **Caja 6/6 · Transferencias 4/4 · Offline 3/3 ·
  fugas 0 · PASS**. **Mutante (`offline.ts` de HEAD): Offline 1/3 · FAIL** — falla (1) "timeout
  esperando reenvío de la venta huérfana" y (2) "estado tras corte de red: FAILED (esperado PENDING)";
  (3) pasa en ambos, como debe. `offline.ts` verificado idéntico a la versión corregida tras la mutación.

## OLA 4 · Fase 24 — Permisos: auditoría (sólo lectura)

Autorización dispersa y duplicada:
- Servidor: 27 funciones deciden por `puesto`, 32 comparan `rol = 'administrador'` literal y 68 usan
  `auth_is_admin()`. Dos listas repetidas a mano: `('tecnico','encargado','jefa')` en 12 funciones
  (inventario, taller, recepción, transferencias, seriales, ajuste de stock) y `('encargado','jefa')` en
  6 (cerrar conteo, resolver cuarentena/reconciliación, marcar terminal fuera de servicio, orden técnica,
  movimiento de caja). 1 policy (`ordenes_actualizacion_tecnica`) repite la lista de 3.
- Frontend: 8 listas más en `App.tsx` (`InventoryOpsRoute`), `Layout.tsx`, `Compras.tsx`,
  `ConteoInventario.tsx`, `Seriales.tsx`, `Taller.tsx`; guardias `AdminRoute` (26 rutas),
  `InventoryOpsRoute` (4), `OperationalRoute` (4), `JornadaRoute` (1).
- Staff activo en producción: administrador/jefa 1 · cajero/técnico 1 · cajero/vendedor 3.
Riesgo: añadir un puesto o cambiar quién puede algo exige tocar ~35 sitios; cualquier olvido deja
servidor y UI en desacuerdo.

**Hallazgo: permisos por sucursal decorativos.** `staff_locations.puede_vender / puede_inventario /
puede_taller` se asignan (`asignar_sucursal_staff_admin`) y se muestran (`mis_sucursales`), pero el
servidor sólo aplica `puede_inventario` en `ajustar_stock`. Producción tiene una fila con
`puede_taller = false` que no impide nada. Semántica a aplicar: el permiso vale para la sucursal
ACTIVA (coherente con `_p2_b`).

## OLA 4 · Fase 23 — Hardware y reimpresión: auditoría (sólo lectura)

- Bridge local (`src/lib/hardware.ts`): `setBridgeUrl` sólo admite localhost/127.0.0.1/::1 y http(s),
  pero `getBridgeUrl` usa lo que haya en `localStorage` **sin revalidar** (una escritura directa al
  storage enviaría recibos y la orden de abrir cajón a otro host).
- **Reimpresión sin rastro:** `Reportes.tsx → abrirReimpresion` reconstruye y reimprime el recibo de
  cualquier venta sin registro en servidor ni marca de "reimpresión" en el papel: una copia es
  indistinguible del original (vector de fraude con recibos duplicados).
- La validación de impresora física no es posible sin hardware: se declarará como no validada.

**Correcciones Fase 23:**
- `hardware.ts`: `getBridgeUrl` revalida lo guardado (sólo localhost/127.0.0.1/::1, http/https); si no es
  válido usa el bridge por defecto.
- `_p2_g_reimpresiones.sql`: `reimpresiones_venta` append-only con `(sale_id, copia)` único;
  `registrar_reimpresion_venta` numera copias con la venta bloqueada, exige sucursal activa para
  no-admin y rechaza ventas anuladas. UI: `Reportes.tsx` registra ANTES de reimprimir (fallo cerrado con
  aviso) y `ReciboVenta.tsx` imprime "REIMPRESIÓN · COPIA N · no es un comprobante nuevo".
  Módulo de negocio `reimpresiones.mjs`.

**Impacto de aplicar permisos por sucursal (Fase 24), sólo lectura:** las 3 filas con
`puede_taller = false` son `cajero/vendedor`, puesto que ya no está en la lista de taller; técnico y
administradora tienen los tres permisos en `true`. Hacer cumplir los flags no cambia nada para el
personal actual de producción.

**Ensayo compuesto #20 — PASS:** 12/12 migraciones nuevas · estructurales 28/28 · negocio **94/94**
(7 módulos; `reimpresiones.mjs` 9: copia correlativa, quién y por qué, otra sucursal rechazada, anulada
rechazada, sin inserción directa, inexistente, admin cualquier sucursal, anon rechazado, append-only).

**Mapa de Fase 24 (definiciones compuestas locales, patrón estándar
`<v>.rol='administrador' or coalesce(<v>.puesto,'') in (...)` en 17 funciones):**
- `operar_taller` (+ `puede_taller`): actualizar_orden_servicio_tecnica, agregar_repuesto_orden,
  retirar_repuesto_orden, registrar_foto_orden.
- `operar_inventario` (+ `puede_inventario`): ajustar_stock, despachar_transferencia_stock,
  iniciar_inventario_fisico, recibir_orden_compra, recibir_transferencia_parcial, registrar_conteo_fisico,
  registrar_serial_contado, registrar_seriales.
- `supervisar` (encargado/jefa, sin flag; semántica actual): cerrar_inventario_fisico,
  marcar_dispositivo_fuera_de_servicio, registrar_movimiento_caja, resolver_cuarentena_serial,
  resolver_reconciliacion_serial.
Resto de menciones a `puesto` son datos (reportes, personal), no autorización. Además
`actualizar_orden_servicio_tecnica` tiene la forma invertida (`rol<>'administrador' and puesto not in
('encargado','jefa')`) para asignar técnico → `not tiene_capacidad('supervisar')`.

**Implementación Fase 24 (servidor):**
- `_p2_h_capacidades.sql` (a mano): `private.tiene_capacidad(text)` única definición (supervisar,
  operar_inventario, operar_taller, vender; desconocida → excepción; admin siempre; flags de la sucursal
  ACTIVA; sin fila en `staff_locations` → no restringe, porque el alta de personal no la crea);
  `mis_capacidades()` para la UI; policy `ordenes_actualizacion_tecnica` sin lista de puestos.
- `_p2_i_capacidades_funciones.sql` GENERADA por `scripts/generar-p2i.mjs` con la regla compartida
  `scripts/lib/capacidades.mjs` (formas directa e invertida; aborta ante función con lista de tres sin
  clasificar, lista desconocida o autorización que sobreviva).
- Ensayo: las P0 intocables sólo pueden diferir por las sustituciones de `_p2_b` y `_p2_i` (misma
  librería); invariantes "ninguna función/policy autoriza por lista de puestos"; módulo
  `capacidades.mjs`.
- Bridge de hardware: `URL.hostname` devuelve IPv6 como `[::1]`, así que la lista original nunca
  aceptaba `::1`; se normaliza. La prueba estática `verify-elite-p2.mjs` exigía el literal viejo y
  falló tras el refactor (detectado por el gate): se actualizó a la forma normalizada y se añadió la
  aserción de revalidación al leer. Gate estático tras el ajuste: 0/0/0.

**Ensayo #22 (Fase 24):** volcado sin `_p2_i` → generador: **17 funciones, 18 sustituciones**
(`actualizar_orden_servicio_tecnica` recibe `operar_taller` y `supervisar`). Ensayo completo: negocio
**106/106** (8 módulos; sin `_p2_i` falló exactamente "técnico con puede_inventario = false NO inicia un
conteo"), P0 intocables sólo con sustituciones admitidas, pero **estructurales 29/30: queda 1 policy que
menciona `puesto`** → falso positivo del propio invariante: `orden_servicio_repuestos` contiene la
subcadena "puesto" y su policy no autoriza por puesto. Corregido a palabra completa (`\mpuesto\M`).

**Implementación Fase 24 (frontend):** `src/lib/auth.tsx` carga `mis_capacidades()` y expone
`capacidades` y `puede(capacidad)`; sin conexión aplica el mismo criterio por puesto de `_p2_h` (único
sitio del frontend con listas; el servidor revalida al sincronizar). Sustituidas las 8 listas en
`App.tsx` (InventoryOpsRoute espera a que carguen las capacidades en vez de expulsar), `Layout.tsx`,
`Compras.tsx`, `ConteoInventario.tsx`, `Seriales.tsx`, `Taller.tsx`. `verify-navigation.mjs` ahora exige
`puede('operar_inventario')` y falla si algún archivo fuera de `auth.tsx` decide por puesto.
**Ensayo compuesto #23 — PASS:** 14/14 migraciones nuevas · estructurales **30/30** (incluye ninguna
función/policy autoriza por puesto y P0 intocables sólo con sustituciones admitidas) · negocio
**106/106** (8 módulos). Gate + E2E en curso.

## OLA 3/4 · WhatsApp, Culqi y CI — auditoría (sólo lectura)

- **`agente-whatsapp` (webhook de Meta) — hallazgo de seguridad:** el GET valida `hub.verify_token`,
  pero el **POST no verifica ninguna firma** (`X-Hub-Signature-256`; `WHATSAPP_APP_SECRET` no aparece en
  ninguna función). Cualquiera que conozca la URL puede inyectar mensajes entrantes falsos: el agente
  consume la API de Anthropic, responde por WhatsApp desde el número del negocio a teléfonos arbitrarios
  y opera con service role.
- `culqi-webhook`: **sin hallazgo.** Usa el cuerpo sólo para extraer `ord_…` y re-consulta la orden a
  la API de Culqi con la llave privada antes de marcar `pagado`; un payload falso no puede fabricar un
  pago.
- **Corrección WhatsApp:** `supabase/functions/agente-whatsapp/firma.ts` (HMAC-SHA256 del cuerpo crudo
  con Web Crypto, comparación en tiempo constante) y el POST verifica ANTES de parsear: sin
  `WHATSAPP_APP_SECRET` → 503 sin procesar (fallo cerrado); firma ausente o inválida → 401. Prueba
  `scripts/verify-webhook-whatsapp.mjs` (importa el mismo módulo; añadida a `npm test`, corre en CI).
  **Impacto operativo:** al desplegar esta función sin configurar `WHATSAPP_APP_SECRET`, el bot deja de
  procesar mensajes entrantes hasta que el dueño cargue el secreto (decisión deliberada: preferible a
  un webhook abierto). Deno no está instalado localmente: la función no se tipa aquí; se valida al
  desplegar.
- E2E tras capacidades en la UI: **Caja 6/6 · Transferencias 4/4 · Offline 3/3 · fugas 0 · PASS**.
  Gate: el build detectó `staff` sin uso en `Compras.tsx` (TS6133) → corregido.
- CI (`.github/workflows/ci.yml`): sólo `npm test`, `npm run lint`, `npm run build`. No ejecuta el
  ensayo compuesto, las suites SQL ni el E2E.
- DevOps (paso 1): las referencias de producción por función que el ensayo necesita estaban en
  `.p04-pgtest/` (ignorado por git), así que el ensayo no podía correr en CI. Movidas a
  `scripts/referencias/` (versionadas; sólo firmas y md5, verificado que no hay otro contenido) y el
  ensayo lee de ahí.
- DevOps (paso 2), **decisión:** nuevo workflow `.github/workflows/integracion.yml` (pull requests y
  manual) con ensayo compuesto, suites SQL de P1 y E2E con el Chrome del runner. Se deja FUERA del CI de
  push a main a propósito: validado en macOS pero aún no en un runner Linux, y un fallo del entorno no
  debe bloquear el push único de release. Revierte la nota anterior del manifiesto de `.p04-pgtest`
  ("nunca en CI"), actualizada explícitamente. Promover a required check cuando se vea verde en Linux.
- Ensayo con referencias versionadas (#24): **PASS** · estructurales 30/30 · negocio 106/106.
- Gate estático con la prueba de firma: **0/0/0**. **Mutación de `firma.ts`** (acepta cualquier firma
  bien formada): **FAIL con exactamente 2 fallos** — "Rechaza un cuerpo alterado" y "Rechaza una firma
  con otro secreto".
- Suites SQL de P1 re-ejecutadas (las lista `integracion.yml`): transferencias **63/63**, recepción
  **96/96**, caja **PASS**, pagos **41/41**. YAML de `integracion.yml` validado (1 job, 8 pasos).

## Fase 18 — terminal y reembolsos a proveedor (`_p2_j_reembolsos_proveedor.sql`, en curso)

Datos (sólo lectura): `payments.metodo` sin restricción (efectivo 8, yape 1, tarjeta 1); sin terminal
en conciliaciones; ningún registro de reembolsos del proveedor. Implementado según la propuesta:
`conciliaciones_pago.terminal` + `registrar_terminal_conciliacion_admin`; `reembolsos_proveedor`
(cabecera inmutable) y `reembolso_proveedor_eventos` (append-only, un evento por estado); solicitud con
clave + huella, bloqueo de la venta, tope = monto del pago descontando rechazados, efectivo excluido,
sucursal activa con fallo cerrado; eventos con transiciones válidas, referencia obligatoria al
confirmar, nota al rechazar, repetición idempotente. **Sin adaptadores automáticos** (bloqueo externo:
credenciales de Culqi/POS; nada devuelve un éxito simulado). Módulo `reembolsos_proveedor.mjs`.

**Ensayo compuesto #25 — PASS:** 15/15 migraciones nuevas · estructurales 30/30 · negocio **127/127**
(9 módulos; reembolsos 21: solicitud, idempotencia por huella, tope del pago, efectivo excluido, otra
sucursal, devolución ajena, transiciones, referencia obligatoria, repetición idempotente, reconfirmación
con otra referencia, confirmado no rechazable, rechazo libera monto, listado con historial, terminal,
vendedor/anon/inserción directa rechazados, cabecera inmutable).
UI `ConciliacionPagos.tsx`: botón Terminal por pago; "Reembolso" sólo en pagos conciliados o con
diferencia (clave estable por contenido); sección de reembolsos con la siguiente acción válida.
Gate estático: 0/0/0. **Mutación sin `_p2_j`: 106/127 — fallan exactamente las 21 de reembolsos.**
Ajuste de UI: la insignia de estado mostraba `confirmado` como alerta amarilla; ahora final correcto
(verde) y `solicitado/enviado` en curso.

## RED TEAM final — módulo genérico (`scripts/compuesto/zz_red_team.mjs`, en ejecución)

Enumera todas las funciones públicas del esquema compuesto final y ataca con tres identidades:
(A) anon sólo ejecuta una lista blanca explícita; (B) authenticated sin fila en `staff` llama cada
función con argumentos NULL: no puede escribir (contadores `pg_stat_xact_user_tables`) ni recibir datos
salvo lista blanca; (C) vendedor contra todas las `*_admin`: error o nada; (D) `crear_primer_admin` no
crea un administrador cuando ya existe uno.

**Primera ejecución — 131/132, 1 FAIL (B) con 5 funciones, clasificadas:**
- `resumen_ganancias` (fila de ceros) y `mis_capacidades` (todo `false`): no son datos; defecto del
  criterio "vacío" del propio red team → corregido (filas/objetos sólo con ceros/false/null son vacíos).
- `limite_descuento_actual` → `0`: configuración no sensible.
- `liberar_seriales_carrito` → `true` sin escribir: no hay reservas de un staff inexistente.
- `obtener_favoritos` → catálogo: SECURITY INVOKER, sólo lo que la RLS del catálogo ya permite (en
  verificación contra producción).
Ninguna escribió. Contraste con producción (sólo lectura): **anon no puede ejecutar ninguna función
pública** (`hay_staff` y `email_por_username` sólo `service_role`, vía Edge Functions) → lista blanca
de anon endurecida a vacía.

Verificación de `obtener_favoritos` (sólo lectura): policies `catalogo_lectura` / `variantes_lectura`
permiten SELECT a cualquier `authenticated`; `authenticated` NO tiene SELECT sobre `products.costo`.
Clasificación confirmada: no es exposición nueva. **Riesgo residual (acción del dueño):** una cuenta de
Auth sin fila en `staff` puede leer el catálogo con precios; es aceptable sólo si el registro público
de usuarios (sign-ups) está desactivado en Supabase Auth — no verificable por SQL. Se pedirá confirmar
junto con Leaked Password Protection.

**Red team refinado — ensayo #27 PASS:** estructurales 30/30 · negocio **132/132** (10 módulos; A–D del
red team en verde). Producción (sólo lectura): siguen **153** migraciones, última
`20260911024014 p04_h_invariantes_admin` → sin deriva nueva desde el inicio.

**Preparación del release:** la base de 153 migraciones queda congelada en
`scripts/referencias/migraciones-produccion-base.txt`; el ensayo resuelve cada migración nueva por
nombre lógico (provisional `_p2_x_…` o ya versionado `2026…_p2_x_…`), para seguir funcionando tras
renombrar los archivos con la versión real al aplicarlos. `POS_INTEGRITY_HARDENING.md`: añadida la
sección OLA 1–4.

Ensayo tras la lista base congelada: **PASS** (30/30 · 132/132). Resolución por nombre lógico
compartida en `scripts/lib/migraciones.mjs` y usada por el ensayo, las 4 suites SQL de P1 y los
generadores; los generadores **abortan** si la migración ya tiene versión (una migración aplicada en
producción es inmutable: se crea otra). Simulación del release en curso: renombrar las 15 migraciones a
nombres versionados de prueba, correr ensayo + suites + generadores, restaurar y comprobar md5.

**Simulación del release — PASS:** suites con nombres provisionales 4/4; con las 15 migraciones
renombradas a versiones de prueba: ensayo **PASS** (15/15 · 30/30 · 132/132), suites 4/4, ambos
generadores **se niegan** a regenerar; archivos restaurados **idénticos por md5** (15) y 0 restos.

**Línea base del release (sólo lectura):** `main` local = `origin/main` = `70578db`; último deployment
de GitHub "Production" = `70578db`, estado **success** (Vercel). El conector de Vercel no ve el proyecto
(lista vacía): la verificación de Vercel se hará por los estados de deployment de GitHub y la URL.

**Revisión previa al commit:** 28 archivos modificados y los nuevos (migraciones `_p1_*`/`_p2_*`,
scripts de verificación, `scripts/lib`, `scripts/referencias`, `scripts/compuesto`, workflow, página de
incidencias, `firma.ts`, checkpoint). Escaneo de secretos sobre todo lo cambiado: **sin secretos
reales**; coincidencias falsas en bundles E2E ignorados por git (texto de la librería de Supabase) y la
contraseña del PostgreSQL local desechable del ensayo. Candidato local final en ejecución.
Conjunto a versionar: 28 modificados + **48 nuevos** exactamente los esperados; ningún artefacto de build,
datos locales ni scratch.

**Paso 1 del release — auditoría de producción (sólo lectura) — OK:**
- Huella del esquema **idéntica a `REFERENCIA` en las 7 categorías** (funciones 167/`ed988c8a…`,
  columnas 674/`7aaead31…`, constraints 321/`abad724d…`, policies 99/`9fb4d1d4…`, grants
  `3662a3f9…`, RLS 66/`ee832627…`, privilegios de columna 5169/`a487b9e7…`): producción no cambió desde
  la auditoría en la que se basa toda la validación local.
- anon SECURITY DEFINER = **0** · tablas públicas sin RLS = **0**.
- Datos clasificados sin cambios: 5 reservas IMEI vencidas · 1 caja abierta (2026-09-07 00:52 UTC) ·
  2 conciliaciones pendientes · 5 ventas reales.

**Candidato local final (2026-09-13 17:11) — PASS completo, sin cambios posteriores:** gate 0/0/0 (393
PASS, 0 FAIL) · ensayo compuesto huella 7/7, 15/15, estructurales 30/30, negocio 132/132 · suites SQL
transferencias PASS, recepción PASS, caja PASS, pagos 41/41 · E2E Caja 6/6, Transferencias 4/4,
Offline 3/3, fugas 0.

**Decisión del dueño (2026-09-13):** *"Yes, release now"* — aplicar las 15 migraciones y publicar,
aceptando los efectos descritos (caja del 2026-09-07 bloquea el próximo cierre, edición CRM sólo admin,
flags por sucursal aplicados). **WhatsApp: "Hold it"** — el código del webhook con firma se versiona,
pero la Edge Function `agente-whatsapp` **NO se despliega** en este release (queda aceptando peticiones
sin firma hasta que el dueño cargue `WHATSAPP_APP_SECRET` y se despliegue).

**Método de verificación por paso (antes de la primera escritura):** `apply_migration` recibe el SQL
como texto, así que cada aplicación se contrasta con el ensayo. El ensayo escribe instantáneas
`.p04-pgtest/pasos-release/paso-NN.json` (huella por categoría + md5 por función) antes de las nuevas y
tras cada una. `scripts/sql-verificacion-paso.mjs N` genera UNA consulta de sólo lectura con las
expectativas del paso N incrustadas que devuelve sólo banderas: huellas de columnas, constraints,
policies, grants, RLS y privilegios de columna iguales; mismo número de funciones; y md5 idéntico en
todas las funciones que la migración N creó o cambió (0 distintas). Un error de transcripción sólo
puede dar un falso fallo, nunca un falso éxito. Regla: **ante cualquier bandera en falso, detenerse**.

**Paso 2 del release — en curso.** Registro de cada aplicación:

| # | Migración | Versión asignada | Verificación posterior |
|---|---|---|---|
| 1 | `p1_a_transferencias_parciales` | (se lee al reconciliar) | **OK** · 7 categorías ✓ · 171 funciones ✓ · 6/6 funciones idénticas · anon secdef 0 · 154 registradas |
| 2 | `p1_b_recepcion_idempotente` | (se lee al reconciliar) | **OK** · autoverificación de la migración ✓ · 7 categorías ✓ · 176 funciones ✓ · 6/6 idénticas (ambas firmas de `recibir_orden_compra`) · anon secdef 0 · 155 registradas |
| 3 | `p1_c_caja_umbral_autorizacion` | (se lee al reconciliar) | **OK** · 7 categorías ✓ · 176 funciones ✓ (firmas viejas reemplazadas) · 2/2 idénticas · anon secdef 0 · 156 registradas |
| 4 | `p1_d_pagos_conciliacion` | (se lee al reconciliar) | **OK** · 7 categorías ✓ · 179 funciones ✓ · 7/7 idénticas · anon secdef 0 · 157 registradas · extra: 2 índices y trigger con definición idéntica al archivo, 3 comentarios de columna, 2 pendientes intactas, 0 `fecha_venta` divergentes · md5 del texto registrado = md5 del archivo (también pasos 1–3) |
| 5 | `p1_e_reconcilia_resolver_turno_fecha` | (se lee al reconciliar) | **OK** · no-op esperado · 7 categorías ✓ · 179 funciones ✓ · 0 cambiadas · `registrar_justificacion_asistencia` md5 = captura de producción · anon secdef 0 · 158 registradas · md5 registrado = archivo |
| 6 | `p2_a_reportes_business_date` | (se lee al reconciliar) | **OK** · 7 categorías ✓ · 180 funciones ✓ · 4/4 idénticas · sin sobrecargas residuales (3 funciones de reporte, una firma cada una) · anon secdef 0 · 159 registradas · md5 registrado = archivo |
| 7 | `p2_b_sucursal_activa` | (se lee al reconciliar) | **OK** · 7 categorías ✓ · 180 funciones ✓ · 32/32 idénticas (incluye las 3 funciones P0 intocables, sólo con la sustitución) · grants sin cambio · anon secdef 0 · 160 registradas · md5 registrado = archivo |
| 8 | `p2_c_rls_puntos_cliente` | (se lee al reconciliar) | **OK** · 7 categorías ✓ (huella de policies sin cambio, como se esperaba) · 180 funciones ✓ · 0 cambiadas · dirigida: `cliente_puntos_read` correlaciona con `cliente_puntos_movimientos.cliente_id`, sin la tautología, rol `{authenticated}`, única policy de la tabla · anon secdef 0 · 161 registradas · md5 registrado = archivo |
| 9 | `p2_d_crm_alcance` | (se lee al reconciliar) | **OK** · 7 categorías ✓ (privilegios de columna cambian según el ensayo) · 180 funciones ✓ · 2/2 idénticas · dirigida: `authenticated` sin UPDATE en `puntos`/consentimientos, con UPDATE en `nombre` e INSERT en `telefono` · 1 cliente intacto · anon secdef 0 · 162 registradas · md5 registrado = archivo |
| 10 | `p2_e_cierre_diario_clasificado` | (se lee al reconciliar) | **OK** · 7 categorías ✓ · 181 funciones ✓ · 5/5 idénticas · `private.checks_cierre_diario` sin EXECUTE para `authenticated` · 0 cierres existentes (nada que reinterpretar) · anon secdef 0 · 163 registradas · md5 registrado = archivo |
| 11 | `p2_f_incidencias` | (se lee al reconciliar) | **OK** · 7 categorías ✓ (tablas, constraints, policies y RLS nuevas según el ensayo) · 185 funciones ✓ · 4/4 idénticas · dirigida: trigger append-only presente, `authenticated` sólo SELECT (sin INSERT/UPDATE ni USAGE de secuencia), `anon` sin SELECT, índice de deduplicación presente · 0 incidencias · anon secdef 0 · 164 registradas · md5 registrado = archivo |
| 12 | `p2_g_reimpresiones` | (se lee al reconciliar) | **OK** · 7 categorías ✓ · 187 funciones ✓ · 2/2 idénticas · dirigida: trigger append-only presente, `authenticated` sólo SELECT (sin INSERT ni USAGE de secuencia), `anon` sin SELECT · 0 reimpresiones · anon secdef 0 · 165 registradas · md5 registrado = archivo |
| 13 | `p2_h_capacidades` | (se lee al reconciliar) | **OK** · 7 categorías ✓ · 189 funciones ✓ · 2/2 idénticas · dirigida: policy `ordenes_actualizacion_tecnica` usa `tiene_capacidad('operar_taller')` en USING y WITH CHECK, sin lista de puestos · `private.tiene_capacidad` EXECUTE sólo para `authenticated` (no `anon`) · anon secdef 0 · 166 registradas · md5 registrado = archivo |
| 14 | `p2_i_capacidades_funciones` | (se lee al reconciliar) | **OK** · 7 categorías ✓ · 189 funciones ✓ · 17/17 idénticas (sustitución de capacidades sobre las definiciones de `_p2_b`) · grants sin cambio · anon secdef 0 · 167 registradas · md5 registrado = archivo |
| 15 | `p2_j_reembolsos_proveedor` | (se lee al reconciliar) | **OK** · 7 categorías ✓ · 195 funciones ✓ · 6/6 idénticas · dirigida: 2 triggers append-only, `authenticated` sólo SELECT en ambas tablas, sin USAGE de secuencia, `private.estado_reembolso_proveedor` sin EXECUTE · anon secdef 0 · **168 registradas** · md5 registrado = archivo · datos intactos (2 conciliaciones pendientes, 1 caja abierta, 5 reservas vencidas, 5 ventas reales, 0 tablas sin RLS) |

**Paso 2 cerrado:** 15/15 migraciones aplicadas una a una, cada una verificada antes de la siguiente; ninguna bandera en falso.

### Paso 3 — Reconciliación de nombres

Versiones reales leídas de `supabase_migrations.schema_migrations` (sólo lectura):

| Versión | Nombre | md5 registrado = archivo local |
|---|---|---|
| 20260913221937 | p1_a_transferencias_parciales | ✓ |
| 20260913222322 | p1_b_recepcion_idempotente | ✓ |
| 20260913222534 | p1_c_caja_umbral_autorizacion | ✓ |
| 20260913222756 | p1_d_pagos_conciliacion | ✓ |
| 20260913223130 | p1_e_reconcilia_resolver_turno_fecha | ✓ |
| 20260913223305 | p2_a_reportes_business_date | ✓ |
| 20260913224059 | p2_b_sucursal_activa | ✓ |
| 20260913224213 | p2_c_rls_puntos_cliente | ✓ |
| 20260913224318 | p2_d_crm_alcance | ✓ |
| 20260913224516 | p2_e_cierre_diario_clasificado | ✓ |
| 20260913224644 | p2_f_incidencias | ✓ |
| 20260913224743 | p2_g_reimpresiones | ✓ |
| 20260913224843 | p2_h_capacidades | ✓ |
| 20260913225428 | p2_i_capacidades_funciones | ✓ |
| 20260913225613 | p2_j_reembolsos_proveedor | ✓ |

Renombrado local `_pN_x_….sql` → `<versión>_pN_x_….sql` con guarda de md5 previa (si un solo archivo no coincidía, no se movía ninguno). Resultado: 0 nombres provisionales, 168 archivos. Ningún script, workflow ni fuente referencia rutas provisionales (todos resuelven por `scripts/lib/migraciones.mjs`). `generar-p2b.mjs` y `generar-p2i.mjs` abortan (exit 1) al detectar la forma versionada; el directorio queda intacto.

### Paso 4 — Paridad producción ↔ repositorio

Snapshot de sólo lectura de producción (lista de migraciones y `md5(prosrc)` de las 195 funciones) comparado contra el repo y contra el ensayo compuesto (`paso-15`):

| Comprobación | Resultado |
|---|---|
| 168 archivos locales, todos versionados | PASS |
| md5 de la lista `version_nombre` local = producción (`9c8850190e261b09c64b7c9175b4dc98`) | PASS |
| Base de producción (153) + 15 nuevas = producción | PASS |
| 195 funciones en producción y en el ensayo; mismo conjunto de firmas | PASS |
| Las 72 funciones creadas o cambiadas por el release, idénticas al ensayo | PASS |
| Sin funciones inexplicadas: 162 idénticas al ensayo + 33 con la deriva de formato previa ya revisada (no tocadas por el release) | PASS |
| Toda función no tocada conserva su md5 previo al release | PASS |
| Invariantes (verificación del paso 15): anon secdef 0 · tablas sin RLS 0 · datos operativos intactos | PASS |

### Paso 5a — Validación local final con nombres versionados

| Gate | Resultado |
|---|---|
| Ensayo compuesto | huella 7/7 · 15/15 migraciones · estructurales 30/30 · negocio 132/132 · STATUS PASS |
| Reproducibilidad | las 16 instantáneas `paso-00…15` regeneradas son byte a byte idénticas a las usadas en producción |
| Generadores | `generar-p2b` y `generar-p2i` abortan (forma versionada); directorio intacto |
| Suites SQL (`authenticated`) | transferencias 63/63 · recepción 96/96 · caja 32/32 · pagos 41/41 |
| E2E navegador | Caja 6/6 · Transferencias 4/4 · Offline 3/3 · 0 fugas (85 al preview, 425 al Supabase simulado, 0 a otros orígenes; canario 2/2 bloqueado) |
| `npm test` / lint / build | exit 0 · 393 PASS · lint 0 errores (3 avisos preexistentes) · build OK |
| Escaneo de secretos del diff | sin credenciales (sólo lecturas de `Deno.env` y la URL local del ensayo) |

## PLAN DE RELEASE (serializado; nada de esto se ha ejecutado todavía)

**0. Candidato local final** (sin cambios posteriores): gate estático, ensayo compuesto completo,
4 suites SQL, E2E; `git status` revisado (sin secretos, sin artefactos).

**1. Auditoría de producción, sólo lectura:** 153 migraciones y última `20260911024014`; huella del
esquema = `REFERENCIA` del ensayo; anon SECURITY DEFINER = 0; RLS sin tablas desprotegidas; datos
clasificados (5 reservas, 1 caja, 2 conciliaciones) sin cambios.

**2. Aplicar, una a una con `apply_migration`, en este orden exacto** (nombre sin guion inicial), y tras
CADA una verificar con consultas de sólo lectura (objetos creados, grants, anon secdef = 0) antes de la
siguiente; ante cualquier fallo, detenerse:
`p1_a_transferencias_parciales` → `p1_b_recepcion_idempotente` → `p1_c_caja_umbral_autorizacion` →
`p1_d_pagos_conciliacion` → `p1_e_reconcilia_resolver_turno_fecha` (no-op) →
`p2_a_reportes_business_date` → `p2_b_sucursal_activa` → `p2_c_rls_puntos_cliente` → `p2_d_crm_alcance` →
`p2_e_cierre_diario_clasificado` → `p2_f_incidencias` → `p2_g_reimpresiones` → `p2_h_capacidades` →
`p2_i_capacidades_funciones` → `p2_j_reembolsos_proveedor`.

**3. Reconciliar nombres:** leer las versiones reales asignadas y renombrar cada `_pN_x_….sql` a
`<versión>_pN_x_….sql` (el ensayo y las suites ya lo soportan; los generadores se niegan a regenerar).

**4. Paridad:** 168 migraciones en producción = archivos locales; huella por función de las nuevas
= la del ensayo; invariantes (`p04_invariantes_admin`, anon secdef 0, sin autorización por puesto).

**5. Validación local final** con los nombres versionados → **un único commit** → **un único push**
→ CI verde → Vercel READY en el MISMO SHA → el bundle servido corresponde al SHA → **una** aceptación
de sólo lectura.

**Retenido hasta decisión del dueño (no forma parte del release automático):**
- Despliegue de la Edge Function `agente-whatsapp`: sin `WHATSAPP_APP_SECRET` el bot deja de procesar
  entrantes (fallo cerrado deliberado). Requiere cargar el secreto antes o aceptar la pausa.
- Habilitar una segunda sucursal: permitido sólo después de `_p2_b` en producción.

**Efectos visibles tras el release que hay que comunicar:** la caja abierta desde 2026-09-07 bloqueará
el próximo cierre diario hasta cerrarla por el flujo normal; las 2 conciliaciones pendientes aparecerán
como warning del cierre y como incidencias al detectar.

**Acciones del dueño al final:** activar Leaked Password Protection; confirmar que el registro público
de usuarios de Supabase Auth está desactivado; `supabase migration repair` para reconstrucción desde
cero (deuda DevOps); decidir el despliegue de `agente-whatsapp`. Frontend: mismas tres
reglas en 8 sitios (`App.tsx` InventoryOpsRoute, `Layout.tsx`, `Compras.tsx`, `ConteoInventario.tsx`
×2, `Seriales.tsx` ×2, `Taller.tsx`).

## Clasificación de datos de producción (sólo lectura, 2026-09-13) — sin sanear

| Objeto | Hechos | Clasificación | Acción |
|---|---|---|---|
| 5 reservas IMEI vencidas | productos `is_test`, serial en `baja`, staff QA inactivo, creadas 2026-09-07 00:31–00:52 UTC (ventana QA de P0), ninguna venta posterior, 159 h vencidas | residuo QA, inocuo: las vencidas se ignoran y se limpian perezosamente | ninguna; opcional limpieza auditada |
| 1 caja abierta `db4fb8e5` | abierta 2026-09-07 00:52 UTC, 7 días, 0 movimientos, 0 ventas, `is_test=false`, cajero activo | warning operativo (no integridad): impide a ese cajero abrir otra por el índice único | el dueño la cierra por el flujo normal (auditado) |
| 2 conciliaciones pendientes | Yape S/ 107 (venta 2026-08-15) y tarjeta S/ 157 (2026-08-19); ventas reales completadas, pagos existen | backlog real de negocio | confirmación del administrador contra el extracto del proveedor; warning en cierre diario |

## OLA 2 · Fase 22 — Reportes (en curso)

Auditoría contra esquema y datos reales (consultas de sólo lectura; producción corre en `TimeZone=UTC`):

| # | Defecto | Evidencia | Corrección (`_p2_a_reportes_business_date.sql`) |
|---|---|---|---|
| D1 | `reportes_avanzados_admin` filtraba con `p_desde::timestamptz` → día de 19:00 a 19:00 Lima | sesión UTC; 5 ventas reales, 0 afectadas hoy (latente) | filtro por `sales.business_date` |
| D2 | cajas y taller igual | mismo cast | `(x at time zone 'America/Lima')::date` |
| D3 | margen restaba el descuento dos veces | trigger exige `subtotal = (precio − descuento) × cantidad` | ingreso = `sum(subtotal)` |
| D4 | sin filtro de sucursal en los 3 reportes | — | `p_location_id uuid default null` |
| D5 | devoluciones no restaban | `devolucion_items.monto` = parte de `subtotal` sin IGV | campos aditivos `devoluciones_*`, `ingreso_neto`, `margen_neto` |
| D6 | `Reportes.tsx` semana/mes = ahora − N×24 h | código | inicio del día comercial de Lima |

Compatibilidad: DROP de las firmas viejas (evita sobrecarga ambigua en PostgREST), nuevo parámetro con
default al final; ACL de producción repuesta (authenticated + service_role, sin PUBLIC). Helper
`private.reporte_resumen_periodo` invocador y sin EXECUTE para nadie. Rango máximo 367 días.
UI `ReportesAvanzados.tsx`: selector de sucursal, tarjetas de devoluciones y margen neto, Excel.

Nuevo en el ensayo compuesto: **Fase 3 · pruebas de negocio** sobre el esquema real completo
(`scripts/compuesto/*.mjs`, como `authenticated`, en transacción con rollback). Primer módulo:
`reportes.mjs` (cifras exactas, franjas 20:30/23:30, sucursal, comparación, compatibilidad, vendedor,
anon, helper privado, RLS real de las funciones invocadoras). Primera ejecución: el sembrado chocó con
el índice real `cash_sessions_one_open_per_staff` (sesiones sembradas abiertas); corregido.

**Ensayo compuesto #9 — PASS:** huella 7/7 · 6/6 migraciones nuevas · estructurales 27/27 ·
negocio 28/28. Gate estático tras la UI: test 0 · lint 0 · build 0.

**Mutación (`ENSAYO_OMITIR=_p2_a_reportes_business_date.sql`) — FAIL esperado, 19/28 de negocio
fallan** con las funciones actuales de producción: `ventas_total=354` (la venta de las 20:30 se cae y
entra la de las 23:30 del día anterior), margen 111 en vez de 150, taller y cajas en el día equivocado,
sin filtro de sucursal. Las 9 que pasan son las que deben pasar con ambas versiones (acceso admin,
rechazo a vendedor/anon, llamadas viejas, rango invertido, ventana Lima de `resumen_ganancias`).
Primer intento de mutación abortó en la comprobación del helper (función inexistente lanzaba
excepción); corregido con `to_regprocedure` para que falle como comprobación y no aborte.
El interruptor sólo quita migraciones y un resultado con omisiones nunca cuenta como PASS.

**Clasificación completa de las 42 funciones con texto distinto** (diff por hashes de línea sin
traer cuerpos completos; luego texto real de las líneas sólo-producción):
- 19: sólo espacios (coinciden con espacios colapsados).
- 18: comentarios internos con redacción anterior + otra disposición de líneas (coinciden sin
  comentarios `--` ni espacios; cada línea sólo-producción revisada: todas son comentarios).
- 4: equivalentes no normalizables, revisadas a mano y **fijadas por par de md5**
  (`.p04-pgtest/huella-funciones-revisadas.txt`): `consumir_autorizacion`,
  `resolver_autorizacion`, `solicitar_autorizacion` (`end;` vs `end`) y `mi_estado_jornada`
  (alias con/sin `as`).
- **1 con deriva de LÓGICA: `public.registrar_justificacion_asistencia`.** En producción
  resuelve el turno con `private.resolver_turno_fecha` (respeta excepciones de turno); el repo
  (20260824122859) consulta `staff_turnos` directo. Mismo cambio manual que creó
  `resolver_turno_fecha`. **Reconciliada en `_p1_e`** con la definición exacta
  (pg_get_functiondef, SECURITY INVOKER, ACL authenticated+service_role, sin PUBLIC).
  Aplicarla en producción es un no-op.

**Hallazgo de seguridad en P1 (lo detectó sólo el ensayo compuesto):** tras aplicar P1, **3
funciones SECURITY DEFINER ejecutables por `anon`**: `recibir_transferencia_parcial`,
`cerrar_transferencia_stock` y `transferencia_detalle`. `_p1_a` concedía `EXECUTE` a
`authenticated` pero nunca revocaba `PUBLIC`, y una función nueva nace con `EXECUTE` para
`PUBLIC`. `despachar`/`recibir_transferencia_stock` no aparecían porque ya existían con `anon`
revocado y `CREATE OR REPLACE` conserva la ACL. **Rompía el invariante de P0.4.** Corregido con
`revoke all ... from public` en las cinco (no `from anon`: el arnés de transferencias no crea ese
rol) manteniendo el `grant` explícito a `authenticated`.

**E2E de navegador limpio:** Caja 6/6 · Transferencias 4/4 · 0 fugas · 0 hallazgos. CAJA-RECARGA
resultó un artefacto de medida: la ventana se tomaba tras el toast y la recarga sale en paralelo.
Anclada al número de la propia llamada fallida, la lectura aparece.

**Deuda de DevOps (acción del dueño):** una reconstrucción desde cero con la CLI de Supabase
aplica por versión y seguiría chocando en `124052`. Resolverlo del todo exige
`supabase migration repair` o un baseline. Afecta a la recuperación ante desastre, no a
producción.

E2E: CAJA-RECARGA y CAJA-GUARDA corregidas en `Caja.tsx` (el primer intento usaba `.finally()`,
que el builder de PostgREST no expone, y rompió el build; corregido con `try/finally`).
Pendientes documentales en `_p1_b`: cabecera (B6) y comentario del bloque C2.

### Datos reales para el shim del ensayo compuesto
- `search_path` de la base: `"$user", public, extensions`. `conrelid::regclass::text` y
  `pg_get_function_identity_arguments` dependen del `search_path`: la huella local debe
  calcularse con el mismo.
- **Collation:** los `ORDER BY` sobre texto ordenan según la collation de la base; `_` frente
  a letra ordena distinto en `C` y en `en_US`, lo que cambiaría el md5 sin cambiar el
  contenido. La huella de referencia se recalcula con `COLLATE "C"` en ambos lados, y el
  squad de integración se lanza sólo con esos valores.
- Extensiones en `extensions` (pg_net, pg_stat_statements, pgcrypto, uuid-ossp); vault aparte.
- Privilegios por defecto de `postgres` en `public`: tablas `arwdDxtm`, funciones `X` y
  secuencias `rwU` para `authenticated` y `service_role`, **no para `anon`**. Las migraciones
  deben ejecutarse localmente como un rol `postgres` con esos privilegios por defecto.
- Definiciones reales de `auth.uid()`, `auth.role()` y `auth.jwt()` obtenidas de producción
  (aplican `nullif` antes del cast, a diferencia del stub que rompió H6).
- `auth.mfa_factors.status` y `storage.buckets.type` son tipos enumerados.
- Privilegios de columna (anon/authenticated/service_role): 5169 filas. Constraints con
  `contype <> 'n'`: mismo md5 que sin filtro, lo que confirma que PG17 no tiene filas `n`.
- `ConciliacionPagos.tsx` — correcta: agrupa por día comercial de Lima, un rechazo envía
  confirmado nulo, exige referencia de proveedor.

### Recepción: la migración NO aplica en la FASE B

Tras arreglar `estado()` la suite pasa la FASE A y falla en B1 al aplicar `_p1_b` sobre
el esquema reescrito. Nunca se había llegado aquí.

**Causa: un defecto previo de la migración original, no el envoltorio C2.** La propia
`_p1_b` contiene un bloque `DO` de autocomprobación que exige "exactamente 1 versión de
recibir_orden_compra". Contra cualquier base donde ya exista la firma de 3 args —**es
decir, producción**— esa comprobación da 2 aunque no exista C2, porque ELITE-09 nunca
escribió el `DROP`. **Tal como la dejó el squad, la migración era imposible de aplicar en
producción: habría abortado en pleno deploy.** C2 mantiene 2 versiones a propósito; la
autocomprobación debe exigir exactamente las dos identidades previstas, ninguna más, y
que la de 3 args sólo delegue.

Semántica del ajuste en el servidor (confirmada, líneas 261–316 de `_p1_c`): monto con
signo y distinto de cero; autorización si `abs > umbral`; `payload.monto` debe ser número
JSON > 0 y se compara contra el valor absoluto.

### Bloqueo de recepción — diagnosticado

**Es del arnés, no de la migración.** La FASE A carga a propósito el esquema *de hoy*
y la función *vieja* para reproducir la duplicación antes de arreglarla, pero `estado()`
selecciona `client_transaction_id`, `payload_hash` y `corrige_recepcion_id`, columnas que
sólo existen tras la migración. Corrección pendiente: `estado()` debe leer vía
`to_jsonb(r)` para tolerar ambas fases.

### Conflicto de diseño C2 vs ELITE-09 — resuelto a favor de C2

El arnés original afirmaba lo contrario de C2 (B2: una sola versión; B2b: la firma de 3
args no existe; B3: llamarla falla con `does not exist`). **Pero la migración de ELITE-09
nunca escribió ese `DROP`**: la función vieja que duplica seguía viva, y B2 lo habría
detectado si el arnés no hubiera muerto antes en la FASE A. Bug real de la migración
original, ahora cerrado por C2.

Escribir el `DROP` violaría el gate duro de compatibilidad (frontend en vivo + bundles
offline). C2 resuelve la preocupación de ELITE-09 por otra vía: el cliente viejo ya no
llega al cuerpo viejo que duplicaba, sino a la lógica nueva con todas sus validaciones.

**Descartado deduplicar por contenido** para clientes sin clave: fundiría dos recepciones
parciales legítimas e idénticas (4 unidades el lunes, 4 el martes) y dejaría el stock
corto en silencio, peor que un duplicado visible. Mismo criterio que C1 en caja.

B2–B4 reescritas: dos firmas exactas y ninguna extra; la de 3 args sólo delega (sin
`insert into` propio); el bundle viejo recibe por la lógica nueva (clave generada, hash
md5 real, un movimiento con delta real); y sin clave dos envíos son dos recepciones,
fijado como coste documentado.

### Próximo paso exacto (actualizado)

1. Resolver el `42703` del arnés de recepción y dejar la suite en verde.
2. Añadir pruebas de compatibilidad: C1 (sin clave, egreso grande exige autorización),
   C2 (firma de 3 args con payload viejo devuelve `recepciones_compra`), C3 (las 5
   llamadoras reales de `insertar_movimiento_caja` resuelven tras el DROP+CREATE).
3. Frontends pendientes: `Transferencias.tsx` y `Compras.tsx` (nunca se tocaron).
4. Relanzar como máximo DOS agentes a la vez.

## Producción

Intacta respecto a `70578db`. No se ha ejecutado ninguna escritura de esta fase.

Datos preexistentes a clasificar (NO sanear sin justificación): 5 reservas IMEI vencidas
del 2026-09-07, 1 caja abierta desde 2026-09-07, 2 conciliaciones pendientes.

## Próximo paso exacto

Ejecutar OLA 1 con los cuatro squads. Cada uno entrega: estado inicial verificado,
gaps, archivos asignados, implementación, pruebas locales contra PostgreSQL real
(`.p04-pgtest/`), riesgos y veredicto GO/NO-GO. Nada se aplica a producción hasta
que las cuatro olas estén integradas y el red team final dé GO.

## Acciones prohibidas pendientes

- No fusionar `origin/elite/wave-2`.
- No desplegar de forma intermedia: un único push final.
- No usar producción para pruebas mutantes ni carreras concurrentes.
- No evadir ningún permission gate; si deniega, parar e informar.
- No implementar con `apply_migration` iterativo: sólo la migración final validada.
- No borrar los datos preexistentes listados arriba sin clasificarlos antes.
- Protección de contraseñas filtradas de Supabase: configuración externa, se pide
  al dueño **sólo cuando todo lo demás esté terminado**.
