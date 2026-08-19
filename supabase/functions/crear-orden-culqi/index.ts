// Edge Function: crear-orden-culqi
// Crea una orden de cobro en Culqi (https://api.culqi.com/v2/orders) por el
// monto exacto de un pago Yape/Plin en el mostrador, y guarda el registro
// local en pagos_digitales en estado 'pendiente'. La confirmación real de
// que el dinero llegó NUNCA ocurre aquí — llega después, vía el webhook
// culqi-webhook, que es la única función autorizada a marcar 'pagado'.
//
// Requiere autenticación de un usuario de la app (verify_jwt activado por
// defecto) porque genera un cobro real.
//
// Variables de entorno requeridas:
//   CULQI_SECRET_KEY -> llave privada (sk_live_xxx / sk_test_xxx) del panel de Culqi
//   CULQI_PUBLIC_KEY -> llave pública (pk_live_xxx / pk_test_xxx), se devuelve al frontend
//                       para montar el widget de Culqi Checkout

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CULQI_SECRET_KEY = Deno.env.get("CULQI_SECRET_KEY")!;
const CULQI_PUBLIC_KEY = Deno.env.get("CULQI_PUBLIC_KEY")!;
const CULQI_ORDERS_URL = "https://api.culqi.com/v2/orders";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

interface Body {
  monto?: number;
  metodo?: string;
  cajeroId?: string;
  locationId?: string;
  clienteNombre?: string;
  clienteTelefono?: string;
  clienteEmail?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body inválido" }, 400);
  }

  const monto = Number(body.monto);
  const metodo = body.metodo;
  if (!monto || monto <= 0) return json({ error: "Monto inválido" }, 400);
  if (metodo !== "yape" && metodo !== "plin") return json({ error: "Método debe ser yape o plin" }, 400);

  if (!CULQI_SECRET_KEY || !CULQI_PUBLIC_KEY) {
    return json({ error: "Culqi no está configurado en el servidor (faltan CULQI_SECRET_KEY / CULQI_PUBLIC_KEY)" }, 200);
  }

  const montoCentavos = Math.round(monto * 100);
  const nombreCompleto = (body.clienteNombre || "Cliente LUKATCELL").trim().split(/\s+/);
  const clientDetails = {
    first_name: nombreCompleto[0] || "Cliente",
    last_name: nombreCompleto.slice(1).join(" ") || "LUKATCELL",
    email: body.clienteEmail || "ventas@lukatcell.pos",
    phone_number: body.clienteTelefono || "+51999999999",
  };
  const expirationDate = Math.floor(Date.now() / 1000) + 15 * 60; // 15 minutos: venta en mostrador, no un carrito online

  let ordenCulqi: Record<string, unknown>;
  try {
    const resp = await fetch(CULQI_ORDERS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CULQI_SECRET_KEY}`,
      },
      body: JSON.stringify({
        amount: montoCentavos,
        currency_code: "PEN",
        description: "Venta LUKATCELL",
        order_number: `lkt-${crypto.randomUUID().slice(0, 18)}`,
        client_details: clientDetails,
        expiration_date: expirationDate,
      }),
    });
    ordenCulqi = await resp.json();
    if (!resp.ok || !ordenCulqi.id) {
      return json({ error: "Culqi rechazó la orden", detalle: ordenCulqi }, 200);
    }
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : "Error desconocido";
    return json({ error: `No se pudo contactar a Culqi: ${mensaje}` }, 200);
  }

  const { data: pago, error: errPago } = await supabase.from("pagos_digitales").insert({
    culqi_order_id: ordenCulqi.id as string,
    monto,
    metodo,
    estado: "pendiente",
    cajero_id: body.cajeroId || null,
    location_id: body.locationId || null,
    respuesta_culqi: ordenCulqi,
  }).select("id").single();

  if (errPago || !pago) {
    return json({ error: `Orden creada en Culqi pero no se pudo guardar localmente: ${errPago?.message}` }, 200);
  }

  return json({
    pagoId: pago.id,
    culqiOrderId: ordenCulqi.id,
    culqiPublicKey: CULQI_PUBLIC_KEY,
    expirationDate,
  });
});
