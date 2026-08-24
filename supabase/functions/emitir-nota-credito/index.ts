import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const NUBEFACT_URL = Deno.env.get("NUBEFACT_URL")!;
const NUBEFACT_TOKEN = Deno.env.get("NUBEFACT_TOKEN")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const n2 = (v: number) => v.toFixed(2);
const fechaNubefact = (v: string | Date) => { const d = new Date(v); return `${String(d.getDate()).padStart(2,"0")}-${String(d.getMonth()+1).padStart(2,"0")}-${d.getFullYear()}`; };

async function autorizado(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return false;
  if (token === SUPABASE_SERVICE_ROLE_KEY) return true;
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: auth } } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return false;
  const { data: staff } = await supabase.from("staff").select("rol,activo").eq("user_id", data.user.id).maybeSingle();
  return !!staff && staff.activo === true && staff.rol === "administrador";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
  if (!(await autorizado(req))) return json({ error: "No autorizado" }, 401);

  let body: { nota_credito_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Body inválido" }, 400); }
  if (!body.nota_credito_id) return json({ error: "Falta nota_credito_id" }, 400);

  const { data: nc, error: ncErr } = await supabase.from("notas_credito").select("*").eq("id", body.nota_credito_id).single();
  if (ncErr || !nc) return json({ error: "Nota de crédito no encontrada" }, 404);
  if (nc.estado === "emitido") return json({ ok: true, already_emitted: true });

  if (!NUBEFACT_URL || !NUBEFACT_TOKEN) {
    await supabase.from("notas_credito").update({ estado: "error", respuesta_error: "NUBEFACT_URL / NUBEFACT_TOKEN no configurados", intentos: (nc.intentos ?? 0) + 1, updated_at: new Date().toISOString() }).eq("id", nc.id);
    return json({ error: "Nubefact no está configurado" });
  }

  try {
    const [{ data: sale }, { data: original }, { data: devItems }] = await Promise.all([
      supabase.from("sales").select("id,fecha,subtotal,impuesto,total,tipo_comprobante,comprobante_cliente_tipo_doc,comprobante_cliente_num_doc,comprobante_cliente_denominacion,comprobante_cliente_direccion").eq("id", nc.sale_id).single(),
      supabase.from("comprobantes_electronicos").select("id,tipo_comprobante,serie,numero").eq("id", nc.comprobante_id).single(),
      supabase.from("devolucion_items").select("sale_item_id,cantidad,monto,variant_id").eq("devolucion_id", nc.devolucion_id),
    ]);
    if (!sale || !original || !devItems?.length) throw new Error("Faltan datos del comprobante original o devolución");

    const saleItemIds = devItems.map((x) => x.sale_item_id);
    const { data: saleItems } = await supabase.from("sale_items").select("id,producto_nombre_snapshot").in("id", saleItemIds);
    const nombres = new Map((saleItems || []).map((x) => [x.id, x.producto_nombre_snapshot || "Producto"]));
    const tasa = Number(sale.subtotal) > 0 ? Number(sale.impuesto) / Number(sale.subtotal) : 0;
    const subtotal = devItems.reduce((a, x) => a + Number(x.monto), 0);
    const igv = subtotal * tasa;
    const total = subtotal + igv;
    const tipoDoc = sale.comprobante_cliente_tipo_doc === "ruc" ? "6" : sale.comprobante_cliente_tipo_doc === "dni" ? "1" : "-";

    const items = devItems.map((x) => {
      const qty = Number(x.cantidad);
      const sub = Number(x.monto);
      const valor = qty > 0 ? sub / qty : 0;
      const igvLinea = sub * tasa;
      return {
        unidad_de_medida: "NIU",
        codigo: String(x.variant_id).slice(0,8),
        descripcion: nombres.get(x.sale_item_id) || "Producto",
        cantidad: String(qty),
        valor_unitario: n2(valor),
        precio_unitario: n2(valor * (1 + tasa)),
        descuento: "",
        subtotal: n2(sub),
        tipo_de_igv: "1",
        igv: n2(igvLinea),
        total: n2(sub + igvLinea),
        anticipo_regularizacion: "false",
      };
    });

    const payload = {
      operacion: "generar_comprobante",
      tipo_de_comprobante: 3,
      serie: nc.serie,
      numero: String(nc.numero),
      sunat_transaction: 1,
      cliente_tipo_de_documento: tipoDoc,
      cliente_numero_de_documento: sale.comprobante_cliente_num_doc || (sale.tipo_comprobante === "factura" ? "" : "00000000"),
      cliente_denominacion: sale.comprobante_cliente_denominacion || "CLIENTE VARIOS",
      cliente_direccion: sale.comprobante_cliente_direccion || "-",
      cliente_email: "",
      fecha_de_emision: fechaNubefact(new Date()),
      moneda: "1",
      porcentaje_de_igv: n2(tasa * 100),
      total_gravada: n2(subtotal),
      total_igv: n2(igv),
      total: n2(total),
      observaciones: nc.sustento,
      documento_que_se_modifica_tipo: sale.tipo_comprobante === "factura" ? 1 : 2,
      documento_que_se_modifica_serie: original.serie,
      documento_que_se_modifica_numero: Number(original.numero),
      tipo_de_nota_de_credito: Number(nc.tipo_nota),
      enviar_automaticamente_a_la_sunat: true,
      enviar_automaticamente_al_cliente: false,
      items,
    };

    const response = await fetch(NUBEFACT_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Token token="${NUBEFACT_TOKEN}"` }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok || result.errors) {
      const message = String(result.errors || `HTTP ${response.status}`);
      await supabase.from("notas_credito").update({ estado: "error", respuesta_error: message, intentos: (nc.intentos ?? 0) + 1, updated_at: new Date().toISOString() }).eq("id", nc.id);
      return json({ ok: false, error: message });
    }

    await supabase.from("notas_credito").update({
      estado: "emitido",
      enlace_pdf: result.enlace_del_pdf ?? null,
      enlace_xml: result.enlace_del_xml ?? null,
      enlace_cdr: result.enlace_del_cdr ?? null,
      aceptada_por_sunat: result.aceptada_por_sunat ?? null,
      sunat_description: result.sunat_description ?? null,
      respuesta_error: null,
      intentos: (nc.intentos ?? 0) + 1,
      updated_at: new Date().toISOString(),
    }).eq("id", nc.id);
    return json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    await supabase.from("notas_credito").update({ estado: "error", respuesta_error: message, intentos: (nc.intentos ?? 0) + 1, updated_at: new Date().toISOString() }).eq("id", nc.id);
    return json({ ok: false, error: message });
  }
});
