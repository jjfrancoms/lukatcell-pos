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
const esEstadoPermiso = (estado: string | null | undefined) => ['permiso', 'vacaciones', 'licencia'].includes(estado || '')
const permisoLabel = (estado: string | null | undefined) => estado === 'vacaciones' ? 'Vacaciones' : estado === 'licencia' ? 'Licencia' : 'Permiso'

function estadoPersonal(p: PersonalHoy) {
  if (p.estado === 'descanso') return { label: 'Descanso', clase: 'text-violet-400', detalle: 'Día libre' }
  if (p.estado === 'permiso') return { label: 'Permiso', clase: 'text-cyan-400', detalle: 'Ausencia autorizada' }
  if (p.estado === 'vacaciones') return { label: 'Vacaciones', clase: 'text-cyan-400', detalle: 'Periodo de vacaciones' }
  if (p.estado === 'licencia') return { label: 'Licencia', clase: 'text-cyan-400', detalle: 'Licencia registrada' }
  if (p.estado === 'pendiente') return { label: 'Pendiente', clase: 'text-amber-400', detalle: 'Aún no marca entrada' }
  if (p.estado === 'tarde' && p.entrada && !p.salida) return { label: `Trabajando · tarde ${p.minutos_tarde || 0} min`, clase: 'text-orange-400', detalle: `${hora(p.entrada)} → —` }
  if ((p.estado === 'presente' || p.estado === 'tarde') && p.entrada && !p.salida) return { label: 'Trabajando', clase: 'text-green-400', detalle: `${hora(p.entrada)} → —` }
  if (p.estado === 'salio' || (p.entrada && p.salida)) return { label: 'Salió', clase: 'text-gray-400', detalle: `${hora(p.entrada)} → ${hora(p.salida)}` }
  return { label: 'Sin entrada', clase: 'text-gray-600', detalle: '—' }
}

export default function MiJornada() {
  const { staff, jornada, jornadaActiva, isAdmin, cashSessionId, registrarEntrada, registrarSalida, refreshJornada } = useAuth()
  const { showToast } = useToast()
  const [procesando, setProcesando] = useState(false)
  const [personal, setPersonal] = useState<PersonalHoy[]>([])
  const esDescanso = Boolean(staff && !isAdmin && !jornada?.turno_id && !jornada?.entrada)
  const esPermiso = Boolean(!isAdmin && esEstadoPermiso(jornada?.estado) && !jornada?.entrada)

  const cargarPersonal = async () => {
    if (!isAdmin) return
    const { data, error } = await supabase.rpc('personal_activo_hoy')
    if (error) { setPersonal([]); return }
    setPersonal((data || []) as PersonalHoy[])
  }

  useEffect(() => { cargarPersonal() }, [isAdmin, jornada?.entrada, jornada?.salida, jornada?.estado])

  const entrada = async () => {
    if (esDescanso) return showToast('Hoy es tu día de descanso', 'error')
    if (esPermiso) return showToast(`Tienes ${permisoLabel(jornada?.estado).toLowerCase()} registrado para esta jornada`, 'error')
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

  const estadoEspecial = esPermiso ? permisoLabel(jornada?.estado) : esDescanso ? 'Día de descanso' : null

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
            <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${jornadaActiva ? 'bg-green-500/15' : (esDescanso || esPermiso) ? 'bg-violet-500/15' : 'bg-cyan-500/15'}`}>
              <Clock3 size={21} className={jornadaActiva ? 'text-green-400' : (esDescanso || esPermiso) ? 'text-violet-400' : 'text-cyan-400'} />
            </div>
            <div>
              <p className="font-semibold text-white">{estadoEspecial || jornada?.turno_nombre || 'Sin turno asignado'}</p>
              <p className="text-xs text-gray-500">{esDescanso ? 'No tienes jornada programada hoy' : esPermiso ? `No debes marcar asistencia durante ${permisoLabel(jornada?.estado).toLowerCase()}` : `${corta(jornada?.hora_inicio || null)} – ${corta(jornada?.hora_fin || null)}`}</p>
            </div>
          </div>
          {jornada?.estado === 'tarde' && <span className="text-xs font-bold px-3 py-1.5 rounded-full bg-orange-500/15 border border-orange-500/30 text-orange-400">Tardanza: {jornada.minutos_tarde} min</span>}
          {jornadaActiva && <span className="text-xs font-bold px-3 py-1.5 rounded-full bg-green-500/15 border border-green-500/30 text-green-400">Trabajando ahora</span>}
          {esDescanso && <span className="text-xs font-bold px-3 py-1.5 rounded-full bg-violet-500/15 border border-violet-500/30 text-violet-400">Descanso</span>}
          {esPermiso && <span className="text-xs font-bold px-3 py-1.5 rounded-full bg-cyan-500/15 border border-cyan-500/30 text-cyan-400">{permisoLabel(jornada?.estado)}</span>}
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
          {!jornada?.entrada && !esDescanso && !esPermiso && (
            <button onClick={entrada} disabled={procesando} className="inline-flex items-center gap-2 bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-bold px-5 py-3 rounded-xl disabled:opacity-50">
              <LogIn size={17} /> {procesando ? 'Registrando...' : 'Registrar entrada'}
            </button>
          )}
          {esDescanso && <p className="text-sm text-violet-300">Hoy no necesitas registrar entrada ni salida.</p>}
          {esPermiso && <p className="text-sm text-cyan-300">Tu {permisoLabel(jornada?.estado).toLowerCase()} está registrado. No necesitas marcar entrada ni salida.</p>}
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
              const estado = estadoPersonal(p)
              return (
                <div key={p.staff_id} className="p-4 border-b border-[#30363d] last:border-b-0 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-sm text-white truncate">{p.nombre}</p>
                    <p className="text-xs text-gray-500 capitalize">
                      {p.puesto || p.rol} · {p.turno_nombre ? `${p.turno_nombre} ${corta(p.hora_inicio)}–${corta(p.hora_fin)}` : 'descanso'}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={`text-xs font-bold ${estado.clase}`}>{estado.label}</p>
                    <p className="text-[10px] text-gray-500">{estado.detalle}</p>
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
