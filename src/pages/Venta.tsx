import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, Trash2, X, Smartphone, Keyboard, Printer, Wrench, Monitor, Headphones, Cable, Shield, LayoutGrid, Percent, ShoppingBag } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { ProductVariant, CartItem, MetodoPago } from '../types'

const IGV = 0.18
interface Categoria { id: string; nombre: string }
const catIcons: Record<string, any> = {
  'Fundas': Smartphone, 'Cables': Cable, 'Audífonos': Headphones,
  'Cargadores': Cable, 'Mica y protectores': Shield, 'Teclados': Keyboard,
  'Insumos de impresora': Printer, 'Reparación técnica': Wrench, 'Accesorios de PC': Monitor,
}

function mapRow(r: any): ProductVariant {
  return { id: r.id, product_id: r.product_id, color: r.color, modelo_celular_id: r.modelo_celular_id,
    precio_override: r.precio_override, codigo_barras: r.codigo_barras,
    product: { nombre: r.producto_nombre, sku: r.producto_sku, precio_base: Number(r.producto_precio), imagen_url: r.producto_imagen } as any,
    modelo: r.modelo_marca ? { marca: r.modelo_marca, modelo: r.modelo_modelo } as any : null }
}

function mapDirect(r: any): ProductVariant {
  return { id: r.id, product_id: r.product_id, color: r.color, modelo_celular_id: r.modelo_celular_id,
    precio_override: r.precio_override, codigo_barras: r.codigo_barras, product: r.product, modelo: r.modelo }
}

export default function Venta() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ProductVariant[]>([])
  const [favoritos, setFavoritos] = useState<ProductVariant[]>([])
  const [cart, setCart] = useState<CartItem[]>([])
  const [showPago, setShowPago] = useState(false)
  const [categorias, setCategorias] = useState<Categoria[]>([])
  const [catActiva, setCatActiva] = useState<string | null>(null)
  const [descItem, setDescItem] = useState<string | null>(null)
  const [descValor, setDescValor] = useState('')
  const [descTipo, setDescTipo] = useState<'pct' | 'fijo'>('pct')
  const [loading, setLoading] = useState(true)
  const searchRef = useRef<HTMLInputElement>(null)

  // Cargar categorías y favoritos al inicio
  useEffect(() => {
    const init = async () => {
      const [catRes, favRes] = await Promise.all([
        supabase.from('categorias').select('id, nombre').order('nombre'),
        supabase.rpc('obtener_favoritos')
      ])
      setCategorias(catRes.data || [])
      const favs = (favRes.data || []).map(mapRow)
      setFavoritos(favs)
      setLoading(false)
    }
    init()
  }, [])

  useEffect(() => {
    searchRef.current?.focus()
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'F4') { e.preventDefault(); if (cart.length) setShowPago(true) }
      if (e.key === 'Escape') { setShowPago(false); setDescItem(null) }
      if (e.key === 'F2') { e.preventDefault(); searchRef.current?.focus() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [cart.length])

  const buscar = useCallback(async (texto: string) => {
    setQuery(texto); setCatActiva(null)
    if (texto.length < 2) { setResults([]); return }
    const { data } = await supabase.rpc('buscar_variantes', { texto })
    setResults((data || []).map(mapRow))
  }, [])

  const cargarCategoria = async (catId: string) => {
    setCatActiva(catId); setQuery('')
    if (catId === 'all') {
      const { data } = await supabase.from('product_variants')
        .select('id, product_id, color, modelo_celular_id, precio_override, codigo_barras, product:products(nombre, sku, precio_base, imagen_url), modelo:modelos_celular(marca, modelo)')
        .limit(40)
      setResults((data || []).map(mapDirect))
    } else {
      const { data } = await supabase.rpc('variantes_por_categoria', { cat_id: catId })
      setResults((data || []).map(mapRow))
    }
  }

  const agregarAlCarrito = (variant: ProductVariant) => {
    const precio = variant.precio_override ?? (variant.product as any)?.precio_base ?? 0
    setCart((prev) => {
      const existe = prev.find((i) => i.variant.id === variant.id)
      if (existe) return prev.map((i) => i.variant.id === variant.id ? { ...i, cantidad: i.cantidad + 1 } : i)
      return [...prev, { variant, cantidad: 1, precio_unitario: precio, descuento: 0 } as any]
    })
    searchRef.current?.focus()
  }

  const actualizarCantidad = (vid: string, c: number) => { if (c >= 1) setCart((p) => p.map((i) => i.variant.id === vid ? { ...i, cantidad: c } : i)) }
  const eliminar = (vid: string) => setCart((p) => p.filter((i) => i.variant.id !== vid))

  const aplicarDescuento = (vid: string) => {
    const val = Number(descValor) || 0
    if (val <= 0) { setDescItem(null); return }
    setCart((p) => p.map((i) => {
      if (i.variant.id !== vid) return i
      const d = descTipo === 'pct' ? (i.precio_unitario * val / 100) : val
      return { ...i, descuento: Math.min(d, i.precio_unitario) }
    }))
    setDescItem(null); setDescValor('')
  }

  const subtotal = cart.reduce((s, i) => s + (i.precio_unitario - ((i as any).descuento || 0)) * i.cantidad, 0)
  const totalDesc = cart.reduce((s, i) => s + ((i as any).descuento || 0) * i.cantidad, 0)
  const impuesto = subtotal * IGV
  const total = subtotal + impuesto
  const productosVisible = query.length >= 2 || catActiva ? results : favoritos
  const showFavLabel = !query && !catActiva && favoritos.length > 0

  return (
    <div className="h-full flex flex-col md:flex-row bg-[#0d1117]">
      {/* Panel principal */}
      <div className="flex-1 p-4 md:p-5 flex flex-col min-h-0">
        {/* Buscador */}
        <div className="relative mb-3">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" size={18} />
          <input ref={searchRef} value={query} onChange={(e) => buscar(e.target.value)}
            placeholder="Buscar producto, SKU o escanear código..."
            className="w-full pl-11 pr-4 py-3 rounded-xl bg-[#161b22] border border-[#30363d] text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent text-sm" />
        </div>

        {/* Categorías */}
        <div className="flex gap-2 mb-4 overflow-x-auto pb-1 scrollbar-hide">
          <button onClick={() => cargarCategoria('all')}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-semibold whitespace-nowrap transition-all ${
              catActiva === 'all' ? 'bg-cyan-500 text-black shadow-lg shadow-cyan-500/30' : 'bg-[#161b22] border border-[#30363d] text-gray-300 hover:border-cyan-500/50 hover:text-white'}`}>
            <LayoutGrid size={13} /> Todo
          </button>
          {categorias.map((c) => {
            const Icon = catIcons[c.nombre] || Smartphone
            return (
              <button key={c.id} onClick={() => cargarCategoria(c.id)}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-semibold whitespace-nowrap transition-all ${
                  catActiva === c.id ? 'bg-cyan-500 text-black shadow-lg shadow-cyan-500/30' : 'bg-[#161b22] border border-[#30363d] text-gray-300 hover:border-cyan-500/50 hover:text-white'}`}>
                <Icon size={13} /> {c.nombre}
              </button>
            )
          })}
        </div>

        {/* Título sección */}
        {showFavLabel && <p className="text-xs font-bold text-cyan-500 uppercase tracking-widest mb-3">⚡ Más vendidos</p>}

        {/* Grid de productos */}
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 overflow-y-auto flex-1">
          {loading && <p className="text-gray-500 text-sm col-span-full py-12 text-center">Cargando productos...</p>}
          {!loading && productosVisible.map((v) => {
            const img = (v.product as any)?.imagen_url
            const precio = v.precio_override ?? (v.product as any)?.precio_base ?? 0
            return (
              <button key={v.id} onClick={() => agregarAlCarrito(v)}
                className="group text-left bg-[#161b22] rounded-xl border border-[#30363d] overflow-hidden hover:border-cyan-500 hover:shadow-lg hover:shadow-cyan-500/10 transition-all">
                <div className="h-32 w-full bg-[#21262d] overflow-hidden relative">
                  {img ? <img src={img} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                    : <div className="w-full h-full flex items-center justify-center"><ShoppingBag size={32} className="text-gray-600" /></div>}
                  <span className="absolute bottom-2 right-2 bg-cyan-500 text-black text-xs font-bold px-2 py-0.5 rounded-md">S/ {precio.toFixed(2)}</span>
                </div>
                <div className="p-3">
                  <p className="font-semibold text-sm text-white truncate">{v.product?.nombre}</p>
                  <p className="text-xs text-gray-500 mt-0.5 truncate">
                    {[v.color, v.modelo?.modelo].filter(Boolean).join(' · ') || v.product?.sku}
                  </p>
                </div>
              </button>
            )
          })}
          {!loading && query.length >= 2 && results.length === 0 && <p className="text-gray-500 text-sm col-span-full py-12 text-center">Sin resultados para "{query}"</p>}
          {!loading && !query && !catActiva && favoritos.length === 0 && <p className="text-gray-500 text-sm col-span-full py-12 text-center">Busca un producto o selecciona una categoría</p>}
        </div>
      </div>

      {/* Panel carrito */}
      <div className="w-full md:w-[380px] bg-[#161b22] border-l border-[#30363d] flex flex-col shrink-0">
        <div className="p-4 border-b border-[#30363d] flex items-center justify-between">
          <h2 className="font-display font-bold text-white text-base">Venta actual</h2>
          {cart.length > 0 && <span className="bg-cyan-500 text-black text-xs font-bold px-2 py-0.5 rounded-full">{cart.length}</span>}
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {cart.length === 0 && (
            <div className="text-center mt-12">
              <ShoppingBag size={40} className="text-gray-600 mx-auto mb-3" />
              <p className="text-gray-500 text-sm">Agrega productos para empezar</p>
            </div>
          )}
          {cart.map((item) => {
            const desc = (item as any).descuento || 0
            const pf = item.precio_unitario - desc
            return (
              <div key={item.variant.id} className="bg-[#21262d] rounded-lg p-3 border border-[#30363d]">
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{item.variant.product?.nombre}</p>
                    <p className="text-xs text-gray-500">
                      S/ {item.precio_unitario.toFixed(2)} c/u
                      {desc > 0 && <span className="text-orange-400 ml-1 font-semibold">→ S/ {pf.toFixed(2)}</span>}
                    </p>
                  </div>
                  <div className="flex items-center bg-[#0d1117] rounded-lg border border-[#30363d]">
                    <button onClick={() => actualizarCantidad(item.variant.id, item.cantidad - 1)} className="px-2 py-1 text-gray-400 hover:text-white text-sm">−</button>
                    <span className="px-2 text-white text-sm font-semibold w-8 text-center">{item.cantidad}</span>
                    <button onClick={() => actualizarCantidad(item.variant.id, item.cantidad + 1)} className="px-2 py-1 text-gray-400 hover:text-white text-sm">+</button>
                  </div>
                  <p className="w-16 text-right text-sm font-bold text-cyan-400">{(pf * item.cantidad).toFixed(2)}</p>
                  <button onClick={() => setDescItem(descItem === item.variant.id ? null : item.variant.id)} className="text-gray-500 hover:text-orange-400 transition-colors" title="Descuento">
                    <Percent size={14} />
                  </button>
                  <button onClick={() => eliminar(item.variant.id)} className="text-gray-500 hover:text-red-400 transition-colors">
                    <Trash2 size={14} />
                  </button>
                </div>
                {descItem === item.variant.id && (
                  <div className="flex items-center gap-2 mt-2 pt-2 border-t border-[#30363d]">
                    <div className="flex bg-[#0d1117] rounded-lg border border-[#30363d] overflow-hidden">
                      <button onClick={() => setDescTipo('pct')} className={`px-2.5 py-1 text-xs font-bold transition-colors ${descTipo === 'pct' ? 'bg-orange-500 text-white' : 'text-gray-400'}`}>%</button>
                      <button onClick={() => setDescTipo('fijo')} className={`px-2.5 py-1 text-xs font-bold transition-colors ${descTipo === 'fijo' ? 'bg-orange-500 text-white' : 'text-gray-400'}`}>S/</button>
                    </div>
                    <input autoFocus type="number" value={descValor} onChange={(e) => setDescValor(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && aplicarDescuento(item.variant.id)}
                      placeholder={descTipo === 'pct' ? '10' : '5.00'}
                      className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-lg px-2 py-1 text-sm text-white placeholder-gray-600" />
                    <button onClick={() => aplicarDescuento(item.variant.id)}
                      className="bg-orange-500 text-white text-xs font-bold px-3 py-1.5 rounded-lg hover:bg-orange-600 transition-colors">Aplicar</button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {/* Totales */}
        <div className="p-4 border-t border-[#30363d] space-y-1.5">
          {totalDesc > 0 && (
            <div className="flex justify-between text-sm"><span className="text-orange-400">Descuento</span><span className="text-orange-400 font-semibold">-S/ {totalDesc.toFixed(2)}</span></div>
          )}
          <div className="flex justify-between text-sm"><span className="text-gray-500">Subtotal</span><span className="text-gray-300">S/ {subtotal.toFixed(2)}</span></div>
          <div className="flex justify-between text-sm"><span className="text-gray-500">IGV (18%)</span><span className="text-gray-300">S/ {impuesto.toFixed(2)}</span></div>
          <div className="flex justify-between text-xl font-bold pt-2 border-t border-[#30363d]">
            <span className="text-white">Total</span><span className="text-cyan-400">S/ {total.toFixed(2)}</span>
          </div>
          <button disabled={cart.length === 0} onClick={() => setShowPago(true)}
            className="w-full mt-2 bg-gradient-to-r from-cyan-500 to-cyan-600 disabled:from-[#21262d] disabled:to-[#21262d] disabled:text-gray-600 text-black font-bold py-3.5 rounded-xl hover:shadow-lg hover:shadow-cyan-500/30 transition-all text-sm">
            Cobrar (F4) · S/ {total.toFixed(2)}
          </button>
        </div>
      </div>

      {showPago && <ModalPago total={total} subtotal={subtotal} impuesto={impuesto} cart={cart}
        onClose={() => setShowPago(false)} onConfirm={() => { setCart([]); setShowPago(false) }} />}
    </div>
  )
}

async function registrarVenta(cart: CartItem[], subtotal: number, impuesto: number, total: number, metodo: MetodoPago, referencia: string) {
  const { data: sale, error } = await supabase.from('sales').insert({ subtotal, impuesto, total, estado: 'completada' }).select().single()
  if (error || !sale) throw new Error(error?.message || 'No se pudo registrar la venta')
  const items = cart.map((i) => ({ sale_id: sale.id, variant_id: i.variant.id, cantidad: i.cantidad, precio_unitario: i.precio_unitario, subtotal: (i.precio_unitario - ((i as any).descuento || 0)) * i.cantidad, descuento: (i as any).descuento || 0 }))
  const { error: e2 } = await supabase.from('sale_items').insert(items)
  if (e2) throw new Error(e2.message)
  const { error: e3 } = await supabase.from('payments').insert({ sale_id: sale.id, metodo, monto: total, referencia: referencia || null })
  if (e3) throw new Error(e3.message)
  return sale.id as string
}

function ModalPago({ total, subtotal, impuesto, cart, onClose, onConfirm }: { total: number; subtotal: number; impuesto: number; cart: CartItem[]; onClose: () => void; onConfirm: () => void }) {
  const [metodo, setMetodo] = useState<MetodoPago>('efectivo')
  const [recibido, setRecibido] = useState('')
  const [referencia, setReferencia] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')
  const vuelto = metodo === 'efectivo' ? Math.max(0, Number(recibido || 0) - total) : 0
  const confirmarPago = async () => {
    setGuardando(true); setError('')
    try { await registrarVenta(cart, subtotal, impuesto, total, metodo, referencia); onConfirm() }
    catch (e) { setError(e instanceof Error ? e.message : 'Error') } finally { setGuardando(false) }
  }
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-[#161b22] rounded-2xl w-full max-w-sm p-6 relative border border-[#30363d] shadow-2xl">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-500 hover:text-white"><X size={20} /></button>
        <h3 className="font-display font-bold text-lg text-white mb-1">Cobrar venta</h3>
        <p className="text-3xl font-bold text-cyan-400 mb-5">S/ {total.toFixed(2)}</p>
        <div className="grid grid-cols-4 gap-2 mb-5">
          {(['efectivo', 'tarjeta', 'yape', 'plin'] as MetodoPago[]).map((m) => (
            <button key={m} onClick={() => setMetodo(m)}
              className={`py-2.5 rounded-xl text-xs font-bold capitalize transition-all ${
                metodo === m ? 'bg-cyan-500 text-black shadow-lg shadow-cyan-500/30' : 'bg-[#21262d] border border-[#30363d] text-gray-400 hover:border-cyan-500/50'}`}>{m}</button>
          ))}
        </div>
        {metodo === 'efectivo' ? (
          <div className="mb-5">
            <label className="text-xs text-gray-500 font-semibold">Monto recibido</label>
            <input autoFocus type="number" value={recibido} onChange={(e) => setRecibido(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mt-1.5 text-white text-lg focus:outline-none focus:ring-2 focus:ring-cyan-500" />
            <div className="flex justify-between mt-3 bg-[#21262d] rounded-lg p-3">
              <span className="text-gray-400 text-sm">Vuelto</span>
              <span className="text-green-400 font-bold text-lg">S/ {vuelto.toFixed(2)}</span>
            </div>
          </div>
        ) : (
          <div className="mb-5">
            <label className="text-xs text-gray-500 font-semibold">Código de operación</label>
            <input autoFocus value={referencia} onChange={(e) => setReferencia(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mt-1.5 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
        )}
        {error && <p className="text-red-400 text-xs mb-3 bg-red-500/10 rounded-lg p-2">{error}</p>}
        <button onClick={confirmarPago} disabled={guardando}
          className="w-full bg-gradient-to-r from-cyan-500 to-cyan-600 disabled:opacity-40 text-black font-bold py-3.5 rounded-xl hover:shadow-lg hover:shadow-cyan-500/30 transition-all">
          {guardando ? 'Procesando...' : '✓ Confirmar pago'}</button>
      </div>
    </div>
  )
}
