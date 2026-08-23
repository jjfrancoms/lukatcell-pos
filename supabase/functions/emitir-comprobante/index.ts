// Edge Function: emitir-comprobante
// Genera la Boleta/Factura electrónica en Nubefact para una venta ya registrada.
// Se invoca de forma asíncrona desde Postgres con service_role; los reintentos
// manuales desde la app solo se permiten a administradores activos.

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

async function llamanteAutorizado(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return false;
  if (token === SUPABASE_SERVICE_ROLE_KEY) return true;

  const clienteUsuario = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth } },
  });
  const { data, error } = await clienteUsuario.auth.getUser(token);
  if (error || !data.user) return false;

  const { data: staff, error: staffError } = await supabase
    .from("staff")
    .select("rol, activo")
    .eq("user_id", data.user.id)
    .maybeSingle();

  return !staffError && !!staff && staff.rol === "administrador" && staff.activo === true;
}

interface NubefactItem {
  unidad_de_medida: string;
  codigo: string;
  descripcion: string;
  cantidad: string;
  valor_unitario: string;
  precio_unitario: string;
  descuento: string;
  subtotal: string;
  tipo_de_igv: string;
  igv: string;
  total: string;
  anticipo_regularizacion: string;
}

function formatearFechaNubefact(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function n2(valor: number): string {
  return valor.toFixed(2);
}

async function construirPayload(saleId: string, comprobante: Record<string, unknown>) {
  const { data: sale, error: errSale } = await supabase
    .from("sales")
    .select("id, numero, fecha, subtotal, impuesto, total, tipo_comprobante, comprobante_cliente_tipo_doc, comprobante_cliente_num_doc, comprobante_cliente_denominacion, comprobante_cliente_direccion")
    .eq("id", saleId)
    .single();
  if (errSale || !sale) throw new Error(`No se encontró la venta: ${errSale?.message ?? saleId}`);

  const { data: items, error: errItems } = await supabase
    .from("sale_items")
    .select("variant_id, cantidad, precio_unitario, subtotal, producto_nombre_snapshot")
    .eq("sale_id", saleId);
  if (errItems || !items || items.length === 0) throw new Error(`No se encontraron los items de la venta: ${errItems?.message ?? saleId}`);

  const subtotal = Number(sale.subtotal);
  const impuesto = Number(sale.impuesto);
  const total = Number(sale.total);
  const tasaIgv = subtotal > 0 ? impuesto / subtotal : 0;
  const porcentajeIgv = n2(tasaIgv * 100);

  const esFactura = sale.tipo_comprobante === "factura";
  const tipoDoc = sale.comprobante_cliente_tipo_doc as string | null;
  const numDoc = sale.comprobante_cliente_num_doc as string | null;

  const clienteTipoDeDocumento = tipoDoc === "ruc" ? "6" : tipoDoc === "dni" ? "1" : "-";
  const clienteNumeroDeDocumento = numDoc || (esFactura ? "" : "00000000");
  const clienteDenominacion = (sale.comprobante_cliente_denominacion as string | null) || "CLIENTE VARIOS";
  const clienteDireccion = (sale.comprobante_cliente_direccion as string | null) || "-";

  const nubefactItems: NubefactItem[] = items.map((item) => {
    const valorUnitario = Number(item.precio_unitario);
    const subtotalLinea = Number(item.subtotal);
    const igvLinea = subtotalLinea * tasaIgv;
    const precioUnitarioConIgv = valorUnitario * (1 + tasaIgv);
    return {
      unidad_de_medida: "NIU",
      codigo: String(item.variant_id).slice(0, 8),
      descripcion: item.producto_nombre_snapshot || "Producto",
      cantidad: String(item.cantidad),
      valor_unitario: n2(valorUnitario),
      precio_unitario: n2(precioUnitarioConIgv),
      descuento: "",
      subtotal: n2(subtotalLinea),
      tipo_de_igv: "1",
      igv: n2(igvLinea),
      total: n2(subtotalLinea + igvLinea),
      anticipo_regularizacion: "false",
    };
  });

  return {
    operacion: "generar_comprobante",
    tipo_de_comprobante: esFactura ? "1" : "2",
    serie: comprobante.serie as string,
    numero: String(comprobante.numero),
    sunat_transaction: 1,
    cliente_tipo_de_documento: clienteTipoDeDocumento,
    cliente_numero_de_documento: clienteNumeroDeDocumento,
    cliente_denominacion: clienteDenominacion,
    cliente_direccion: clienteDireccion,
    cliente_email: "",
    fecha_de_emision: formatearFechaNubefact(sale.fecha as string),
    moneda: "1",
    porcentaje_de_igv: porcentajeIgv,
    total_gravada: n2(subtotal),
    total_igv: n2(impuesto),
    total: n2(total),
    enviar_automaticamente_a_la_sunat: "true",
    enviar_automaticamente_al_cliente: "false",
    observaciones: `Venta LUKATCELL #${sale.numero}`,
    items: nubefactItems,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  if (!(await llamanteAutorizado(req))) return json({ error: "No autorizado" }, 401);

  let body: { comprobante_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Body inválido" }, 400); }

  const comprobanteId = body.comprobante_id;
  if (!comprobanteId) return json({ error: "Falta comprobante_id" }, 400);

  const { data: comprobante, error: errComprobante } = await supabase
    .from("comprobantes_electronicos")
    .select("*")
    .eq("id", comprobanteId)
    .single();

  if (errComprobante || !comprobante) return json({ error: "Comprobante no encontrado" }, 404);

  if (!NUBEFACT_URL || !NUBEFACT_TOKEN) {
    await supabase.from("comprobantes_electronicos").update({
      estado: "error",
      respuesta_error: "NUBEFACT_URL / NUBEFACT_TOKEN no configurados en los secrets de la Edge Function",
      intentos: (comprobante.intentos ?? 0) + 1,
      updated_at: new Date().toISOString(),
    }).eq("id", comprobanteId);
    return json({ error: "Nubefact no está configurado" });
  }

  try {
    const payload = await construirPayload(comprobante.sale_id as string, comprobante);
    const response = await fetch(NUBEFACT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token token="${NUBEFACT_TOKEN}"`,
      },
      body: JSON.stringify(payload),
    });

    const resultado = await response.json();
    if (!response.ok || resultado.errors) {
      const mensajeError = resultado.errors || `HTTP ${response.status}`;
      await supabase.from("comprobantes_electronicos").update({
        estado: "error",
        respuesta_error: String(mensajeError),
        intentos: (comprobante.intentos ?? 0) + 1,
        updated_at: new Date().toISOString(),
      }).eq("id", comprobanteId);
      console.error("Nubefact rechazó el comprobante:", mensajeError);
      return json({ ok: false, error: mensajeError });
    }

    await supabase.from("comprobantes_electronicos").update({
      estado: "emitido",
      enlace_pdf: resultado.enlace_del_pdf ?? null,
      enlace_xml: resultado.enlace_del_xml ?? null,
      enlace_cdr: resultado.enlace_del_cdr ?? null,
      codigo_qr: resultado.cadena_para_codigo_qr ?? null,
      aceptada_por_sunat: resultado.aceptada_por_sunat ?? null,
      sunat_description: resultado.sunat_description ?? null,
      intentos: (comprobante.intentos ?? 0) + 1,
      updated_at: new Date().toISOString(),
    }).eq("id", comprobanteId);

    return json({ ok: true });
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : "Error desconocido";
    console.error("Error emitiendo comprobante:", mensaje);
    await supabase.from("comprobantes_electronicos").update({
      estado: "error",
      respuesta_error: mensaje,
      intentos: (comprobante.intentos ?? 0) + 1,
      updated_at: new Date().toISOString(),
    }).eq("id", comprobanteId);
    return json({ ok: false, error: mensaje });
  }
});
