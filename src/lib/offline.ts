import { useEffect, useState } from 'react'
import { openDB, type IDBPDatabase } from 'idb'
import { supabase } from './supabase'
import { calcularSubtotalLinea } from './money'
import type { CartItem, DatosComprobante, PagoDetalle, ProductVariant, Sale, SyncEstado } from '../types'

const DB_NAME = 'lukatcell-pos'
const DB_VERSION = 2

export interface VentaPendiente {
  id?: number
  clientTransactionId: string
  cart: CartItem[]
  subtotal: number
  impuesto: number
  total: number
  pagos: PagoDetalle[]
  clienteId: string | null
  clienteDoc: string | null
  cashSessionId: string | null
  locationId: string | null
  cajeroId: string | null
  comprobante: DatosComprobante
  createdAt: string
  estado: SyncEstado
  intentos: number
  ultimoError: string | null
}

export interface CarritoActivo {
  key: string
  cart: CartItem[]
  savedAt: string
}

// Cada cajero tiene su propia clave (en vez de una fija 'actual') para que dos
// sesiones/cajeros en la misma base local de IndexedDB no se pisen el carrito.
function claveCarrito(cajeroId: string | null): string {
  return `carrito_${cajeroId ?? 'sin_sesion'}`
}

const MAX_INTENTOS_AUTO = 5

let dbPromise: Promise<IDBPDatabase> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      blocked() {
        console.warn('lukatcell-pos: hay otra pestaña con una versión anterior de la base local abierta. Ciérrala para continuar.')
      },
      blocking() {
        // Otra pestaña quiere abrir una versión más nueva de la base local: cerramos esta
        // conexión para no dejarla esperando indefinidamente (sin esto, getDB() en la
        // pestaña nueva podía colgarse para siempre mientras esta pestaña siguiera abierta).
        dbPromise?.then((db) => db.close())
        dbPromise = null
      },
      async upgrade(db, oldVersion, _newVersion, transaction) {
        if (!db.objectStoreNames.contains('productos_cache')) db.createObjectStore('productos_cache', { keyPath: 'id' })
        if (!db.objectStoreNames.contains('categorias')) db.createObjectStore('categorias', { keyPath: 'id' })
        if (!db.objectStoreNames.contains('ventas_pendientes')) db.createObjectStore('ventas_pendientes', { keyPath: 'id', autoIncrement: true })
        if (!db.objectStoreNames.contains('movimientos_pendientes')) db.createObjectStore('movimientos_pendientes', { keyPath: 'id', autoIncrement: true })
        if (!db.objectStoreNames.contains('sync_metadata')) db.createObjectStore('sync_metadata', { keyPath: 'key' })
        if (!db.objectStoreNames.contains('carrito_activo')) db.createObjectStore('carrito_activo', { keyPath: 'key' })

        // Migración desde la v1: outbox_ventas -> ventas_pendientes, catalogo -> productos_cache
        if (oldVersion < 2 && db.objectStoreNames.contains('outbox_ventas')) {
          const antiguas = await transaction.objectStore('outbox_ventas').getAll()
          const nuevas = transaction.objectStore('ventas_pendientes')
          for (const v of antiguas) {
            await nuevas.add({
              ...v,
              clientTransactionId: v.clientTransactionId ?? crypto.randomUUID(),
              estado: 'PENDING',
              intentos: 0,
              ultimoError: null,
            })
          }
          db.deleteObjectStore('outbox_ventas')
        }
        if (oldVersion < 2 && db.objectStoreNames.contains('catalogo')) {
          db.deleteObjectStore('catalogo')
        }
      },
    })
  }
  return dbPromise
}

// ============================================================
// Estado de conexión real (no solo navigator.onLine)
// ============================================================

async function verificarConexionReal(timeoutMs = 4000): Promise<boolean> {
  if (!navigator.onLine) return false
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const { error } = await supabase
      .from('configuracion')
      .select('id')
      .eq('id', 1)
      .limit(1)
      .abortSignal(controller.signal)
    clearTimeout(timeout)
    return !error
  } catch {
    return false
  }
}

export function useOnlineStatus(intervalMs = 20000) {
  const [online, setOnline] = useState(navigator.onLine)
  const [verificando, setVerificando] = useState(false)

  useEffect(() => {
    let cancelado = false
    const chequear = async () => {
      setVerificando(true)
      const real = await verificarConexionReal()
      if (!cancelado) { setOnline(real); setVerificando(false) }
    }
    chequear()
    const onOnline = () => chequear()
    const onOffline = () => setOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    const interval = setInterval(chequear, intervalMs)
    return () => {
      cancelado = true
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      clearInterval(interval)
    }
  }, [intervalMs])

  return { online, verificando }
}

// ============================================================
// Metadata de sincronización
// ============================================================

export async function getSyncMetadata(key: string): Promise<string | null> {
  const db = await getDB()
  const row = await db.get('sync_metadata', key)
  return row?.value ?? null
}

export async function setSyncMetadata(key: string, value: string) {
  const db = await getDB()
  await db.put('sync_metadata', { key, value })
}

// ============================================================
// Catálogo (cache local para búsqueda offline)
// ============================================================

// Traduce la forma plana que devuelven las RPC de búsqueda a ProductVariant.
// Única fuente de verdad para este mapeo (antes duplicado en Venta.tsx).
export function mapVarianteRow(r: Record<string, unknown>): ProductVariant {
  return {
    id: r.id as string,
    product_id: r.product_id as string,
    color: (r.color as string) ?? null,
    modelo_celular_id: (r.modelo_celular_id as string) ?? null,
    precio_override: r.precio_override != null ? Number(r.precio_override) : null,
    codigo_barras: (r.codigo_barras as string) ?? null,
    product: {
      nombre: r.producto_nombre,
      sku: r.producto_sku,
      precio_base: Number(r.producto_precio),
      imagen_url: r.producto_imagen,
    } as unknown as ProductVariant['product'],
    modelo: r.modelo_marca ? ({ marca: r.modelo_marca, modelo: r.modelo_modelo } as unknown as ProductVariant['modelo']) : null,
  }
}

export async function cacheCatalogo(items: ProductVariant[]) {
  const db = await getDB()
  const tx = db.transaction('productos_cache', 'readwrite')
  await Promise.all(items.map((i) => tx.store.put(i)))
  await tx.done
}

export async function eliminarDeCache(ids: string[]) {
  if (ids.length === 0) return
  const db = await getDB()
  const tx = db.transaction('productos_cache', 'readwrite')
  await Promise.all(ids.map((id) => tx.store.delete(id)))
  await tx.done
}

export async function getCatalogoCache(): Promise<ProductVariant[]> {
  const db = await getDB()
  return db.getAll('productos_cache')
}

export async function buscarEnCache(texto: string): Promise<ProductVariant[]> {
  const items = await getCatalogoCache()
  const t = texto.toLowerCase()
  return items.filter((v) => {
    const nombre = v.product?.nombre?.toLowerCase() || ''
    const sku = v.product?.sku?.toLowerCase() || ''
    const color = v.color?.toLowerCase() || ''
    const barcode = v.codigo_barras?.toLowerCase() || ''
    return nombre.includes(t) || sku.includes(t) || color.includes(t) || barcode.includes(t)
  }).slice(0, 20)
}

export async function cacheCategorias(items: { id: string; nombre: string }[]) {
  const db = await getDB()
  const tx = db.transaction('categorias', 'readwrite')
  await Promise.all(items.map((i) => tx.store.put(i)))
  await tx.done
}

export async function getCategoriasCache(): Promise<{ id: string; nombre: string }[]> {
  const db = await getDB()
  return db.getAll('categorias')
}

/**
 * Descarga solo lo que cambió desde la última sincronización (por updated_at).
 * Devuelve false si nunca se sincronizó antes (el caller debe hacer una carga completa).
 */
export async function sincronizarCatalogoIncremental(): Promise<boolean> {
  const desde = await getSyncMetadata('ultima_sync_catalogo')
  if (!desde) return false

  const { data, error } = await supabase.rpc('variantes_actualizadas_desde', { desde })
  if (error || !data) return false

  const activos = data.filter((r: Record<string, unknown>) => r.producto_activo !== false)
  const inactivos = data.filter((r: Record<string, unknown>) => r.producto_activo === false)

  if (activos.length) await cacheCatalogo(activos.map(mapVarianteRow))
  if (inactivos.length) await eliminarDeCache(inactivos.map((r: Record<string, unknown>) => r.id as string))

  const maxUpdated = data.reduce((max: string, r: Record<string, unknown>) => {
    const u = r.updated_at as string
    return u > max ? u : max
  }, desde)
  await setSyncMetadata('ultima_sync_catalogo', maxUpdated)

  return true
}

export async function marcarSyncCatalogoCompleta() {
  await setSyncMetadata('ultima_sync_catalogo', new Date().toISOString())
}

// ============================================================
// Carrito activo (recuperación tras cierre inesperado del navegador)
// ============================================================

export async function guardarCarritoActivo(cart: CartItem[], cajeroId: string | null) {
  const db = await getDB()
  const key = claveCarrito(cajeroId)
  if (cart.length === 0) {
    await db.delete('carrito_activo', key)
    return
  }
  await db.put('carrito_activo', { key, cart, savedAt: new Date().toISOString() } satisfies CarritoActivo)
}

export async function obtenerCarritoActivo(cajeroId: string | null): Promise<CarritoActivo | null> {
  const db = await getDB()
  return (await db.get('carrito_activo', claveCarrito(cajeroId))) ?? null
}

export async function borrarCarritoActivo(cajeroId: string | null) {
  const db = await getDB()
  await db.delete('carrito_activo', claveCarrito(cajeroId))
}

// ============================================================
// Ventas pendientes (outbox) — misma RPC idempotente usada online y offline
// ============================================================

/**
 * Un error "de servidor" trae un código Postgres/PostgREST real (ej. 'P0001' del
 * RAISE EXCEPTION de la RPC) — significa que el request SÍ llegó y el rechazo es
 * una regla de negocio (ej. stock insuficiente), no debe encolarse offline.
 * Un fallo de red (fetch nunca llegó a responder) no trae ese código.
 * Esto es más confiable que inspeccionar el texto del mensaje de error, que
 * varía entre navegadores (Chrome: "Failed to fetch", Safari: "Load failed", etc.).
 */
export class ErrorRegistroVenta extends Error {
  esErrorDeServidor: boolean
  constructor(message: string, esErrorDeServidor: boolean) {
    super(message)
    this.esErrorDeServidor = esErrorDeServidor
  }
}

export async function registrarVenta(v: {
  clientTransactionId: string
  cart: CartItem[]
  subtotal: number
  impuesto: number
  total: number
  pagos: PagoDetalle[]
  clienteId: string | null
  clienteDoc: string | null
  locationId: string | null
  cajeroId: string | null
  cashSessionId: string | null
  comprobante?: DatosComprobante
}): Promise<Sale> {
  // Ventas encoladas antes de agregar comprobantes electrónicos no tienen este campo:
  // se tratan como boleta sin datos de cliente (mismo comportamiento que antes de Nubefact).
  const c = v.comprobante
  const { data, error } = await supabase.rpc('registrar_venta', {
    p_items: v.cart.map((i) => ({
      variant_id: i.variant.id,
      cantidad: i.cantidad,
      precio_unitario: i.precio_unitario,
      descuento: i.descuento,
      subtotal: calcularSubtotalLinea(i.precio_unitario, i.descuento, i.cantidad),
    })),
    p_pagos: v.pagos.map((p) => ({ metodo: p.metodo, monto: p.monto, referencia: p.referencia || null, pago_digital_id: p.pagoDigitalId || null })),
    p_subtotal: v.subtotal,
    p_impuesto: v.impuesto,
    p_total: v.total,
    p_client_transaction_id: v.clientTransactionId,
    p_cliente_id: v.clienteId,
    p_cliente_doc: v.clienteDoc,
    p_location_id: v.locationId,
    p_cajero_id: v.cajeroId,
    p_cash_session_id: v.cashSessionId,
    p_tipo_comprobante: c?.tipoComprobante ?? 'boleta',
    p_comprobante_cliente_tipo_doc: c?.clienteTipoDoc ?? null,
    p_comprobante_cliente_num_doc: c?.clienteNumDoc ?? null,
    p_comprobante_cliente_denominacion: c?.clienteDenominacion ?? null,
    p_comprobante_cliente_direccion: c?.clienteDireccion ?? null,
  })
  if (error) {
    throw new ErrorRegistroVenta(error.message || 'No se pudo registrar la venta', !!error.code)
  }
  return data as Sale
}

export async function queueVenta(venta: Omit<VentaPendiente, 'id' | 'estado' | 'intentos' | 'ultimoError'>) {
  const db = await getDB()
  return db.add('ventas_pendientes', { ...venta, estado: 'PENDING', intentos: 0, ultimoError: null } as VentaPendiente)
}

export async function getVentasPendientes(): Promise<VentaPendiente[]> {
  const db = await getDB()
  return db.getAll('ventas_pendientes')
}

export async function contarVentasPendientes(): Promise<{ pendientes: number; fallidas: number; agotadas: number }> {
  const db = await getDB()
  const todas = await db.getAll('ventas_pendientes')
  return {
    pendientes: todas.filter((v) => v.estado === 'PENDING' || v.estado === 'SYNCING').length,
    fallidas: todas.filter((v) => v.estado === 'FAILED' && v.intentos < MAX_INTENTOS_AUTO).length,
    agotadas: todas.filter((v) => v.estado === 'FAILED' && v.intentos >= MAX_INTENTOS_AUTO).length,
  }
}

async function marcarEstado(id: number, estado: SyncEstado, ultimoError: string | null = null) {
  const db = await getDB()
  const v = await db.get('ventas_pendientes', id)
  if (!v) return
  await db.put('ventas_pendientes', {
    ...v,
    estado,
    ultimoError,
    intentos: estado === 'FAILED' ? (v.intentos ?? 0) + 1 : v.intentos,
  })
}

let sincronizando = false

/**
 * Reintenta las ventas PENDING/FAILED del outbox (hasta MAX_INTENTOS_AUTO veces
 * automáticamente; después queda "agotada" y requiere reintento manual — ver
 * `reintentarVentaManual` — en vez de reintentarse cada 45s para siempre sin que
 * nadie se entere de que nunca va a pasar).
 *
 * Tiene un mutex en memoria que evita ejecuciones concurrentes DENTRO de la misma
 * pestaña (dos timers disparando a la vez). No protege entre pestañas distintas
 * (cada una tiene su propio contexto de JS) — la garantía real de no-duplicado
 * ante dos pestañas sincronizando al mismo tiempo vive en el backend, vía el
 * `client_transaction_id` único y el `exception when unique_violation` de
 * `registrar_venta`.
 */
export async function sincronizarVentasPendientes(forzarAgotadas = false): Promise<{ ok: number; fallidas: number }> {
  if (sincronizando) return { ok: 0, fallidas: 0 }
  sincronizando = true
  try {
    const db = await getDB()
    const todas = await db.getAll('ventas_pendientes')
    const pendientes = todas.filter((v) => v.estado === 'PENDING' || (v.estado === 'FAILED' && (forzarAgotadas || v.intentos < MAX_INTENTOS_AUTO)))
    let ok = 0
    let fallidas = 0
    for (const v of pendientes) {
      if (v.id === undefined) continue
      await marcarEstado(v.id, 'SYNCING')
      try {
        await registrarVenta(v)
        await db.delete('ventas_pendientes', v.id)
        ok++
      } catch (e) {
        await marcarEstado(v.id, 'FAILED', e instanceof Error ? e.message : 'Error desconocido')
        fallidas++
      }
    }
    return { ok, fallidas }
  } finally {
    sincronizando = false
  }
}

/** Reintenta manualmente una venta que agotó sus reintentos automáticos (acción explícita del cajero/admin). */
export async function reintentarVentaManual(id: number): Promise<boolean> {
  const db = await getDB()
  const v = await db.get('ventas_pendientes', id)
  if (!v) return false
  await marcarEstado(id, 'SYNCING')
  try {
    await registrarVenta(v)
    await db.delete('ventas_pendientes', id)
    return true
  } catch (e) {
    await marcarEstado(id, 'FAILED', e instanceof Error ? e.message : 'Error desconocido')
    return false
  }
}
