# Agent State — LukatCell POS

Última actualización: 2026-09-27 (olas P3, P4.A y P4.B en producción; auditoría de integridad POS). Checkpoint reanudable: [CURRENT_EXECUTION.md](CURRENT_EXECUTION.md).

## Stack

React + TypeScript + Vite · Supabase (Postgres 17.6, Auth, Edge Functions, Storage) · Vercel · GitHub Actions.

## Producción

- **174 migraciones registradas** (`p4_b` el 2026-09-27: alta de inventario atómica por RPC
  `registrar_stock_inicial`; `authenticated` pierde el INSERT directo sobre `inventory`).
- **173 migraciones** (`p4_a` el 2026-09-27: inventario con no-negatividad por restricción y cantidad sólo por función).
- **172 migraciones** (las 4 de la ola P3 el 2026-09-27; ver CURRENT_EXECUTION).
- **168 migraciones** al cierre de OLA 1–4. Las 15 de OLA 1–4 se aplicaron el 2026-09-13, una a una, cada una
  verificada antes de la siguiente (huellas de columnas, constraints, policies, grants, RLS y privilegios
  de columna; `md5(prosrc)` de cada función tocada; texto registrado = archivo del repo).
- Paridad producción ↔ repositorio: lista de migraciones idéntica (md5), 195 funciones, las 72 tocadas
  por el release idénticas al ensayo compuesto.
- Tras `p3_d`: 0 tablas con TRUNCATE para `authenticated`, 0 secuencias accesibles (correlativos
  fiscales incluidos), `documento`/`direccion` de clientes sólo por la RPC de administración, y los
  tres libros de movimientos sin UPDATE/DELETE. Tras `p3_a`: 0 funciones sin `search_path`.
- Auditoría de integridad POS (2026-09-27): 18 de 21 invariantes con 0 violaciones; las 3 restantes
  investigadas una a una (centinela deliberado, chequeo propio incompleto y datos históricos). Las
  21 quedan como prueba permanente en `scripts/compuesto/pos_integridad.mjs`.
- Invariantes vigentes: tablas públicas sin RLS = 0; SECURITY DEFINER ejecutable por `anon` = 0;
  `products.costo` oculto para `authenticated` (en SELECT); productos/ventas `is_test` fuera de finanzas.
  **Estos invariantes no cubren TRUNCATE ni los privilegios de secuencia**, que la RLS no filtra: ver
  los hallazgos abiertos del red team en BACKLOG.
- Deriva histórica codificada en `20260913223130_p1_e_reconcilia_resolver_turno_fecha`. Quedan 33
  funciones que difieren del repo sólo en formato/comentarios (verificadas; ninguna migración nueva las toca).
- Edge Function `agente-whatsapp`: el código con verificación de firma está en el repo, **no desplegada**
  (decisión del dueño; requiere `WHATSAPP_APP_SECRET`).

## Release publicado

- Commit de release: **`5149079`** (`OLA 1–4: transferencias, recepción, caja, …`), `main`.
  Evidencia: `git log --oneline -1` → `5149079`.
- **CI PASS** en ese commit: workflow `CI`, run `34788694062`, conclusión `success`,
  `headSha 514907991ca8d51cdcccc93d86e447f1142f2b99`. Evidencia:
  `gh run view 34788694062 --json headSha,conclusion`.
- Gates locales reproducidos el 2026-09-17 sobre el árbol de `5149079`: `npm test` (exit 0),
  `npm run lint` (exit 0, 0 errores), `npm run build` (exit 0), y las 4 suites SQL contra PostgreSQL
  real: transferencias 63/63, recepción 96/96, caja 32/32, pagos 41/41 (exit 0 las cuatro).
- Workflow `Integración (PostgreSQL real + navegador)`: primera ejecución en runner Linux el
  2026-09-27, run **36332296929**, job `postgres-y-navegador`, conclusión **success**, sin pasos
  fallidos y sin necesitar correcciones.
- Despliegue de Vercel: **NO VERIFICADO desde esta sesión.** El token disponible sólo ve el equipo
  `msjuanjf-5186s-projects`, cuyo listado de proyectos vuelve vacío, y no hay `.vercel/project.json`
  en el repo. El estado `READY` lo reporta el coordinador; aquí no hay evidencia reproducible.

## Migraciones de OLA 1–4 (en producción)

| Versión | Migración | Qué corrige |
|---|---|---|
| 20260913221937 | `p1_a_transferencias_parciales` | recepción por línea/serial, diferencias, idempotencia |
| 20260913222322 | `p1_b_recepcion_idempotente` | recepción de compras idempotente y corregible |
| 20260913222534 | `p1_c_caja_umbral_autorizacion` | umbral de egreso + autorización operativa |
| 20260913222756 | `p1_d_pagos_conciliacion` | conciliación sin doble aceptación ni referencias duplicadas |
| 20260913223130 | `p1_e_reconcilia_resolver_turno_fecha` | deriva de producción codificada (no-op en prod) |
| 20260913223305 | `p2_a_reportes_business_date` | reportes por día comercial Lima y sucursal |
| 20260913224059 | `p2_b_sucursal_activa` | 32 funciones con la sucursal activa (generada) |
| 20260913224213 | `p2_c_rls_puntos_cliente` | policy tautológica de puntos de cliente |
| 20260913224318 | `p2_d_crm_alcance` | alcance del perfil CRM y columnas escribibles de `clientes` |
| 20260913224516 | `p2_e_cierre_diario_clasificado` | cierre diario con verificaciones P0/P1/warning |
| 20260913224644 | `p2_f_incidencias` | centro de incidencias |
| 20260913224743 | `p2_g_reimpresiones` | reimpresión con rastro y copia numerada |
| 20260913224843 | `p2_h_capacidades` | capacidades centralizadas |
| 20260913225428 | `p2_i_capacidades_funciones` | 17 funciones con capacidades (generada) |
| 20260913225613 | `p2_j_reembolsos_proveedor` | terminal de conciliación y reembolsos a proveedor |

## Efectos operativos que el negocio debe conocer

- La caja abierta desde el **2026-09-06 19:52 hora de Lima** (`2026-09-07 00:52 UTC`; producción corre
  en `TimeZone=UTC` y la fecha comercial del negocio es la de `America/Lima`, UTC−5) **bloquea el
  próximo cierre diario** hasta cerrarla con su arqueo. Las 5 reservas IMEI vencidas son de la misma
  ventana: 2026-09-06 19:31–19:52 Lima.
- La edición CRM de **segmento, consentimientos y puntos** es **sólo de administración**
  (`actualizar_cliente_crm` exige admin y `authenticated` perdió el INSERT/UPDATE de tabla).
  **Corrección (2026-09-17):** `documento` y `direccion` NO quedaron restringidos — `_p2_d` les da
  privilegio de columna a `authenticated` (líneas 119–121 de
  `20260913224318_p2_d_crm_alcance.sql`) y la policy `clientes_actualizacion_autenticados` es
  `USING true / WITH CHECK true`: cualquier autenticado puede reescribirlos en cualquier cliente.
  Hallazgo abierto del red team (ver BACKLOG).
- Los flags `puede_inventario` / `puede_taller` por sucursal se aplican de verdad en el servidor.
- Habilitar una 2.ª sucursal ya es seguro a nivel de servidor (`p2_b` en producción).

## Validación

- Ensayo compuesto (`scripts/verify-migraciones-compuestas.mjs`) con los nombres versionados: huella 7/7
  contra la base de producción, 15/15 migraciones, estructurales 30/30, negocio 132/132 (10 módulos).
- Mutación por migración (`ENSAYO_OMITIR`): cada módulo falla sin su corrección.
- Suites SQL como `authenticated`, E2E de navegador (Caja, Transferencias, Offline), `npm test`, lint y build.

## Reglas operativas vigentes

- Sin despliegues intermedios; escrituras de producción serializadas; `apply_migration` sólo con la
  migración final validada; nada de registrar migraciones con `execute_sql`.
- Una migración ya aplicada no se edita ni se regenera: `generar-p2b.mjs` / `generar-p2i.mjs` abortan
  si existe la forma versionada. Todo cambio posterior es una migración nueva.
- Sin pruebas mutantes ni carreras en producción; sólo consultas de lectura para auditoría.
- El `.env` del repo apunta a producción: los E2E usan un origen falso y verifican el bundle.

## Bloqueos externos (acción del dueño)

Leaked Password Protection (panel) · confirmar registros de Auth deshabilitados · `WHATSAPP_APP_SECRET` y
despliegue de `agente-whatsapp` · credenciales POS externo/Culqi · `supabase migration repair`.

## Próximo trabajo

Datos de producción a clasificar con el negocio (5 reservas IMEI vencidas, 1 caja abierta, 2 conciliaciones
pendientes); decisión de T5 (sobrante de transferencia); interfaz para revertir unidades con IMEI (el
servidor ya la soporta desde `p3_c`); módulo de compras en el ensayo compuesto; validación de impresora
física con hardware. La deuda interna de ingeniería del núcleo POS queda cerrada con `p4_b`.
Ver [BACKLOG.md](BACKLOG.md) y [CURRENT_EXECUTION.md](CURRENT_EXECUTION.md).
