import { useEffect, useRef, useState } from 'react'
import { Loader2, AlertTriangle, CheckCircle2, RefreshCw, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { EstadoPagoDigital } from '../types'

const CULQI_SCRIPT_SRC = 'https://checkout.culqi.com/js/v4'
const POLL_MS = 2500
const MAX_POLLS = 240 // ~10 minutos

declare global {
  interface Window {
    Culqi?: {
      publicKey: string
      settings: (opts: { title: string; currency: string; amount: number; order: string }) => void
      options: (opts: { paymentMethods: Record<string, boolean> }) => void
      open: () => void
      close: () => void
      order?: { id: string }
      token?: { id: string }
      error?: unknown
    }
    culqi?: () => void
  }
}

let scriptPromise: Promise<void> | null = null
function cargarScriptCulqi(): Promise<void> {
  if (window.Culqi) return Promise.resolve()
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const existente = document.querySelector(`script[src="${CULQI_SCRIPT_SRC}"]`)
      if (existente) { existente.addEventListener('load', () => resolve()); return }
      const script = document.createElement('script')
      script.src = CULQI_SCRIPT_SRC
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('No se pudo cargar el script de Culqi'))
      document.body.appendChild(script)
    })
  }
  return scriptPromise
}

interface Props {
  monto: number
  metodo: 'yape' | 'plin'
  cajeroId: string | null
  locationId: string | null
  clienteNombre?: string | null
  onConfirmado: (pagoId: string) => void
  onCancelar: () => void
}

type Estado = 'creando' | 'esperando' | 'verificando' | 'confirmado' | 'expirado' | 'error'

export default function PagoDigitalCulqi({ monto, metodo, cajeroId, locationId, clienteNombre, onConfirmado, onCancelar }: Props) {
  const [estado, setEstado] = useState<Estado>('creando')
  const [mensajeError, setMensajeError] = useState('')
  const [pagoId, setPagoId] = useState<string | null>(null)
  const pollsRef = useRef(0)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const canceladoRef = useRef(false)

  useEffect(() => {
    canceladoRef.current = false
    iniciar()
    return () => {
      canceladoRef.current = true
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const iniciar = async () => {
    setEstado('creando')
    setMensajeError('')
    try {
      const { data, error } = await supabase.functions.invoke('crear-orden-culqi', {
        body: { monto, metodo, cajeroId, locationId, clienteNombre: clienteNombre || undefined },
      })
      if (error || data?.error) {
        setMensajeError(data?.error || error?.message || 'No se pudo generar el cobro digital')
        setEstado('error')
        return
      }
      setPagoId(data.pagoId)
      await cargarScriptCulqi()
      if (canceladoRef.current) return
      montarWidget(data.culqiPublicKey, data.culqiOrderId)
      setEstado('esperando')
      iniciarPolling(data.pagoId)
    } catch (e) {
      setMensajeError(e instanceof Error ? e.message : 'Error inesperado generando el cobro digital')
      setEstado('error')
    }
  }

  const montarWidget = (publicKey: string, culqiOrderId: string) => {
    if (!window.Culqi) return
    window.Culqi.publicKey = publicKey
    window.Culqi.settings({
      title: 'LUKATCELL',
      currency: 'PEN',
      amount: Math.round(monto * 100),
      order: culqiOrderId,
    })
    // "yape" habilita el flujo propio de Yape; "billetera" es el QR interoperable
    // (Plin y otras billeteras). Verificar contra el panel de pruebas de Culqi
    // que "billetera" efectivamente muestra Plin como opción antes de ir a producción.
    window.Culqi.options({
      paymentMethods: {
        tarjeta: false,
        yape: metodo === 'yape',
        billetera: metodo === 'plin',
        bancaMovil: false,
        agente: false,
        cuotealo: false,
      },
    })
    // Este callback NUNCA se usa para confirmar el pago — Culqi.order aquí solo
    // significa "el cliente completó el flujo en el widget", no que el dinero ya
    // llegó. La única confirmación real viene del polling a pagos_digitales,
    // que refleja lo que el webhook de Culqi confirmó del lado del servidor.
    window.culqi = () => {
      window.Culqi?.close()
    }
    window.Culqi.open()
  }

  const iniciarPolling = (id: string) => {
    pollsRef.current = 0
    const tick = async () => {
      if (canceladoRef.current) return
      pollsRef.current++
      const { data } = await supabase.from('pagos_digitales').select('estado').eq('id', id).maybeSingle()
      if (canceladoRef.current) return
      const est = data?.estado as EstadoPagoDigital | undefined
      if (est === 'pagado') { setEstado('confirmado'); onConfirmado(id); return }
      if (est === 'expirado' || est === 'fallido') { setEstado('expirado'); return }
      if (pollsRef.current >= MAX_POLLS) { setEstado('expirado'); return }
      pollTimerRef.current = setTimeout(tick, POLL_MS)
    }
    pollTimerRef.current = setTimeout(tick, POLL_MS)
  }

  const verificarAhora = async () => {
    if (!pagoId) return
    setEstado('verificando')
    const { data } = await supabase.functions.invoke('verificar-pago-culqi', { body: { pagoId } })
    if (data?.estado === 'pagado') { setEstado('confirmado'); onConfirmado(pagoId); return }
    if (data?.estado === 'expirado' || data?.estado === 'fallido') { setEstado('expirado'); return }
    setEstado('esperando')
    iniciarPolling(pagoId)
  }

  return (
    <div className="bg-[#0d1117] rounded-xl border border-[#30363d] p-4 text-center">
      {(estado === 'creando') && (
        <div className="py-6 flex flex-col items-center gap-2">
          <Loader2 size={22} className="animate-spin text-cyan-400" />
          <p className="text-xs text-gray-400">Generando cobro con Culqi...</p>
        </div>
      )}
      {(estado === 'esperando' || estado === 'verificando') && (
        <div className="py-4 flex flex-col items-center gap-2">
          <Loader2 size={22} className="animate-spin text-cyan-400" />
          <p className="text-sm text-white font-semibold">Esperando confirmación real del pago...</p>
          <p className="text-xs text-gray-500">Se completa automáticamente en cuanto Culqi confirme el {metodo === 'yape' ? 'Yape' : 'Plin'}. No marques la venta como pagada antes de esto.</p>
          <div className="flex gap-2 mt-2">
            <button onClick={verificarAhora} disabled={estado === 'verificando'} className="flex items-center gap-1.5 text-xs font-semibold text-cyan-400 bg-cyan-500/10 px-3 py-1.5 rounded-lg">
              <RefreshCw size={13} className={estado === 'verificando' ? 'animate-spin' : ''} /> Verificar ahora
            </button>
            <button onClick={onCancelar} className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 bg-white/5 px-3 py-1.5 rounded-lg">
              <X size={13} /> Cancelar
            </button>
          </div>
        </div>
      )}
      {estado === 'confirmado' && (
        <div className="py-6 flex flex-col items-center gap-2">
          <CheckCircle2 size={22} className="text-green-400" />
          <p className="text-sm text-green-400 font-semibold">Pago confirmado</p>
        </div>
      )}
      {(estado === 'error' || estado === 'expirado') && (
        <div className="py-4 flex flex-col items-center gap-2">
          <AlertTriangle size={20} className="text-orange-400" />
          <p className="text-xs text-orange-400">{estado === 'expirado' ? 'El cobro expiró o no se completó.' : mensajeError}</p>
          <div className="flex gap-2 mt-1">
            <button onClick={iniciar} className="text-xs font-semibold text-cyan-400 bg-cyan-500/10 px-3 py-1.5 rounded-lg">Reintentar</button>
            <button onClick={onCancelar} className="text-xs font-semibold text-gray-400 bg-white/5 px-3 py-1.5 rounded-lg">Usar otro método</button>
          </div>
        </div>
      )}
    </div>
  )
}
