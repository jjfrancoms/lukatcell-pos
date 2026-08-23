import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CalendarDays, Clock3, Pencil, Plus, ShieldCheck, User as UserIcon, Users, Wrench, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import type { Staff, StaffPuesto, StaffRol, StaffTurno, Turno } from '../types'

const DIAS = [
  { id: 1, corto: 'Lun', nombre: 'Lunes' },
  { id: 2, corto: 'Mar', nombre: 'Martes' },
  { id: 3, corto: 'Mié', nombre: 'Miércoles' },
  { id: 4, corto: 'Jue', nombre: 'Jueves' },
  { id: 5, corto: 'Vie', nombre: 'Viernes' },
  { id: 6, corto: 'Sáb', nombre: 'Sábado' },
  { id: 0, corto: 'Dom', nombre: 'Domingo' },
]

const PUESTOS: Array<{ value: StaffPuesto; label: string }> = [
  { value: 'vendedor', label: 'Vendedor' },
  { value: 'tecnico', label: 'Técnico' },
  { value: 'encargado', label: 'Encargado' },
  { value: 'jefa', label: 'Jefa' },
]

interface ConfigPendiente {
  staff_id: string
  nombre: string
  username: string
  puesto: string | null
  dias_programados: number
  falta_login: boolean
  falta_puesto: boolean
  falta_horario: boolean
}

function horaCorta(hora: string) {
  return hora?.slice(0, 5) || '--:--'
}

function puestoLabel(puesto: StaffPuesto | null) {
  return PUESTOS.find((p) => p.value === puesto)?.label || 'Sin puesto'
}

export default function Personal() {
  const { staff: yo } = useAuth()
  const { showToast } = useToast()
  const [lista, setLista] = useState<Staff[]>([])
  const [turnos, setTurnos] = useState<Turno[]>([])
  const [asignaciones, setAsignaciones] = useState<StaffTurno[]>([])
  const [pendientes, setPendientes] = useState<ConfigPendiente[]>([])
  const [loading, setLoading] = useState(true)
  const [nuevoOpen, setNuevoOpen] = useState(false)
  const [editando, setEditando] = useState<Staff | null>(null)

  const cargar = async () => {
    setLoading(true)
    const [
      { data: staffData, error: staffError },
      { data: turnosData, error: turnosError },
      { data: asignacionesData, error: asignacionesError },
      { data: pendientesData, error: pendientesError },
    ] = await Promise.all([
      supabase.from('staff').select('*').order('created_at'),
      supabase.from('turnos').select('*').eq('activo', true).order('hora_inicio'),
      supabase.from('staff_turnos').select('*').eq('activo', true),
      supabase.rpc('personal_configuracion_pendiente'),
    ])

    if (staffError || turnosError || asignacionesError || pendientesError) {
      showToast('No se pudo cargar la configuración del personal', 'error')
    }
    setLista(staffData || [])
    setTurnos(turnosData || [])
    setAsignaciones(asignacionesData || [])
    setPendientes((pendientesData as ConfigPendiente[] | null) || [])
    setLoading(false)
  }

  useEffect(() => { cargar() }, [])

  const toggleActivo = async (s: Staff) => {
    if (s.id === yo?.id) { showToast('No puedes desactivar tu propia cuenta', 'error'); return }
    const { error } = await supabase.from('staff').update({ activo: !s.activo }).eq('id', s.id)
    if (error) { showToast('No se pudo actualizar', 'error'); return }
    setLista((l) => l.map((x) => x.id === s.id ? { ...x, activo: !x.activo } : x))
    showToast(s.activo ? `${s.nombre} desactivado` : `${s.nombre} activado`, 'success')
    await cargar()
  }

  const turnosPorStaff = useMemo(() => {
    const mapa = new Map<string, StaffTurno[]>()
    asignaciones.forEach((a) => mapa.set(a.staff_id, [...(mapa.get(a.staff_id) || []), a]))
    return mapa
  }, [asignaciones])

  return (
    <div className="p-3 md:p-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="font-display font-bold text-xl text-white">Personal y turnos</h1>
          <p className="text-xs text-gray-500 mt-1">Puestos reales, permisos del POS y horario semanal.</p>
        </div>
        <button onClick={() => setNuevoOpen(true)}
          className="flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-bold px-4 py-2.5 rounded-xl hover:shadow-lg hover:shadow-cyan-500/30 transition-all text-sm">
          <Plus size={16} /> Nuevo personal
        </button>
      </div>

      {!loading && pendientes.length > 0 && (
        <div className="mb-4 rounded-2xl border border-orange-500/30 bg-orange-500/10 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="text-orange-400 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-orange-300">Configuración pendiente</p>
              <p className="text-xs text-orange-200/70 mt-1">Completa estos perfiles antes de usarlos para iniciar sesión o registrar jornadas.</p>
              <div className="mt-3 grid gap-2">
                {pendientes.map((p) => (
                  <div key={p.staff_id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl border border-orange-500/20 bg-[#0d1117]/70 px-3 py-2.5">
                    <div>
                      <p className="text-sm font-semibold text-white">{p.nombre} <span className="font-normal text-gray-500">@{p.username}</span></p>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {p.falta_login && <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/20">Sin login</span>}
                        {p.falta_puesto && <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-400 border border-orange-500/20">Sin puesto</span>}
                        {p.falta_horario && <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-300 border border-yellow-500/20">Sin horario</span>}
                      </div>
                    </div>
                    <button onClick={() => {
                      const encontrado = lista.find((s) => s.id === p.staff_id)
                      if (encontrado) setEditando(encontrado)
                    }} className="self-start sm:self-auto px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#21262d] text-gray-300 border border-[#30363d] hover:text-white">
                      Revisar
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-3">
        {loading && <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-8 text-center text-gray-500 text-sm">Cargando...</div>}
        {!loading && lista.map((s) => {
          const asignadas = turnosPorStaff.get(s.id) || []
          return (
            <div key={s.id} className="bg-[#161b22] rounded-2xl border border-[#30363d] p-4">
              <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
                <div className="flex items-start gap-3 min-w-0">
                  <div className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 ${s.puesto === 'tecnico' ? 'bg-violet-500/15' : s.rol === 'administrador' ? 'bg-orange-500/15' : 'bg-cyan-500/15'}`}>
                    {s.puesto === 'tecnico' ? <Wrench size={18} className="text-violet-400" /> : s.rol === 'administrador' ? <ShieldCheck size={18} className="text-orange-400" /> : <UserIcon size={18} className="text-cyan-400" />}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-white text-sm">{s.nombre} {s.id === yo?.id && <span className="text-gray-500 font-normal">(tú)</span>}</p>
                      <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-[#21262d] text-gray-300 border border-[#30363d]">{puestoLabel(s.puesto)}</span>
                      <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border ${s.rol === 'administrador' ? 'bg-orange-500/10 text-orange-400 border-orange-500/20' : 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20'}`}>{s.rol}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">@{s.username}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => setEditando(s)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#21262d] text-gray-300 border border-[#30363d] hover:text-white">
                    <Pencil size={13} /> Editar
                  </button>
                  <button onClick={() => toggleActivo(s)} disabled={s.id === yo?.id}
                    className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all disabled:opacity-40 disabled:cursor-not-allowed ${s.activo ? 'bg-green-500/15 text-green-400 border-green-500/30' : 'bg-gray-500/15 text-gray-400 border-gray-500/30'}`}>
                    {s.activo ? 'Activo' : 'Inactivo'}
                  </button>
                </div>
              </div>

              <div className="mt-4 border-t border-[#30363d] pt-3">
                <div className="flex items-center gap-2 text-xs text-gray-400 mb-2"><CalendarDays size={14} /> Horario semanal</div>
                {asignadas.length === 0 ? (
                  <p className="text-xs text-gray-600">Sin turno asignado.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {DIAS.map((dia) => {
                      const asignacion = asignadas.find((a) => a.dia_semana === dia.id)
                      if (!asignacion) return null
                      const turno = turnos.find((t) => t.id === asignacion.turno_id)
                      return <span key={dia.id} title={dia.nombre} className="inline-flex items-center gap-1.5 bg-[#0d1117] border border-[#30363d] rounded-lg px-2.5 py-1.5 text-xs text-gray-300"><strong className="text-white">{dia.corto}</strong> · {turno?.nombre || 'Turno'} {turno && <span className="text-gray-500">{horaCorta(turno.hora_inicio)}–{horaCorta(turno.hora_fin)}</span>}</span>
                    })}
                  </div>
                )}
              </div>
            </div>
          )
        })}
        {!loading && lista.length === 0 && <div className="bg-[#161b22] rounded-2xl border border-[#30363d] py-16 text-center text-gray-500"><Users size={32} className="mx-auto mb-2 text-gray-600" /><p className="text-sm">Sin personal registrado</p></div>}
      </div>

      {nuevoOpen && <ModalPersonal turnos={turnos} onClose={() => setNuevoOpen(false)} onSaved={() => { setNuevoOpen(false); cargar(); showToast('Personal creado y programado', 'success') }} />}
      {editando && <ModalPersonal staff={editando} turnos={turnos} asignaciones={turnosPorStaff.get(editando.id) || []} onClose={() => setEditando(null)} onSaved={() => { setEditando(null); cargar(); showToast('Personal actualizado', 'success') }} />}
    </div>
  )
}

function ModalPersonal({ staff, turnos, asignaciones = [], onClose, onSaved }: { staff?: Staff; turnos: Turno[]; asignaciones?: StaffTurno[]; onClose: () => void; onSaved: () => void }) {
  const editando = Boolean(staff)
  const [nombre, setNombre] = useState(staff?.nombre || '')
  const [username, setUsername] = useState(staff?.username || '')
  const [correo, setCorreo] = useState('')
  const [password, setPassword] = useState('')
  const [rol, setRol] = useState<StaffRol>(staff?.rol || 'cajero')
  const [puesto, setPuesto] = useState<StaffPuesto>(staff?.puesto || 'vendedor')
  const inicial = Object.fromEntries(asignaciones.map((a) => [a.dia_semana, a.turno_id])) as Record<number, string>
  const [programacion, setProgramacion] = useState<Record<number, string>>(inicial)
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')

  const cambiarDia = (dia: number, turnoId: string) => {
    setProgramacion((prev) => {
      const next = { ...prev }
      if (!turnoId) delete next[dia]
      else next[dia] = turnoId
      return next
    })
  }

  const guardarProgramacion = async (staffId: string) => {
    const { error: deleteError } = await supabase.from('staff_turnos').delete().eq('staff_id', staffId)
    if (deleteError) throw deleteError
    const filas = Object.entries(programacion).map(([dia, turnoId]) => ({ staff_id: staffId, turno_id: turnoId, dia_semana: Number(dia), activo: true }))
    if (filas.length) {
      const { error: insertError } = await supabase.from('staff_turnos').insert(filas)
      if (insertError) throw insertError
    }
  }

  const guardar = async () => {
    setGuardando(true); setError('')
    try {
      if (!editando && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo.trim())) throw new Error('El correo no es válido')
      if (!nombre.trim() || !username.trim()) throw new Error('Completa nombre y usuario')

      let staffId = staff?.id
      if (staff) {
        const { error: updateError } = await supabase.from('staff').update({ nombre: nombre.trim(), username: username.trim(), rol, puesto }).eq('id', staff.id)
        if (updateError) throw updateError
      } else {
        const { data, error: createError } = await supabase.functions.invoke('crear-personal', {
          body: { nombre: nombre.trim(), username: username.trim(), correo: correo.trim(), password, rol, puesto },
        })
        if (createError || data?.error) throw new Error(data?.error || createError?.message || 'No se pudo crear el personal')
        staffId = data?.staff?.id
        if (!staffId) throw new Error('El usuario se creó, pero no se pudo obtener su perfil de personal')
      }

      if (!staffId) throw new Error('No se encontró el personal')
      await guardarProgramacion(staffId)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar')
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end md:items-center justify-center z-50 p-0 md:p-4">
      <div className="bg-[#161b22] rounded-t-2xl md:rounded-2xl w-full max-w-2xl p-5 border border-[#30363d] shadow-2xl relative max-h-[92vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-500 hover:text-white" aria-label="Cerrar"><X size={20} /></button>
        <h3 className="font-display font-bold text-lg text-white mb-1">{editando ? 'Editar personal' : 'Nuevo personal'}</h3>
        <p className="text-xs text-gray-500 mb-5">El puesto describe su función real; el permiso define qué puede hacer dentro del POS.</p>

        <div className="grid md:grid-cols-2 gap-3">
          <Campo label="Nombre"><input autoFocus value={nombre} onChange={(e) => setNombre(e.target.value)} className="input-personal" /></Campo>
          <Campo label="Usuario"><input value={username} onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))} className="input-personal" placeholder="jperez" /></Campo>
          {!editando && <Campo label="Correo"><input type="email" value={correo} onChange={(e) => setCorreo(e.target.value)} className="input-personal" /></Campo>}
          {!editando && <Campo label="Contraseña temporal"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={6} className="input-personal" /></Campo>}
          <Campo label="Puesto en tienda"><select value={puesto} onChange={(e) => setPuesto(e.target.value as StaffPuesto)} className="input-personal">{PUESTOS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></Campo>
          <Campo label="Permiso del sistema"><select value={rol} onChange={(e) => setRol(e.target.value as StaffRol)} className="input-personal"><option value="cajero">Cajero</option><option value="administrador">Administrador</option></select></Campo>
        </div>

        <div className="mt-5 pt-4 border-t border-[#30363d]">
          <div className="flex items-center gap-2 mb-3"><Clock3 size={15} className="text-cyan-400" /><h4 className="text-sm font-bold text-white">Turno semanal</h4></div>
          <div className="grid sm:grid-cols-2 gap-2">
            {DIAS.map((dia) => (
              <div key={dia.id} className="flex items-center gap-3 bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2.5">
                <span className="text-xs font-semibold text-gray-300 w-20">{dia.nombre}</span>
                <select value={programacion[dia.id] || ''} onChange={(e) => cambiarDia(dia.id, e.target.value)} className="flex-1 bg-[#161b22] border border-[#30363d] rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-cyan-500">
                  <option value="">Descanso</option>
                  {turnos.map((t) => <option key={t.id} value={t.id}>{t.nombre} · {horaCorta(t.hora_inicio)}–{horaCorta(t.hora_fin)}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>

        {error && <p className="text-red-400 text-xs bg-red-500/10 rounded-lg p-2 mt-4">{error}</p>}
        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="flex-1 bg-[#21262d] text-gray-300 border border-[#30363d] font-semibold py-3 rounded-xl text-sm">Cancelar</button>
          <button onClick={guardar} disabled={guardando || !nombre.trim() || !username.trim() || (!editando && (!correo.trim() || password.length < 6))} className="flex-1 bg-gradient-to-r from-cyan-500 to-cyan-600 disabled:opacity-40 text-black font-bold py-3 rounded-xl text-sm active:scale-[0.98]">
            {guardando ? 'Guardando...' : editando ? 'Guardar cambios' : 'Crear personal'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="text-xs text-gray-500 font-semibold">{label}</label>{children}</div>
}
