import { useEffect, useMemo, useState } from 'react'
import { Ban, RefreshCw, Search, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useToast } from '../lib/toast'

interface VentaFila {
  id: string
  numero: number
  fecha: string
  total: number
  estado: string
  anulada_at: string | null
  anulacion_motivo: string | null
  cajero: { nombre: string } | null
  comprobante: { id: string; estado: string; tipo_comprobante: string; serie: string; numero: number }[] | null
}

function soles(v: number) {
  return new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' }).format(Number(v || 0))
}

function fecha(v: string) {
  return new Date(v).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' })
}

export default function Anulaciones() {
  const { showToast } = useToast()
  const [ventas, setVentas] = useState<VentaFila[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [seleccion, setSeleccion] = useState<VentaFila | null>(null)

  const cargar = async (manual = false) => {
    manual ? setRefreshing(true) : setLoading(true)
    const { data, error } = await supabase
      .from('sales')
      .select('id,numero,fecha,total,estado,anulada_at,anulacion_motivo,cajero:staff!sales_cajero_id_fkey(nombre),comprobante:comprobantes_electronicos(id,estado,tipo_comprobante,serie,numero)')
      .order('fecha', { ascending: false })
      .limit(250)

    if (error) {
      showToast('No se pudieron cargar las ventas', 'error')
      setVentas([])
    } else {
      setVentas((data as unknown as VentaFila[]) || [])
    }
    setLoading(false)
    setRefreshing(false)
  }

  useEffect(() => { cargar() }, [])

  const filtradas = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return ventas
    return ventas.filter((v) =>
      String(v.numero).includes(q) ||
      v.estado.toLowerCase().includes(q) ||
      (v.cajero?.nombre || '').toLowerCase().includes(q) ||
      (v.anulacion_motivo || '').toLowerCase().includes(q)
    )
  }, [ventas, query])

  return (
    <div className="p-3 md:p-5 max-w-6xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-5">
        <div>
          <div className="flex items-center gap-2"><Ban size={20} className="text-red-400" /><h1 className="font-display font-bold text-xl text-white">Anulaciones</h1></div>
          <p className="text-xs text-gray-500 mt-1">Anulación administrativa de ventas sin comprobante electrónico ni pago digital pendiente de reembolso.</p>
        </div>
        <button onClick={() => cargar(true)} disabled={refreshing} className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#30363d] bg-[#161b22] px-3 py-2 text-sm text-gray-300 disabled:opacity-50">
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} /> Actualizar
        </button>
      </div>

      <div className="relative mb-4">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por venta, cajero, estado o motivo..." className="w-full rounded-xl border border-[#30363d] bg-[#0d1117] py-2.5 pl-9 pr-3 text-sm text-white placeholder:text-gray-700 focus:outline-none focus:ring-1 focus:ring-cyan-500" />
      </div>

      <div className="rounded-2xl border border-[#30363d] bg-[#161b22] overflow-hidden">
        {loading ? <div className="p-10 text-center text-sm text-gray-500">Cargando ventas...</div> : filtradas.length === 0 ? <div className="p-10 text-center text-sm text-gray-600">No hay ventas para mostrar.</div> : (
          <div className="divide-y divide-[#21262d]">
            {filtradas.map((v) => {
              const tieneComprobante = Boolean(v.comprobante?.length)
              const anulada = v.estado === 'anulada'
              return <div key={v.id} className="px-4 py-3 flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-bold text-white">Venta #{v.numero}</p>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${anulada ? 'border-red-500/20 bg-red-500/10 text-red-300' : 'border-green-500/20 bg-green-500/10 text-green-300'}`}>{anulada ? 'Anulada' : 'Completada'}</span>
                    {tieneComprobante && <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-300">Con comprobante</span>}
                  </div>
                  <p className="text-[11px] text-gray-500 mt-1">{fecha(v.fecha)} · {v.cajero?.nombre || 'Sin cajero'}</p>
                  <p className="text-base font-bold text-cyan-300 mt-1">{soles(v.total)}</p>
                  {anulada && <p className="text-xs text-red-200/70 mt-1.5">{v.anulacion_motivo || 'Sin motivo registrado'}{v.anulada_at ? ` · ${fecha(v.anulada_at)}` : ''}</p>}
                </div>
                {!anulada && <button onClick={() => setSeleccion(v)} className="self-start md:self-auto rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-300 hover:bg-red-500/15">Anular venta</button>}
              </div>
            })}
          </div>
        )}
      </div>

      {seleccion && <ModalAnular venta={seleccion} onClose={() => setSeleccion(null)} onSaved={async () => { setSeleccion(null); await cargar(true); showToast('Venta anulada y stock repuesto', 'success') }} />}
    </div>
  )
}

function ModalAnular({ venta, onClose, onSaved }: { venta: VentaFila; onClose: () => void; onSaved: () => void }) {
  const [motivo, setMotivo] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')

  const confirmar = async () => {
    setError('')
    if (motivo.trim().length < 5) { setError('Ingresa un motivo de al menos 5 caracteres'); return }
    setGuardando(true)
    const { error: rpcError } = await supabase.rpc('anular_venta', { p_sale_id: venta.id, p_motivo: motivo.trim() })
    setGuardando(false)
    if (rpcError) { setError(rpcError.message || 'No se pudo anular la venta'); return }
    onSaved()
  }

  return <div className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-end md:items-center justify-center p-0 md:p-4">
    <div className="relative w-full max-w-md rounded-t-2xl md:rounded-2xl border border-red-500/25 bg-[#161b22] p-5 shadow-2xl">
      <button onClick={onClose} className="absolute right-4 top-4 text-gray-500 hover:text-white" aria-label="Cerrar"><X size={19} /></button>
      <div className="flex items-center gap-3 mb-4"><div className="w-10 h-10 rounded-xl border border-red-500/25 bg-red-500/10 flex items-center justify-center"><Ban size={18} className="text-red-400" /></div><div><h3 className="font-bold text-white">Anular venta #{venta.numero}</h3><p className="text-xs text-gray-500">Total: {soles(venta.total)}</p></div></div>
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200/80 mb-4">La anulación repone el stock y deja la venta como anulada. Si existe comprobante electrónico o pago digital confirmado, el servidor bloqueará esta operación hasta usar nota de crédito/reembolso.</div>
      <label className="text-xs font-semibold text-gray-500">Motivo obligatorio</label>
      <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={4} placeholder="Ej. venta duplicada, error de caja..." className="mt-1 w-full resize-none rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2.5 text-sm text-white placeholder:text-gray-700 focus:outline-none focus:ring-1 focus:ring-red-500" />
      {error && <p className="mt-3 rounded-lg bg-red-500/10 p-2 text-xs text-red-400">{error}</p>}
      <div className="flex gap-2 mt-5"><button onClick={onClose} className="flex-1 rounded-xl border border-[#30363d] bg-[#21262d] py-2.5 text-sm font-semibold text-gray-300">Cancelar</button><button onClick={confirmar} disabled={guardando || motivo.trim().length < 5} className="flex-1 rounded-xl bg-red-500 py-2.5 text-sm font-bold text-white disabled:opacity-40">{guardando ? 'Anulando...' : 'Confirmar anulación'}</button></div>
    </div>
  </div>
}
