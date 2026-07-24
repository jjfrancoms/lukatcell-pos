import { useState, useEffect } from 'react'
import { Percent, Store, Package, Save } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useConfig } from '../lib/config'
import { useToast } from '../lib/toast'

export default function Configuracion() {
  const { config, refreshConfig } = useConfig()
  const { showToast } = useToast()
  const [igvActivo, setIgvActivo] = useState(config.igv_activo)
  const [igvPorcentaje, setIgvPorcentaje] = useState(String(config.igv_porcentaje))
  const [negocioNombre, setNegocioNombre] = useState(config.negocio_nombre)
  const [negocioRuc, setNegocioRuc] = useState(config.negocio_ruc || '')
  const [negocioDireccion, setNegocioDireccion] = useState(config.negocio_direccion || '')
  const [stockMinimo, setStockMinimo] = useState(String(config.stock_minimo_default))
  const [guardando, setGuardando] = useState(false)

  useEffect(() => {
    setIgvActivo(config.igv_activo)
    setIgvPorcentaje(String(config.igv_porcentaje))
    setNegocioNombre(config.negocio_nombre)
    setNegocioRuc(config.negocio_ruc || '')
    setNegocioDireccion(config.negocio_direccion || '')
    setStockMinimo(String(config.stock_minimo_default))
  }, [config])

  const guardar = async () => {
    setGuardando(true)
    const { error } = await supabase.from('configuracion').update({
      igv_activo: igvActivo,
      igv_porcentaje: Number(igvPorcentaje) || 0,
      negocio_nombre: negocioNombre.trim() || 'LUKATCELL',
      negocio_ruc: negocioRuc.trim() || null,
      negocio_direccion: negocioDireccion.trim() || null,
      stock_minimo_default: Number(stockMinimo) || 0,
      updated_at: new Date().toISOString(),
    }).eq('id', 1)
    setGuardando(false)
    if (error) { showToast('No se pudo guardar la configuración', 'error'); return }
    await refreshConfig()
    showToast('Configuración guardada', 'success')
  }

  return (
    <div className="p-3 md:p-5 max-w-2xl">
      <h1 className="font-display font-bold text-xl text-white mb-5">Configuración</h1>

      <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-5 mb-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-cyan-500/15 flex items-center justify-center shrink-0"><Percent size={18} className="text-cyan-400" /></div>
          <div><h2 className="font-semibold text-white">Impuesto (IGV)</h2><p className="text-xs text-gray-500">Se aplica a todas las ventas nuevas</p></div>
        </div>
        <div className="flex items-center justify-between bg-[#0d1117] rounded-xl border border-[#30363d] px-4 py-3 mb-3">
          <span className="text-sm text-gray-300">Activar IGV en las ventas</span>
          <button onClick={() => setIgvActivo(!igvActivo)} aria-pressed={igvActivo}
            className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${igvActivo ? 'bg-cyan-500' : 'bg-[#30363d]'}`}>
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${igvActivo ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
        <label className="text-xs text-gray-500 font-semibold">Porcentaje de IGV (%)</label>
        <input type="number" min="0" max="100" step="0.01" value={igvPorcentaje} onChange={(e) => setIgvPorcentaje(e.target.value)}
          disabled={!igvActivo}
          className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mt-1.5 text-white text-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 disabled:opacity-40" />
      </div>

      <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-5 mb-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-orange-500/15 flex items-center justify-center shrink-0"><Store size={18} className="text-orange-400" /></div>
          <div><h2 className="font-semibold text-white">Datos del negocio</h2><p className="text-xs text-gray-500">Aparecen en los comprobantes impresos</p></div>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500 font-semibold">Nombre del negocio</label>
            <input value={negocioNombre} onChange={(e) => setNegocioNombre(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
          <div>
            <label className="text-xs text-gray-500 font-semibold">RUC (opcional)</label>
            <input value={negocioRuc} onChange={(e) => setNegocioRuc(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
          <div>
            <label className="text-xs text-gray-500 font-semibold">Dirección (opcional)</label>
            <input value={negocioDireccion} onChange={(e) => setNegocioDireccion(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
        </div>
      </div>

      <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-5 mb-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-green-500/15 flex items-center justify-center shrink-0"><Package size={18} className="text-green-400" /></div>
          <div><h2 className="font-semibold text-white">Inventario</h2><p className="text-xs text-gray-500">Referencia al crear productos nuevos en Supabase</p></div>
        </div>
        <label className="text-xs text-gray-500 font-semibold">Stock mínimo por defecto</label>
        <input type="number" min="0" value={stockMinimo} onChange={(e) => setStockMinimo(e.target.value)}
          className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mt-1.5 text-white text-lg focus:outline-none focus:ring-2 focus:ring-cyan-500" />
        <p className="text-xs text-gray-600 mt-2">No cambia el mínimo de productos ya existentes en Inventario — cada uno mantiene el suyo, editable ahí mismo.</p>
      </div>

      <button onClick={guardar} disabled={guardando}
        className="flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-500 to-cyan-600 disabled:opacity-40 text-black font-bold px-6 py-3 rounded-xl hover:shadow-lg hover:shadow-cyan-500/30 transition-all">
        <Save size={16} /> {guardando ? 'Guardando...' : 'Guardar cambios'}
      </button>
    </div>
  )
}
