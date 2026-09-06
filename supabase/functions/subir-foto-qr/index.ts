// Edge Function: subir-foto-qr
// Recibe la foto tomada desde el celular (vía la página pública /subir-foto/:id,
// sin sesión iniciada) y la sube al bucket "productos" usando la service role key,
// ya que el celular nunca está autenticado en el POS. La única protección es el
// propio id de sesión (UUID aleatorio) más su expiración de 10 minutos y que solo
// se puede usar una vez (estado pasa de 'pendiente' a 'completado').

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const MAX_BYTES = 8 * 1024 * 1024;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Body inválido" }, 400);
  }

  const sessionId = form.get("session_id");
  const file = form.get("file");
  if (typeof sessionId !== "string" || !sessionId) return json({ error: "Falta session_id" }, 400);
  if (!(file instanceof File)) return json({ error: "Falta la foto" }, 400);
  if (!file.type.startsWith("image/")) return json({ error: "El archivo debe ser una imagen" }, 400);
  if (file.size > MAX_BYTES) return json({ error: "La imagen no debe superar 8 MB" }, 400);

  const { data: sesion, error: errSesion } = await supabase
    .from("sesiones_subida_imagen")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();

  if (errSesion || !sesion) return json({ error: "Sesión no encontrada. Genera un nuevo código QR." }, 404);
  if (sesion.estado !== "pendiente") return json({ error: "Este código QR ya se usó. Genera uno nuevo." }, 409);
  if (new Date(sesion.expira_at as string).getTime() < Date.now()) {
    await supabase.from("sesiones_subida_imagen").update({ estado: "expirado" }).eq("id", sessionId);
    return json({ error: "Este código QR expiró. Genera uno nuevo." }, 409);
  }

  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const ruta = `${crypto.randomUUID()}.${ext}`;
  const { error: errSubida } = await supabase.storage.from("productos").upload(ruta, file);
  if (errSubida) return json({ error: "No se pudo subir la imagen" }, 500);

  const { data: publico } = supabase.storage.from("productos").getPublicUrl(ruta);

  await supabase.from("sesiones_subida_imagen").update({ estado: "completado", url: publico.publicUrl }).eq("id", sessionId);

  return json({ ok: true, url: publico.publicUrl });
});
