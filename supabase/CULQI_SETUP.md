# Pago digital verificado con QR (Culqi) — Guía de despliegue

Este documento explica cómo activar la verificación real de pagos con Yape/Plin en LUKATCELL POS vía [Culqi](https://culqi.com), una pasarela de pago peruana. En vez de que el cajero solo teclee un "código de operación" a mano (sin garantía de que el dinero llegó), esta integración genera un QR real con el monto exacto y **solo permite completar la venta cuando Culqi confirma el pago desde su servidor** — nunca a partir de lo que muestra el navegador.

## Por qué Culqi y no una cuenta Yape/Plin propia

No necesitas una cuenta comercial de Yape ni de Plin. Culqi es el intermediario: genera el QR, cobra al cliente, y **te deposita el dinero en tu cuenta bancaria** (BBVA, o la que configures en su panel) según su calendario de liquidación. El cliente paga con su Yape o Plin personal — no importa qué banco uses tú.

## 1. Crear la cuenta en Culqi

1. Regístrate en https://culqi.com con el RUC de LUKATCELL y tu cuenta bancaria para liquidación.
2. En el panel, ve a **Llaves API** y obtén, para el ambiente de pruebas (test) primero:
   - **Llave pública** (`pk_test_...`) → `CULQI_PUBLIC_KEY`
   - **Llave privada** (`sk_test_...`) → `CULQI_SECRET_KEY`
3. Cuando confirmes que todo funciona con las llaves de prueba, repite con las llaves de producción (`pk_live_...` / `sk_live_...`).

## 2. Aplicar la migración SQL

Desde la raíz del proyecto (`lukatcell-pos/`):

```bash
supabase link --project-ref TU_PROJECT_REF
supabase db push
```

Esto agrega `configuracion.culqi_activo`, la tabla `pagos_digitales`, y la validación en `registrar_venta` que rechaza cualquier pago yape/plin que no tenga una confirmación real vinculada.

## 3. Configurar los secrets de las Edge Functions

```bash
supabase secrets set CULQI_SECRET_KEY=sk_test_xxxxxxxxxxxxxxxx
supabase secrets set CULQI_PUBLIC_KEY=pk_test_xxxxxxxxxxxxxxxx
```

`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` no necesitas configurarlos manualmente — Supabase los inyecta automáticamente en toda Edge Function.

## 4. Desplegar las Edge Functions

```bash
supabase functions deploy crear-orden-culqi
supabase functions deploy culqi-webhook --no-verify-jwt
supabase functions deploy verificar-pago-culqi
```

> Solo `culqi-webhook` necesita `--no-verify-jwt`, porque Culqi la llama directamente sin un JWT de Supabase. Las otras dos las llama la propia app con la sesión del cajero, así que se quedan protegidas por defecto.

## 5. Configurar el webhook en el panel de Culqi

1. En el panel de Culqi → **Eventos** → **Webhooks**.
2. Selecciona el evento **order.status.changed**.
3. Pega la URL: `https://TU_PROJECT_REF.supabase.co/functions/v1/culqi-webhook`
4. Guarda.

No hace falta configurar ningún secreto de firma en la app — `culqi-webhook` nunca confía en el contenido del webhook por sí solo, siempre vuelve a consultar la orden directamente a la API de Culqi con tu llave privada antes de marcar un pago como confirmado. Esto significa que incluso si en el futuro cambia el formato exacto del payload del webhook, la seguridad de la verificación no depende de eso.

## 6. Activar en la app

1. Entra a **Configuración** (como administrador) → sección **Pago digital verificado (Culqi)**.
2. Activa **"Exigir confirmación real de Culqi para Yape/Plin"**.
3. Guarda.

A partir de este momento, elegir Yape o Plin como único método de pago en el modal de cobro muestra un QR real (widget de Culqi Checkout) en vez del campo de código manual, y el botón de confirmar venta queda oculto hasta que Culqi confirme el pago.

## 7. Probar

1. Usa las llaves de **prueba** de Culqi primero. Consulta su documentación de pruebas (sandbox) para simular una confirmación de pago sin dinero real.
2. Haz una venta de prueba eligiendo Yape o Plin: debe aparecer el widget de Culqi con el QR.
3. Verifica en **Reportes** o revisando la tabla `pagos_digitales` que el estado pasa de `pendiente` a `pagado` solo después de la confirmación real (no antes).
4. Si el webhook no llega, usa el botón **"Verificar ahora"** dentro del propio modal de cobro — fuerza una re-consulta directa a Culqi.
5. Revisa `supabase functions logs culqi-webhook` y `supabase functions logs crear-orden-culqi` si algo falla.

## Límites de esta primera versión (a propósito)

- **Solo pago con un único método.** Yape/Plin verificado por Culqi no está disponible todavía dentro de "Pago mixto" — combinar montos parciales verificados añade una complejidad que no se justificaba para esta primera versión. El selector de pago mixto oculta Yape/Plin cuando esta función está activa, para no dejar al cajero armar una combinación que la base de datos va a rechazar.
- **Requiere conexión a internet.** Sin conexión, Yape/Plin quedan deshabilitados como método de pago en el mostrador (no hay forma de generar ni verificar un cobro real sin conectividad) — el cajero debe usar efectivo o tarjeta.
- **Las tarjetas no se tocaron.** Siguen procesándose como hasta ahora (POS físico aparte); esto solo cambia Yape y Plin.
- **El widget del checkout de Culqi (`Culqi.settings({ order: ... })`) se verificó contra la documentación pública actual de Culqi (checkout v4), pero no se probó todavía contra una cuenta real** — al conectar tus llaves de prueba, revisa que el QR se muestre correctamente para ambos métodos antes de usarlo con clientes reales. En particular, confirma en el panel de pruebas si el flag `billetera` efectivamente muestra Plin como opción (es el nombre genérico de Culqi para billeteras además de Yape).

## Diseño: por qué nunca se confía en el navegador

Culqi mismo advierte esto en su documentación: nunca se debe marcar un pago como confirmado solo porque el navegador o el widget lo muestran. Por eso:

- El frontend (`PagoDigitalCulqi.tsx`) muestra el widget y sondea la tabla `pagos_digitales`, pero **nunca decide por sí mismo** que algo está pagado — solo refleja lo que el backend ya confirmó.
- `culqi-webhook` recibe la notificación de Culqi solo como una señal de "algo cambió, ve a revisar" — siempre vuelve a consultar `GET /v2/orders/{id}` con la llave privada del servidor antes de escribir `estado = 'pagado'`.
- `registrar_venta` (la función de base de datos) valida de nuevo, en el servidor, que exista un `pagos_digitales` en estado `'pagado'`, sin usar, y por el monto exacto — antes de aceptar la venta. Aunque alguien lograra manipular el frontend para "confirmar" un pago falso, la venta se rechaza igual.

## Resumen de variables de entorno

| Variable | Dónde se obtiene | Dónde se configura |
|---|---|---|
| `CULQI_SECRET_KEY` | Panel de Culqi → Llaves API | `supabase secrets set` |
| `CULQI_PUBLIC_KEY` | Panel de Culqi → Llaves API | `supabase secrets set` |
| `SUPABASE_URL` | Automático (inyectado por Supabase) | — |
| `SUPABASE_SERVICE_ROLE_KEY` | Automático (inyectado por Supabase) | — |
