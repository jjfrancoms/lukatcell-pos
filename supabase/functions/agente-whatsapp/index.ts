// Edge Function: agente-whatsapp
// Webhook de WhatsApp Cloud API + agente conversacional con Claude Haiku 4.5 (tool-use).
//
// GET  -> verificación del webhook de Meta (hub.challenge)
// POST -> mensajes entrantes de WhatsApp

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WHATSAPP_TOKEN = Deno.env.get("WHATSAPP_TOKEN")!;
const WHATSAPP_PHONE_ID = Deno.env.get("WHATSAPP_PHONE_ID")!;
const WEBHOOK_VERIFY_TOKEN = Deno.env.get("WEBHOOK_VERIFY_TOKEN")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const GRAPH_API_URL = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`;
const MAX_HISTORY = 20;
const MAX_TOOL_ITERATIONS = 5;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const SYSTEM_PROMPT = `Eres el asistente virtual de LUKATCELL, una tienda de tecnología ubicada en Av. Jardines Este 388, San Juan de Lurigancho (SJL), Lima, Perú.

Reglas:
- Responde siempre en español, de forma breve y directa (2-4 líneas cuando sea posible).
- Todos los precios se expresan en soles peruanos (S/).
- NUNCA inventes precios, stock, modelos ni disponibilidad. Si no tienes el dato exacto de una herramienta, dilo claramente y ofrece confirmar con el equipo de la tienda.
- Si el cliente pregunta por un producto y no especifica el modelo de celular (por ejemplo funda, mica, cargador que dependen del modelo), pregunta primero cuál es su modelo antes de buscar.
- Usa la herramienta buscar_producto para consultar productos y precios reales.
- Usa la herramienta consultar_orden_servicio cuando el cliente pregunte por el estado de una reparación o equipo dejado en la tienda.
- Usa la herramienta consultar_faqs para preguntas sobre ubicación, horario, envíos, métodos de pago, tiempos de reparación o garantía.
- Si no puedes resolver algo, indica que un asesor de la tienda se comunicará o invita a llamar/visitar la tienda.
- No uses markdown pesado (sin tablas); WhatsApp solo soporta texto plano con *negritas* y _cursivas_.`;

const TOOLS = [
  {
    name: "buscar_producto",
    description:
      "Busca productos y variantes (con precio y modelo de celular compatible) en el catálogo de la tienda por nombre, categoría o palabra clave. Úsala siempre que el cliente pregunte por un producto o precio.",
    input_schema: {
      type: "object",
      properties: {
        busqueda: {
          type: "string",
          description: "Texto de búsqueda: nombre del producto, marca o palabra clave (ej: 'mica iphone 13', 'cargador tipo c').",
        },
      },
      required: ["busqueda"],
    },
  },
  {
    name: "consultar_orden_servicio",
    description:
      "Consulta las órdenes de servicio (reparaciones) asociadas a un número de teléfono. Úsala cuando el cliente pregunte por el estado de un equipo dejado en reparación.",
    input_schema: {
      type: "object",
      properties: {
        telefono: {
          type: "string",
          description: "Número de teléfono del cliente tal como aparece en WhatsApp (con o sin código de país).",
        },
      },
      required: ["telefono"],
    },
  },
  {
    name: "consultar_faqs",
    description:
      "Consulta preguntas frecuentes de la tienda: ubicación, horario, envíos, métodos de pago, tiempos de reparación, garantía.",
    input_schema: {
      type: "object",
      properties: {
        categoria: {
          type: "string",
          description: "Categoría de la FAQ a buscar (ej: 'ubicacion', 'horario', 'envios', 'pagos', 'reparaciones', 'garantia'). Si no se especifica, se devuelven todas.",
        },
      },
      required: [],
    },
  },
];

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

function normalizarTelefono(telefono: string): string {
  const digitos = telefono.replace(/\D/g, "");
  if (digitos.length === 9) return `51${digitos}`;
  return digitos;
}

async function buscarProducto(busqueda: string): Promise<string> {
  const { data, error } = await supabase.rpc("buscar_variantes", { texto: busqueda });

  if (error) {
    console.error("buscar_variantes error:", error);
    return "Ocurrió un error al buscar el producto. Indícale al cliente que un asesor confirmará disponibilidad.";
  }

  if (!data || data.length === 0) {
    return `No se encontraron productos que coincidan con "${busqueda}" en el catálogo.`;
  }

  const items = data.slice(0, 8).map((row: Record<string, unknown>) => {
    const precio = row.precio_override ?? row.producto_precio;
    const partes: string[] = [String(row.producto_nombre ?? "Producto")];
    if (row.modelo_marca && row.modelo_modelo) {
      partes.push(`(${row.modelo_marca} ${row.modelo_modelo})`);
    }
    if (row.color) partes.push(`- color ${row.color}`);
    if (precio !== null && precio !== undefined) {
      partes.push(`- S/ ${Number(precio).toFixed(2)}`);
    }
    return partes.join(" ");
  });

  return `Resultados encontrados:\n${items.join("\n")}`;
}

async function consultarOrdenServicio(telefono: string): Promise<string> {
  const telefonoNormalizado = normalizarTelefono(telefono);
  const ultimosDigitos = telefonoNormalizado.slice(-9);

  const { data, error } = await supabase
    .from("ordenes_servicio")
    .select("numero, estado, equipo_marca, equipo_modelo, problema, costo_estimado, fecha_recepcion, cliente_telefono")
    .ilike("cliente_telefono", `%${ultimosDigitos}`)
    .order("fecha_recepcion", { ascending: false })
    .limit(5);

  if (error) {
    console.error("consultar_orden_servicio error:", error);
    return "Ocurrió un error al consultar las órdenes de servicio.";
  }

  if (!data || data.length === 0) {
    return "No se encontraron órdenes de servicio asociadas a este número de teléfono.";
  }

  const items = data.map((orden: Record<string, unknown>) => {
    const equipo = [orden.equipo_marca, orden.equipo_modelo].filter(Boolean).join(" ") || "Equipo no especificado";
    const costo = orden.costo_estimado !== null && orden.costo_estimado !== undefined
      ? `S/ ${Number(orden.costo_estimado).toFixed(2)}`
      : "sin estimar aún";
    return `Orden #${orden.numero} - ${equipo}\nProblema: ${orden.problema}\nEstado: ${orden.estado}\nCosto estimado: ${costo}\nRecibido: ${orden.fecha_recepcion}`;
  });

  return items.join("\n\n");
}

async function consultarFaqs(categoria?: string): Promise<string> {
  let query = supabase.from("faqs").select("pregunta, respuesta, categoria");
  if (categoria) {
    query = query.ilike("categoria", `%${categoria}%`);
  }
  const { data, error } = await query.limit(10);

  if (error) {
    console.error("consultar_faqs error:", error);
    return "Ocurrió un error al consultar las preguntas frecuentes.";
  }

  if (!data || data.length === 0) {
    return "No se encontraron preguntas frecuentes para esa categoría.";
  }

  return data.map((faq: Record<string, unknown>) => `P: ${faq.pregunta}\nR: ${faq.respuesta}`).join("\n\n");
}

async function ejecutarHerramienta(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "buscar_producto":
      return buscarProducto(String(input.busqueda ?? ""));
    case "consultar_orden_servicio":
      return consultarOrdenServicio(String(input.telefono ?? ""));
    case "consultar_faqs":
      return consultarFaqs(input.categoria ? String(input.categoria) : undefined);
    default:
      return `Herramienta desconocida: ${name}`;
  }
}

async function llamarClaude(messages: AnthropicMessage[]): Promise<{ text: string; raw: AnthropicMessage[] }> {
  const conversacion: AnthropicMessage[] = [...messages];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: conversacion,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", response.status, errText);
      return {
        text: "Disculpa, tuvimos un problema técnico. Un asesor te responderá en breve.",
        raw: conversacion,
      };
    }

    const data = await response.json();
    const content: AnthropicContentBlock[] = data.content ?? [];

    conversacion.push({ role: "assistant", content });

    if (data.stop_reason === "tool_use") {
      const toolResults: AnthropicContentBlock[] = [];

      for (const block of content) {
        if (block.type === "tool_use" && block.id && block.name) {
          const resultado = await ejecutarHerramienta(block.name, block.input ?? {});
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: resultado,
          });
        }
      }

      conversacion.push({ role: "user", content: toolResults });
      continue;
    }

    const textBlock = content.find((b) => b.type === "text");
    return { text: textBlock?.text ?? "", raw: conversacion };
  }

  return {
    text: "Disculpa, no pude procesar tu solicitud en este momento. Un asesor te contactará.",
    raw: conversacion,
  };
}

async function cargarHistorial(telefono: string): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const { data, error } = await supabase
    .from("conversaciones")
    .select("mensajes")
    .eq("telefono", telefono)
    .maybeSingle();

  if (error) {
    console.error("cargarHistorial error:", error);
    return [];
  }

  return (data?.mensajes as { role: "user" | "assistant"; content: string }[]) ?? [];
}

async function guardarHistorial(
  telefono: string,
  historial: { role: "user" | "assistant"; content: string }[],
): Promise<void> {
  const recortado = historial.slice(-MAX_HISTORY);
  const { error } = await supabase
    .from("conversaciones")
    .upsert(
      { telefono, mensajes: recortado, updated_at: new Date().toISOString() },
      { onConflict: "telefono" },
    );

  if (error) {
    console.error("guardarHistorial error:", error);
  }
}

async function enviarWhatsApp(telefono: string, texto: string): Promise<void> {
  const response = await fetch(GRAPH_API_URL, {
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

  if (!response.ok) {
    const errText = await response.text();
    console.error("Error enviando WhatsApp:", response.status, errText);
  }
}

function extraerMensajeEntrante(payload: Record<string, unknown>): { telefono: string; texto: string } | null {
  try {
    const entry = (payload.entry as unknown[])?.[0] as Record<string, unknown>;
    const changes = (entry?.changes as unknown[])?.[0] as Record<string, unknown>;
    const value = changes?.value as Record<string, unknown>;
    const messages = value?.messages as Record<string, unknown>[] | undefined;

    if (!messages || messages.length === 0) return null;

    const message = messages[0];
    const telefono = String(message.from ?? "");
    const texto = String((message.text as Record<string, unknown>)?.body ?? "");

    if (!telefono || !texto) return null;

    return { telefono, texto };
  } catch (err) {
    console.error("extraerMensajeEntrante error:", err);
    return null;
  }
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
      return new Response(challenge ?? "", { status: 200 });
    }

    return new Response("Forbidden", { status: 403 });
  }

  if (req.method === "POST") {
    let payload: Record<string, unknown>;
    try {
      payload = await req.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const mensaje = extraerMensajeEntrante(payload);

    // Respuesta inmediata a Meta (evita reintentos); el mensaje solo se procesa si existe.
    if (!mensaje) {
      return new Response("OK", { status: 200 });
    }

    try {
      const historial = await cargarHistorial(mensaje.telefono);
      const mensajesParaClaude: AnthropicMessage[] = [
        ...historial.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: mensaje.texto },
      ];

      const { text } = await llamarClaude(mensajesParaClaude);

      const nuevoHistorial = [
        ...historial,
        { role: "user" as const, content: mensaje.texto },
        { role: "assistant" as const, content: text },
      ];

      await guardarHistorial(mensaje.telefono, nuevoHistorial);
      await enviarWhatsApp(mensaje.telefono, text);
    } catch (err) {
      console.error("Error procesando mensaje:", err);
    }

    return new Response("OK", { status: 200 });
  }

  return new Response("Method Not Allowed", { status: 405 });
});
