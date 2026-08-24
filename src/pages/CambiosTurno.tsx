import { useEffect, useMemo, useState } from 'react'
import { CalendarClock, Plus, RefreshCw, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useToast } from '../lib/toast'

interface StaffLite {
  id: string
  nombre: string
  username: string
  puesto: string | null
}

interface TurnoLite {
  id: string
  nombre: string
  hora_inicio: string
  hora_fin: string
}

interface CambioTurno {
  excepcion_id: string
  staff_id: string
  nombre: string
  username: string
  fecha: string
  turno_id: string | null
  turno_nombre: string | null
  hora_inicio: string | null
  hora_fin: string | null
  motivo: string
  activo: boolean
  registrado_por_nombre: string | null
}

const fecha = (v: string) => new Date(`${v}T12:00:00`).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' })
const hora = (v: string | null) => v ? v.slice(0, 5) : '--:--'

export default function CambiosTurno() {
  const { showToast } = useToast()
  const hoy = new Date().toISOString().slice(0, 10)
  const [desde, setDesde] = useState(hoy)
  const [hasta, setHasta] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().slice(0, 10) })
  const [staff, setStaff] = useState<StaffLite[]>([])
  const [turnos, setTurnos] = useState<TurnoLite[]>([])
  const [cambios, setCambios] = useState<CambioTurno[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [open, setOpen] = useState(false)

  const cargar = async (manual = false) => {
    manual ? setRefreshing(true) : setLoading(true)
    const [s, t, c] = await Promise.all([
      supabase.from('staff').select('id,nombre,username,puesto').eq('activo', true).order('nombre'),
      supabase.from('turnos').select('id,nombre,hora_inicio,hora_fin').eq('activo', true).order('hora_inicio'),
      supabase.rpc('excepciones_turno_admin', { p_desde: desde, p_hasta: hasta }),
    ])
    if (s.error || t.error || c.error) showToast('No se pudieron cargar los cambios de turno', 'error')
    setStaff((s.data as StaffLite[] | null) || [])
    setTurnos((t.data as TurnoLite[] | null) || [])
    setCambios((c.data as CambioTurno[] | null) || [])
    setLoading(false)
    setRefreshing(false)
  }

  useEffect(() => { cargar() }, [desde, hasta])

  const activos = useMemo(() => cambios.filter((c) => c.activo), [cambios])

  const cancelar = async (c: CambioTurno) => {
    if (!window.confirm(`¿Cancelar el cambio de ${c.nombre} del ${fecha(c.fecha)}?`)) return
    const { data, error } = await supabase.rpc('cancelar_excepcion_turno', { p_excepcion_id: c.excepcion_id })
    if (error || !data) { showToast('No se pudo cancelar el cambio', 'error'); return }
    showToast('Cambio de turno cancelado', 'success')
    await cargar(true)
  }

  return <div className="p-3 md:p-5 max-w-6xl mx-auto">
    <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-5">
      <div>
        <div className="flex items-center gap-2"><CalendarClock size={20} className="text-cyan-400" /><h1 className="font-display font-bold text-xl text-white">Cambios de turno</h1></div>
        <p className="text-xs text-gray-500 mt-1">Excepciones por fecha para coberturas, cambios temporales o descansos extraordinarios, sin alterar el horario semanal.</p>
      </div>
      <div className="flex gap-2"><button onClick={() => cargar(true)} disabled={refreshing} className="inline-flex items-center gap-2 rounded-xl border border-[#30363d] bg-[#161b22] px-3 py-2 text-sm text-gray-300 disabled:opacity-50"><RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} /> Actualizar</button><button onClick={() => setOpen(true)} className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 px-4 py-2 text-sm font-bold text-black"><Plus size={15} /> Nuevo cambio</button></div>
    </div>

    <div className="grid md:grid-cols-2 gap-2 rounded-2xl border border-[#30363d] bg-[#161b22] p-4 mb-4">
      <div><label className="text-xs font-semibold text-gray-500">Desde</label><input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className="mt-1 w-full rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2 text-sm text-white" /></div>
      <div><label className="text-xs font-semibold text-gray-500">Hasta</label><input type="date" value={hasta} min={desde} onChange={(e) => setHasta(e.target.value)} className="mt-1 w-full rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2 text-sm text-white" /></div>
    </div>

    <div className="rounded-2xl border border-[#30363d] bg-[#161b22] overflow-hidden">
      <div className="px-4 py-3 border-b border-[#30363d]"><h2 className="text-sm font-bold text-white">Excepciones registradas</h2><p className="text-[11px] text-gray-500">{activos.length} cambio{activos.length === 1 ? '' : 's'} activo{activos.length === 1 ? '' : 's'} en el rango seleccionado.</p></div>
      {loading ? <div className="p-10 text-center text-sm text-gray-500">Cargando...</div> : cambios.length === 0 ? <div className="p-10 text-center text-sm text-gray-600">No hay cambios de turno registrados en este rango.</div> : <div className="divide-y divide-[#21262d]">
        {cambios.map((c) => <div key={c.excepcion_id} className="px-4 py-3 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold text-white">{c.nombre}</p><span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${c.activo ? 'border-cyan-500/20 bg-cyan-500/10 text-cyan-300' : 'border-gray-500/20 bg-gray-500/10 text-gray-500'}`}>{c.turno_id ? c.turno_nombre : 'Descanso excepcional'}{c.activo ? '' : ' · cancelado'}</span></div><p className="text-[11px] text-gray-500 mt-0.5">{fecha(c.fecha)} · @{c.username}{c.turno_id ? ` · ${hora(c.hora_inicio)}–${hora(c.hora_fin)}` : ''}</p><p className="text-xs text-gray-300 mt-1.5">{c.motivo}</p>{c.registrado_por_nombre && <p className="text-[10px] text-gray-600 mt-1">Registrado por {c.registrado_por_nombre}</p>}</div>
          {c.activo && <button onClick={() => cancelar(c)} className="self-start md:self-auto rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-[11px] font-semibold text-red-300 hover:bg-red-500/15">Cancelar cambio</button>}
        </div>)}
      </div>}
    </div>

    {open && <ModalCambio staff={staff} turnos={turnos} onClose={() => setOpen(false)} onSaved={async () => { setOpen(false); await cargar(true); showToast('Cambio de turno registrado', 'success') }} />}
  </div>
}

function ModalCambio({ staff, turnos, onClose, onSaved }: { staff: StaffLite[]; turnos: TurnoLite[]; onClose: () => void; onSaved: () => void }) {
  const hoy = new Date().toISOString().slice(0, 10)
  const [staffId, setStaffId] = useState(staff[0]?.id || '')
  const [fechaCambio, setFechaCambio] = useState(hoy)
  const [turnoId, setTurnoId] = useState('')
  const [motivo, setMotivo] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')

  const guardar = async () => {
    setError('')
    if (!staffId || !fechaCambio || motivo.trim().length < 3) { setError('Completa personal, fecha y motivo'); return }
    setGuardando(true)
    const { error: rpcError } = await supabase.rpc('registrar_excepcion_turno', { p_staff_id: staffId, p_fecha: fechaCambio, p_turno_id: turnoId || null, p_motivo: motivo.trim() })
    setGuardando(false)
    if (rpcError) { setError(rpcError.message || 'No se pudo registrar el cambio'); return }
    onSaved()
  }

  return <div className="fixed inset-0 z-[70] bg-black/65 backdrop-blur-sm flex items-end md:items-center justify-center p-0 md:p-4"><div className="relative w-full max-w-md rounded-t-2xl md:rounded-2xl border border-[#30363d] bg-[#161b22] p-5 shadow-2xl"><button onClick={onClose} className="absolute right-4 top-4 text-gray-500 hover:text-white" aria-label="Cerrar"><X size={19} /></button><div className="flex items-center gap-3 mb-5"><div className="w-10 h-10 rounded-xl border border-cyan-500/20 bg-cyan-500/10 flex items-center justify-center"><CalendarClock size={18} className="text-cyan-400" /></div><div><h3 className="font-bold text-white">Cambio temporal</h3><p className="text-xs text-gray-500">Solo afecta la fecha seleccionada.</p></div></div>
    <label className="text-xs font-semibold text-gray-500">Personal</label><select value={staffId} onChange={(e) => setStaffId(e.target.value)} className="mt-1 w-full rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2.5 text-sm text-white">{staff.map((s) => <option key={s.id} value={s.id}>{s.nombre} · @{s.username}</option>)}</select>
    <label className="block text-xs font-semibold text-gray-500 mt-4">Fecha</label><input type="date" value={fechaCambio} onChange={(e) => setFechaCambio(e.target.value)} className="mt-1 w-full rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2.5 text-sm text-white" />
    <label className="block text-xs font-semibold text-gray-500 mt-4">Turno para ese día</label><select value={turnoId} onChange={(e) => setTurnoId(e.target.value)} className="mt-1 w-full rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2.5 text-sm text-white"><option value="">Descanso excepcional</option>{turnos.map((t) => <option key={t.id} value={t.id}>{t.nombre} · {hora(t.hora_inicio)}–{hora(t.hora_fin)}</option>)}</select>
    <p className="text-[10px] text-gray-600 mt-1">Seleccionar “Descanso excepcional” anula únicamente el turno de esa fecha. Elegir un turno permite cubrir un día que normalmente era descanso.</p>
    <label className="block text-xs font-semibold text-gray-500 mt-4">Motivo</label><textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={3} placeholder="Ej. cobertura por vacaciones, cambio acordado..." className="mt-1 w-full resize-none rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2.5 text-sm text-white placeholder:text-gray-700" />
    {error && <p className="mt-3 rounded-lg bg-red-500/10 p-2 text-xs text-red-400">{error}</p>}<div className="flex gap-2 mt-5"><button onClick={onClose} className="flex-1 rounded-xl border border-[#30363d] bg-[#21262d] py-2.5 text-sm font-semibold text-gray-300">Cancelar</button><button onClick={guardar} disabled={guardando || !staffId || !fechaCambio || motivo.trim().length < 3} className="flex-1 rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 py-2.5 text-sm font-bold text-black disabled:opacity-40">{guardando ? 'Guardando...' : 'Registrar cambio'}</button></div></div></div>
}
