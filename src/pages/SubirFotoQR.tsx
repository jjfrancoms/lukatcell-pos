import { useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Camera, RotateCcw, Check, X, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

type Estado = 'capturando' | 'previsualizando' | 'subiendo' | 'completado' | 'error'

export default function SubirFotoQR() {
  const { id } = useParams<{ id: string }>()
  const [estado, setEstado] = useState<Estado>('capturando')
  const [archivo, setArchivo] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const onArchivoElegido = (file: File | undefined) => {
    if (!file) return
    setArchivo(file)
    setPreviewUrl(URL.createObjectURL(file))
    setEstado('previsualizando')
  }

  const reintentar = () => {
    setArchivo(null)
    setPreviewUrl('')
    setEstado('capturando')
    inputRef.current?.click()
  }

  const confirmar = async () => {
    if (!archivo || !id) return
    setEstado('subiendo'); setError('')
    try {
      const form = new FormData()
      form.append('session_id', id)
      form.append('file', archivo)
      const res = await fetch(`${SUPABASE_URL}/functions/v1/subir-foto-qr`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}`, apikey: SUPABASE_ANON_KEY },
        body: form,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'No se pudo subir la foto')
      setEstado('completado')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo subir la foto')
      setEstado('error')
    }
  }

  return (
    <div className="min-h-screen bg-[#0d1117] flex flex-col items-center justify-center p-5 text-center">
      <input ref={inputRef} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={(e) => onArchivoElegido(e.target.files?.[0])} />

      {estado === 'capturando' && (
        <>
          <div className="w-16 h-16 rounded-2xl bg-cyan-500/15 flex items-center justify-center mb-4">
            <Camera size={28} className="text-cyan-400" />
          </div>
          <h1 className="font-display font-bold text-lg text-white mb-1">Foto del producto</h1>
          <p className="text-sm text-gray-500 mb-6 max-w-xs">Toma una foto con la cámara de tu celular. Se sube directo al POS.</p>
          <button onClick={() => inputRef.current?.click()}
            className="flex items-center gap-2 bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-bold px-6 py-3.5 rounded-xl">
            <Camera size={18} /> Abrir cámara
          </button>
        </>
      )}

      {estado === 'previsualizando' && (
        <div className="w-full max-w-sm">
          <div className="rounded-2xl overflow-hidden border border-[#30363d] mb-4 bg-[#161b22]">
            <img src={previewUrl} alt="Vista previa" className="w-full max-h-[60vh] object-contain" />
          </div>
          <div className="flex gap-2">
            <button onClick={reintentar} className="flex-1 flex items-center justify-center gap-1.5 bg-[#21262d] border border-[#30363d] text-gray-300 font-semibold py-3 rounded-xl text-sm">
              <RotateCcw size={15} /> Reintentar
            </button>
            <button onClick={confirmar} className="flex-1 flex items-center justify-center gap-1.5 bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-bold py-3 rounded-xl text-sm">
              <Check size={15} /> Confirmar
            </button>
          </div>
          <button onClick={() => { setArchivo(null); setPreviewUrl(''); setEstado('capturando') }} className="mt-3 flex items-center gap-1.5 mx-auto text-xs text-gray-500">
            <X size={13} /> Cancelar
          </button>
        </div>
      )}

      {estado === 'subiendo' && (
        <>
          <Loader2 size={32} className="text-cyan-400 animate-spin mb-4" />
          <p className="text-sm text-gray-400">Subiendo foto...</p>
        </>
      )}

      {estado === 'completado' && (
        <>
          <div className="w-16 h-16 rounded-2xl bg-green-500/15 flex items-center justify-center mb-4">
            <CheckCircle2 size={28} className="text-green-400" />
          </div>
          <h1 className="font-display font-bold text-lg text-white mb-1">¡Listo!</h1>
          <p className="text-sm text-gray-500">La foto ya se aplicó en la computadora. Puedes cerrar esta página.</p>
        </>
      )}

      {estado === 'error' && (
        <>
          <div className="w-16 h-16 rounded-2xl bg-red-500/15 flex items-center justify-center mb-4">
            <AlertTriangle size={28} className="text-red-400" />
          </div>
          <h1 className="font-display font-bold text-lg text-white mb-1">No se pudo subir</h1>
          <p className="text-sm text-gray-500 mb-6 max-w-xs">{error}</p>
          <button onClick={() => setEstado('previsualizando')} disabled={!archivo}
            className="flex items-center gap-2 bg-[#21262d] border border-[#30363d] text-gray-300 font-semibold px-5 py-3 rounded-xl disabled:opacity-40">
            Volver a intentar
          </button>
        </>
      )}
    </div>
  )
}
