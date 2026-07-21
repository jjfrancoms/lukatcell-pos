import { useState, useEffect } from 'react'
import { AlertTriangle, Search, Plus, Minus, History, X, Package, ArrowUpCircle, ArrowDownCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'

interface FilaInventario {
  variant_id: string; cantidad: number; stock_minimo: number; location_id: string
  variant: { id: string; color: string | null; codigo_barras: string | null
    product: { id: string; nombre: string; sku: string | null; imagen_url: string | null; costo: number }
    modelo: { marca: string; modelo: string } | null }
}

interface Movimiento {
  id: string; cantidad_delta: number; motivo: string; created_at: string
}

export default function Inventario() {
  const { isAdmin } = useAuth()
  const { showToast } = useToast()
  const [filas, setFilas] = useState<FilaInventario[]>([])
  const [busqueda, setBusqueda] = useState('')
  const [soloStockBajo, setSoloStockBajo] = useState(false)
  const [ajusteModal, setAjusteModal] = useState<FilaInventario | null>(null)
  const [histModal, setHistModal] = useState<FilaInventario | null>(null)
  const [movimientos, setMovimientos] = useState<Movimiento[]>([])
  const [ajusteCant, setAjusteCant] = useState('')
  const [ajusteMotivo, setAjusteMotivo] = useState('Entrada de mercadería')
  const [ajusteTipo, setAjusteTipo] = useState<'entrada' | 'salida'>('entrada')
  const [guardando, setGuardando] = useState(false)
  const [costoEdit, setCostoEdit] = useState<Record<string, string>>({})

  const cargar = async () => {
    const { data } = await supabase.from('inventory')
      .select('variant_id, cantidad, stock_minimo, location_id, variant:product_variants(id, color, codigo_barras, product:products(id, nombre, sku, imagen_url, costo), modelo:modelos_celular(marca, modelo))')
      .order('cantidad', { ascending: true })
    setFilas((data as unknown as FilaInventario[]) || [])
  }

  const guardarCosto = async (productId: string, valor: string) => {
    const costo = Number(valor)
    if (Number.isNaN(costo) || costo < 0) return
    const { error } = await supabase.from('products').update({ costo }).eq('id', productId)
    if (error) { showToast('No se pudo guardar el costo', 'error'); return }
    setFilas((fs) => fs.map((f) => f.variant?.product?.id === productId ? { ...f, variant: { ...f.variant, product: { ...f.variant.product, costo } } } : f))
    showToast('Costo actualizado', 'success')
  }

  useEffect(() => { cargar() }, [])

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

  return (
    <div className="p-3 md:p-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <h1 className="font-display font-bold text-xl text-white">Inventario</h1>
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
      </div>

      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" size={16} />
          <input value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="Buscar producto, SKU o código de barras..."
            className="w-full pl-10 pr-3 py-2.5 rounded-xl bg-[#161b22] border border-[#30363d] text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500" />
        </div>
        <button onClick={() => setSoloStockBajo(!soloStockBajo)}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold transition-all shrink-0 ${soloStockBajo ? 'bg-orange-500/15 text-orange-400 border border-orange-500/30' : 'bg-[#161b22] border border-[#30363d] text-gray-400'}`}>
          <AlertTriangle size={14} /> Stock bajo
        </button>
      </div>

      {/* Tabla responsive */}
      <div className="bg-[#161b22] rounded-2xl border border-[#30363d] overflow-x-auto">
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
              return (
                <tr key={f.variant_id} className="hover:bg-[#21262d] transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {img ? (
                        <img src={img} alt="" className="w-8 h-8 rounded-md object-cover shrink-0 bg-[#21262d]"
                          onError={(e) => { e.currentTarget.style.display = 'none' }} />
                      ) : (
                        <div className="w-8 h-8 rounded-md bg-[#21262d] flex items-center justify-center shrink-0"><Package size={14} className="text-gray-600" /></div>
                      )}
                      <div className="min-w-0">
                        <p className="font-medium text-white truncate">{f.variant?.product?.nombre}</p>
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
            <div className="overflow-y-auto flex-1 space-y-2">
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
    </div>
  )
}
