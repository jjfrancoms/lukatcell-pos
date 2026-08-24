import { useEffect, useState } from 'react'
import { CalendarOff, Plus, RefreshCw, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useToast } from '../lib/toast'

interface StaffLite {
  id: string
  nombre: string
  username: string
  puesto: string | null
}

interface Permiso {
  permiso_id: string
  staff_id: string
  nombre: string
  username: string
  tipo: 'permiso' | 'vacaciones' | 'licencia'
  fecha_desde: string
  fecha_hasta: string
  motivo: string
  activo: boolean
  registrado_por_nombre: string | null
}

const tipoLabel = (tipo: Permiso['tipo']) => tipo === 'vacaciones' ? 'Vacaciones' : tipo === 'licencia' ? 'Licencia' : 'Permiso'
const fecha = (v: string) => new Date(`${v}T12:00:00`).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' })

export default function PermisosPersonal() {
  const { showToast } = useToast()
  const ahora = new Date()
  const [mes, setMes] = useState(`${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}`)
  const [staff, setStaff] = useState<StaffLite[]>([])
  const [permisos, setPermisos] = useState<Permiso[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [open, setOpen] = useState(false)

  const cargar = async (manual = false) => {
    manual ? setRefreshing(true) : setLoading(true)
    const [{ data: s, error: se }, { data: p, error: pe }] = await Promise.all([
      supabase.from('staff').select('id,nombre,username,puesto').eq('activo', true).order('nombre'),
      supabase.rpc('permisos_personal_admin', { p_mes: `${mes}-01` }),
    ])
    if (se || pe) showToast('No se pudieron cargar los permisos', 'error')
    setStaff((s as StaffLite[] | null) || [])
    setPermisos((p as Permiso[] | null) || [])
    setLoading(false)
    setRefreshing(false)
  }

  useEffect(() => { cargar() }, [mes])

  const cancelar = async (p: Permiso) => {
    if (!window.confirm(`¿Cancelar ${tipoLabel(p.tipo).toLowerCase()} de ${p.nombre}?`)) return
    const { data, error } = await supabase.rpc('cancelar_permiso_personal', { p_permiso_id: p.permiso_id })
    if (error || !data) { showToast('No se pudo cancelar el periodo', 'error'); return }
    showToast('Periodo cancelado', 'success')
    await cargar(true)
  }

  return <div className="p-3 md:p-5 max-w-6xl mx-auto">
    <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-5">
      <div>
        <div className="flex items-center gap-2"><CalendarOff size={20} className="text-cyan-400" /><h1 className="font-display font-bold text-xl text-white">Permisos y vacaciones</h1></div>
        <p className="text-xs text-gray-500 mt-1">Periodos autorizados que modifican el estado operativo y el cálculo de ausencias.</p>
      </div>
      <div className="flex gap-2"><button onClick={() => cargar(true)} disabled={refreshing} className="inline-flex items-center gap-2 rounded-xl border border-[#30363d] bg-[#161b22] px-3 py-2 text-sm text-gray-300 disabled:opacity-50"><RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} /> Actualizar</button><button onClick={() => setOpen(true)} className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 px-4 py-2 text-sm font-bold text-black"><Plus size={15} /> Nuevo periodo</button></div>
    </div>

    <div className="rounded-2xl border border-[#30363d] bg-[#161b22] p-4 mb-4">
      <label className="text-xs font-semibold text-gray-500">Mes a revisar</label>
      <input type="month" value={mes} onChange={(e) => setMes(e.target.value)} className="mt-1 block w-full md:w-64 rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-cyan-500" />
    </div>

    <div className="rounded-2xl border border-[#30363d] bg-[#161b22] overflow-hidden">
      <div className="px-4 py-3 border-b border-[#30363d]"><h2 className="text-sm font-bold text-white">Periodos registrados</h2><p className="text-[11px] text-gray-500">Los periodos que se cruzan con el mes seleccionado aparecen aquí.</p></div>
      {loading ? <div className="p-10 text-center text-sm text-gray-500">Cargando...</div> : permisos.length === 0 ? <div className="p-10 text-center text-sm text-gray-600">No hay permisos, vacaciones o licencias en este periodo.</div> : <div className="divide-y divide-[#21262d]">
        {permisos.map((p) => <div key={p.permiso_id} className="px-4 py-3 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="min-w-0"><div className="flex items-center flex-wrap gap-2"><p className="text-sm font-semibold text-white">{p.nombre}</p><span className={`text-[10px] font-bold rounded-full border px-2 py-0.5 ${p.activo ? 'bg-cyan-500/10 border-cyan-500/20 text-cyan-300' : 'bg-gray-500/10 border-gray-500/20 text-gray-500'}`}>{tipoLabel(p.tipo)}{p.activo ? '' : ' · cancelado'}</span></div><p className="text-[11px] text-gray-500 mt-0.5">{fecha(p.fecha_desde)} → {fecha(p.fecha_hasta)} · @{p.username}</p><p className="text-xs text-gray-300 mt-1.5">{p.motivo}</p>{p.registrado_por_nombre && <p className="text-[10px] text-gray-600 mt-1">Registrado por {p.registrado_por_nombre}</p>}</div>
          {p.activo && <button onClick={() => cancelar(p)} className="self-start md:self-auto rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-[11px] font-semibold text-red-300 hover:bg-red-500/15">Cancelar periodo</button>}
        </div>)}
      </div>}
    </div>

    {open && <ModalPermiso staff={staff} onClose={() => setOpen(false)} onSaved={async () => { setOpen(false); await cargar(true); showToast('Periodo registrado', 'success') }} />}
  </div>
}

function ModalPermiso({ staff, onClose, onSaved }: { staff: StaffLite[]; onClose: () => void; onSaved: () => void }) {
  const hoy = new Date().toISOString().slice(0, 10)
  const [staffId, setStaffId] = useState(staff[0]?.id || '')
  const [tipo, setTipo] = useState<Permiso['tipo']>('permiso')
  const [desde, setDesde] = useState(hoy)
  const [hasta, setHasta] = useState(hoy)
  const [motivo, setMotivo] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')

  const guardar = async () => {
    setError('')
    if (!staffId || !desde || !hasta || motivo.trim().length < 3) { setError('Completa todos los datos'); return }
    if (hasta < desde) { setError('La fecha final no puede ser anterior a la inicial'); return }
    setGuardando(true)
    const { error: rpcError } = await supabase.rpc('registrar_permiso_personal', { p_staff_id: staffId, p_tipo: tipo, p_fecha_desde: desde, p_fecha_hasta: hasta, p_motivo: motivo.trim() })
    setGuardando(false)
    if (rpcError) { setError(rpcError.message || 'No se pudo registrar el periodo'); return }
    onSaved()
  }

  return <div className="fixed inset-0 z-[70] bg-black/65 backdrop-blur-sm flex items-end md:items-center justify-center p-0 md:p-4"><div className="relative w-full max-w-md rounded-t-2xl md:rounded-2xl border border-[#30363d] bg-[#161b22] p-5 shadow-2xl"><button onClick={onClose} className="absolute right-4 top-4 text-gray-500 hover:text-white" aria-label="Cerrar"><X size={19} /></button><div className="flex items-center gap-3 mb-5"><div className="w-10 h-10 rounded-xl border border-cyan-500/20 bg-cyan-500/10 flex items-center justify-center"><CalendarOff size={18} className="text-cyan-400" /></div><div><h3 className="font-bold text-white">Registrar periodo</h3><p className="text-xs text-gray-500">Permiso, vacaciones o licencia.</p></div></div>
    <label className="text-xs font-semibold text-gray-500">Personal</label><select value={staffId} onChange={(e) => setStaffId(e.target.value)} className="mt-1 w-full rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2.5 text-sm text-white">{staff.map((s) => <option key={s.id} value={s.id}>{s.nombre} · @{s.username}</option>)}</select>
    <label className="block text-xs font-semibold text-gray-500 mt-4">Tipo</label><select value={tipo} onChange={(e) => setTipo(e.target.value as Permiso['tipo'])} className="mt-1 w-full rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2.5 text-sm text-white"><option value="permiso">Permiso</option><option value="vacaciones">Vacaciones</option><option value="licencia">Licencia</option></select>
    <div className="grid grid-cols-2 gap-2 mt-4"><div><label className="text-xs font-semibold text-gray-500">Desde</label><input type="date" value={desde} onChange={(e) => { setDesde(e.target.value); if (hasta < e.target.value) setHasta(e.target.value) }} className="mt-1 w-full rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2.5 text-sm text-white" /></div><div><label className="text-xs font-semibold text-gray-500">Hasta</label><input type="date" value={hasta} min={desde} onChange={(e) => setHasta(e.target.value)} className="mt-1 w-full rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2.5 text-sm text-white" /></div></div>
    <label className="block text-xs font-semibold text-gray-500 mt-4">Motivo / nota</label><textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={3} placeholder="Ej. vacaciones programadas, permiso familiar..." className="mt-1 w-full resize-none rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2.5 text-sm text-white placeholder:text-gray-700" />
    <p className="text-[10px] text-gray-600 mt-2">El sistema impide rangos superpuestos para la misma persona y excluye los días programados del cálculo de ausencias.</p>{error && <p className="mt-3 rounded-lg bg-red-500/10 p-2 text-xs text-red-400">{error}</p>}<div className="flex gap-2 mt-5"><button onClick={onClose} className="flex-1 rounded-xl border border-[#30363d] bg-[#21262d] py-2.5 text-sm font-semibold text-gray-300">Cancelar</button><button onClick={guardar} disabled={guardando || !staffId || motivo.trim().length < 3} className="flex-1 rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 py-2.5 text-sm font-bold text-black disabled:opacity-40">{guardando ? 'Guardando...' : 'Registrar'}</button></div></div></div>
}
