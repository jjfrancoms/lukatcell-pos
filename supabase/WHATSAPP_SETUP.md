# Agente de WhatsApp — Guía de despliegue

Este documento explica cómo desplegar el agente conversacional de WhatsApp para LUKATCELL: dos Edge Functions (`agente-whatsapp` y `notificar-estado`), una migración SQL, y la configuración del webhook en Meta.

## 1. Requisitos previos

- Proyecto de Supabase creado, con [Supabase CLI](https://supabase.com/docs/guides/cli) instalado y logueado (`supabase login`).
- Cuenta de **Meta for Developers** con una app configurada para **WhatsApp Cloud API**: https://developers.facebook.com/apps
- Cuenta de Anthropic con acceso a la API (API key): https://console.anthropic.com

## 2. Obtener credenciales de Meta (WhatsApp Cloud API)

1. Entra a tu app en [Meta for Developers](https://developers.facebook.com/apps) → producto **WhatsApp** → **API Setup**.
2. Ahí encontrarás:
   - **Temporary access token** (válido 24h, para pruebas) o genera un **token permanente** creando un System User en Business Settings con permiso `whatsapp_business_messaging` → este es tu `WHATSAPP_TOKEN`.
   - **Phone number ID** (debajo del número de prueba o tu número verificado) → este es tu `WHATSAPP_PHONE_ID`.
3. Define un valor propio y secreto para `WEBHOOK_VERIFY_TOKEN` (cualquier string aleatorio que tú elijas, ej. generado con `openssl rand -hex 20`). Lo usarás también al configurar el webhook en el paso 6.
4. Para producción, verifica tu número de WhatsApp Business y solicita que la app pase de modo "Development" a "Live" en **App Review**.

## 3. Obtener tu API key de Anthropic

1. Entra a https://console.anthropic.com/settings/keys
2. Crea una API key → este es tu `ANTHROPIC_API_KEY`.

## 4. Aplicar la migración SQL

Desde la raíz del proyecto (`lukatcell-pos/`):

```bash
supabase link --project-ref TU_PROJECT_REF
supabase db push
```

Esto crea las tablas `conversaciones` y `faqs`, inserta las FAQs iniciales, y crea el trigger `on_estado_change` sobre `ordenes_servicio`.

### Configurar el trigger de notificación

El trigger `notificar_cambio_estado()` llama a la Edge Function `notificar-estado` vía `pg_net` cuando cambia el campo `estado` de una orden de servicio. Necesita conocer la URL de tu proyecto y tu service role key. Configúralos **una sola vez** en el SQL Editor del dashboard:

```sql
alter database postgres set app.settings.supabase_url = 'https://TU_PROJECT_REF.supabase.co';
alter database postgres set app.settings.service_role_key = 'TU_SERVICE_ROLE_KEY';
```

Ambos valores los encuentras en **Project Settings → API** de tu dashboard de Supabase. Si no los configuras, el trigger no falla pero omite el envío (verás un `WARNING` en los logs de Postgres).

## 5. Configurar variables de entorno (secrets) de las Edge Functions

```bash
supabase secrets set WHATSAPP_TOKEN=EAAxxxxxxxxxxxxxxxx
supabase secrets set WHATSAPP_PHONE_ID=1234567890123456
supabase secrets set ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
supabase secrets set WEBHOOK_VERIFY_TOKEN=el-token-que-elegiste-en-el-paso-2
```

`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` **no necesitas configurarlos manualmente** — Supabase los inyecta automáticamente en toda Edge Function.

Verifica los secrets configurados:

```bash
supabase secrets list
```

## 6. Desplegar las Edge Functions

```bash
supabase functions deploy agente-whatsapp
supabase functions deploy notificar-estado
```

Ambas quedarán disponibles en:

```
https://TU_PROJECT_REF.supabase.co/functions/v1/agente-whatsapp
https://TU_PROJECT_REF.supabase.co/functions/v1/notificar-estado
```

> **Importante:** `agente-whatsapp` debe aceptar peticiones sin JWT de Supabase (Meta no envía uno). Si tu proyecto tiene "Enforce JWT verification" activado por defecto para Edge Functions, desactívalo para esta función específica:
>
> ```bash
> supabase functions deploy agente-whatsapp --no-verify-jwt
> ```
>
> `notificar-estado` es invocada internamente por el trigger de Postgres con el service role key en el header `Authorization`, así que puede desplegarse igual con `--no-verify-jwt` para simplificar, o mantenerse protegida si prefieres validar el JWT del service role.

## 7. Configurar el webhook en Meta

1. En tu app de Meta → producto **WhatsApp** → **Configuration** → **Webhook**.
2. Click en **Edit** y completa:
   - **Callback URL**: `https://TU_PROJECT_REF.supabase.co/functions/v1/agente-whatsapp`
   - **Verify token**: el mismo valor que configuraste como `WEBHOOK_VERIFY_TOKEN` en el paso 5.
3. Click **Verify and save**. Meta hará un `GET` a tu función con `hub.mode=subscribe`, `hub.verify_token` y `hub.challenge`; la función debe responder con el valor de `hub.challenge` (esto ya está implementado en `index.ts`).
4. En **Webhook fields**, suscríbete al campo **messages**.

## 8. Probar

Envía un mensaje de WhatsApp al número de prueba (o tu número verificado). Deberías ver:

1. El mensaje entrante disparando un `POST` a `agente-whatsapp` (revisa logs con `supabase functions logs agente-whatsapp`).
2. Una respuesta generada por Claude Haiku 4.5 llegando de vuelta al chat de WhatsApp.
3. Si preguntas por un producto, el bot debe usar la herramienta `buscar_producto` (verifica en los logs que se llamó al RPC `buscar_variantes`).

Para probar la notificación de estado, cambia manualmente el `estado` de una orden en la tabla `ordenes_servicio` (por ejemplo a `'listo'`) desde el dashboard o la app, y confirma que el cliente recibe el WhatsApp correspondiente. Revisa `supabase functions logs notificar-estado` si no llega.

## Resumen de variables de entorno

| Variable | Dónde se obtiene | Dónde se configura |
|---|---|---|
| `WHATSAPP_TOKEN` | Meta for Developers → WhatsApp → API Setup | `supabase secrets set` |
| `WHATSAPP_PHONE_ID` | Meta for Developers → WhatsApp → API Setup | `supabase secrets set` |
| `WEBHOOK_VERIFY_TOKEN` | Lo defines tú (string aleatorio) | `supabase secrets set` + webhook de Meta |
| `ANTHROPIC_API_KEY` | console.anthropic.com/settings/keys | `supabase secrets set` |
| `SUPABASE_URL` | Automático (inyectado por Supabase) | — |
| `SUPABASE_SERVICE_ROLE_KEY` | Automático (inyectado por Supabase) | — |
