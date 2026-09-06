import { useEffect, useRef, useState } from 'react'
import { Upload, Loader2, ImageOff, QrCode, X, CheckCircle2 } from 'lucide-react'
import QRCode from 'qrcode'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'

const MAX_BYTES = 5 * 1024 * 1024
const QR_TTL_MS = 10 * 60 * 1000

interface Props {
  valor: string
  onChange: (url: string) => void
}

export default function SubirImagenProducto({ valor, onChange }: Props) {
  const { staff } = useAuth()
  const [subiendo, setSubiendo] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const [qrAbierto, setQrAbierto] = useState(false)
  const [qrImagen, setQrImagen] = useState('')
  const [qrEstado, setQrEstado] = useState<'esperando' | 'completado' | 'expirado'>('esperando')
  const sesionIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!qrAbierto || !sesionIdRef.current) return
    const canal = supabase
      .channel(`sesion_subida_${sesionIdRef.current}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sesiones_subida_imagen', filter: `id=eq.${sesionIdRef.current}` }, (payload) => {
        const fila = payload.new as { estado: string; url: string | null }
        if (fila.estado === 'completado' && fila.url) {
          setQrEstado('completado')
          onChange(fila.url)
          setTimeout(() => setQrAbierto(false), 1200)
        }
      })
      .subscribe()

    const vencimiento = setTimeout(() => setQrEstado((e) => e === 'esperando' ? 'expirado' : e), QR_TTL_MS)

    return () => { supabase.removeChannel(canal); clearTimeout(vencimiento) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrAbierto])

  const generarQR = async () => {
    if (!staff?.id) return
    setError('')
    const { data, error: errSesion } = await supabase.from('sesiones_subida_imagen')
      .insert({ creado_por: staff.id }).select('id').single()
    if (errSesion || !data) { setError('No se pudo generar el código QR'); return }
    sesionIdRef.current = data.id
    const url = `${window.location.origin}/subir-foto/${data.id}`
    const dataUrl = await QRCode.toDataURL(url, { width: 220, margin: 1, color: { dark: '#0d1117', light: '#e6edf3' } })
    setQrImagen(dataUrl)
    setQrEstado('esperando')
    setQrAbierto(true)
  }

  const subir = async (file: File) => {
    if (!file.type.startsWith('image/')) { setError('Elige un archivo de imagen'); return }
    if (file.size > MAX_BYTES) { setError('La imagen no debe superar 5 MB'); return }
    setSubiendo(true); setError('')
    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
    const ruta = `${crypto.randomUUID()}.${ext}`
    const { error: errSubida } = await supabase.storage.from('productos').upload(ruta, file)
    if (errSubida) { setSubiendo(false); setError('No se pudo subir la imagen'); return }
    const { data } = supabase.storage.from('productos').getPublicUrl(ruta)
    setSubiendo(false)
    onChange(data.publicUrl)
  }

  return (
    <div>
      <label className="text-xs text-gray-500 font-semibold">Imagen del producto</label>
      <div className="flex items-center gap-3 mt-1">
        <div className="w-16 h-16 rounded-xl bg-[#0d1117] border border-[#30363d] overflow-hidden shrink-0 flex items-center justify-center">
          {valor
            ? <img src={valor} alt="" className="w-full h-full object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
            : <ImageOff size={18} className="text-gray-600" />}
        </div>
        <div className="flex-1 min-w-0 space-y-1.5">
          <input ref={inputRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) subir(f); e.target.value = '' }} />
          <div className="flex gap-1.5">
            <button type="button" onClick={() => inputRef.current?.click()} disabled={subiendo}
              className="flex-1 flex items-center justify-center gap-1.5 bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-xs font-semibold text-gray-300 hover:border-cyan-500/50 disabled:opacity-50 transition-colors">
              {subiendo ? <><Loader2 size={13} className="animate-spin" /> Subiendo...</> : <><Upload size={13} /> Subir imagen</>}
            </button>
            <button type="button" onClick={generarQR} disabled={subiendo || !staff?.id} title="Tomar foto desde el celular"
              className="flex items-center justify-center gap-1.5 bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-xs font-semibold text-gray-300 hover:border-cyan-500/50 disabled:opacity-50 transition-colors">
              <QrCode size={13} />
            </button>
          </div>
          <input value={valor} onChange={(e) => onChange(e.target.value)} placeholder="o pega una URL"
            className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-2.5 py-1.5 text-[11px] text-gray-400 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-cyan-500" />
        </div>
      </div>
      {error && <p className="text-[11px] text-red-400 mt-1">{error}</p>}

      {qrAbierto && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60] p-4" onClick={() => setQrAbierto(false)}>
          <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-6 max-w-xs w-full text-center relative" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setQrAbierto(false)} className="absolute top-3 right-3 text-gray-500 hover:text-white" aria-label="Cerrar"><X size={18} /></button>
            <p className="font-display font-bold text-white mb-1">Escanea con tu celular</p>
            <p className="text-xs text-gray-500 mb-4">Abre la cámara del celular y apunta al código. La foto se aplica sola aquí.</p>
            {qrEstado === 'completado' ? (
              <div className="py-10 flex flex-col items-center gap-2">
                <CheckCircle2 size={40} className="text-green-400" />
                <p className="text-sm text-green-300 font-semibold">Foto recibida</p>
              </div>
            ) : qrEstado === 'expirado' ? (
              <div className="py-6 flex flex-col items-center gap-3">
                <p className="text-sm text-orange-400">El código expiró</p>
                <button onClick={generarQR} className="text-xs font-bold bg-cyan-500 text-black px-4 py-2 rounded-lg">Generar otro</button>
              </div>
            ) : (
              <>
                <img src={qrImagen} alt="Código QR" className="mx-auto rounded-xl border border-[#30363d]" />
                <p className="text-[11px] text-gray-600 mt-3">Esperando la foto...</p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
