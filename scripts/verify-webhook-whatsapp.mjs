#!/usr/bin/env node
// Verifica la firma de webhooks de Meta usada por supabase/functions/agente-whatsapp.
// Importa el MISMO módulo que la Edge Function (firma.ts, sólo Web Crypto) y lo
// contrasta con HMAC-SHA256 calculado por node:crypto. También comprueba que el
// handler verifica ANTES de parsear y que falla cerrado sin secreto.
import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

// FIRMA_MODULO=<ruta>: sólo para demostrar que las pruebas fallan con un módulo mutante.
const modulo = process.env.FIRMA_MODULO ? pathToFileURL(process.env.FIRMA_MODULO).href : '../supabase/functions/agente-whatsapp/firma.ts'
const { firmaMetaValida } = await import(modulo)
if (process.env.FIRMA_MODULO) console.log(`*** MUTACIÓN: módulo ${process.env.FIRMA_MODULO} — se espera FAIL ***`)

let fallos = 0
const assert = (ok, msg) => { if (ok) console.log(`PASS: ${msg}`); else { console.error(`FAIL: ${msg}`); fallos++ } }

const secreto = 'app-secret-de-prueba-no-real'
const cuerpo = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '51999999999', text: { body: 'hola' } }] } }] }] })
const firma = (s, b) => 'sha256=' + createHmac('sha256', s).update(b, 'utf8').digest('hex')

assert(await firmaMetaValida(secreto, cuerpo, firma(secreto, cuerpo)) === true, 'Acepta una firma válida')
assert(await firmaMetaValida(secreto, cuerpo, firma(secreto, cuerpo).replace(/[a-f]/g, (c) => c.toUpperCase()).replace('SHA256=', 'sha256=')) === true, 'Acepta hex en mayúsculas')
assert(await firmaMetaValida(secreto, cuerpo + ' ', firma(secreto, cuerpo)) === false, 'Rechaza un cuerpo alterado')
assert(await firmaMetaValida(secreto, cuerpo, firma('otro-secreto', cuerpo)) === false, 'Rechaza una firma con otro secreto')
assert(await firmaMetaValida(secreto, cuerpo, null) === false, 'Rechaza sin cabecera')
assert(await firmaMetaValida(secreto, cuerpo, firma(secreto, cuerpo).slice(0, -2)) === false, 'Rechaza longitud incorrecta')
assert(await firmaMetaValida(secreto, cuerpo, firma(secreto, cuerpo).slice(7)) === false, 'Rechaza sin prefijo sha256=')
assert(await firmaMetaValida('', cuerpo, firma('', cuerpo)) === false, 'Sin secreto nunca valida')
const cuerpoUnicode = JSON.stringify({ texto: 'cámara ñandú 📱' })
assert(await firmaMetaValida(secreto, cuerpoUnicode, firma(secreto, cuerpoUnicode)) === true, 'Firma sobre bytes UTF-8 del cuerpo crudo')

const handler = fs.readFileSync(new URL('../supabase/functions/agente-whatsapp/index.ts', import.meta.url), 'utf8')
const post = handler.slice(handler.indexOf('if (req.method === "POST")'))
const iSecreto = post.indexOf('if (!WHATSAPP_APP_SECRET)')
const iFirma = post.indexOf('firmaMetaValida(')
const iParse = post.indexOf('JSON.parse(cuerpoCrudo)')
assert(iSecreto >= 0 && post.slice(iSecreto, iSecreto + 250).includes('status: 503'), 'Sin WHATSAPP_APP_SECRET el webhook responde 503 y no procesa')
assert(iFirma > iSecreto && iParse > iFirma, 'La firma se verifica antes de parsear el cuerpo')
assert(!post.includes('await req.json()'), 'El POST no parsea el cuerpo antes de verificar')

if (fallos) { console.error(`Webhook WhatsApp: ${fallos} fallo(s)`); process.exit(1) }
console.log('Webhook WhatsApp: firma verificada.')
