import { useState, useEffect } from 'react'
import { Plus, X, Users, ShieldCheck, User as UserIcon } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import type { Staff } from '../types'

export default function Personal() {
  const { staff: yo } = useAuth()
  const { showToast } = useToast()
  const [lista, setLista] = useState<Staff[]>([])
  const [loading, setLoading] = useState(true)
  const [nuevoOpen, setNuevoOpen] = useState(false)

  const cargar = async () => {
    const { data } = await supabase.from('staff').select('*').order('created_at')
    setLista(data || [])
    setLoading(false)
  }
  useEffect(() => { cargar() }, [])

  const toggleActivo = async (s: Staff) => {
    if (s.id === yo?.id) { showToast('No puedes desactivar tu propia cuenta', 'error'); return }
    const { error } = await supabase.from('staff').update({ activo: !s.activo }).eq('id', s.id)
    if (error) { showToast('No se pudo actualizar', 'error'); return }
    setLista((l) => l.map((x) => x.id === s.id ? { ...x, activo: !x.activo } : x))
    showToast(s.activo ? `${s.nombre} desactivado` : `${s.nombre} activado`, 'success')
  }

  return (
    <div className="p-3 md:p-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <h1 className="font-display font-bold text-xl text-white">Personal</h1>
        <button onClick={() => setNuevoOpen(true)}
          className="flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-bold px-4 py-2.5 rounded-xl hover:shadow-lg hover:shadow-cyan-500/30 transition-all text-sm">
          <Plus size={16} /> Nuevo personal
        </button>
      </div>

      <div className="bg-[#161b22] rounded-2xl border border-[#30363d] divide-y divide-[#30363d]">
        {loading && <p className="p-8 text-center text-gray-500 text-sm">Cargando...</p>}
        {!loading && lista.map((s) => (
          <div key={s.id} className="p-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${s.rol === 'administrador' ? 'bg-orange-500/15' : 'bg-cyan-500/15'}`}>
                {s.rol === 'administrador' ? <ShieldCheck size={18} className="text-orange-400" /> : <UserIcon size={18} className="text-cyan-400" />}
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-white text-sm truncate">{s.nombre} {s.id === yo?.id && <span className="text-gray-500 font-normal">(tú)</span>}</p>
                <p className="text-xs text-gray-500">@{s.username} · <span className="capitalize">{s.rol}</span></p>
              </div>
            </div>
            <button onClick={() => toggleActivo(s)} disabled={s.id === yo?.id}
              aria-label={s.activo ? `Desactivar a ${s.nombre}` : `Activar a ${s.nombre}`}
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-bold border transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                s.activo ? 'bg-green-500/15 text-green-400 border-green-500/30 hover:bg-red-500/15 hover:text-red-400 hover:border-red-500/30' : 'bg-gray-500/15 text-gray-400 border-gray-500/30 hover:bg-green-500/15 hover:text-green-400'}`}>
              {s.activo ? 'Activo' : 'Inactivo'}
            </button>
          </div>
        ))}
        {!loading && lista.length === 0 && (
          <div className="py-16 text-center text-gray-500">
            <Users size={32} className="mx-auto mb-2 text-gray-600" />
            <p className="text-sm">Sin personal registrado</p>
          </div>
        )}
      </div>

      {nuevoOpen && <ModalNuevoPersonal onClose={() => setNuevoOpen(false)} onCreated={() => { setNuevoOpen(false); cargar(); showToast('Personal creado correctamente', 'success') }} />}
    </div>
  )
}

function ModalNuevoPersonal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [nombre, setNombre] = useState('')
  const [username, setUsername] = useState('')
  const [correo, setCorreo] = useState('')
  const [password, setPassword] = useState('')
  const [rol, setRol] = useState<'cajero' | 'administrador'>('cajero')
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')

  const guardar = async () => {
    setGuardando(true); setError('')
    const { data, error: err } = await supabase.functions.invoke('crear-personal', {
      body: { nombre: nombre.trim(), username: username.trim(), correo: correo.trim(), password, rol },
    })
    setGuardando(false)
    if (err || data?.error) { setError(data?.error || err?.message || 'No se pudo crear el personal'); return }
    onCreated()
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end md:items-center justify-center z-50 p-0 md:p-4">
      <div className="bg-[#161b22] rounded-t-2xl md:rounded-2xl w-full max-w-sm p-5 border border-[#30363d] shadow-2xl relative max-h-[90vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-500 hover:text-white" aria-label="Cerrar"><X size={20} /></button>
        <h3 className="font-display font-bold text-lg text-white mb-4">Nuevo personal</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500 font-semibold">Nombre</label>
            <input autoFocus value={nombre} onChange={(e) => setNombre(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
          <div>
            <label className="text-xs text-gray-500 font-semibold">Usuario (para iniciar sesión)</label>
            <input value={username} onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" placeholder="jperez" />
          </div>
          <div>
            <label className="text-xs text-gray-500 font-semibold">Correo (solo para recuperar acceso)</label>
            <input type="email" value={correo} onChange={(e) => setCorreo(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
          <div>
            <label className="text-xs text-gray-500 font-semibold">Contraseña temporal</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={6}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
          <div>
            <label className="text-xs text-gray-500 font-semibold">Rol</label>
            <div className="flex gap-2 mt-1">
              <button type="button" onClick={() => setRol('cajero')}
                className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${rol === 'cajero' ? 'bg-cyan-500 text-black' : 'bg-[#21262d] text-gray-400 border border-[#30363d]'}`}>Cajero</button>
              <button type="button" onClick={() => setRol('administrador')}
                className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${rol === 'administrador' ? 'bg-orange-500 text-black' : 'bg-[#21262d] text-gray-400 border border-[#30363d]'}`}>Administrador</button>
            </div>
          </div>
          {error && <p className="text-red-400 text-xs bg-red-500/10 rounded-lg p-2">{error}</p>}
          <button onClick={guardar} disabled={guardando || !nombre.trim() || !username.trim() || !correo.trim() || password.length < 6}
            className="w-full bg-gradient-to-r from-cyan-500 to-cyan-600 disabled:opacity-40 text-black font-bold py-3 rounded-xl transition-all active:scale-[0.98] mt-1">
            {guardando ? 'Creando...' : 'Crear personal'}
          </button>
        </div>
      </div>
    </div>
  )
}
