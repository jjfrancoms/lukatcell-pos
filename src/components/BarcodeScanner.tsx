import { useEffect, useRef, useState } from 'react'
import { BrowserMultiFormatReader } from '@zxing/browser'
import type { IScannerControls } from '@zxing/browser'
import { X, CameraOff, Keyboard } from 'lucide-react'

interface Props {
  onDetect: (code: string) => void
  onClose: () => void
  titulo?: string
}

export default function BarcodeScanner({ onDetect, onClose, titulo = 'Escanear código de barras' }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const controlsRef = useRef<IScannerControls | null>(null)
  const detectedRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [manual, setManual] = useState('')
  const [mostrarManual, setMostrarManual] = useState(false)

  useEffect(() => {
    let cancelado = false
    const reader = new BrowserMultiFormatReader()

    reader.decodeFromConstraints(
      { audio: false, video: { facingMode: 'environment' } },
      videoRef.current ?? undefined,
      (result) => {
        if (result && !detectedRef.current) {
          detectedRef.current = true
          if (navigator.vibrate) navigator.vibrate(80)
          onDetect(result.getText())
        }
      }
    ).then((controls) => {
      if (cancelado) { controls.stop(); return }
      controlsRef.current = controls
    }).catch((e: unknown) => {
      if (cancelado) return
      const name = e instanceof Error ? e.name : ''
      if (name === 'NotAllowedError') setError('Permiso de cámara denegado. Actívalo en los ajustes del navegador.')
      else if (name === 'NotFoundError' || name === 'OverconstrainedError') setError('No se encontró una cámara disponible en este dispositivo.')
      else if (name === 'NotReadableError') setError('La cámara está siendo usada por otra aplicación.')
      else setError('No se pudo acceder a la cámara. Puedes ingresar el código manualmente.')
      setMostrarManual(true)
    })

    return () => { cancelado = true; controlsRef.current?.stop() }
  }, [])

  const confirmarManual = () => {
    if (manual.trim()) onDetect(manual.trim())
  }

  return (
    <div className="fixed inset-0 bg-black z-[60] flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 bg-black/80 shrink-0" style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
        <h3 className="text-white font-semibold text-sm">{titulo}</h3>
        <button onClick={onClose} className="text-gray-300 hover:text-white" aria-label="Cerrar escáner"><X size={22} /></button>
      </div>

      <div className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden">
        {!error ? (
          <>
            <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" muted playsInline />
            <div className="relative w-[80%] max-w-sm aspect-[3/2] pointer-events-none">
              <div className="absolute inset-0 border-2 border-cyan-400/80 rounded-2xl shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]" />
              <div className="absolute left-3 right-3 top-1/2 h-0.5 bg-cyan-400 shadow-[0_0_8px_2px_rgba(34,211,238,0.7)] animate-pulse" />
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-3 text-center px-6">
            <CameraOff size={40} className="text-red-400" />
            <p className="text-red-300 text-sm max-w-xs">{error}</p>
          </div>
        )}
      </div>

      <div className="p-4 bg-black/80 shrink-0 space-y-3" style={{ paddingBottom: 'max(1rem, calc(env(safe-area-inset-bottom) + 0.5rem))' }}>
        {!error && <p className="text-center text-gray-400 text-xs">Apunta la cámara al código de barras</p>}
        {!mostrarManual ? (
          <button onClick={() => setMostrarManual(true)} className="w-full flex items-center justify-center gap-2 text-gray-400 hover:text-white text-xs font-semibold py-2">
            <Keyboard size={14} /> Ingresar código manualmente
          </button>
        ) : (
          <div className="flex gap-2">
            <input autoFocus value={manual} onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && confirmarManual()}
              placeholder="Código de barras"
              className="flex-1 bg-[#161b22] border border-[#30363d] rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
            <button onClick={confirmarManual} disabled={!manual.trim()}
              className="bg-cyan-500 disabled:opacity-40 text-black font-bold px-4 rounded-xl text-sm">OK</button>
          </div>
        )}
      </div>
    </div>
  )
}
