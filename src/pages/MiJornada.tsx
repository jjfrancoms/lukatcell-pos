import { useEffect, useState } from 'react'
import { Clock3, LogIn, LogOut, RefreshCw, Users } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'

interface PersonalHoy {
  staff_id: string
  nombre: string
  puesto: string | null
  rol: string
  entrada: string | null
  salida: string | null
  estado: string | null
  minutos_tarde: number | null
  turno_nombre: string | null
  hora_inicio: string | null
  hora_fin: string | null
}

const hora = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }) : '—'
const corta = (t: string | null) => t ? t.slice(0, 5) : '—'

export default function MiJornada() {
  const { jornada, jornadaActiva, isAdmin, cashSessionId, registrarEntrada, registrarSalida, refreshJornada } = useAuth()
  const { showToast } = useToast()
  const [procesando, setProcesando] = useState(false)
  const [personal, setPersonal] = useState<PersonalHoy[]>([])

  const cargarPersonal = async () => {
    if (!isAdmin) return
    const { data, error } = await supabase.rpc('personal_activo_hoy')
    if (error) { setPersonal([]); return }
    setPersonal((data || []) as PersonalHoy[])
  }

  useEffect(() => { cargarPersonal() }, [isAdmin, jornada?.entrada, jornada?.salida])

  const entrada = async () => {
    setProcesando(true)
    const error = await registrarEntrada()
    setProcesando(false)
    if (error) return showToast(error, 'error')
    showToast('Entrada registrada', 'success')
    cargarPersonal()
  }

  const salida = async () => {
    if (cashSessionId) return showToast('Cierra tu caja antes de registrar la salida', 'error')
    setProcesando(true)
    const error = await registrarSalida()
    setProcesando(false)
    if (error) return showToast(error, 'error')
    showToast('Salida registrada', 'success')
    cargarPersonal()
  }

  return (
    <div className="p-3 md:p-5 max-w-5xl">
      <div className="flex items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="font-display font-bold text-xl text-white">Mi jornada</h1>
          <p className="text-xs text-gray-500 mt-1">Asistencia y turno operativo de hoy</p>
        </div>
        <button onClick={() => { refreshJornada(); cargarPersonal() }} className="p-2.5 rounded-xl bg-[#161b22] border border-[#30363d] text-gray-400 hover:text-white" aria-label="Actualizar">
          <RefreshCw size={17} />
        </button>
      </div>

      <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-5 mb-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${jornadaActiva ? 'bg-green-500/15' : 'bg-cyan-500/15'}`}>
              <Clock3 size={21} className={jornadaActiva ? 'text-green-400' : 'text-cyan-400'} />
            </div>
            <div>
              <p className="font-semibold text-white">{jornada?.turno_nombre || 'Sin turno asignado'}</p>
              <p className="text-xs text-gray-500">{corta(jornada?.hora_inicio || null)} – {corta(jornada?.hora_fin || null)}</p>
            </div>
          </div>
          {jornada?.estado === 'tarde' && <span className="text-xs font-bold px-3 py-1.5 rounded-full bg-orange-500/15 border border-orange-500/30 text-orange-400">Tardanza: {jornada.minutos_tarde} min</span>}
          {jornadaActiva && <span className="text-xs font-bold px-3 py-1.5 rounded-full bg-green-500/15 border border-green-500/30 text-green-400">Trabajando ahora</span>}
        </div>

        <div className="grid grid-cols-2 gap-3 mt-5">
          <div className="bg-[#0d1117] border border-[#30363d] rounded-xl p-4">
            <p className="text-xs text-gray-500">Entrada</p>
            <p className="text-lg font-bold text-white mt-1">{hora(jornada?.entrada || null)}</p>
          </div>
          <div className="bg-[#0d1117] border border-[#30363d] rounded-xl p-4">
            <p className="text-xs text-gray-500">Salida</p>
            <p className="text-lg font-bold text-white mt-1">{hora(jornada?.salida || null)}</p>
          </div>
        </div>

        <div className="mt-4">
          {!jornada?.entrada && (
            <button onClick={entrada} disabled={procesando} className="inline-flex items-center gap-2 bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-bold px-5 py-3 rounded-xl disabled:opacity-50">
              <LogIn size={17} /> {procesando ? 'Registrando...' : 'Registrar entrada'}
            </button>
          )}
          {jornadaActiva && (
            <button onClick={salida} disabled={procesando || Boolean(cashSessionId)} className="inline-flex items-center gap-2 bg-gradient-to-r from-orange-500 to-orange-600 text-white font-bold px-5 py-3 rounded-xl disabled:opacity-40">
              <LogOut size={17} /> {cashSessionId ? 'Cierra caja para salir' : procesando ? 'Registrando...' : 'Registrar salida'}
            </button>
          )}
          {jornada?.entrada && jornada?.salida && <p className="text-sm text-gray-400">Jornada finalizada por hoy.</p>}
        </div>
      </div>

      {isAdmin && (
        <>
          <div className="flex items-center gap-2 mb-3"><Users size={18} className="text-cyan-400" /><h2 className="font-display font-bold text-white">Personal de hoy</h2></div>
          <div className="bg-[#161b22] border border-[#30363d] rounded-2xl overflow-hidden">
            {personal.map((p) => {
              const trabajando = Boolean(p.entrada && !p.salida)
              return (
                <div key={p.staff_id} className="p-4 border-b border-[#30363d] last:border-b-0 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-sm text-white truncate">{p.nombre}</p>
                    <p className="text-xs text-gray-500 capitalize">{p.puesto || p.rol} · {p.turno_nombre || 'sin turno'} {p.hora_inicio ? `${corta(p.hora_inicio)}–${corta(p.hora_fin)}` : ''}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={`text-xs font-bold ${trabajando ? 'text-green-400' : p.entrada ? 'text-gray-400' : 'text-gray-600'}`}>{trabajando ? 'Trabajando' : p.entrada ? 'Salió' : 'Sin entrada'}</p>
                    <p className="text-[10px] text-gray-500">{p.entrada ? `${hora(p.entrada)} → ${hora(p.salida)}` : '—'}</p>
                  </div>
                </div>
              )
            })}
            {personal.length === 0 && <p className="p-6 text-sm text-gray-500 text-center">Sin personal disponible</p>}
          </div>
        </>
      )}
    </div>
  )
}
