import { useState, useEffect } from 'react'
import { Percent, Store, Package, Save, Printer, ShieldAlert, FileText, QrCode } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useConfig } from '../lib/config'
import { useToast } from '../lib/toast'
import type { TamanoPapel } from '../types'

export default function Configuracion() {
  const { config, refreshConfig } = useConfig()
  const { showToast } = useToast()
  const [igvActivo, setIgvActivo] = useState(config.igv_activo)
  const [igvPorcentaje, setIgvPorcentaje] = useState(String(config.igv_porcentaje))
  const [negocioNombre, setNegocioNombre] = useState(config.negocio_nombre)
  const [negocioRuc, setNegocioRuc] = useState(config.negocio_ruc || '')
  const [negocioDireccion, setNegocioDireccion] = useState(config.negocio_direccion || '')
  const [stockMinimo, setStockMinimo] = useState(String(config.stock_minimo_default))
  const [permitirStockNegativo, setPermitirStockNegativo] = useState(config.permitir_stock_negativo)
  const [autoImprimir, setAutoImprimir] = useState(config.auto_imprimir_ticket)
  const [tamanoPapel, setTamanoPapel] = useState<TamanoPapel>(config.tamano_papel)
  const [nubefactActivo, setNubefactActivo] = useState(config.nubefact_activo)
  const [serieBoleta, setSerieBoleta] = useState(config.nubefact_serie_boleta)
  const [serieFactura, setSerieFactura] = useState(config.nubefact_serie_factura)
  const [culqiActivo, setCulqiActivo] = useState(config.culqi_activo)
  const [guardando, setGuardando] = useState(false)

  useEffect(() => {
    setIgvActivo(config.igv_activo)
    setIgvPorcentaje(String(config.igv_porcentaje))
    setNegocioNombre(config.negocio_nombre)
    setNegocioRuc(config.negocio_ruc || '')
    setNegocioDireccion(config.negocio_direccion || '')
    setStockMinimo(String(config.stock_minimo_default))
    setPermitirStockNegativo(config.permitir_stock_negativo)
    setAutoImprimir(config.auto_imprimir_ticket)
    setTamanoPapel(config.tamano_papel)
    setNubefactActivo(config.nubefact_activo)
    setSerieBoleta(config.nubefact_serie_boleta)
    setSerieFactura(config.nubefact_serie_factura)
    setCulqiActivo(config.culqi_activo)
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
      permitir_stock_negativo: permitirStockNegativo,
      auto_imprimir_ticket: autoImprimir,
      tamano_papel: tamanoPapel,
      nubefact_activo: nubefactActivo,
      nubefact_serie_boleta: serieBoleta.trim() || 'BBB1',
      nubefact_serie_factura: serieFactura.trim() || 'FFF1',
      culqi_activo: culqiActivo,
      updated_at: new Date().toISOString(),
    }).eq('id', 1)
    setGuardando(false)
    if (error) { showToast('No se pudo guardar la configuración', 'error'); return }
    await refreshConfig()
    showToast('Configuración guardada', 'success')
  }

  return (
    <div className="p-3 md:p-5 max-w-6xl">
      <h1 className="font-display font-bold text-xl text-white mb-5">Configuración</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
      <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-5">
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

      <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-5">
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

      <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-green-500/15 flex items-center justify-center shrink-0"><Package size={18} className="text-green-400" /></div>
          <div><h2 className="font-semibold text-white">Inventario</h2><p className="text-xs text-gray-500">Referencia al crear productos nuevos en Supabase</p></div>
        </div>
        <label className="text-xs text-gray-500 font-semibold">Stock mínimo por defecto</label>
        <input type="number" min="0" value={stockMinimo} onChange={(e) => setStockMinimo(e.target.value)}
          className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mt-1.5 mb-4 text-white text-lg focus:outline-none focus:ring-2 focus:ring-cyan-500" />
        <p className="text-xs text-gray-600 -mt-3 mb-4">No cambia el mínimo de productos ya existentes en Inventario — cada uno mantiene el suyo, editable ahí mismo.</p>
        <div className="flex items-center justify-between bg-[#0d1117] rounded-xl border border-[#30363d] px-4 py-3">
          <span className="flex items-center gap-2 text-sm text-gray-300"><ShieldAlert size={15} className="text-orange-400 shrink-0" /> Permitir vender sin stock disponible</span>
          <button onClick={() => setPermitirStockNegativo(!permitirStockNegativo)} aria-pressed={permitirStockNegativo}
            className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${permitirStockNegativo ? 'bg-orange-500' : 'bg-[#30363d]'}`}>
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${permitirStockNegativo ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-2">Con esto desactivado (recomendado), una venta se rechaza si no hay stock suficiente.</p>
      </div>

      <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-cyan-500/15 flex items-center justify-center shrink-0"><Printer size={18} className="text-cyan-400" /></div>
          <div><h2 className="font-semibold text-white">Impresión de ticket</h2><p className="text-xs text-gray-500">Al confirmar una venta</p></div>
        </div>
        <div className="flex items-center justify-between bg-[#0d1117] rounded-xl border border-[#30363d] px-4 py-3 mb-3">
          <span className="text-sm text-gray-300">Imprimir automáticamente al cobrar</span>
          <button onClick={() => setAutoImprimir(!autoImprimir)} aria-pressed={autoImprimir}
            className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${autoImprimir ? 'bg-cyan-500' : 'bg-[#30363d]'}`}>
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${autoImprimir ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
        <label className="text-xs text-gray-500 font-semibold">Tamaño de papel</label>
        <div className="flex gap-2 mt-1.5">
          {(['80mm', '58mm'] as TamanoPapel[]).map((t) => (
            <button key={t} onClick={() => setTamanoPapel(t)}
              className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-all ${tamanoPapel === t ? 'bg-cyan-500 text-black' : 'bg-[#0d1117] border border-[#30363d] text-gray-400'}`}>{t}</button>
          ))}
        </div>
      </div>

      <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-purple-500/15 flex items-center justify-center shrink-0"><FileText size={18} className="text-purple-400" /></div>
          <div><h2 className="font-semibold text-white">Boleta / Factura electrónica (Nubefact)</h2><p className="text-xs text-gray-500">Requiere una cuenta en Nubefact y el token configurado en el servidor</p></div>
        </div>
        <div className="flex items-center justify-between bg-[#0d1117] rounded-xl border border-[#30363d] px-4 py-3 mb-3">
          <span className="text-sm text-gray-300">Emitir comprobante electrónico al vender</span>
          <button onClick={() => setNubefactActivo(!nubefactActivo)} aria-pressed={nubefactActivo}
            className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${nubefactActivo ? 'bg-cyan-500' : 'bg-[#30363d]'}`}>
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${nubefactActivo ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-500 font-semibold">Serie boleta</label>
            <input value={serieBoleta} onChange={(e) => setSerieBoleta(e.target.value.toUpperCase())}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
          <div>
            <label className="text-xs text-gray-500 font-semibold">Serie factura</label>
            <input value={serieFactura} onChange={(e) => setSerieFactura(e.target.value.toUpperCase())}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
        </div>
        <p className="text-xs text-gray-600 mt-3">Las series deben coincidir exactamente con las que Nubefact asignó a esta cuenta. El token de acceso NO se configura aquí — se guarda como secreto del servidor.</p>
      </div>

      <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-green-500/15 flex items-center justify-center shrink-0"><QrCode size={18} className="text-green-400" /></div>
          <div><h2 className="font-semibold text-white">Pago digital verificado (Culqi)</h2><p className="text-xs text-gray-500">QR real para Yape/Plin, confirmado por Culqi — no un código tecleado a mano</p></div>
        </div>
        <div className="flex items-center justify-between bg-[#0d1117] rounded-xl border border-[#30363d] px-4 py-3">
          <span className="text-sm text-gray-300">Exigir confirmación real de Culqi para Yape/Plin</span>
          <button onClick={() => setCulqiActivo(!culqiActivo)} aria-pressed={culqiActivo}
            className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${culqiActivo ? 'bg-cyan-500' : 'bg-[#30363d]'}`}>
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${culqiActivo ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-2">Con esto activado, un pago con Yape o Plin en el mostrador muestra un QR real generado por Culqi y solo se puede completar la venta cuando Culqi confirma que el dinero llegó. Requiere cuenta en Culqi y las llaves configuradas como secrets del servidor.</p>
      </div>
      </div>

      <button onClick={guardar} disabled={guardando}
        className="flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-500 to-cyan-600 disabled:opacity-40 text-black font-bold px-6 py-3 rounded-xl hover:shadow-lg hover:shadow-cyan-500/30 transition-all">
        <Save size={16} /> {guardando ? 'Guardando...' : 'Guardar cambios'}
      </button>
    </div>
  )
}
