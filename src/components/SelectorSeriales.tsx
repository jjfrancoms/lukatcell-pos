import { useState, useEffect } from 'react'
import { X, Check } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useToast } from '../lib/toast'

interface Serial { id: string; serial_number: string; imei2: string | null }

export default function SelectorSeriales({ variantId, nombreProducto, cartTransactionId, seleccionInicial, onConfirm, onClose }: {
  variantId: string
  nombreProducto: string
  cartTransactionId: string
  seleccionInicial: string[]
  onConfirm: (serialIds: string[]) => void
  onClose: () => void
}) {
  const { showToast } = useToast()
  const [seriales, setSeriales] = useState<Serial[]>([])
  const [seleccion, setSeleccion] = useState<string[]>(seleccionInicial)
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)

  useEffect(() => {
    supabase.rpc('seriales_disponibles', { p_variant_id: variantId, p_client_transaction_id: cartTransactionId }).then(({ data }) => {
      setSeriales(data || [])
      setCargando(false)
    })
  }, [variantId, cartTransactionId])

  const toggle = (id: string) => {
    setSeleccion((prev) => prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id])
  }

  const confirmar = async () => {
    if (seleccion.length === 0) { showToast('Selecciona al menos un IMEI/serie', 'error'); return }
    setGuardando(true)
    const { error } = await supabase.rpc('reservar_seriales_carrito', {
      p_variant_id: variantId, p_serial_ids: seleccion, p_client_transaction_id: cartTransactionId,
    })
    setGuardando(false)
    if (error) { showToast(error.message || 'No se pudo reservar el IMEI/serie', 'error'); return }
    onConfirm(seleccion)
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end md:items-center justify-center z-[60] p-0 md:p-4">
      <div className="bg-[#161b22] rounded-t-2xl md:rounded-2xl w-full max-w-sm p-5 relative border border-[#30363d] shadow-2xl max-h-[85vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-500 hover:text-white" aria-label="Cerrar"><X size={20} /></button>
        <h3 className="font-display font-bold text-lg text-white mb-1">Selecciona el IMEI/serie</h3>
        <p className="text-xs text-gray-500 mb-4">{nombreProducto} · elige exactamente la unidad física que se va a vender</p>

        {cargando ? (
          <p className="text-sm text-gray-500 text-center py-6">Cargando disponibles...</p>
        ) : seriales.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-6">No hay unidades disponibles de este producto en tu sucursal.</p>
        ) : (
          <div className="space-y-1.5 mb-4">
            {seriales.map((s) => {
              const sel = seleccion.includes(s.id)
              return (
                <button key={s.id} onClick={() => toggle(s.id)}
                  className={`w-full flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 border text-left transition-colors ${sel ? 'bg-cyan-500/15 border-cyan-500' : 'bg-[#0d1117] border-[#30363d] hover:border-gray-600'}`}>
                  <div>
                    <p className="text-sm font-medium text-white">{s.serial_number}</p>
                    {s.imei2 && <p className="text-xs text-gray-500">IMEI2: {s.imei2}</p>}
                  </div>
                  {sel && <Check size={16} className="text-cyan-400 shrink-0" />}
                </button>
              )
            })}
          </div>
        )}

        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 bg-[#21262d] text-gray-300 font-semibold py-2.5 rounded-xl text-sm">Cancelar</button>
          <button onClick={confirmar} disabled={guardando || seleccion.length === 0} className="flex-1 bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-bold py-2.5 rounded-xl text-sm disabled:opacity-40">
            {guardando ? 'Reservando...' : `Confirmar (${seleccion.length})`}
          </button>
        </div>
      </div>
    </div>
  )
}
