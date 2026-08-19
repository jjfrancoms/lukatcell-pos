# Boleta / Factura electrónica (Nubefact) — Guía de despliegue

Este documento explica cómo activar la emisión de comprobantes electrónicos (boleta/factura) de LUKATCELL vía [Nubefact](https://www.nubefact.com), un OSE/PSE autorizado por SUNAT. Requiere la migración SQL `20260819170156_comprobantes_electronicos_nubefact.sql` y la Edge Function `emitir-comprobante` (ambas ya incluidas en el repo).

## 1. Crear la cuenta en Nubefact

1. Regístrate en https://www.nubefact.com con el RUC de LUKATCELL.
2. En el panel de Nubefact, configura tus **series** de Boleta y Factura (por defecto Nubefact suele asignar `BBB1` y `FFF1` — coinciden con los valores por defecto de esta app, pero confírmalos).
3. En **Configuración → API**, obtén:
   - Tu **URL de API** (`url_token` incluido), algo como `https://api.nubefact.com/api/v1/xxxxx` (o `https://demo.nubefact.com/api/v1/xxxxx` mientras estés en modo de pruebas) → este es tu `NUBEFACT_URL`.
   - Tu **token de API** → este es tu `NUBEFACT_TOKEN`.

> Nubefact ofrece un entorno de pruebas (demo) separado del de producción, con su propia URL y token. Usa el de pruebas hasta confirmar que todo funciona, y cambia a producción recién cuando quieras emitir comprobantes reales ante SUNAT.

## 2. Aplicar la migración SQL

Desde la raíz del proyecto (`lukatcell-pos/`):

```bash
supabase link --project-ref TU_PROJECT_REF
supabase db push
```

Esto agrega las columnas de comprobante a `sales` y `configuracion`, crea la tabla `comprobantes_electronicos`, las secuencias de correlativo, y el trigger `on_comprobante_pendiente` que dispara la emisión.

### Configurar el trigger (si no lo hiciste ya para el agente de WhatsApp)

El trigger `emitir_comprobante_trigger()` llama a la Edge Function `emitir-comprobante` vía `pg_net` cuando se crea un comprobante pendiente. Necesita la URL de tu proyecto y tu service role key — **si ya los configuraste para el agente de WhatsApp, este paso ya está hecho** (es la misma configuración compartida):

```sql
alter database postgres set app.settings.supabase_url = 'https://TU_PROJECT_REF.supabase.co';
alter database postgres set app.settings.service_role_key = 'TU_SERVICE_ROLE_KEY';
```

Ambos valores están en **Project Settings → API** del dashboard de Supabase. Si no los configuras, el trigger no falla pero omite la emisión (verás un `WARNING` en los logs de Postgres) — la venta se registra igual, solo queda sin comprobante generado hasta que reintentes manualmente desde Reportes.

## 3. Configurar los secrets de la Edge Function

```bash
supabase secrets set NUBEFACT_URL=https://api.nubefact.com/api/v1/TU_URL_TOKEN
supabase secrets set NUBEFACT_TOKEN=TU_TOKEN_DE_NUBEFACT
```

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` y `SUPABASE_ANON_KEY` **no necesitas configurarlos manualmente** — Supabase los inyecta automáticamente en toda Edge Function.

Verifica los secrets configurados:

```bash
supabase secrets list
```

## 4. Desplegar la Edge Function

```bash
supabase functions deploy emitir-comprobante --no-verify-jwt
```

> `--no-verify-jwt` es necesario porque el trigger de Postgres invoca la función con el service role key en el header `Authorization`, no con un JWT de usuario firmado por el gateway de Supabase. La función valida el llamante por su cuenta (service role key del trigger, o JWT de un usuario ya autenticado en la app para el botón de reintento manual en Reportes) — cualquier otra petición recibe `401`.

## 5. Activar en la app

1. Entra a **Configuración** (como administrador) → sección **Boleta / Factura electrónica (Nubefact)**.
2. Activa **"Emitir comprobante electrónico al vender"**.
3. Confirma que **Serie boleta** y **Serie factura** coincidan exactamente con las que Nubefact te asignó.
4. Guarda.

A partir de este momento, cada venta desde el POS mostrará el selector **Boleta / Factura** en el modal de cobro (con captura de RUC/razón social para factura, DNI opcional para boleta).

## 6. Probar

1. Haz una venta de prueba (usa el entorno demo de Nubefact para no emitir un comprobante real).
2. El ticket físico se imprime de inmediato — la emisión del comprobante electrónico ocurre en paralelo y no bloquea la venta. El recibo en pantalla mostrará "Generando comprobante electrónico...", y si termina mientras el ticket sigue abierto, mostrará el enlace al PDF.
3. Revisa **Reportes**: cada venta muestra una insignia con el estado del comprobante (pendiente / emitido con enlace al PDF / error con botón de reintento).
4. Si algo falla, revisa `supabase functions logs emitir-comprobante`.

## Diseño: por qué la emisión nunca bloquea la venta

La emisión del comprobante ocurre **después** de que la venta ya se guardó exitosamente en la base de datos (trigger `on_comprobante_pendiente` → Edge Function → API de Nubefact). Si Nubefact está caído, mal configurado, o rechaza el comprobante, la venta ya está completa y el stock ya se descontó — solo queda el comprobante en estado `error`, reintentable manualmente desde Reportes sin tocar la venta original. Esto es intencional: un problema con SUNAT/Nubefact nunca debe impedir que el negocio siga vendiendo.

## Resumen de variables de entorno

| Variable | Dónde se obtiene | Dónde se configura |
|---|---|---|
| `NUBEFACT_URL` | Panel de Nubefact → Configuración → API | `supabase secrets set` |
| `NUBEFACT_TOKEN` | Panel de Nubefact → Configuración → API | `supabase secrets set` |
| `SUPABASE_URL` | Automático (inyectado por Supabase) | — |
| `SUPABASE_SERVICE_ROLE_KEY` | Automático (inyectado por Supabase) | — |
| `SUPABASE_ANON_KEY` | Automático (inyectado por Supabase) | — |
| `app.settings.supabase_url` / `app.settings.service_role_key` | Project Settings → API | `alter database postgres set ...` (SQL Editor, una sola vez — compartido con el trigger de WhatsApp) |
