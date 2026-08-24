import { useState, useEffect } from 'react'
import { AlertTriangle, Search, Plus, Minus, History, X, Package, ArrowUpCircle, ArrowDownCircle, ScanLine, Pencil, PackagePlus, Ban, CheckCircle2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useConfig } from '../lib/config'
import { useToast } from '../lib/toast'
import BarcodeScanner from '../components/BarcodeScanner'
import SubirImagenProducto from '../components/SubirImagenProducto'

interface Categoria { id: string; nombre: string; requiere_modelo_celular: boolean }
interface Modelo { id: string; marca: string; modelo: string }

interface FilaInventario {
  variant_id: string; cantidad: number; stock_minimo: number; location_id: string
  variant: {
    id: string; color: string | null; codigo_barras: string | null; modelo_celular_id: string | null; precio_override: number | null
    product: { id: string; nombre: string; sku: string | null; imagen_url: string | null; costo?: number; precio_base: number; categoria_id: string | null; activo: boolean }
    modelo: { id: string; marca: string; modelo: string } | null
  }
}

interface Movimiento { id: string; cantidad_delta: number; motivo: string; created_at: string }

const SELECT_INVENTARIO = 'variant_id, cantidad, stock_minimo, location_id, variant:product_variants(id, color, codigo_barras, modelo_celular_id, precio_override, product:products(id, nombre, sku, imagen_url, precio_base, categoria_id, activo), modelo:modelos_celular(id, marca, modelo))'

function generarCodigoInterno() {
  return '2' + Date.now().toString().slice(-9) + Math.floor(Math.random() * 10)
}

export default function Inventario() {
  const { isAdmin, staff } = useAuth()
  const { config } = useConfig()
  const { showToast } = useToast()
  const [filas, setFilas] = useState<FilaInventario[]>([])
  const [categorias, setCategorias] = useState<Categoria[]>([])
  const [modelos, setModelos] = useState<Modelo[]>([])
  const [busqueda, setBusqueda] = useState('')
  const [soloStockBajo, setSoloStockBajo] = useState(false)
  const [ajusteModal, setAjusteModal] = useState<FilaInventario | null>(null)
  const [histModal, setHistModal] = useState<FilaInventario | null>(null)
  const [editModal, setEditModal] = useState<FilaInventario | null>(null)
  const [nuevoModal, setNuevoModal] = useState<null | { varianteDe?: { id: string; nombre: string; categoria_id: string | null }; prefillBarcode?: string }>(null)
  const [scannerBuscar, setScannerBuscar] = useState(false)
  const [movimientos, setMovimientos] = useState<Movimiento[]>([])
  const [ajusteCant, setAjusteCant] = useState('')
  const [ajusteMotivo, setAjusteMotivo] = useState('Entrada de mercadería')
  const [ajusteTipo, setAjusteTipo] = useState<'entrada' | 'salida'>('entrada')
  const [guardando, setGuardando] = useState(false)
  const [costoEdit, setCostoEdit] = useState<Record<string, string>>({})

  const cargar = async () => {
    const { data } = await supabase.from('inventory').select(SELECT_INVENTARIO).order('cantidad', { ascending: true })
    const base = ((data as unknown as FilaInventario[]) || [])
    if (!isAdmin) { setFilas(base); return }
    const { data: costos, error: costoError } = await supabase.rpc('costos_productos_admin')
    if (costoError) { showToast('No se pudieron cargar los costos', 'error'); setFilas(base); return }
    const porProducto = new Map(((costos || []) as { product_id: string; costo: number }[]).map((c) => [c.product_id, Number(c.costo || 0)]))
    setFilas(base.map((f) => ({ ...f, variant: { ...f.variant, product: { ...f.variant.product, costo: porProducto.get(f.variant.product.id) } } })))
  }

  const guardarCosto = async (productId: string, valor: string) => {
    const costo = Number(valor)
    if (Number.isNaN(costo) || costo < 0) return
    const { error } = await supabase.rpc('actualizar_costo_producto_admin', { p_product_id: productId, p_costo: costo, p_origen: 'inventario_ui' })
    if (error) { showToast('No se pudo guardar el costo', 'error'); return }
    setFilas((fs) => fs.map((f) => f.variant?.product?.id === productId ? { ...f, variant: { ...f.variant, product: { ...f.variant.product, costo } } } : f))
    showToast('Costo actualizado', 'success')
  }

  useEffect(() => {
    cargar()
    supabase.from('categorias').select('id, nombre, requiere_modelo_celular').order('nombre').then(({ data }) => setCategorias(data || []))
    supabase.from('modelos_celular').select('id, marca, modelo').order('marca').then(({ data }) => setModelos(data || []))
  }, [])

  const filtradas = filas.filter((f) => {
    const t = `${f.variant?.product?.nombre} ${f.variant?.product?.sku} ${f.variant?.color} ${f.variant?.codigo_barras}`.toLowerCase()
    return t.includes(busqueda.toLowerCase()) && (!soloStockBajo || f.cantidad <= f.stock_minimo)
  })

  const totalItems = filtradas.reduce((s, f) => s + f.cantidad, 0)
  const totalSkus = filtradas.length
  const bajosStock = filas.filter(f => f.cantidad <= f.stock_minimo).length

  const abrirHistorial = async (fila: FilaInventario) => {
    setHistModal(fila)
    const { data } = await supabase.from('inventory_movements')
      .select('id, cantidad_delta, motivo, created_at')
      .eq('variant_id', fila.variant_id)
      .order('created_at', { ascending: false })
      .limit(20)
    setMovimientos(data || [])
  }

  const aplicarAjuste = async () => {
    if (!ajusteModal || !ajusteCant) return
    setGuardando(true)
    const delta = ajusteTipo === 'entrada' ? Math.abs(Number(ajusteCant)) : -Math.abs(Number(ajusteCant))
    const { error } = await supabase.rpc('ajustar_stock', {
      p_variant_id: ajusteModal.variant_id,
      p_location_id: ajusteModal.location_id,
      p_cantidad_delta: delta,
      p_motivo: ajusteMotivo
    })
    setGuardando(false)
    setAjusteModal(null)
    setAjusteCant('')
    await cargar()
    showToast(error ? 'No se pudo aplicar el ajuste' : 'Stock actualizado', error ? 'error' : 'success')
  }

  const manejarEscaneoBusqueda = (codigo: string) => {
    setScannerBuscar(false)
    const fila = filas.find((f) => f.variant?.codigo_barras === codigo)
    setBusqueda(codigo)
    if (fila) {
      setAjusteModal(fila)
      setAjusteTipo('entrada')
      return
    }
    showToast('Código no encontrado en el catálogo', 'info',
      isAdmin ? { label: 'Crear producto', onClick: () => setNuevoModal({ prefillBarcode: codigo }) } : undefined)
  }

  return (
    <div className="p-3 md:p-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <h1 className="font-display font-bold text-xl text-white">Inventario</h1>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-2">
            <div className="bg-[#161b22] border border-[#30363d] rounded-xl px-3 py-2 text-center">
              <p className="text-[10px] text-gray-500 uppercase">SKUs</p><p className="text-base font-bold text-white">{totalSkus}</p>
            </div>
            <div className="bg-[#161b22] border border-[#30363d] rounded-xl px-3 py-2 text-center">
              <p className="text-[10px] text-gray-500 uppercase">Unidades</p><p className="text-base font-bold text-cyan-400">{totalItems}</p>
            </div>
            <div className="bg-[#161b22] border border-[#30363d] rounded-xl px-3 py-2 text-center">
              <p className="text-[10px] text-gray-500 uppercase">Alerta</p><p className="text-base font-bold text-orange-400">{bajosStock}</p>
            </div>
          </div>
          {isAdmin && (
            <button onClick={() => setNuevoModal({})}
              className="flex items-center gap-2 bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-semibold px-3.5 py-2.5 rounded-xl hover:shadow-lg hover:shadow-cyan-500/30 transition-all text-xs shrink-0">
              <PackagePlus size={15} /> Nuevo producto
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" size={16} />
          <input value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="Buscar producto, SKU o código de barras..."
            className="w-full pl-10 pr-3 py-2.5 rounded-xl bg-[#161b22] border border-[#30363d] text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500" />
        </div>
        <div className="flex gap-2 shrink-0">
          <button onClick={() => setScannerBuscar(true)} title="Escanear código de barras con la cámara"
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold bg-[#161b22] border border-[#30363d] text-cyan-400 hover:border-cyan-500/50 transition-all">
            <ScanLine size={16} /> <span className="hidden sm:inline">Escanear</span>
          </button>
          <button onClick={() => setSoloStockBajo(!soloStockBajo)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold transition-all ${soloStockBajo ? 'bg-orange-500/15 text-orange-400 border border-orange-500/30' : 'bg-[#161b22] border border-[#30363d] text-gray-400'}`}>
            <AlertTriangle size={14} /> Stock bajo
          </button>
        </div>
      </div>

      {/* Tarjetas — móvil/tablet */}
      <div className="md:hidden space-y-2">
        {filtradas.map((f) => {
          const img = f.variant?.product?.imagen_url
          const productId = f.variant?.product?.id
          const costoActual = f.variant?.product?.costo ?? 0
          const bajo = f.cantidad <= f.stock_minimo
          const inactivo = f.variant?.product?.activo === false
          return (
            <div key={f.variant_id} className={`bg-[#161b22] rounded-2xl border p-3 ${inactivo ? 'border-red-500/20 opacity-70' : 'border-[#30363d]'}`}>
              <div className="flex items-center gap-3">
                {img ? (
                  <img src={img} alt="" className="w-11 h-11 rounded-lg object-cover shrink-0 bg-[#21262d]"
                    onError={(e) => { e.currentTarget.style.display = 'none' }} />
                ) : (
                  <div className="w-11 h-11 rounded-lg bg-[#21262d] flex items-center justify-center shrink-0"><Package size={18} className="text-gray-600" /></div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-white text-sm truncate flex items-center gap-1.5">
                    {f.variant?.product?.nombre}
                    {inactivo && <span className="shrink-0 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-red-500/15 text-red-400">Inactivo</span>}
                  </p>
                  <p className="text-xs text-gray-500 truncate">
                    {f.variant?.product?.sku}{[f.variant?.color, f.variant?.modelo && `${f.variant.modelo.marca} ${f.variant.modelo.modelo}`].filter(Boolean).length > 0 && ` · ${[f.variant?.color, f.variant?.modelo && `${f.variant.modelo.marca} ${f.variant.modelo.modelo}`].filter(Boolean).join(' · ')}`}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className={`font-bold text-lg leading-none ${bajo ? 'text-orange-400' : f.cantidad > 15 ? 'text-green-400' : 'text-white'}`}>{f.cantidad}</p>
                  <p className="text-[10px] text-gray-600 mt-0.5">mín {f.stock_minimo}</p>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 mt-3 pt-3 border-t border-[#30363d]">
                <code className="text-[11px] text-gray-500 bg-[#0d1117] px-2 py-1 rounded truncate max-w-[40%]">{f.variant?.codigo_barras || '—'}</code>
                {isAdmin && (
                  <div className="flex items-center gap-1.5 text-xs text-gray-500">
                    <span>Costo S/</span>
                    <input type="number" min="0" step="0.01"
                      value={costoEdit[productId] ?? costoActual}
                      onChange={(e) => setCostoEdit((c) => ({ ...c, [productId]: e.target.value }))}
                      onBlur={(e) => { if (Number(e.target.value) !== costoActual) guardarCosto(productId, e.target.value) }}
                      className="w-16 bg-[#0d1117] border border-[#30363d] rounded-lg px-2 py-1 text-right text-xs text-gray-300 focus:outline-none focus:ring-1 focus:ring-cyan-500" />
                  </div>
                )}
                <div className="flex items-center gap-1.5">
                  <button onClick={() => { setAjusteModal(f); setAjusteTipo('entrada') }}
                    className="p-2 rounded-lg bg-green-500/10 text-green-400 active:bg-green-500/20" aria-label={`Registrar entrada de stock para ${f.variant?.product?.nombre}`}>
                    <Plus size={16} />
                  </button>
                  <button onClick={() => { setAjusteModal(f); setAjusteTipo('salida') }}
                    className="p-2 rounded-lg bg-red-500/10 text-red-400 active:bg-red-500/20" aria-label={`Registrar salida de stock para ${f.variant?.product?.nombre}`}>
                    <Minus size={16} />
                  </button>
                  <button onClick={() => abrirHistorial(f)}
                    className="p-2 rounded-lg bg-cyan-500/10 text-cyan-400 active:bg-cyan-500/20" aria-label={`Ver historial de ${f.variant?.product?.nombre}`}>
                    <History size={16} />
                  </button>
                  {isAdmin && (
                    <button onClick={() => setEditModal(f)}
                      className="p-2 rounded-lg bg-orange-500/10 text-orange-400 active:bg-orange-500/20" aria-label={`Editar ${f.variant?.product?.nombre}`}>
                      <Pencil size={16} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
        {filtradas.length === 0 && <p className="py-10 text-center text-gray-500 bg-[#161b22] rounded-2xl border border-[#30363d]">Sin resultados</p>}
      </div>

      {/* Tabla — escritorio */}
      <div className="hidden md:block bg-[#161b22] rounded-2xl border border-[#30363d] overflow-x-auto">
        <table className="w-full text-sm min-w-[600px]">
          <thead><tr className="border-b border-[#30363d]">
            <th className="text-left px-4 py-3 text-xs text-gray-500 uppercase">Producto</th>
            <th className="text-left px-3 py-3 text-xs text-gray-500 uppercase">Variante</th>
            <th className="text-left px-3 py-3 text-xs text-gray-500 uppercase">Código</th>
            <th className="text-right px-3 py-3 text-xs text-gray-500 uppercase">Stock</th>
            <th className="text-right px-3 py-3 text-xs text-gray-500 uppercase">Mín</th>
            {isAdmin && <th className="text-right px-3 py-3 text-xs text-gray-500 uppercase">Costo</th>}
            <th className="px-3 py-3 text-xs text-gray-500 uppercase text-center">Acciones</th>
          </tr></thead>
          <tbody className="divide-y divide-[#30363d]">
            {filtradas.map((f) => {
              const img = f.variant?.product?.imagen_url
              const productId = f.variant?.product?.id
              const costoActual = f.variant?.product?.costo ?? 0
              const inactivo = f.variant?.product?.activo === false
              return (
                <tr key={f.variant_id} className={`hover:bg-[#21262d] transition-colors ${inactivo ? 'opacity-60' : ''}`}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {img ? (
                        <img src={img} alt="" className="w-8 h-8 rounded-md object-cover shrink-0 bg-[#21262d]"
                          onError={(e) => { e.currentTarget.style.display = 'none' }} />
                      ) : (
                        <div className="w-8 h-8 rounded-md bg-[#21262d] flex items-center justify-center shrink-0"><Package size={14} className="text-gray-600" /></div>
                      )}
                      <div className="min-w-0">
                        <p className="font-medium text-white truncate flex items-center gap-1.5">
                          {f.variant?.product?.nombre}
                          {inactivo && <span className="shrink-0 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-red-500/15 text-red-400">Inactivo</span>}
                        </p>
                        <p className="text-xs text-gray-500">{f.variant?.product?.sku}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-gray-400 text-xs">
                    {[f.variant?.color, f.variant?.modelo && `${f.variant.modelo.marca} ${f.variant.modelo.modelo}`].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td className="px-3 py-3">
                    <code className="text-xs text-gray-500 bg-[#0d1117] px-1.5 py-0.5 rounded">{f.variant?.codigo_barras || '—'}</code>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <span className={`font-bold ${f.cantidad <= f.stock_minimo ? 'text-orange-400' : f.cantidad > 15 ? 'text-green-400' : 'text-white'}`}>{f.cantidad}</span>
                  </td>
                  <td className="px-3 py-3 text-right text-gray-500">{f.stock_minimo}</td>
                  {isAdmin && (
                    <td className="px-3 py-3 text-right">
                      <input type="number" min="0" step="0.01"
                        value={costoEdit[productId] ?? costoActual}
                        onChange={(e) => setCostoEdit((c) => ({ ...c, [productId]: e.target.value }))}
                        onBlur={(e) => { if (Number(e.target.value) !== costoActual) guardarCosto(productId, e.target.value) }}
                        className="w-20 bg-[#0d1117] border border-[#30363d] rounded-lg px-2 py-1 text-right text-xs text-gray-300 focus:outline-none focus:ring-1 focus:ring-cyan-500" />
                    </td>
                  )}
                  <td className="px-3 py-3">
                    <div className="flex items-center justify-center gap-1">
                      <button onClick={() => { setAjusteModal(f); setAjusteTipo('entrada') }}
                        className="p-1.5 rounded-lg bg-green-500/10 text-green-400 hover:bg-green-500/20 transition-colors" title="Entrada" aria-label={`Registrar entrada de stock para ${f.variant?.product?.nombre}`}>
                        <Plus size={14} />
                      </button>
                      <button onClick={() => { setAjusteModal(f); setAjusteTipo('salida') }}
                        className="p-1.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors" title="Salida" aria-label={`Registrar salida de stock para ${f.variant?.product?.nombre}`}>
                        <Minus size={14} />
                      </button>
                      <button onClick={() => abrirHistorial(f)}
                        className="p-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 transition-colors" title="Historial" aria-label={`Ver historial de ${f.variant?.product?.nombre}`}>
                        <History size={14} />
                      </button>
                      {isAdmin && (
                        <button onClick={() => setEditModal(f)}
                          className="p-1.5 rounded-lg bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 transition-colors" title="Editar" aria-label={`Editar ${f.variant?.product?.nombre}`}>
                          <Pencil size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
            {filtradas.length === 0 && <tr><td colSpan={isAdmin ? 7 : 6} className="px-4 py-10 text-center text-gray-500">Sin resultados</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Modal ajuste de stock */}
      {ajusteModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end md:items-center justify-center z-50 p-0 md:p-4">
          <div className="bg-[#161b22] rounded-t-2xl md:rounded-2xl w-full max-w-sm p-5 border border-[#30363d] shadow-2xl relative">
            <button onClick={() => setAjusteModal(null)} className="absolute top-4 right-4 text-gray-500 hover:text-white" aria-label="Cerrar"><X size={20} /></button>
            <div className="flex items-center gap-3 mb-4">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${ajusteTipo === 'entrada' ? 'bg-green-500/15' : 'bg-red-500/15'}`}>
                {ajusteTipo === 'entrada' ? <ArrowUpCircle size={20} className="text-green-400" /> : <ArrowDownCircle size={20} className="text-red-400" />}
              </div>
              <div>
                <h3 className="font-bold text-white">{ajusteTipo === 'entrada' ? 'Entrada' : 'Salida'} de stock</h3>
                <p className="text-xs text-gray-500">{ajusteModal.variant?.product?.nombre}</p>
              </div>
            </div>
            <p className="text-sm text-gray-400 mb-3">Stock actual: <span className="font-bold text-white">{ajusteModal.cantidad}</span></p>
            <div className="flex gap-2 mb-3">
              <button onClick={() => setAjusteTipo('entrada')}
                className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${ajusteTipo === 'entrada' ? 'bg-green-500 text-black' : 'bg-[#21262d] text-gray-400 border border-[#30363d]'}`}>
                + Entrada
              </button>
              <button onClick={() => setAjusteTipo('salida')}
                className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${ajusteTipo === 'salida' ? 'bg-red-500 text-white' : 'bg-[#21262d] text-gray-400 border border-[#30363d]'}`}>
                - Salida
              </button>
            </div>
            <label className="text-xs text-gray-500 font-semibold">Cantidad</label>
            <input autoFocus type="number" min="1" value={ajusteCant} onChange={(e) => setAjusteCant(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mt-1 mb-3 text-white text-lg focus:outline-none focus:ring-2 focus:ring-cyan-500" placeholder="0" />
            <label className="text-xs text-gray-500 font-semibold">Motivo</label>
            <select value={ajusteMotivo} onChange={(e) => setAjusteMotivo(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mt-1 mb-4 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500">
              {ajusteTipo === 'entrada' ? (
                <>
                  <option>Entrada de mercadería</option>
                  <option>Devolución de cliente</option>
                  <option>Conteo físico (ajuste)</option>
                  <option>Transferencia entre tiendas</option>
                </>
              ) : (
                <>
                  <option>Merma / producto dañado</option>
                  <option>Conteo físico (ajuste)</option>
                  <option>Uso interno</option>
                  <option>Robo / pérdida</option>
                  <option>Transferencia entre tiendas</option>
                </>
              )}
            </select>
            <button onClick={aplicarAjuste} disabled={guardando || !ajusteCant}
              className={`w-full font-bold py-3 rounded-xl transition-all active:scale-[0.98] ${
                ajusteTipo === 'entrada' ? 'bg-gradient-to-r from-green-500 to-green-600 text-black' : 'bg-gradient-to-r from-red-500 to-red-600 text-white'
              } disabled:opacity-40`}>
              {guardando ? 'Guardando...' : `Confirmar ${ajusteTipo}`}
            </button>
          </div>
        </div>
      )}

      {/* Modal historial de movimientos */}
      {histModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end md:items-center justify-center z-50 p-0 md:p-4">
          <div className="bg-[#161b22] rounded-t-2xl md:rounded-2xl w-full max-w-md p-5 border border-[#30363d] shadow-2xl relative max-h-[80vh] flex flex-col">
            <button onClick={() => setHistModal(null)} className="absolute top-4 right-4 text-gray-500 hover:text-white" aria-label="Cerrar"><X size={20} /></button>
            <h3 className="font-bold text-white mb-1">Historial de movimientos</h3>
            <p className="text-xs text-gray-500 mb-4">{histModal.variant?.product?.nombre} · {histModal.variant?.color || histModal.variant?.product?.sku}</p>
            <div className="overflow-y-auto overflow-x-hidden flex-1 space-y-2">
              {movimientos.map((m) => (
                <div key={m.id} className="flex items-center justify-between bg-[#21262d] rounded-lg p-3 border border-[#30363d]">
                  <div>
                    <p className="text-sm text-white">{m.motivo}</p>
                    <p className="text-xs text-gray-500">{new Date(m.created_at).toLocaleString('es-PE')}</p>
                  </div>
                  <span className={`font-bold text-sm ${m.cantidad_delta > 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {m.cantidad_delta > 0 ? '+' : ''}{m.cantidad_delta}
                  </span>
                </div>
              ))}
              {movimientos.length === 0 && <p className="text-gray-500 text-sm text-center py-8">Sin movimientos registrados</p>}
            </div>
          </div>
        </div>
      )}

      {editModal && (
        <ModalEditarProducto
          fila={editModal}
          categorias={categorias}
          modelos={modelos}
          onClose={() => setEditModal(null)}
          onSaved={async () => { setEditModal(null); await cargar() }}
          onAgregarVariante={() => {
            const p = editModal.variant.product
            setEditModal(null)
            setNuevoModal({ varianteDe: { id: p.id, nombre: p.nombre, categoria_id: p.categoria_id } })
          }}
        />
      )}

      {nuevoModal && (
        <ModalProducto
          varianteDe={nuevoModal.varianteDe}
          prefillBarcode={nuevoModal.prefillBarcode}
          categorias={categorias}
          modelos={modelos}
          locationId={staff?.location_id ?? null}
          staffId={staff?.id ?? null}
          stockMinimoDefault={config.stock_minimo_default}
          onClose={() => setNuevoModal(null)}
          onSaved={async () => { setNuevoModal(null); await cargar() }}
        />
      )}

      {scannerBuscar && (
        <BarcodeScanner titulo="Escanear producto" onClose={() => setScannerBuscar(false)} onDetect={manejarEscaneoBusqueda} />
      )}
    </div>
  )
}

function ModalProducto({ varianteDe, prefillBarcode, categorias, modelos, locationId, staffId, stockMinimoDefault, onClose, onSaved }: {
  varianteDe?: { id: string; nombre: string; categoria_id: string | null }
  prefillBarcode?: string
  categorias: Categoria[]
  modelos: Modelo[]
  locationId: string | null
  staffId: string | null
  stockMinimoDefault: number
  onClose: () => void
  onSaved: () => void
}) {
  const { showToast } = useToast()
  const esVariante = !!varianteDe
  const [nombre, setNombre] = useState('')
  const [sku, setSku] = useState('')
  const [categoriaId, setCategoriaId] = useState(varianteDe?.categoria_id || '')
  const [precioBase, setPrecioBase] = useState('')
  const [costo, setCosto] = useState('0')
  const [imagenUrl, setImagenUrl] = useState('')
  const [color, setColor] = useState('')
  const [modeloId, setModeloId] = useState('')
  const requiereModelo = categorias.find((c) => c.id === categoriaId)?.requiere_modelo_celular ?? false
  const [precioOverride, setPrecioOverride] = useState('')
  const [codigoBarras, setCodigoBarras] = useState(prefillBarcode || '')
  const [stockInicial, setStockInicial] = useState('0')
  const [stockMinimo, setStockMinimo] = useState(String(stockMinimoDefault))
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')
  const [scannerAbierto, setScannerAbierto] = useState(false)

  useEffect(() => { if (!requiereModelo) setModeloId('') }, [requiereModelo])

  const guardar = async () => {
    if (!esVariante && (!nombre.trim() || !precioBase)) { setError('Completa nombre y precio de venta'); return }
    if (!locationId) { setError('Tu usuario no tiene una tienda/almacén asignado'); return }
    setGuardando(true); setError('')
    try {
      let productId = varianteDe?.id ?? ''
      if (!esVariante) {
        const { data: prod, error: e1 } = await supabase.from('products').insert({
          nombre: nombre.trim(), sku: sku.trim() || null, categoria_id: categoriaId || null,
          precio_base: Number(precioBase), costo: Number(costo) || 0, imagen_url: imagenUrl.trim() || null,
        }).select('id').single()
        if (e1 || !prod) throw new Error(e1?.code === '23505' ? 'Ese SKU ya existe' : (e1?.message || 'No se pudo crear el producto'))
        productId = prod.id
      }
      const { data: variant, error: e2 } = await supabase.from('product_variants').insert({
        product_id: productId, color: color.trim() || null, modelo_celular_id: modeloId || null,
        precio_override: precioOverride ? Number(precioOverride) : null, codigo_barras: codigoBarras.trim() || null,
      }).select('id').single()
      if (e2 || !variant) throw new Error(e2?.code === '23505' ? 'Ese código de barras ya está en uso' : (e2?.message || 'No se pudo crear la variante'))
      const cantidad = Math.max(0, Number(stockInicial) || 0)
      const { error: e3 } = await supabase.from('inventory').insert({
        variant_id: variant.id, location_id: locationId, cantidad, stock_minimo: Math.max(0, Number(stockMinimo) || 0),
      })
      if (e3) throw new Error(e3.message)
      if (cantidad > 0) {
        await supabase.from('inventory_movements').insert({
          variant_id: variant.id, location_id: locationId, cantidad_delta: cantidad, motivo: 'Alta de producto nuevo', staff_id: staffId,
        })
      }
      showToast(esVariante ? 'Variante creada' : 'Producto creado', 'success')
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar')
    } finally { setGuardando(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end md:items-center justify-center z-50 p-0 md:p-4">
      <div className="bg-[#161b22] rounded-t-2xl md:rounded-2xl w-full max-w-md p-5 border border-[#30363d] shadow-2xl relative max-h-[92vh] overflow-y-auto overflow-x-hidden">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-500 hover:text-white" aria-label="Cerrar"><X size={20} /></button>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-cyan-500/15 flex items-center justify-center shrink-0"><PackagePlus size={20} className="text-cyan-400" /></div>
          <div className="min-w-0">
            <h3 className="font-bold text-white">{esVariante ? 'Nueva variante' : 'Nuevo producto'}</h3>
            {esVariante && <p className="text-xs text-gray-500 truncate">{varianteDe?.nombre}</p>}
          </div>
        </div>

        {!esVariante && (
          <div className="space-y-3 mb-3">
            <div>
              <label className="text-xs text-gray-500 font-semibold">Nombre *</label>
              <input autoFocus value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Funda Silicona iPhone 15"
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-500 font-semibold">SKU</label>
                <input value={sku} onChange={(e) => setSku(e.target.value)}
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
              </div>
              <div>
                <label className="text-xs text-gray-500 font-semibold">Categoría</label>
                <select value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)}
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500">
                  <option value="">Sin categoría</option>
                  {categorias.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-500 font-semibold">Precio venta (S/) *</label>
                <input type="number" min="0" step="0.01" value={precioBase} onChange={(e) => setPrecioBase(e.target.value)}
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
              </div>
              <div>
                <label className="text-xs text-gray-500 font-semibold">Costo (S/)</label>
                <input type="number" min="0" step="0.01" value={costo} onChange={(e) => setCosto(e.target.value)}
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
              </div>
            </div>
            <SubirImagenProducto valor={imagenUrl} onChange={setImagenUrl} />
          </div>
        )}

        <p className="text-[11px] text-gray-500 font-semibold uppercase tracking-wide mb-2 mt-1">{esVariante ? 'Datos de la variante' : 'Variante inicial'}</p>
        <div className={`grid ${requiereModelo ? 'grid-cols-2' : 'grid-cols-1'} gap-2 mb-3`}>
          <div>
            <label className="text-xs text-gray-500 font-semibold">Color</label>
            <input value={color} onChange={(e) => setColor(e.target.value)} placeholder="Negro"
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
          {requiereModelo && (
            <div>
              <label className="text-xs text-gray-500 font-semibold">Modelo de celular</label>
              <select value={modeloId} onChange={(e) => setModeloId(e.target.value)}
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500">
                <option value="">General</option>
                {modelos.map((m) => <option key={m.id} value={m.id}>{m.marca} {m.modelo}</option>)}
              </select>
            </div>
          )}
        </div>

        <label className="text-xs text-gray-500 font-semibold">Código de barras</label>
        <div className="flex gap-2 mt-1 mb-3">
          <input value={codigoBarras} onChange={(e) => setCodigoBarras(e.target.value)} placeholder="Escanea o escribe"
            className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          <button type="button" onClick={() => setScannerAbierto(true)} title="Escanear con cámara"
            className="shrink-0 w-11 rounded-xl bg-cyan-500/15 text-cyan-400 flex items-center justify-center hover:bg-cyan-500/25"><ScanLine size={18} /></button>
          <button type="button" onClick={() => setCodigoBarras(generarCodigoInterno())} title="Generar código interno"
            className="shrink-0 px-3 rounded-xl bg-[#21262d] border border-[#30363d] text-gray-400 text-[11px] font-semibold hover:text-white">Generar</button>
        </div>

        {esVariante && (
          <div className="mb-3">
            <label className="text-xs text-gray-500 font-semibold">Precio diferente (opcional)</label>
            <input type="number" min="0" step="0.01" value={precioOverride} onChange={(e) => setPrecioOverride(e.target.value)} placeholder="Usa el precio base del producto"
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 mb-4">
          <div>
            <label className="text-xs text-gray-500 font-semibold">Stock inicial</label>
            <input type="number" min="0" value={stockInicial} onChange={(e) => setStockInicial(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
          <div>
            <label className="text-xs text-gray-500 font-semibold">Stock mínimo</label>
            <input type="number" min="0" value={stockMinimo} onChange={(e) => setStockMinimo(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
        </div>

        {error && <p className="text-red-400 text-xs mb-3 bg-red-500/10 rounded-lg p-2">{error}</p>}
        <button onClick={guardar} disabled={guardando}
          className="w-full bg-gradient-to-r from-cyan-500 to-cyan-600 disabled:opacity-40 text-black font-bold py-3 rounded-xl transition-all active:scale-[0.98]">
          {guardando ? 'Guardando...' : esVariante ? 'Crear variante' : 'Crear producto'}
        </button>
      </div>

      {scannerAbierto && (
        <BarcodeScanner onClose={() => setScannerAbierto(false)} onDetect={(c) => { setCodigoBarras(c); setScannerAbierto(false) }} />
      )}
    </div>
  )
}

function ModalEditarProducto({ fila, categorias, modelos, onClose, onSaved, onAgregarVariante }: {
  fila: FilaInventario
  categorias: Categoria[]
  modelos: Modelo[]
  onClose: () => void
  onSaved: () => void
  onAgregarVariante: () => void
}) {
  const { showToast } = useToast()
  const p = fila.variant.product
  const v = fila.variant
  const [nombre, setNombre] = useState(p.nombre)
  const [sku, setSku] = useState(p.sku || '')
  const [categoriaId, setCategoriaId] = useState(p.categoria_id || '')
  const [precioBase, setPrecioBase] = useState(String(p.precio_base))
  const [imagenUrl, setImagenUrl] = useState(p.imagen_url || '')
  const [activo, setActivo] = useState(p.activo)
  const [color, setColor] = useState(v.color || '')
  const [modeloId, setModeloId] = useState(v.modelo_celular_id || '')
  const [precioOverride, setPrecioOverride] = useState(v.precio_override != null ? String(v.precio_override) : '')
  const [codigoBarras, setCodigoBarras] = useState(v.codigo_barras || '')
  const [stockMinimo, setStockMinimo] = useState(String(fila.stock_minimo))
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')
  const [scannerAbierto, setScannerAbierto] = useState(false)
  const requiereModelo = categorias.find((c) => c.id === categoriaId)?.requiere_modelo_celular ?? false

  useEffect(() => { if (!requiereModelo) setModeloId('') }, [requiereModelo])

  const guardar = async () => {
    if (!nombre.trim() || !precioBase) { setError('Completa nombre y precio'); return }
    setGuardando(true); setError('')
    try {
      const { error: e1 } = await supabase.from('products').update({
        nombre: nombre.trim(), sku: sku.trim() || null, categoria_id: categoriaId || null,
        precio_base: Number(precioBase) || 0, imagen_url: imagenUrl.trim() || null, activo,
      }).eq('id', p.id)
      if (e1) throw new Error(e1.code === '23505' ? 'Ese SKU ya existe' : e1.message)

      const { error: e2 } = await supabase.from('product_variants').update({
        color: color.trim() || null, modelo_celular_id: modeloId || null,
        codigo_barras: codigoBarras.trim() || null, precio_override: precioOverride ? Number(precioOverride) : null,
      }).eq('id', v.id)
      if (e2) throw new Error(e2.code === '23505' ? 'Ese código de barras ya está en uso' : e2.message)

      const { error: e3 } = await supabase.from('inventory').update({ stock_minimo: Math.max(0, Number(stockMinimo) || 0) })
        .eq('variant_id', fila.variant_id).eq('location_id', fila.location_id)
      if (e3) throw new Error(e3.message)

      showToast('Producto actualizado', 'success')
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar')
    } finally { setGuardando(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end md:items-center justify-center z-50 p-0 md:p-4">
      <div className="bg-[#161b22] rounded-t-2xl md:rounded-2xl w-full max-w-md p-5 border border-[#30363d] shadow-2xl relative max-h-[92vh] overflow-y-auto overflow-x-hidden">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-500 hover:text-white" aria-label="Cerrar"><X size={20} /></button>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-orange-500/15 flex items-center justify-center shrink-0"><Pencil size={18} className="text-orange-400" /></div>
          <h3 className="font-bold text-white">Editar producto</h3>
        </div>

        <div className="space-y-3 mb-3">
          <div>
            <label className="text-xs text-gray-500 font-semibold">Nombre *</label>
            <input value={nombre} onChange={(e) => setNombre(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-500 font-semibold">SKU</label>
              <input value={sku} onChange={(e) => setSku(e.target.value)}
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
            </div>
            <div>
              <label className="text-xs text-gray-500 font-semibold">Categoría</label>
              <select value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)}
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500">
                <option value="">Sin categoría</option>
                {categorias.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-500 font-semibold">Precio venta (S/) *</label>
            <input type="number" min="0" step="0.01" value={precioBase} onChange={(e) => setPrecioBase(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
          <SubirImagenProducto valor={imagenUrl} onChange={setImagenUrl} />
        </div>

        <p className="text-[11px] text-gray-500 font-semibold uppercase tracking-wide mb-2">Esta variante</p>
        <div className={`grid ${requiereModelo ? 'grid-cols-2' : 'grid-cols-1'} gap-2 mb-3`}>
          <div>
            <label className="text-xs text-gray-500 font-semibold">Color</label>
            <input value={color} onChange={(e) => setColor(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
          {requiereModelo && (
            <div>
              <label className="text-xs text-gray-500 font-semibold">Modelo de celular</label>
              <select value={modeloId} onChange={(e) => setModeloId(e.target.value)}
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500">
                <option value="">General</option>
                {modelos.map((m) => <option key={m.id} value={m.id}>{m.marca} {m.modelo}</option>)}
              </select>
            </div>
          )}
        </div>

        <label className="text-xs text-gray-500 font-semibold">Código de barras</label>
        <div className="flex gap-2 mt-1 mb-3">
          <input value={codigoBarras} onChange={(e) => setCodigoBarras(e.target.value)}
            className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          <button type="button" onClick={() => setScannerAbierto(true)} title="Escanear con cámara"
            className="shrink-0 w-11 rounded-xl bg-cyan-500/15 text-cyan-400 flex items-center justify-center hover:bg-cyan-500/25"><ScanLine size={18} /></button>
        </div>

        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <label className="text-xs text-gray-500 font-semibold">Precio diferente</label>
            <input type="number" min="0" step="0.01" value={precioOverride} onChange={(e) => setPrecioOverride(e.target.value)} placeholder="Precio base"
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
          <div>
            <label className="text-xs text-gray-500 font-semibold">Stock mínimo</label>
            <input type="number" min="0" value={stockMinimo} onChange={(e) => setStockMinimo(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
        </div>

        <button type="button" onClick={() => setActivo(!activo)} aria-pressed={activo}
          className={`w-full flex items-center justify-between px-4 py-3 rounded-xl mb-3 border ${activo ? 'bg-green-500/10 border-green-500/30 text-green-400' : 'bg-red-500/10 border-red-500/30 text-red-400'}`}>
          <span className="flex items-center gap-2 text-sm font-semibold">{activo ? <CheckCircle2 size={16} /> : <Ban size={16} />} {activo ? 'Activo · visible en Venta' : 'Desactivado · oculto en Venta'}</span>
          <span className="text-xs">Cambiar</span>
        </button>

        <button type="button" onClick={onAgregarVariante}
          className="w-full flex items-center justify-center gap-2 border border-dashed border-[#30363d] text-gray-400 text-xs font-semibold py-2.5 rounded-xl hover:border-cyan-500/50 hover:text-cyan-400 mb-4">
          <PackagePlus size={14} /> Agregar otra variante (color / modelo) de este producto
        </button>

        {error && <p className="text-red-400 text-xs mb-3 bg-red-500/10 rounded-lg p-2">{error}</p>}
        <button onClick={guardar} disabled={guardando}
          className="w-full bg-gradient-to-r from-cyan-500 to-cyan-600 disabled:opacity-40 text-black font-bold py-3 rounded-xl transition-all active:scale-[0.98]">
          {guardando ? 'Guardando...' : 'Guardar cambios'}
        </button>
      </div>

      {scannerAbierto && (
        <BarcodeScanner onClose={() => setScannerAbierto(false)} onDetect={(c) => { setCodigoBarras(c); setScannerAbierto(false) }} />
      )}
    </div>
  )
}
