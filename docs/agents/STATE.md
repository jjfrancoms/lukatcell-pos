# Agent State — LukatCell POS

Última actualización: 2026-09-13. Checkpoint reanudable: [CURRENT_EXECUTION.md](CURRENT_EXECUTION.md).

## Stack

React + TypeScript + Vite · Supabase (Postgres 17.6, Auth, Edge Functions, Storage) · Vercel · GitHub Actions.

## Producción

- **168 migraciones registradas.** Las 15 de OLA 1–4 se aplicaron el 2026-09-13, una a una, cada una
  verificada antes de la siguiente (huellas de columnas, constraints, policies, grants, RLS y privilegios
  de columna; `md5(prosrc)` de cada función tocada; texto registrado = archivo del repo).
- Paridad producción ↔ repositorio: lista de migraciones idéntica (md5), 195 funciones, las 72 tocadas
  por el release idénticas al ensayo compuesto.
- Invariantes vigentes: tablas públicas sin RLS = 0; SECURITY DEFINER ejecutable por `anon` = 0;
  `products.costo` oculto para `authenticated`; productos/ventas `is_test` fuera de finanzas.
- Deriva histórica codificada en `20260913223130_p1_e_reconcilia_resolver_turno_fecha`. Quedan 33
  funciones que difieren del repo sólo en formato/comentarios (verificadas; ninguna migración nueva las toca).
- Edge Function `agente-whatsapp`: el código con verificación de firma está en el repo, **no desplegada**
  (decisión del dueño; requiere `WHATSAPP_APP_SECRET`).

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

- La caja abierta desde 2026-09-07 **bloquea el próximo cierre diario** hasta cerrarla con su arqueo.
- La edición CRM de documento, segmento y consentimientos es **sólo de administración**.
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
pendientes); deuda P2 de OLA 1; validación de impresora física con hardware.
Ver [BACKLOG.md](BACKLOG.md) y [CURRENT_EXECUTION.md](CURRENT_EXECUTION.md).
