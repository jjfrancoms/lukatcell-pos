# Seguridad del webhook de WhatsApp

## Estado actual

- `agente-whatsapp` necesita `verify_jwt=false` porque Meta llama el webhook sin JWT de Supabase.
- El GET de verificación sí valida `WEBHOOK_VERIFY_TOKEN`.
- El POST debe validar adicionalmente `X-Hub-Signature-256` antes de procesar el body.

## Pendiente externo

Configurar en Supabase Edge Function Secrets:

```text
WHATSAPP_APP_SECRET=<App Secret de la aplicación de Meta>
```

No guardar este valor en GitHub, `.env` público ni código fuente.

## Validación requerida

1. Leer el body como bytes/texto crudo antes de `JSON.parse`.
2. Leer `X-Hub-Signature-256`.
3. Calcular HMAC-SHA256 del body crudo usando `WHATSAPP_APP_SECRET`.
4. Comparar en tiempo constante contra el hash enviado por Meta.
5. Rechazar con HTTP 401 si falta la firma o no coincide.
6. Solo después parsear y procesar el mensaje.

## Pruebas de aceptación

- GET con verify token correcto → `200` + challenge.
- GET con token incorrecto → `403`.
- POST sin `X-Hub-Signature-256` → `401`.
- POST con firma inválida → `401`.
- POST con firma válida → `200` y procesa el evento.

Relacionado: GitHub Issue #2.
