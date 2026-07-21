import { useEffect, useState } from 'react'
import { openDB, type IDBPDatabase } from 'idb'
import { supabase } from './supabase'
import type { CartItem, PagoDetalle, ProductVariant } from '../types'

const DB_NAME = 'lukatcell-pos'
const DB_VERSION = 1

export interface VentaPendiente {
  id?: number
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
  createdAt: string
}

let dbPromise: Promise<IDBPDatabase> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('catalogo')) db.createObjectStore('catalogo', { keyPath: 'id' })
        if (!db.objectStoreNames.contains('categorias')) db.createObjectStore('categorias', { keyPath: 'id' })
        if (!db.objectStoreNames.contains('outbox_ventas')) db.createObjectStore('outbox_ventas', { keyPath: 'id', autoIncrement: true })
      },
    })
  }
  return dbPromise
}

export function useOnlineStatus() {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  return online
}

export async function cacheCatalogo(items: ProductVariant[]) {
  const db = await getDB()
  const tx = db.transaction('catalogo', 'readwrite')
  await Promise.all(items.map((i) => tx.store.put(i)))
  await tx.done
}

export async function getCatalogoCache(): Promise<ProductVariant[]> {
  const db = await getDB()
  return db.getAll('catalogo')
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

export async function queueVenta(venta: Omit<VentaPendiente, 'id'>) {
  const db = await getDB()
  return db.add('outbox_ventas', venta as VentaPendiente)
}

export async function getVentasPendientes(): Promise<VentaPendiente[]> {
  const db = await getDB()
  return db.getAll('outbox_ventas')
}

export async function contarVentasPendientes(): Promise<number> {
  const db = await getDB()
  return db.count('outbox_ventas')
}

async function insertarVentaRemota(v: VentaPendiente) {
  const { data: sale, error } = await supabase.from('sales')
    .insert({ subtotal: v.subtotal, impuesto: v.impuesto, total: v.total, estado: 'completada', cliente_id: v.clienteId, cliente_doc: v.clienteDoc, cash_session_id: v.cashSessionId, location_id: v.locationId, cajero_id: v.cajeroId })
    .select().single()
  if (error || !sale) throw new Error(error?.message || 'Error al sincronizar venta')
  const items = v.cart.map((i) => ({
    sale_id: sale.id, variant_id: i.variant.id, cantidad: i.cantidad,
    precio_unitario: i.precio_unitario, subtotal: (i.precio_unitario - (i.descuento || 0)) * i.cantidad, descuento: i.descuento || 0,
  }))
  await supabase.from('sale_items').insert(items)
  await supabase.from('payments').insert(v.pagos.map((p) => ({ sale_id: sale.id, metodo: p.metodo, monto: p.monto, referencia: p.referencia || null })))
}

export async function sincronizarVentasPendientes(): Promise<{ ok: number; fallidas: number }> {
  const db = await getDB()
  const pendientes = await db.getAll('outbox_ventas')
  let ok = 0, fallidas = 0
  for (const v of pendientes) {
    try {
      await insertarVentaRemota(v)
      if (v.id !== undefined) await db.delete('outbox_ventas', v.id)
      ok++
    } catch {
      fallidas++
    }
  }
  return { ok, fallidas }
}
