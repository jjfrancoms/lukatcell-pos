// Verificación de la firma de los webhooks de Meta (WhatsApp Cloud API).
//
// Meta firma cada POST con HMAC-SHA256 del CUERPO CRUDO usando el App Secret y
// lo envía en la cabecera `X-Hub-Signature-256: sha256=<hex>`. Sin esta
// verificación cualquiera que conozca la URL pública de la función puede
// inyectar mensajes entrantes falsos.
//
// Sólo Web Crypto: el mismo código corre en Deno (Edge Function) y en Node
// (scripts/verify-webhook-whatsapp.mjs).

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export async function firmaMetaValida(secreto: string, cuerpoCrudo: string, cabecera: string | null): Promise<boolean> {
  if (!secreto || !cabecera) return false;
  const prefijo = "sha256=";
  if (!cabecera.toLowerCase().startsWith(prefijo)) return false;
  const recibido = cabecera.slice(prefijo.length).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(recibido)) return false;

  const codificador = new TextEncoder();
  const clave = await crypto.subtle.importKey("raw", codificador.encode(secreto), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const esperado = hex(new Uint8Array(await crypto.subtle.sign("HMAC", clave, codificador.encode(cuerpoCrudo))));

  // Comparación en tiempo constante (misma longitud garantizada por la regex).
  let diferencia = 0;
  for (let i = 0; i < esperado.length; i++) diferencia |= esperado.charCodeAt(i) ^ recibido.charCodeAt(i);
  return diferencia === 0;
}
