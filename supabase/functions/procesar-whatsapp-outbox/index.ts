import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WHATSAPP_TOKEN = Deno.env.get("WHATSAPP_TOKEN")!;
const WHATSAPP_PHONE_ID = Deno.env.get("WHATSAPP_PHONE_ID")!;
const GRAPH_API_URL = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`;

function normalizarTelefono(raw: string) {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.length === 9 ? `51${digits}` : digits;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return Response.json({ error: "No autenticado" }, { status: 401 });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData.user) return Response.json({ error: "Sesión inválida" }, { status: 401 });
  const { data: staff } = await admin.from("staff").select("id,rol,activo").eq("user_id", userData.user.id).eq("activo", true).maybeSingle();
  if (!staff || staff.rol !== "administrador") return Response.json({ error: "Solo administración" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const limit = Math.max(1, Math.min(Number(body?.limit || 20), 100));
  const { data: pending, error: pendingError } = await admin.from("whatsapp_envios")
    .select("id,telefono,variables,plantilla:whatsapp_plantillas(meta_template_name,idioma,nombre)")
    .eq("estado", "pendiente").order("created_at", { ascending: true }).limit(limit);
  if (pendingError) return Response.json({ error: pendingError.message }, { status: 500 });

  let enviados = 0, fallidos = 0, omitidos = 0;
  const resultados: Array<Record<string, unknown>> = [];
  for (const row of pending || []) {
    const { data: claimed } = await admin.from("whatsapp_envios")
      .update({ estado: "procesando", procesado_at: new Date().toISOString(), error: null })
      .eq("id", row.id).eq("estado", "pendiente").select("id").maybeSingle();
    if (!claimed) { omitidos++; continue; }

    const raw = row.plantilla as unknown;
    const plantilla = (Array.isArray(raw) ? raw[0] : raw) as { meta_template_name?: string | null; idioma?: string | null } | null;
    const metaName = plantilla?.meta_template_name?.trim();
    if (!metaName) {
      await admin.from("whatsapp_envios").update({ estado: "fallido", error: "Plantilla Meta no configurada" }).eq("id", row.id);
      fallidos++; resultados.push({ id: row.id, estado: "fallido", error: "Plantilla Meta no configurada" }); continue;
    }
    const telefono = normalizarTelefono(row.telefono);
    if (telefono.length < 10) {
      await admin.from("whatsapp_envios").update({ estado: "fallido", error: "Teléfono inválido" }).eq("id", row.id);
      fallidos++; resultados.push({ id: row.id, estado: "fallido", error: "Teléfono inválido" }); continue;
    }
    const vars = row.variables as Record<string, unknown> | null;
    const params = Array.isArray(vars?.params) ? (vars!.params as unknown[]).map((x) => ({ type: "text", text: String(x ?? "") })) : [];
    const components = params.length ? [{ type: "body", parameters: params }] : undefined;
    try {
      const response = await fetch(GRAPH_API_URL, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${WHATSAPP_TOKEN}` },
        body: JSON.stringify({ messaging_product: "whatsapp", to: telefono, type: "template", template: { name: metaName, language: { code: plantilla?.idioma || "es" }, ...(components ? { components } : {}) } }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const msg = String(payload?.error?.message || `Meta HTTP ${response.status}`).slice(0, 1000);
        await admin.from("whatsapp_envios").update({ estado: "fallido", error: msg }).eq("id", row.id);
        fallidos++; resultados.push({ id: row.id, estado: "fallido", error: msg }); continue;
      }
      const messageId = payload?.messages?.[0]?.id ? String(payload.messages[0].id) : null;
      await admin.from("whatsapp_envios").update({ estado: "enviado", meta_message_id: messageId, enviado_at: new Date().toISOString(), error: null }).eq("id", row.id);
      enviados++; resultados.push({ id: row.id, estado: "enviado", meta_message_id: messageId });
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 1000) : "Error de red al enviar";
      await admin.from("whatsapp_envios").update({ estado: "fallido", error: msg }).eq("id", row.id);
      fallidos++; resultados.push({ id: row.id, estado: "fallido", error: msg });
    }
  }
  return Response.json({ procesados: enviados + fallidos, enviados, fallidos, omitidos, resultados });
});
