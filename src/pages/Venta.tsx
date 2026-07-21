import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, Trash2, X, Smartphone, Keyboard, Printer, Wrench, Monitor, Headphones, Cable, Shield, LayoutGrid, Percent, ShoppingBag, Plus, Minus, ChevronUp, UserPlus, User } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { cacheCatalogo, cacheCategorias, buscarEnCache, getCatalogoCache, queueVenta, useOnlineStatus } from '../lib/offline'
import { useToast } from '../lib/toast'
import type { ProductVariant, CartItem, MetodoPago, PagoDetalle, Cliente } from '../types'
import ReciboVenta from '../components/ReciboVenta'

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

export default function Venta() {
  const { staff, cashSessionId } = useAuth()
  const online = useOnlineStatus()
  const { showToast } = useToast()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ProductVariant[]>([])
  const [favoritos, setFavoritos] = useState<ProductVariant[]>([])
  const [cart, setCart] = useState<CartItem[]>([])
  const [showPago, setShowPago] = useState(false)
  const [showCart, setShowCart] = useState(false)
  const [categorias, setCategorias] = useState<Categoria[]>([])
  const [catActiva, setCatActiva] = useState<string | null>(null)
  const [descItem, setDescItem] = useState<string | null>(null)
  const [descValor, setDescValor] = useState('')
  const [descTipo, setDescTipo] = useState<'pct' | 'fijo'>('pct')
  const [loading, setLoading] = useState(true)
  const [recibo, setRecibo] = useState<{ saleId: string; fecha: string; cart: CartItem[]; subtotal: number; impuesto: number; total: number; pagos: PagoDetalle[]; clienteNombre: string | null } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    Promise.all([
      supabase.from('categorias').select('id, nombre').order('nombre'),
      supabase.rpc('obtener_favoritos'),
      supabase.from('product_variants').select('id, product_id, color, modelo_celular_id, precio_override, codigo_barras, product:products(nombre, sku, precio_base, imagen_url), modelo:modelos_celular(marca, modelo)'),
    ]).then(([catRes, favRes, allRes]) => {
      const cats = catRes.data || []
      const favs = (favRes.data || []).map(mapRow)
      const todas = ((allRes.data as any[]) || []).map((r) => ({ ...r, product: r.product, modelo: r.modelo })) as ProductVariant[]
      setCategorias(cats)
      setFavoritos(favs.length > 0 ? favs : todas.slice(0, 12))
      setLoading(false)
      if (cats.length) cacheCategorias(cats)
      if (todas.length) cacheCatalogo(todas)
    }).catch(async () => {
      const cached = await getCatalogoCache()
      setFavoritos(cached.slice(0, 12))
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'F4') { e.preventDefault(); if (cart.length) setShowPago(true) }
      if (e.key === 'Escape') { setShowPago(false); setDescItem(null) }
      if (e.key === 'F2') { e.preventDefault(); searchRef.current?.focus() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [cart.length])

  const handleSearchKeyDown = async (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && query.length >= 4) {
      e.preventDefault()
      if (!online) {
        const cached = await buscarEnCache(query.trim())
        if (cached.length) { agregarAlCarrito(cached[0]); setQuery(''); setResults([]) }
        return
      }
      const { data } = await supabase.rpc('buscar_por_barcode', { barcode: query.trim() })
      if (data && data.length > 0) {
        agregarAlCarrito(mapRow(data[0])); setQuery(''); setResults([])
      }
    }
  }

  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const ejecutarBusqueda = useCallback(async (texto: string) => {
    if (!online) { setResults(await buscarEnCache(texto)); return }

    if (/^\d{8,}$/.test(texto)) {
      const { data: exact } = await supabase.rpc('buscar_por_barcode', { barcode: texto })
      if (exact && exact.length > 0) { agregarAlCarrito(mapRow(exact[0])); setQuery(''); setResults([]); return }
    }

    try {
      const { data } = await supabase.rpc('buscar_variantes', { texto })
      setResults((data || []).map(mapRow))
    } catch { setResults(await buscarEnCache(texto)) }
  }, [online])

  const buscar = useCallback((texto: string) => {
    setQuery(texto); setCatActiva(null)
    if (searchTimeout.current) clearTimeout(searchTimeout.current)
    if (texto.length < 2) { setResults([]); return }
    searchTimeout.current = setTimeout(() => ejecutarBusqueda(texto), 300)
  }, [ejecutarBusqueda])

  const cargarCategoria = async (catId: string) => {
    setCatActiva(catId); setQuery('')
    if (!online) {
      const cached = await getCatalogoCache()
      setResults(catId === 'all' ? cached : cached.filter((v) => (v.product as any)?.categoria_id === catId))
      return
    }
    if (catId === 'all') {
      const { data } = await supabase.from('product_variants')
        .select('id, product_id, color, modelo_celular_id, precio_override, codigo_barras, product:products(nombre, sku, precio_base, imagen_url), modelo:modelos_celular(marca, modelo)')
        .limit(60)
      setResults(((data as any[]) || []).map((r) => ({ ...r, product: r.product, modelo: r.modelo })))
    } else {
      const { data } = await supabase.rpc('variantes_por_categoria', { cat_id: catId })
      setResults((data || []).map(mapRow))
    }
  }

  const agregarAlCarrito = (v: ProductVariant) => {
    const precio = v.precio_override ?? (v.product as any)?.precio_base ?? 0
    setCart((prev) => {
      const e = prev.find((i) => i.variant.id === v.id)
      if (e) return prev.map((i) => i.variant.id === v.id ? { ...i, cantidad: i.cantidad + 1 } : i)
      return [...prev, { variant: v, cantidad: 1, precio_unitario: precio, descuento: 0 }]
    })
  }

  const updQty = (vid: string, c: number) => { if (c >= 1) setCart((p) => p.map((i) => i.variant.id === vid ? { ...i, cantidad: c } : i)) }
  const del = (vid: string) => {
    const item = cart.find((i) => i.variant.id === vid)
    setCart((p) => p.filter((i) => i.variant.id !== vid))
    if (item) showToast(`${item.variant.product?.nombre ?? 'Producto'} eliminado`, 'info', {
      label: 'Deshacer', onClick: () => setCart((p) => p.some((i) => i.variant.id === vid) ? p : [...p, item]),
    })
  }
  const applyDisc = (vid: string) => {
    const val = Number(descValor) || 0; if (val <= 0) { setDescItem(null); return }
    setCart((p) => p.map((i) => { if (i.variant.id !== vid) return i; const d = descTipo === 'pct' ? (i.precio_unitario * val / 100) : val; return { ...i, descuento: Math.min(d, i.precio_unitario) } }))
    setDescItem(null); setDescValor('')
  }

  const subtotal = cart.reduce((s, i) => s + (i.precio_unitario - i.descuento) * i.cantidad, 0)
  const totalDesc = cart.reduce((s, i) => s + i.descuento * i.cantidad, 0)
  const impuesto = subtotal * IGV
  const total = subtotal + impuesto
  const items = query.length >= 2 || catActiva ? results : favoritos

  return (
    <div className="h-full flex flex-col lg:flex-row relative">
      {/* Panel productos */}
      <div className="flex-1 p-3 md:p-5 flex flex-col min-h-0">
        <div className="relative mb-3">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" size={18} />
          <input ref={searchRef} value={query} onChange={(e) => buscar(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            aria-label="Buscar producto, SKU o escanear código de barras"
            placeholder="Buscar producto, SKU o escanear código de barras..."
            className="w-full pl-11 pr-4 py-3 rounded-xl bg-[#161b22] border border-[#30363d] text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 text-sm" />
        </div>
        <p className="hidden lg:flex items-center gap-3 text-[10px] text-gray-600 -mt-2 mb-3">
          <span><kbd className="px-1 py-0.5 bg-[#161b22] border border-[#30363d] rounded">F2</kbd> buscar</span>
          <span><kbd className="px-1 py-0.5 bg-[#161b22] border border-[#30363d] rounded">F4</kbd> cobrar</span>
          <span><kbd className="px-1 py-0.5 bg-[#161b22] border border-[#30363d] rounded">Esc</kbd> cancelar</span>
        </p>
        <div className="flex gap-2 mb-3 overflow-x-auto pb-1 scrollbar-hide">
          <button onClick={() => cargarCategoria('all')}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-semibold whitespace-nowrap transition-all shrink-0 ${catActiva === 'all' ? 'bg-cyan-500 text-black' : 'bg-[#161b22] border border-[#30363d] text-gray-300 hover:border-cyan-500/50'}`}>
            <LayoutGrid size={13} /> Todo
          </button>
          {categorias.map((c) => {
            const Icon = catIcons[c.nombre] || Smartphone
            return <button key={c.id} onClick={() => cargarCategoria(c.id)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-semibold whitespace-nowrap transition-all shrink-0 ${catActiva === c.id ? 'bg-cyan-500 text-black' : 'bg-[#161b22] border border-[#30363d] text-gray-300 hover:border-cyan-500/50'}`}>
              <Icon size={13} /> {c.nombre}
            </button>
          })}
        </div>
        {!query && !catActiva && favoritos.length > 0 && <p className="text-xs font-bold text-cyan-500 uppercase tracking-widest mb-2">⚡ Más vendidos</p>}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-2 md:gap-3 overflow-y-auto flex-1 pb-20 lg:pb-0">
          {loading && <p className="text-gray-500 text-sm col-span-full py-12 text-center">Cargando...</p>}
          {!loading && items.map((v) => {
            const img = (v.product as any)?.imagen_url
            const precio = v.precio_override ?? (v.product as any)?.precio_base ?? 0
            return (
              <button key={v.id} onClick={() => agregarAlCarrito(v)}
                className="group text-left bg-[#161b22] rounded-xl border border-[#30363d] overflow-hidden hover:border-cyan-500 hover:shadow-lg hover:shadow-cyan-500/10 transition-all active:scale-[0.98]">
                <div className="h-24 sm:h-32 w-full bg-[#21262d] overflow-hidden relative">
                  {img ? (
                    <img src={img} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" loading="lazy"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; e.currentTarget.nextElementSibling?.classList.remove('hidden') }} />
                  ) : null}
                  <div className={`w-full h-full items-center justify-center ${img ? 'hidden' : 'flex'}`}><ShoppingBag size={28} className="text-gray-600" /></div>
                  <span className="absolute bottom-1.5 right-1.5 bg-cyan-500 text-black text-[11px] font-bold px-1.5 py-0.5 rounded-md">S/ {precio.toFixed(2)}</span>
                </div>
                <div className="p-2 md:p-3">
                  <p className="font-semibold text-xs md:text-sm text-white truncate">{v.product?.nombre}</p>
                  <p className="text-[11px] text-gray-500 truncate">{[v.color, v.modelo?.modelo].filter(Boolean).join(' · ') || v.product?.sku}</p>
                </div>
              </button>
            )
          })}
          {!loading && query.length >= 2 && results.length === 0 && <p className="text-gray-500 text-sm col-span-full py-12 text-center">Sin resultados para "{query}"</p>}
          {!loading && !query && !catActiva && favoritos.length === 0 && <p className="text-gray-500 text-sm col-span-full py-12 text-center">Busca un producto o selecciona una categoría</p>}
        </div>
      </div>

      {/* Mobile cart toggle */}
      {cart.length > 0 && !showCart && (
        <button onClick={() => setShowCart(true)}
          className="lg:hidden fixed bottom-4 left-4 right-4 z-20 bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-bold py-3.5 rounded-xl flex items-center justify-between px-5 shadow-xl shadow-cyan-500/30 active:scale-[0.98]">
          <span className="flex items-center gap-2"><ShoppingBag size={18} /> {cart.length} items</span>
          <span>S/ {total.toFixed(2)} <ChevronUp size={16} className="inline" /></span>
        </button>
      )}

      {/* Cart panel */}
      <div className={`${showCart ? 'fixed inset-0 z-30 bg-black/60 lg:relative lg:bg-transparent' : 'hidden lg:flex'} lg:w-[360px]`}>
        <div className={`${showCart ? 'absolute bottom-0 left-0 right-0 max-h-[85vh] lg:relative lg:max-h-none' : ''} w-full lg:w-[360px] bg-[#161b22] border-l border-[#30363d] flex flex-col shrink-0 rounded-t-2xl lg:rounded-none`}>
          <div className="p-4 border-b border-[#30363d] flex items-center justify-between">
            <h2 className="font-display font-bold text-white text-base">Venta actual</h2>
            <div className="flex items-center gap-2">
              {cart.length > 0 && <span className="bg-cyan-500 text-black text-xs font-bold px-2 py-0.5 rounded-full">{cart.length}</span>}
              <button onClick={() => setShowCart(false)} className="lg:hidden text-gray-500" aria-label="Cerrar carrito"><X size={20} /></button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {cart.length === 0 && <div className="text-center mt-8"><ShoppingBag size={36} className="text-gray-600 mx-auto mb-2" /><p className="text-gray-500 text-sm">Agrega productos</p></div>}
            {cart.map((item) => {
              const pf = item.precio_unitario - item.descuento
              return (
                <div key={item.variant.id} className="bg-[#21262d] rounded-lg p-2.5 border border-[#30363d]">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white truncate">{item.variant.product?.nombre}</p>
                      <p className="text-xs text-gray-500">S/ {item.precio_unitario.toFixed(2)}{item.descuento > 0 && <span className="text-orange-400 ml-1">→ {pf.toFixed(2)}</span>}</p>
                    </div>
                    <div className="flex items-center bg-[#0d1117] rounded-lg border border-[#30363d]">
                      <button onClick={() => updQty(item.variant.id, item.cantidad - 1)} className="p-1.5 text-gray-400 hover:text-white" aria-label="Restar cantidad"><Minus size={14} /></button>
                      <span className="px-1.5 text-white text-sm font-semibold min-w-[24px] text-center">{item.cantidad}</span>
                      <button onClick={() => updQty(item.variant.id, item.cantidad + 1)} className="p-1.5 text-gray-400 hover:text-white" aria-label="Sumar cantidad"><Plus size={14} /></button>
                    </div>
                    <p className="w-14 text-right text-sm font-bold text-cyan-400">{(pf * item.cantidad).toFixed(2)}</p>
                    <button onClick={() => setDescItem(descItem === item.variant.id ? null : item.variant.id)} className="text-gray-500 hover:text-orange-400" aria-label="Aplicar descuento"><Percent size={13} /></button>
                    <button onClick={() => del(item.variant.id)} className="text-gray-500 hover:text-red-400" aria-label="Eliminar producto"><Trash2 size={13} /></button>
                  </div>
                  {descItem === item.variant.id && (
                    <div className="flex items-center gap-2 mt-2 pt-2 border-t border-[#30363d]">
                      <div className="flex bg-[#0d1117] rounded-lg border border-[#30363d] overflow-hidden">
                        <button onClick={() => setDescTipo('pct')} className={`px-2 py-1 text-xs font-bold ${descTipo === 'pct' ? 'bg-orange-500 text-white' : 'text-gray-400'}`}>%</button>
                        <button onClick={() => setDescTipo('fijo')} className={`px-2 py-1 text-xs font-bold ${descTipo === 'fijo' ? 'bg-orange-500 text-white' : 'text-gray-400'}`}>S/</button>
                      </div>
                      <input autoFocus type="number" value={descValor} onChange={(e) => setDescValor(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && applyDisc(item.variant.id)} placeholder={descTipo === 'pct' ? '10' : '5'}
                        className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-lg px-2 py-1 text-sm text-white placeholder-gray-600 min-w-0" />
                      <button onClick={() => applyDisc(item.variant.id)} className="bg-orange-500 text-white text-xs font-bold px-3 py-1.5 rounded-lg shrink-0">OK</button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <div className="p-3 border-t border-[#30363d] space-y-1">
            {totalDesc > 0 && <div className="flex justify-between text-sm"><span className="text-orange-400">Descuento</span><span className="text-orange-400 font-semibold">-S/ {totalDesc.toFixed(2)}</span></div>}
            <div className="flex justify-between text-sm"><span className="text-gray-500">Subtotal</span><span className="text-gray-300">S/ {subtotal.toFixed(2)}</span></div>
            <div className="flex justify-between text-sm"><span className="text-gray-500">IGV (18%)</span><span className="text-gray-300">S/ {impuesto.toFixed(2)}</span></div>
            <div className="flex justify-between text-lg font-bold pt-2 border-t border-[#30363d]"><span className="text-white">Total</span><span className="text-cyan-400">S/ {total.toFixed(2)}</span></div>
            <button disabled={cart.length === 0} onClick={() => { setShowPago(true); setShowCart(false) }}
              className="w-full mt-2 bg-gradient-to-r from-cyan-500 to-cyan-600 disabled:from-[#21262d] disabled:to-[#21262d] disabled:text-gray-600 text-black font-bold py-3 rounded-xl hover:shadow-lg hover:shadow-cyan-500/30 transition-all text-sm active:scale-[0.98]">
              Cobrar · S/ {total.toFixed(2)}
            </button>
          </div>
        </div>
      </div>

      {showPago && (
        <ModalPago total={total} subtotal={subtotal} impuesto={impuesto} cart={cart} online={online}
          locationId={staff?.location_id ?? null} cajeroId={staff?.id ?? null} cashSessionId={cashSessionId}
          onClose={() => setShowPago(false)}
          onConfirm={(res) => {
            setCart([]); setShowPago(false); setShowCart(false)
            if (res) {
              setRecibo(res)
              if (res.saleId === 'pendiente-sync') showToast('Venta guardada sin conexión, se sincronizará automáticamente', 'info')
            }
          }} />
      )}
      {recibo && <ReciboVenta {...recibo} onClose={() => setRecibo(null)} />}
    </div>
  )
}

async function registrarVenta(cart: CartItem[], subtotal: number, impuesto: number, total: number, pagos: PagoDetalle[], clienteId: string | null, clienteDoc: string | null, locationId: string | null, cajeroId: string | null, cashSessionId: string | null) {
  const { data: sale, error } = await supabase.from('sales')
    .insert({ subtotal, impuesto, total, estado: 'completada', cliente_id: clienteId, cliente_doc: clienteDoc, location_id: locationId, cajero_id: cajeroId, cash_session_id: cashSessionId })
    .select().single()
  if (error || !sale) throw new Error(error?.message || 'Error')
  const items = cart.map((i) => ({ sale_id: sale.id, variant_id: i.variant.id, cantidad: i.cantidad, precio_unitario: i.precio_unitario, subtotal: (i.precio_unitario - i.descuento) * i.cantidad, descuento: i.descuento }))
  await supabase.from('sale_items').insert(items)
  await supabase.from('payments').insert(pagos.map((p) => ({ sale_id: sale.id, metodo: p.metodo, monto: p.monto, referencia: p.referencia || null })))
  return sale.id as string
}

interface ResultadoVenta { saleId: string; fecha: string; cart: CartItem[]; subtotal: number; impuesto: number; total: number; pagos: PagoDetalle[]; clienteNombre: string | null }

function ModalPago({ total, subtotal, impuesto, cart, online, locationId, cajeroId, cashSessionId, onClose, onConfirm }: {
  total: number; subtotal: number; impuesto: number; cart: CartItem[]; online: boolean
  locationId: string | null; cajeroId: string | null; cashSessionId: string | null
  onClose: () => void; onConfirm: (r: ResultadoVenta | null) => void
}) {
  const [mixto, setMixto] = useState(false)
  const [metodo, setMetodo] = useState<MetodoPago>('efectivo')
  const [recibido, setRecibido] = useState('')
  const [referencia, setReferencia] = useState('')
  const [lineas, setLineas] = useState<PagoDetalle[]>([{ metodo: 'efectivo', monto: total }])
  const [clienteQuery, setClienteQuery] = useState('')
  const [clienteSel, setClienteSel] = useState<Cliente | null>(null)
  const [clienteOpts, setClienteOpts] = useState<Cliente[]>([])
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')
  const vuelto = metodo === 'efectivo' ? Math.max(0, Number(recibido || 0) - total) : 0

  useEffect(() => {
    if (!mixto) return
    setLineas((ls) => ls.length === 1 ? [{ ...ls[0], monto: total }] : ls)
  }, [total, mixto])

  const buscarCliente = async (texto: string) => {
    setClienteQuery(texto); setClienteSel(null)
    if (texto.length < 2 || !online) { setClienteOpts([]); return }
    const { data } = await supabase.from('clientes').select('*').or(`nombre.ilike.%${texto}%,telefono.ilike.%${texto}%`).limit(6)
    setClienteOpts(data || [])
  }

  const sumaLineas = lineas.reduce((s, l) => s + (Number(l.monto) || 0), 0)
  const faltante = total - sumaLineas
  const vueltoMixto = Math.max(0, sumaLineas - total)

  const agregarLinea = () => setLineas((l) => [...l, { metodo: 'efectivo', monto: Math.max(0, faltante) }])
  const quitarLinea = (idx: number) => setLineas((l) => l.filter((_, i) => i !== idx))
  const actualizarLinea = (idx: number, patch: Partial<PagoDetalle>) => setLineas((l) => l.map((x, i) => i === idx ? { ...x, ...patch } : x))

  const confirmar = async () => {
    setGuardando(true); setError('')
    const pagos: PagoDetalle[] = mixto ? lineas.filter((l) => l.monto > 0) : [{ metodo, monto: total, referencia: metodo !== 'efectivo' ? referencia : undefined }]
    if (mixto && sumaLineas < total - 0.005) { setError('La suma de los pagos no cubre el total'); setGuardando(false); return }
    const clienteId = clienteSel?.id ?? null
    try {
      if (!online) throw new Error('offline')
      const saleId = await registrarVenta(cart, subtotal, impuesto, total, pagos, clienteId, null, locationId, cajeroId, cashSessionId)
      onConfirm({ saleId, fecha: new Date().toISOString(), cart, subtotal, impuesto, total, pagos, clienteNombre: clienteSel?.nombre ?? null })
    } catch (e) {
      if (!online || (e instanceof Error && /fetch|network/i.test(e.message))) {
        await queueVenta({ cart, subtotal, impuesto, total, pagos, clienteId, clienteDoc: null, cashSessionId, locationId, cajeroId, createdAt: new Date().toISOString() })
        onConfirm({ saleId: 'pendiente-sync', fecha: new Date().toISOString(), cart, subtotal, impuesto, total, pagos, clienteNombre: clienteSel?.nombre ?? null })
      } else {
        setError(e instanceof Error ? e.message : 'Error')
      }
    } finally { setGuardando(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end md:items-center justify-center z-50 p-0 md:p-4">
      <div className="bg-[#161b22] rounded-t-2xl md:rounded-2xl w-full max-w-sm p-5 relative border border-[#30363d] shadow-2xl max-h-[92vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-500 hover:text-white" aria-label="Cerrar"><X size={20} /></button>
        <h3 className="font-display font-bold text-lg text-white mb-1">Cobrar venta</h3>
        <p className="text-3xl font-bold text-cyan-400 mb-4">S/ {total.toFixed(2)}</p>

        {/* Cliente */}
        <div className="mb-4">
          {clienteSel ? (
            <div className="flex items-center justify-between bg-cyan-500/10 border border-cyan-500/30 rounded-xl px-3 py-2">
              <span className="flex items-center gap-2 text-sm text-cyan-300"><User size={14} /> {clienteSel.nombre}</span>
              <button onClick={() => { setClienteSel(null); setClienteQuery('') }} className="text-gray-400 hover:text-white" aria-label="Quitar cliente seleccionado"><X size={14} /></button>
            </div>
          ) : (
            <div className="relative">
              <UserPlus size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
              <input value={clienteQuery} onChange={(e) => buscarCliente(e.target.value)} placeholder="Cliente (opcional)"
                className="w-full pl-8 pr-3 py-2 rounded-lg bg-[#0d1117] border border-[#30363d] text-white text-xs placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500" />
              {clienteOpts.length > 0 && (
                <div className="absolute z-10 top-full mt-1 left-0 right-0 bg-[#21262d] border border-[#30363d] rounded-lg overflow-hidden max-h-32 overflow-y-auto">
                  {clienteOpts.map((c) => (
                    <button key={c.id} onClick={() => { setClienteSel(c); setClienteOpts([]) }}
                      className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-cyan-500/10">{c.nombre} {c.telefono && `· ${c.telefono}`}</button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex bg-[#0d1117] rounded-lg border border-[#30363d] overflow-hidden mb-4">
          <button onClick={() => setMixto(false)} className={`flex-1 py-2 text-xs font-bold ${!mixto ? 'bg-cyan-500 text-black' : 'text-gray-400'}`}>Un método</button>
          <button onClick={() => setMixto(true)} className={`flex-1 py-2 text-xs font-bold ${mixto ? 'bg-cyan-500 text-black' : 'text-gray-400'}`}>Pago mixto</button>
        </div>

        {!mixto ? (
          <>
            <div className="grid grid-cols-4 gap-2 mb-4">
              {(['efectivo', 'tarjeta', 'yape', 'plin'] as MetodoPago[]).map((m) => (
                <button key={m} onClick={() => setMetodo(m)}
                  className={`py-2.5 rounded-xl text-xs font-bold capitalize transition-all ${metodo === m ? 'bg-cyan-500 text-black' : 'bg-[#21262d] border border-[#30363d] text-gray-400'}`}>{m}</button>
              ))}
            </div>
            {metodo === 'efectivo' ? (
              <div className="mb-4">
                <label className="text-xs text-gray-500 font-semibold">Monto recibido</label>
                <input autoFocus type="number" value={recibido} onChange={(e) => setRecibido(e.target.value)}
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mt-1 text-white text-lg focus:outline-none focus:ring-2 focus:ring-cyan-500" />
                <div className="flex justify-between mt-2 bg-[#21262d] rounded-lg p-3">
                  <span className="text-gray-400 text-sm">Vuelto</span>
                  <span className="text-green-400 font-bold text-lg">S/ {vuelto.toFixed(2)}</span>
                </div>
              </div>
            ) : (
              <div className="mb-4">
                <label className="text-xs text-gray-500 font-semibold">Código de operación</label>
                <input autoFocus value={referencia} onChange={(e) => setReferencia(e.target.value)}
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mt-1 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500" />
              </div>
            )}
          </>
        ) : (
          <div className="mb-4 space-y-2">
            {lineas.map((l, idx) => (
              <div key={idx} className="bg-[#0d1117] rounded-xl border border-[#30363d] p-2.5">
                <div className="flex items-center gap-2 mb-2">
                  <select value={l.metodo} onChange={(e) => actualizarLinea(idx, { metodo: e.target.value as MetodoPago })}
                    className="flex-1 bg-[#161b22] border border-[#30363d] rounded-lg px-2 py-1.5 text-xs text-white capitalize focus:outline-none">
                    {(['efectivo', 'tarjeta', 'yape', 'plin'] as MetodoPago[]).map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <input type="number" value={l.monto || ''} onChange={(e) => actualizarLinea(idx, { monto: Number(e.target.value) || 0 })}
                    placeholder="Monto" className="w-24 bg-[#161b22] border border-[#30363d] rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none" />
                  {lineas.length > 1 && <button onClick={() => quitarLinea(idx)} className="text-gray-500 hover:text-red-400"><Trash2 size={14} /></button>}
                </div>
                {l.metodo !== 'efectivo' && (
                  <input value={l.referencia || ''} onChange={(e) => actualizarLinea(idx, { referencia: e.target.value })} placeholder="Código de operación (opcional)"
                    className="w-full bg-[#161b22] border border-[#30363d] rounded-lg px-2 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none" />
                )}
              </div>
            ))}
            <button onClick={agregarLinea} className="w-full flex items-center justify-center gap-1.5 border border-dashed border-[#30363d] text-gray-400 text-xs font-semibold py-2 rounded-lg hover:border-cyan-500/50">
              <Plus size={13} /> Agregar método de pago
            </button>
            <div className="flex justify-between bg-[#21262d] rounded-lg p-3 text-sm">
              <span className="text-gray-400">{faltante > 0.005 ? 'Falta cubrir' : 'Vuelto'}</span>
              <span className={`font-bold ${faltante > 0.005 ? 'text-orange-400' : 'text-green-400'}`}>S/ {(faltante > 0.005 ? faltante : vueltoMixto).toFixed(2)}</span>
            </div>
          </div>
        )}

        {error && <p className="text-red-400 text-xs mb-3 bg-red-500/10 rounded-lg p-2">{error}</p>}
        {!online && <p className="text-orange-400 text-xs mb-3 bg-orange-500/10 rounded-lg p-2">Sin conexión: la venta se guardará y sincronizará automáticamente.</p>}
        <button onClick={confirmar} disabled={guardando || (mixto && sumaLineas < total - 0.005)}
          className="w-full bg-gradient-to-r from-cyan-500 to-cyan-600 disabled:opacity-40 text-black font-bold py-3.5 rounded-xl transition-all active:scale-[0.98]">
          {guardando ? 'Procesando...' : '✓ Confirmar pago'}</button>
      </div>
    </div>
  )
}
