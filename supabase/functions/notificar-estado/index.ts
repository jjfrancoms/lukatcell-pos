// Edge Function: notificar-estado
// Envía una notificación por WhatsApp cuando cambia el estado de una orden de servicio.
// Sin LLM: solo plantillas de texto fijas según el estado.
//
// Body esperado (POST):
// { telefono, estado, numero_orden, cliente_nombre, equipo }

const WHATSAPP_TOKEN = Deno.env.get("WHATSAPP_TOKEN")!;
const WHATSAPP_PHONE_ID = Deno.env.get("WHATSAPP_PHONE_ID")!;
const GRAPH_API_URL = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`;

interface NotificarEstadoBody {
  telefono: string;
  estado: string;
  numero_orden: number | string;
  cliente_nombre?: string;
  equipo?: string;
}

function normalizarTelefono(telefono: string): string {
  const digitos = telefono.replace(/\D/g, "");
  if (digitos.length === 9) return `51${digitos}`;
  return digitos;
}

function construirMensaje(body: NotificarEstadoBody): string | null {
  const nombre = body.cliente_nombre?.trim() || "";
  const saludo = nombre ? `Hola ${nombre},` : "Hola,";
  const equipo = body.equipo?.trim() ? ` (${body.equipo.trim()})` : "";
  const orden = `tu orden #${body.numero_orden}${equipo}`;

  switch (body.estado) {
    case "diagnosticado":
      return `${saludo} ya diagnosticamos ${orden} en LUKATCELL. Te contactaremos con el detalle y costo del servicio. Cualquier consulta, escríbenos por este medio.`;
    case "en_reparacion":
      return `${saludo} ${orden} ya está en reparación en LUKATCELL. Te avisaremos apenas esté lista.`;
    case "listo":
      return `${saludo} ${orden} ya está *lista* para recoger en LUKATCELL, Av. Jardines Este 388, SJL, Lima. Te esperamos.`;
    case "cancelado":
      return `${saludo} ${orden} fue cancelada. Si tienes dudas, comunícate con nosotros.`;
    default:
      return null;
  }
}

async function enviarWhatsApp(telefono: string, texto: string): Promise<Response> {
  return fetch(GRAPH_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: telefono,
      type: "text",
      text: { body: texto },
    }),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: NotificarEstadoBody;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Body inválido" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (!body.telefono || !body.estado || body.numero_orden === undefined) {
    return new Response(
      JSON.stringify({ error: "Faltan campos requeridos: telefono, estado, numero_orden" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const mensaje = construirMensaje(body);
  if (!mensaje) {
    // Estado sin plantilla (ej: "recibido", "entregado") — no se notifica.
    return new Response(JSON.stringify({ skipped: true, motivo: `sin plantilla para estado "${body.estado}"` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const telefonoNormalizado = normalizarTelefono(body.telefono);

  try {
    const response = await enviarWhatsApp(telefonoNormalizado, mensaje);
    if (!response.ok) {
      const errText = await response.text();
      console.error("Error enviando WhatsApp:", response.status, errText);
      return new Response(JSON.stringify({ error: "Error al enviar WhatsApp", detalle: errText }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  } catch (err) {
    console.error("Error notificar-estado:", err);
    return new Response(JSON.stringify({ error: "Error interno" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});
