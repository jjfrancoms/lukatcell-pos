import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, Trash2, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { ProductVariant, CartItem, MetodoPago } from '../types'

const IGV = 0.18

export default function Venta() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ProductVariant[]>([])
  const [cart, setCart] = useState<CartItem[]>([])
  const [showPago, setShowPago] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    searchRef.current?.focus()
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'F4') { e.preventDefault(); if (cart.length) setShowPago(true) }
      if (e.key === 'Escape') { setShowPago(false); setCart([]) }
      if (e.key === 'F2') { e.preventDefault(); searchRef.current?.focus() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [cart.length])

  const buscar = useCallback(async (texto: string) => {
    setQuery(texto)
    if (texto.length < 2) { setResults([]); return }
    const { data } = await supabase
      .from('product_variants')
      .select('*, product:products(*), modelo:modelos_celular(*)')
      .or(`codigo_barras.eq.${texto},product.nombre.ilike.%${texto}%`)
      .limit(12)
    setResults((data as unknown as ProductVariant[]) || [])
  }, [])

  const agregarAlCarrito = (variant: ProductVariant) => {
    const precio = variant.precio_override ?? variant.product?.precio_base ?? 0
    setCart((prev) => {
      const existe = prev.find((i) => i.variant.id === variant.id)
      if (existe) {
        return prev.map((i) =>
          i.variant.id === variant.id ? { ...i, cantidad: i.cantidad + 1 } : i
        )
      }
      return [...prev, { variant, cantidad: 1, precio_unitario: precio }]
    })
    setQuery('')
    setResults([])
    searchRef.current?.focus()
  }

  const actualizarCantidad = (variantId: string, cantidad: number) => {
    if (cantidad < 1) return
    setCart((prev) => prev.map((i) => (i.variant.id === variantId ? { ...i, cantidad } : i)))
  }

  const eliminar = (variantId: string) => {
    setCart((prev) => prev.filter((i) => i.variant.id !== variantId))
  }

  const subtotal = cart.reduce((sum, i) => sum + i.precio_unitario * i.cantidad, 0)
  const impuesto = subtotal * IGV
  const total = subtotal + impuesto

  return (
    <div className="h-full flex flex-col md:flex-row">
      {/* Panel izquierdo: búsqueda */}
      <div className="flex-1 p-6 flex flex-col min-h-0">
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" size={18} />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => buscar(e.target.value)}
            placeholder="Escanea o busca un producto (F2)"
            className="w-full pl-10 pr-4 py-3 rounded-xl border border-ink-100 bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 text-sm"
          />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 overflow-y-auto">
          {results.map((v) => (
            <button
              key={v.id}
              onClick={() => agregarAlCarrito(v)}
              className="text-left bg-white rounded-xl border border-ink-100 p-3 hover:border-cyan-500 hover:shadow-md transition-all"
            >
              <p className="font-semibold text-sm text-ink-900 truncate">{v.product?.nombre}</p>
              <p className="text-xs text-ink-400 mt-0.5">
                {[v.color, v.modelo?.modelo].filter(Boolean).join(' · ') || 'Sin variante'}
              </p>
              <p className="text-cyan-700 font-bold mt-1">
                S/ {(v.precio_override ?? v.product?.precio_base ?? 0).toFixed(2)}
              </p>
            </button>
          ))}
          {query.length >= 2 && results.length === 0 && (
            <p className="text-ink-400 text-sm col-span-full">Sin resultados para "{query}"</p>
          )}
        </div>
      </div>

      {/* Panel derecho: carrito */}
      <div className="w-full md:w-96 bg-white border-l border-ink-100 flex flex-col shrink-0">
        <div className="p-4 border-b border-ink-100">
          <h2 className="font-display font-bold text-ink-900">Venta actual</h2>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {cart.length === 0 && (
            <p className="text-ink-400 text-sm text-center mt-8">Agrega productos para empezar</p>
          )}
          {cart.map((item) => (
            <div key={item.variant.id} className="flex items-center gap-2 bg-ink-100/60 rounded-lg p-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{item.variant.product?.nombre}</p>
                <p className="text-xs text-ink-400">S/ {item.precio_unitario.toFixed(2)} c/u</p>
              </div>
              <input
                type="number"
                min={1}
                value={item.cantidad}
                onChange={(e) => actualizarCantidad(item.variant.id, Number(e.target.value))}
                className="w-12 text-center border border-ink-100 rounded py-1 text-sm"
              />
              <p className="w-16 text-right text-sm font-semibold">
                {(item.precio_unitario * item.cantidad).toFixed(2)}
              </p>
              <button onClick={() => eliminar(item.variant.id)} className="text-ink-400 hover:text-red-500">
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
        <div className="p-4 border-t border-ink-100 space-y-1">
          <div className="flex justify-between text-sm text-ink-400">
            <span>Subtotal</span><span>S/ {subtotal.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-sm text-ink-400">
            <span>IGV (18%)</span><span>S/ {impuesto.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-lg font-bold text-ink-900 mb-3">
            <span>Total</span><span>S/ {total.toFixed(2)}</span>
          </div>
          <button
            disabled={cart.length === 0}
            onClick={() => setShowPago(true)}
            className="w-full bg-orange-500 disabled:bg-ink-100 disabled:text-ink-400 text-white font-semibold py-3 rounded-xl hover:bg-orange-600 transition-colors"
          >
            Cobrar (F4) · S/ {total.toFixed(2)}
          </button>
        </div>
      </div>

      {showPago && (
        <ModalPago
          total={total}
          subtotal={subtotal}
          impuesto={impuesto}
          cart={cart}
          onClose={() => setShowPago(false)}
          onConfirm={() => { setCart([]); setShowPago(false) }}
        />
      )}
    </div>
  )
}

async function registrarVenta(
  cart: CartItem[],
  subtotal: number,
  impuesto: number,
  total: number,
  metodo: MetodoPago,
  referencia: string
) {
  const { data: sale, error } = await supabase
    .from('sales')
    .insert({ subtotal, impuesto, total, estado: 'completada' })
    .select()
    .single()

  if (error || !sale) {
    throw new Error(error?.message || 'No se pudo registrar la venta')
  }

  const items = cart.map((i) => ({
    sale_id: sale.id,
    variant_id: i.variant.id,
    cantidad: i.cantidad,
    precio_unitario: i.precio_unitario,
    subtotal: i.precio_unitario * i.cantidad,
  }))
  const { error: itemsError } = await supabase.from('sale_items').insert(items)
  if (itemsError) throw new Error(itemsError.message)

  const { error: pagoError } = await supabase
    .from('payments')
    .insert({ sale_id: sale.id, metodo, monto: total, referencia: referencia || null })
  if (pagoError) throw new Error(pagoError.message)

  return sale.id as string
}

function ModalPago({
  total, subtotal, impuesto, cart, onClose, onConfirm,
}: { total: number; subtotal: number; impuesto: number; cart: CartItem[]; onClose: () => void; onConfirm: () => void }) {
  const [metodo, setMetodo] = useState<MetodoPago>('efectivo')
  const [recibido, setRecibido] = useState('')
  const [referencia, setReferencia] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')

  const vuelto = metodo === 'efectivo' ? Math.max(0, Number(recibido || 0) - total) : 0

  const confirmarPago = async () => {
    setGuardando(true)
    setError('')
    try {
      await registrarVenta(cart, subtotal, impuesto, total, metodo, referencia)
      onConfirm()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al procesar el pago')
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-sm p-6 relative">
        <button onClick={onClose} className="absolute top-4 right-4 text-ink-400 hover:text-ink-900">
          <X size={20} />
        </button>
        <h3 className="font-display font-bold text-lg mb-1">Cobrar venta</h3>
        <p className="text-2xl font-bold text-cyan-700 mb-4">S/ {total.toFixed(2)}</p>

        <div className="flex gap-2 mb-4">
          {(['efectivo', 'tarjeta', 'yape', 'plin'] as MetodoPago[]).map((m) => (
            <button
              key={m}
              onClick={() => setMetodo(m)}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold capitalize border ${
                metodo === m ? 'bg-cyan-500 text-ink-900 border-cyan-500' : 'border-ink-100 text-ink-400'
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        {metodo === 'efectivo' ? (
          <div className="mb-4">
            <label className="text-xs text-ink-400">Monto recibido</label>
            <input
              autoFocus
              type="number"
              value={recibido}
              onChange={(e) => setRecibido(e.target.value)}
              className="w-full border border-ink-100 rounded-lg px-3 py-2 mt-1"
            />
            <p className="text-sm mt-2">Vuelto: <span className="font-semibold">S/ {vuelto.toFixed(2)}</span></p>
          </div>
        ) : (
          <div className="mb-4">
            <label className="text-xs text-ink-400">Código de operación</label>
            <input
              autoFocus
              value={referencia}
              onChange={(e) => setReferencia(e.target.value)}
              className="w-full border border-ink-100 rounded-lg px-3 py-2 mt-1"
            />
          </div>
        )}

        {error && <p className="text-red-500 text-xs mb-2">{error}</p>}

        <button
          onClick={confirmarPago}
          disabled={guardando}
          className="w-full bg-cyan-500 disabled:opacity-60 text-ink-900 font-bold py-3 rounded-xl hover:bg-cyan-600 transition-colors"
        >
          {guardando ? 'Procesando...' : 'Confirmar pago'}
        </button>
      </div>
    </div>
  )
}
