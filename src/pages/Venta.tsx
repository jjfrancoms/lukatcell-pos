import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, Trash2, X, Smartphone, Keyboard, Printer, Wrench, Monitor, Headphones, Cable, Shield, LayoutGrid, Percent, ShoppingBag, Plus, Minus, ChevronUp, RotateCcw } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useConfig } from '../lib/config'
import {
  cacheCatalogo, cacheCategorias, buscarEnCache, getCatalogoCache, useOnlineStatus,
  mapVarianteRow, sincronizarCatalogoIncremental, marcarSyncCatalogoCompleta,
  guardarCarritoActivo, obtenerCarritoActivo, borrarCarritoActivo,
} from '../lib/offline'
import { calcularTotalesCarrito, calcularDescuentoLinea, restarMontos } from '../lib/money'
import { useToast } from '../lib/toast'
import type { ProductVariant, CartItem, PagoDetalle } from '../types'
import ReciboVenta from '../components/ReciboVenta'
import ModalPago from '../components/ModalPago'

interface Categoria { id: string; nombre: string }
const catIcons: Record<string, any> = {
  'Fundas': Smartphone, 'Cables': Cable, 'Audífonos': Headphones,
  'Cargadores': Cable, 'Mica y protectores': Shield, 'Teclados': Keyboard,
  'Insumos de impresora': Printer, 'Reparación técnica': Wrench, 'Accesorios de PC': Monitor,
}

export default function Venta() {
  const { staff, cashSessionId, isAdmin } = useAuth()
  const { config } = useConfig()
  const { online } = useOnlineStatus()
  const { showToast } = useToast()
  const IGV = config.igv_activo ? config.igv_porcentaje / 100 : 0
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
  const [descuentosManuales, setDescuentosManuales] = useState<Record<string, number>>({})
  const [cupon, setCupon] = useState('')
  const [promoAplicada, setPromoAplicada] = useState<string | null>(null)
  const [limiteDescuento, setLimiteDescuento] = useState(isAdmin ? 100 : Number(localStorage.getItem('lukatcell_descuento_max_pct') || 0))
  const [preparandoCobro, setPreparandoCobro] = useState(false)
  const [loading, setLoading] = useState(true)
  const [recuperarDisponible, setRecuperarDisponible] = useState<{ cart: CartItem[]; savedAt: string } | null>(null)
  const [recibo, setRecibo] = useState<{ saleId: string; numero: number | null; fecha: string; cart: CartItem[]; subtotal: number; impuesto: number; total: number; pagos: PagoDetalle[]; clienteNombre: string | null; cajeroNombre: string | null } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    Promise.all([
      supabase.from('categorias').select('id, nombre').order('nombre'),
      supabase.rpc('obtener_favoritos'),
      supabase.from('product_variants').select('id, product_id, color, modelo_celular_id, precio_override, codigo_barras, product:products(nombre, sku, precio_base, imagen_url), modelo:modelos_celular(marca, modelo)'),
    ]).then(([catRes, favRes, allRes]) => {
      const cats = catRes.data || []
      const favs = (favRes.data || []).map(mapVarianteRow)
      const todas = ((allRes.data as any[]) || []).map((r) => ({ ...r, product: r.product, modelo: r.modelo })) as ProductVariant[]
      setCategorias(cats)
      setFavoritos(favs.length > 0 ? favs : todas.slice(0, 12))
      setLoading(false)
      if (cats.length) cacheCategorias(cats)
      if (todas.length) { cacheCatalogo(todas); marcarSyncCatalogoCompleta() }
    }).catch(async () => {
      const cached = await getCatalogoCache()
      setFavoritos(cached.slice(0, 12))
      setLoading(false)
    })
  }, [])

  // Sync incremental del catálogo cuando hay conexión (no vuelve a descargar todo)
  useEffect(() => {
    if (!online) return
    sincronizarCatalogoIncremental()
  }, [online])

  useEffect(() => {
    if (isAdmin) { setLimiteDescuento(100); return }
    if (!online) return
    supabase.rpc('limite_descuento_actual').then(({ data, error }) => {
      if (error) return
      const limite = Number(data || 0)
      setLimiteDescuento(limite)
      localStorage.setItem('lukatcell_descuento_max_pct', String(limite))
    })
  }, [isAdmin, online])

  // Recuperación de carrito: si el navegador se cerró a mitad de una venta, se ofrece recuperarlo (nunca se auto-convierte en venta)
  useEffect(() => {
    if (!staff?.id) return
    obtenerCarritoActivo(staff.id).then((guardado) => {
      if (guardado && guardado.cart.length > 0) setRecuperarDisponible(guardado)
    })
  }, [staff?.id])

  // Persistir el carrito activo en IndexedDB (debounced) para poder recuperarlo
  useEffect(() => {
    if (!staff?.id) return
    const t = setTimeout(() => { guardarCarritoActivo(cart, staff.id) }, 300)
    return () => clearTimeout(t)
  }, [cart, staff?.id])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'F4') { e.preventDefault(); if (cart.length) document.getElementById('btn-cobrar')?.click() }
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
        agregarAlCarrito(mapVarianteRow(data[0])); setQuery(''); setResults([])
      }
    }
  }

  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const ejecutarBusqueda = useCallback(async (texto: string) => {
    if (!online) { setResults(await buscarEnCache(texto)); return }

    if (/^\d{8,}$/.test(texto)) {
      const { data: exact } = await supabase.rpc('buscar_por_barcode', { barcode: texto })
      if (exact && exact.length > 0) { agregarAlCarrito(mapVarianteRow(exact[0])); setQuery(''); setResults([]); return }
    }

    try {
      const { data } = await supabase.rpc('buscar_variantes', { texto })
      setResults((data || []).map(mapVarianteRow))
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
      setResults((data || []).map(mapVarianteRow))
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
  const applyDisc = async (vid: string) => {
    const val = Number(descValor) || 0; if (val <= 0) { setDescItem(null); return }
    const item = cart.find((i) => i.variant.id === vid); if (!item) return
    const descuento = calcularDescuentoLinea(item.precio_unitario, val, descTipo)
    const pct = item.precio_unitario > 0 ? descuento / item.precio_unitario * 100 : 0
    if (!isAdmin && pct > limiteDescuento + 0.0001) {
      const { data: autorizado, error: consumeError } = await supabase.rpc('consumir_autorizacion_descuento', {
        p_variant_id: vid, p_porcentaje: pct, p_descuento_unitario: descuento
      })
      if (consumeError) { showToast('No se pudo validar la autorización', 'error'); return }
      if (!autorizado) {
        const { error } = await supabase.rpc('solicitar_autorizacion', {
          p_tipo: 'descuento', p_motivo: `Descuento solicitado ${pct.toFixed(2)}%`, p_recurso_tipo: 'variant', p_recurso_id: vid,
          p_payload: { variant_id: vid, porcentaje: pct, descuento_unitario: descuento, precio_unitario: item.precio_unitario }
        })
        showToast(error ? 'No se pudo solicitar autorización' : `Supera tu límite (${limiteDescuento.toFixed(2)}%). Autorización solicitada.`, error ? 'error' : 'info')
        setDescItem(null); setDescValor(''); return
      }
      showToast('Autorización de descuento aplicada', 'success')
    }
    setDescuentosManuales((m) => ({ ...m, [vid]: descuento }))
    setCart((p) => p.map((i) => i.variant.id === vid ? { ...i, descuento } : i))
    setPromoAplicada(null); setDescItem(null); setDescValor('')
  }

  const recuperarCarrito = () => {
    if (!recuperarDisponible) return
    setCart(recuperarDisponible.cart)
    setDescuentosManuales(Object.fromEntries(recuperarDisponible.cart.map((i) => [i.variant.id, Number(i.descuento || 0)])))
    setRecuperarDisponible(null)
    showToast('Venta recuperada', 'success')
  }
  const descartarRecuperacion = () => {
    setRecuperarDisponible(null)
    if (staff?.id) borrarCarritoActivo(staff.id)
  }

  const prepararCobro = async () => {
    if (!cart.length) return
    if (!online) {
      if (cupon.trim()) { showToast('Los cupones requieren conexión', 'error'); return }
      setShowPago(true); setShowCart(false); return
    }
    setPreparandoCobro(true)
    const payload = cart.map((i) => ({ variant_id: i.variant.id, cantidad: i.cantidad, precio_unitario: i.precio_unitario }))
    const { data, error } = await supabase.rpc('resolver_promociones_carrito', { p_items: payload, p_codigo_cupon: cupon.trim() || null })
    if (error) { setPreparandoCobro(false); showToast('No se pudieron validar promociones', 'error'); return }
    const promos = (data || []) as { variant_id: string; descuento_promocion_unitario: number; promocion_nombre: string; acumulable: boolean }[]
    if (cupon.trim() && promos.length === 0) { setPreparandoCobro(false); showToast('Cupón inválido, vencido o no aplicable al carrito', 'error'); return }
    const porVariant = new Map(promos.map((r) => [r.variant_id, r]))
    setCart((prev) => prev.map((i) => {
      const promo = porVariant.get(i.variant.id)
      const manual = Number(descuentosManuales[i.variant.id] || 0)
      if (!promo) return { ...i, descuento: manual }
      const pd = Number(promo.descuento_promocion_unitario || 0)
      const descuento = promo.acumulable ? Math.min(i.precio_unitario, manual + pd) : Math.max(manual, pd)
      return { ...i, descuento }
    }))
    setPromoAplicada(promos[0]?.promocion_nombre || null)
    if (promos.length) showToast(`Promoción aplicada: ${promos[0].promocion_nombre}`, 'success')
    setPreparandoCobro(false); setShowPago(true); setShowCart(false)
  }

  const { subtotal, totalDescuento: totalDesc, impuesto, total } = calcularTotalesCarrito(cart, IGV)
  const items = query.length >= 2 || catActiva ? results : favoritos

  return (
    <div className="h-full flex flex-col lg:flex-row relative">
      {/* Panel productos */}
      <div className="flex-1 min-w-0 p-3 md:p-5 flex flex-col min-h-0">
        {recuperarDisponible && (
          <div className="mb-3 flex items-center justify-between gap-3 bg-orange-500/10 border border-orange-500/30 rounded-xl px-4 py-2.5">
            <span className="flex items-center gap-2 text-sm text-orange-300">
              <RotateCcw size={15} className="shrink-0" /> Tienes una venta sin terminar de {new Date(recuperarDisponible.savedAt).toLocaleTimeString('es-PE')}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={descartarRecuperacion} className="text-xs font-semibold text-gray-400 hover:text-white">Descartar</button>
              <button onClick={recuperarCarrito} className="text-xs font-bold bg-orange-500 text-black px-3 py-1.5 rounded-lg">Recuperar</button>
            </div>
          </div>
        )}
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
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-2 md:gap-3 overflow-y-auto overflow-x-hidden flex-1 pb-24 lg:pb-2 content-start">
          {loading && Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-[#30363d] overflow-hidden animate-pulse">
              <div className="h-28 sm:h-32 w-full bg-[#161b22]" />
              <div className="p-2 md:p-3 space-y-1.5">
                <div className="h-3 bg-[#161b22] rounded w-3/4" />
                <div className="h-2.5 bg-[#161b22] rounded w-1/2" />
              </div>
            </div>
          ))}
          {!loading && items.map((v) => {
            const img = (v.product as any)?.imagen_url
            const precio = v.precio_override ?? (v.product as any)?.precio_base ?? 0
            return (
              <button key={v.id} onClick={() => agregarAlCarrito(v)}
                className="group text-left min-w-0 bg-[#161b22] rounded-xl border border-[#30363d] overflow-hidden hover:border-cyan-500 hover:shadow-lg hover:shadow-cyan-500/10 transition-all active:scale-[0.98]">
                <div className="h-28 sm:h-32 w-full bg-[#21262d] overflow-hidden relative">
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
          style={{ bottom: 'max(1rem, calc(env(safe-area-inset-bottom) + 0.5rem))' }}
          className="lg:hidden fixed left-4 right-4 z-20 bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-bold py-3.5 rounded-xl flex items-center justify-between px-5 shadow-xl shadow-cyan-500/30 active:scale-[0.98]">
          <span className="flex items-center gap-2"><ShoppingBag size={18} /> {cart.length} items</span>
          <span>S/ {total.toFixed(2)} <ChevronUp size={16} className="inline" /></span>
        </button>
      )}

      {/* Cart panel */}
      <div className={`${showCart ? 'fixed inset-0 z-30 bg-black/60 lg:relative lg:bg-transparent' : 'hidden lg:flex'} lg:w-[320px] xl:w-[360px] 2xl:w-[400px]`}>
        <div className={`${showCart ? 'absolute bottom-0 left-0 right-0 max-h-[85vh] lg:relative lg:max-h-none' : ''} w-full lg:w-[320px] xl:w-[360px] 2xl:w-[400px] bg-[#161b22] border-l border-[#30363d] flex flex-col shrink-0 rounded-t-2xl lg:rounded-none`}>
          <div className="p-4 border-b border-[#30363d] flex items-center justify-between">
            <h2 className="font-display font-bold text-white text-base">Venta actual</h2>
            <div className="flex items-center gap-2">
              {cart.length > 0 && <span className="bg-cyan-500 text-black text-xs font-bold px-2 py-0.5 rounded-full">{cart.length}</span>}
              <button onClick={() => setShowCart(false)} className="lg:hidden text-gray-500" aria-label="Cerrar carrito"><X size={20} /></button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-2">
            {cart.length === 0 && <div className="text-center mt-8"><ShoppingBag size={36} className="text-gray-600 mx-auto mb-2" /><p className="text-gray-500 text-sm">Agrega productos</p></div>}
            {cart.map((item) => {
              const pf = restarMontos(item.precio_unitario, item.descuento)
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
          <div className="p-3 border-t border-[#30363d] space-y-1" style={{ paddingBottom: 'max(0.75rem, calc(env(safe-area-inset-bottom) + 0.5rem))' }}>
            <div className="flex gap-2 mb-2"><input value={cupon} onChange={(e) => { setCupon(e.target.value.toUpperCase()); setPromoAplicada(null) }} placeholder="Cupón (opcional)" className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-xs text-white uppercase placeholder:normal-case placeholder-gray-600" /></div>
            {promoAplicada && <div className="text-[11px] text-green-400 mb-1">Promoción: {promoAplicada}</div>}
            {totalDesc > 0 && <div className="flex justify-between text-sm"><span className="text-orange-400">Descuento</span><span className="text-orange-400 font-semibold">-S/ {totalDesc.toFixed(2)}</span></div>}
            <div className="flex justify-between text-sm"><span className="text-gray-500">Subtotal</span><span className="text-gray-300">S/ {subtotal.toFixed(2)}</span></div>
            {config.igv_activo && <div className="flex justify-between text-sm"><span className="text-gray-500">IGV ({config.igv_porcentaje}%)</span><span className="text-gray-300">S/ {impuesto.toFixed(2)}</span></div>}
            <div className="flex justify-between text-lg font-bold pt-2 border-t border-[#30363d]"><span className="text-white">Total</span><span className="text-cyan-400">S/ {total.toFixed(2)}</span></div>
            <button id="btn-cobrar" disabled={cart.length === 0 || preparandoCobro} onClick={prepararCobro}
              className="w-full mt-2 bg-gradient-to-r from-cyan-500 to-cyan-600 disabled:from-[#21262d] disabled:to-[#21262d] disabled:text-gray-600 text-black font-bold py-3 rounded-xl hover:shadow-lg hover:shadow-cyan-500/30 transition-all text-sm active:scale-[0.98]">
              {preparandoCobro ? 'Validando...' : `Cobrar · S/ ${total.toFixed(2)}`}
            </button>
          </div>
        </div>
      </div>

      {showPago && (
        <ModalPago total={total} subtotal={subtotal} impuesto={impuesto} cart={cart} online={online}
          nubefactActivo={config.nubefact_activo} culqiActivo={config.culqi_activo} permitirVincularOrden
          locationId={staff?.location_id ?? null} cajeroId={staff?.id ?? null} cashSessionId={cashSessionId}
          onClose={() => setShowPago(false)}
          onConfirm={(res) => {
            const codigoUsado = cupon.trim()
            setCart([]); setDescuentosManuales({}); setCupon(''); setPromoAplicada(null); setShowPago(false); setShowCart(false)
            if (staff?.id) borrarCarritoActivo(staff.id)
            if (res) {
              setRecibo({ ...res, cajeroNombre: staff?.nombre ?? null })
              if (res.saleId === 'pendiente-sync') showToast('Venta guardada sin conexión, se sincronizará automáticamente', 'info')
              else if (codigoUsado && online) supabase.rpc('registrar_uso_cupon', { p_codigo: codigoUsado, p_sale_id: res.saleId }).then(({ error }) => { if (error) showToast('Venta registrada, pero no se pudo contabilizar el uso del cupón', 'error') })
            }
          }} />
      )}
      {recibo && <ReciboVenta {...recibo} autoImprimir={config.auto_imprimir_ticket} onClose={() => setRecibo(null)} />}
    </div>
  )
}
