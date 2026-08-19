import { useRef, useState } from 'react'
import { Upload, Loader2, ImageOff } from 'lucide-react'
import { supabase } from '../lib/supabase'

const MAX_BYTES = 5 * 1024 * 1024

interface Props {
  valor: string
  onChange: (url: string) => void
}

export default function SubirImagenProducto({ valor, onChange }: Props) {
  const [subiendo, setSubiendo] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

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
          <button type="button" onClick={() => inputRef.current?.click()} disabled={subiendo}
            className="w-full flex items-center justify-center gap-1.5 bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-xs font-semibold text-gray-300 hover:border-cyan-500/50 disabled:opacity-50 transition-colors">
            {subiendo ? <><Loader2 size={13} className="animate-spin" /> Subiendo...</> : <><Upload size={13} /> Subir imagen</>}
          </button>
          <input value={valor} onChange={(e) => onChange(e.target.value)} placeholder="o pega una URL"
            className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-2.5 py-1.5 text-[11px] text-gray-400 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-cyan-500" />
        </div>
      </div>
      {error && <p className="text-[11px] text-red-400 mt-1">{error}</p>}
    </div>
  )
}
