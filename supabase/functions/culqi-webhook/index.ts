// Edge Function: culqi-webhook
// Recibe la notificación de Culqi cuando cambia el estado de una orden
// (evento "order.status.changed"). Deliberadamente NO confía en el
// contenido del payload del webhook para decidir si algo está pagado —
// lo usa solo como una señal de "algo cambió, ve a revisar", y siempre
// re-consulta la orden directamente a la API de Culqi con la llave privada
// del servidor antes de marcar pagos_digitales.estado = 'pagado'. Así, ni
// un payload de webhook falsificado ni un frontend comprometido pueden
// fabricar una confirmación de pago falsa — la única fuente de verdad es
// la respuesta de Culqi a nuestra propia consulta autenticada.
//
// verify_jwt desactivado: Culqi llama a esta URL pública sin JWT de Supabase.
//
// Variables de entorno requeridas:
//   CULQI_SECRET_KEY -> llave privada del panel de Culqi

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CULQI_SECRET_KEY = Deno.env.get("CULQI_SECRET_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// El payload exacto de Culqi puede traer el id de la orden en distintas
// formas según el evento; se busca en las ubicaciones más plausibles en vez
// de asumir una sola — si no se encuentra, se ignora la notificación (nunca
// se marca nada como pagado a partir de esto).
function extraerOrderId(payload: Record<string, unknown>): string | null {
  const data = payload.data as Record<string, unknown> | undefined;
  const candidatos = [
    payload.id,
    data?.id,
    (data?.object as Record<string, unknown> | undefined)?.id,
    payload.order_id,
    data?.order_id,
  ];
  const encontrado = candidatos.find((c) => typeof c === "string" && c.startsWith("ord_"));
  return (encontrado as string) ?? null;
}

async function actualizarDesdeOrdenReal(culqiOrderId: string) {
  const resp = await fetch(`https://api.culqi.com/v2/orders/${culqiOrderId}`, {
    headers: { Authorization: `Bearer ${CULQI_SECRET_KEY}` },
  });
  const orden = await resp.json();
  if (!resp.ok || !orden.id) return;

  let estado: "pagado" | "expirado" | null = null;
  if (orden.state === "paid") estado = "pagado";
  else if (orden.state === "expired" || orden.state === "deleted") estado = "expirado";

  if (!estado) {
    // Sigue pendiente (u otro estado transitorio de Culqi): solo se guarda la
    // respuesta cruda para diagnóstico, sin tocar el estado local.
    await supabase.from("pagos_digitales").update({ respuesta_culqi: orden, updated_at: new Date().toISOString() })
      .eq("culqi_order_id", culqiOrderId);
    return;
  }

  await supabase.from("pagos_digitales").update({
    estado,
    respuesta_culqi: orden,
    updated_at: new Date().toISOString(),
  }).eq("culqi_order_id", culqiOrderId);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Body inválido" }), { status: 400 });
  }

  if (!CULQI_SECRET_KEY) {
    console.error("culqi-webhook: CULQI_SECRET_KEY no configurado, no se puede re-verificar la orden");
    return new Response(JSON.stringify({ ok: false, error: "no configurado" }), { status: 200 });
  }

  const orderId = extraerOrderId(payload);
  if (!orderId) {
    // Evento que no reconocemos como relacionado a una orden: se ignora sin error.
    return new Response(JSON.stringify({ ok: true, ignorado: true }), { status: 200 });
  }

  try {
    await actualizarDesdeOrdenReal(orderId);
  } catch (err) {
    console.error("culqi-webhook: error verificando orden", err);
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200 });
});
