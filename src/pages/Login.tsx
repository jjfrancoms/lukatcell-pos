import { useState, useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { Smartphone, Loader2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'

const PENDING_KEY = 'lukatcell_pending_admin'

export default function Login() {
  const { session, staff, signIn, refreshStaff } = useAuth()
  const [hayStaff, setHayStaff] = useState<boolean | null>(null)
  const [modo, setModo] = useState<'login' | 'signup'>('login')
  const [username, setUsername] = useState('')
  const [correo, setCorreo] = useState('')
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
      const pendiente = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null')
      const nombrePendiente = pendiente?.nombre || 'Administrador'
      const usernamePendiente = pendiente?.username || session.user.email?.split('@')[0] || 'admin'
      const { error: rpcError } = await supabase.rpc('crear_primer_admin', { p_nombre: nombrePendiente, p_username: usernamePendiente })
      if (!rpcError) {
        localStorage.removeItem(PENDING_KEY)
        await refreshStaff()
      }
      setBootstrapping(false)
    }
    tryBootstrap()
  }, [session, staff, bootstrapping, refreshStaff])

  const submitLogin = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setCargando(true)
    const { data: email } = await supabase.rpc('email_por_username', { p_username: username.trim() })
    if (!email) { setError('Usuario o contraseña incorrectos'); setCargando(false); return }
    const err = await signIn(email, password)
    if (err) setError('Usuario o contraseña incorrectos')
    setCargando(false)
  }

  const submitSignup = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setInfo(''); setCargando(true)
    localStorage.setItem(PENDING_KEY, JSON.stringify({ nombre: nombre || 'Administrador', username: username.trim() }))
    const { data, error: signErr } = await supabase.auth.signUp({ email: correo, password })
    if (signErr) { setError(signErr.message); setCargando(false); return }
    if (!data.session) {
      setInfo('Cuenta creada. Revisa tu correo para confirmar el acceso y luego inicia sesión aquí con tu usuario.')
      setModo('login')
    }
    setCargando(false)
  }

  if (session && staff) return <Navigate to="/" replace />

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
    <div className="min-h-screen flex items-center justify-center bg-[#0d1117] p-4 py-8 overflow-y-auto overflow-x-hidden">
      <div className="w-full max-w-sm bg-[#161b22] border border-[#30363d] rounded-2xl p-6 shadow-2xl my-auto">
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

        {modo === 'login' ? (
          <form onSubmit={submitLogin} className="space-y-3">
            <div>
              <label className="text-xs text-gray-500 font-semibold">Usuario</label>
              <input value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mt-1 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500" placeholder="admin" />
            </div>
            <div>
              <label className="text-xs text-gray-500 font-semibold">Contraseña</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6}
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mt-1 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500" placeholder="••••••••" />
            </div>
            {error && <p className="text-red-400 text-xs bg-red-500/10 rounded-lg p-2.5">{error}</p>}
            <button type="submit" disabled={cargando}
              className="w-full bg-gradient-to-r from-cyan-500 to-cyan-600 disabled:opacity-40 text-black font-bold py-3.5 rounded-xl transition-all active:scale-[0.98] mt-1">
              {cargando ? 'Procesando...' : 'Ingresar'}
            </button>
          </form>
        ) : (
          <form onSubmit={submitSignup} className="space-y-3">
            <div>
              <label className="text-xs text-gray-500 font-semibold">Tu nombre</label>
              <input value={nombre} onChange={(e) => setNombre(e.target.value)} required
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mt-1 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500" placeholder="Juan Franco" />
            </div>
            <div>
              <label className="text-xs text-gray-500 font-semibold">Usuario (con el que vas a iniciar sesión)</label>
              <input value={username} onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))} required
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mt-1 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500" placeholder="admin" />
            </div>
            <div>
              <label className="text-xs text-gray-500 font-semibold">Correo (solo para recuperar acceso, no se usa para iniciar sesión)</label>
              <input type="email" value={correo} onChange={(e) => setCorreo(e.target.value)} required
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
              {cargando ? 'Procesando...' : 'Crear cuenta de administrador'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
