import { useState, useEffect } from 'react'
import { Smartphone, Loader2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'

const PENDING_NOMBRE_KEY = 'lukatcell_pending_admin_nombre'

export default function Login() {
  const { session, staff, signIn, refreshStaff } = useAuth()
  const [hayStaff, setHayStaff] = useState<boolean | null>(null)
  const [modo, setModo] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [nombre, setNombre] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [cargando, setCargando] = useState(false)
  const [bootstrapping, setBootstrapping] = useState(false)

  useEffect(() => {
    supabase.rpc('hay_staff').then(({ data }) => setHayStaff(!!data))
  }, [])

  useEffect(() => {
    if (!session || staff || bootstrapping) return
    const tryBootstrap = async () => {
      const { data: existe } = await supabase.rpc('hay_staff')
      if (existe) return
      setBootstrapping(true)
      const nombrePendiente = localStorage.getItem(PENDING_NOMBRE_KEY) || session.user.email?.split('@')[0] || 'Administrador'
      const { error: rpcError } = await supabase.rpc('crear_primer_admin', { p_nombre: nombrePendiente })
      if (!rpcError) {
        localStorage.removeItem(PENDING_NOMBRE_KEY)
        await refreshStaff()
      }
      setBootstrapping(false)
    }
    tryBootstrap()
  }, [session, staff, bootstrapping, refreshStaff])

  const submitLogin = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setCargando(true)
    const err = await signIn(email, password)
    if (err) setError(err)
    setCargando(false)
  }

  const submitSignup = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setInfo(''); setCargando(true)
    localStorage.setItem(PENDING_NOMBRE_KEY, nombre || 'Administrador')
    const { data, error: signErr } = await supabase.auth.signUp({ email, password })
    if (signErr) { setError(signErr.message); setCargando(false); return }
    if (!data.session) {
      setInfo('Cuenta creada. Revisa tu correo para confirmar el acceso y luego inicia sesión aquí.')
      setModo('login')
    }
    setCargando(false)
  }

  if (session && !staff) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#0d1117]">
        <div className="text-center text-gray-400 flex flex-col items-center gap-3">
          <Loader2 className="animate-spin text-cyan-500" size={28} />
          <p className="text-sm">{bootstrapping ? 'Preparando tu cuenta...' : 'Tu usuario no tiene un perfil de personal asignado. Contacta al administrador.'}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen flex items-center justify-center bg-[#0d1117] p-4">
      <div className="w-full max-w-sm bg-[#161b22] border border-[#30363d] rounded-2xl p-6 shadow-2xl">
        <div className="flex flex-col items-center mb-6">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-cyan-400 to-cyan-600 flex items-center justify-center shadow-lg shadow-cyan-500/20 mb-3">
            <Smartphone size={22} className="text-black" />
          </div>
          <h1 className="font-display font-bold text-white text-lg tracking-wide">LUKATCELL</h1>
          <p className="text-[11px] text-cyan-500 uppercase tracking-widest">Punto de venta</p>
        </div>

        {hayStaff === false && (
          <div className="flex bg-[#0d1117] rounded-lg border border-[#30363d] overflow-hidden mb-5">
            <button onClick={() => setModo('login')} className={`flex-1 py-2 text-xs font-bold ${modo === 'login' ? 'bg-cyan-500 text-black' : 'text-gray-400'}`}>Iniciar sesión</button>
            <button onClick={() => setModo('signup')} className={`flex-1 py-2 text-xs font-bold ${modo === 'signup' ? 'bg-cyan-500 text-black' : 'text-gray-400'}`}>Crear administrador</button>
          </div>
        )}

        {info && <p className="text-cyan-400 text-xs mb-4 bg-cyan-500/10 rounded-lg p-2.5">{info}</p>}

        <form onSubmit={modo === 'login' ? submitLogin : submitSignup} className="space-y-3">
          {modo === 'signup' && (
            <div>
              <label className="text-xs text-gray-500 font-semibold">Tu nombre</label>
              <input value={nombre} onChange={(e) => setNombre(e.target.value)} required
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mt-1 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500" placeholder="Juan Franco" />
            </div>
          )}
          <div>
            <label className="text-xs text-gray-500 font-semibold">Correo</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mt-1 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500" placeholder="tu@correo.com" />
          </div>
          <div>
            <label className="text-xs text-gray-500 font-semibold">Contraseña</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mt-1 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500" placeholder="••••••••" />
          </div>
          {error && <p className="text-red-400 text-xs bg-red-500/10 rounded-lg p-2.5">{error}</p>}
          <button type="submit" disabled={cargando}
            className="w-full bg-gradient-to-r from-cyan-500 to-cyan-600 disabled:opacity-40 text-black font-bold py-3.5 rounded-xl transition-all active:scale-[0.98] mt-1">
            {cargando ? 'Procesando...' : modo === 'login' ? 'Ingresar' : 'Crear cuenta de administrador'}
          </button>
        </form>
      </div>
    </div>
  )
}
