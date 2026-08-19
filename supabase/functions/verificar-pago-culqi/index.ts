// Edge Function: verificar-pago-culqi
// Fallback manual: si el webhook de Culqi tarda o no llega (ej. primera vez
// que se configura, o un evento se perdió), el cajero puede forzar una
// re-consulta directa a la API de Culqi para ese pago. Misma lógica de
// verificación que el webhook — nunca confía en nada que no venga
// directamente de una respuesta autenticada de Culqi.
//
// Requiere autenticación de un usuario de la app (verify_jwt activado).
//
// Variables de entorno requeridas:
//   CULQI_SECRET_KEY -> llave privada del panel de Culqi

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CULQI_SECRET_KEY = Deno.env.get("CULQI_SECRET_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  let body: { pagoId?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body inválido" }, 400);
  }

  if (!body.pagoId) return json({ error: "Falta pagoId" }, 400);
  if (!CULQI_SECRET_KEY) return json({ error: "Culqi no está configurado en el servidor" }, 200);

  const { data: pago, error: errPago } = await supabase.from("pagos_digitales").select("id, culqi_order_id, estado").eq("id", body.pagoId).single();
  if (errPago || !pago) return json({ error: "Pago no encontrado" }, 404);
  if (!pago.culqi_order_id) return json({ error: "Este pago no tiene una orden de Culqi asociada" }, 400);

  const resp = await fetch(`https://api.culqi.com/v2/orders/${pago.culqi_order_id}`, {
    headers: { Authorization: `Bearer ${CULQI_SECRET_KEY}` },
  });
  const orden = await resp.json();
  if (!resp.ok || !orden.id) {
    return json({ error: "No se pudo consultar la orden en Culqi", detalle: orden }, 200);
  }

  let estado = pago.estado;
  if (orden.state === "paid") estado = "pagado";
  else if (orden.state === "expired" || orden.state === "deleted") estado = "expirado";

  await supabase.from("pagos_digitales").update({
    estado,
    respuesta_culqi: orden,
    updated_at: new Date().toISOString(),
  }).eq("id", pago.id);

  return json({ estado });
});
