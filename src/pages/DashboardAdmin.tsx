import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Boxes, CalendarDays, CheckCircle2, Clock3, FileCheck2, RefreshCw, ShoppingCart, Trash2, UserCheck, Users, Wallet, Wrench, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useToast } from '../lib/toast'

interface DashboardData {
  fecha: string
  ventas_total: number
  ventas_cantidad: number
  cajas_abiertas: number
  stock_critico: number
  ordenes_pendientes: number
  ordenes_listas: number
  personal_total: number
  personal_descanso: number
  personal_pendiente: number
  personal_trabajando: number
  personal_tarde: number
  personal_salieron: number
  config_incompleta: number
}

interface PersonalHoy {
  staff_id: string
  nombre: string
  puesto: string | null
  rol: string
  entrada: string | null
  salida: string | null
  estado: string
  minutos_tarde: number
  turno_nombre: string | null
  hora_inicio: string | null
  hora_fin: string | null
}

interface AsistenciaMes {
  staff_id: string
  nombre: string
  username: string
  puesto: string | null
  dias_programados_mes: number
  dias_programados_hasta_hoy: number
  dias_con_entrada: number
  tardanzas: number
  minutos_tarde: number
  ausencias: number
  justificados: number
  horas_programadas_mes: number
  horas_programadas_hasta_hoy: number
  horas_trabajadas: number
  jornadas_incompletas: number
}

interface Justificacion {
  asistencia_id: string
  staff_id: string
  nombre: string
  username: string
  fecha: string
  turno_nombre: string | null
  observacion: string | null
  registrado_por_nombre: string | null
}

function soles(valor: number) {
  return new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' }).format(Number(valor || 0))
}

function hora(valor: string | null) {
  if (!valor) return '--:--'
  if (/^\d{2}:\d{2}/.test(valor)) return valor.slice(0, 5)
  return new Date(valor).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })
}

function fechaCorta(valor: string) {
  return new Date(`${valor}T12:00:00`).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' })
}

function estadoPersonal(p: PersonalHoy) {
  if (p.estado === 'descanso') return { label: 'Descanso', cls: 'text-violet-300 bg-violet-500/10 border-violet-500/20' }
  if (p.estado === 'pendiente') return { label: 'Pendiente', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/20' }
  if (p.estado === 'tarde') return { label: `Tarde · ${p.minutos_tarde} min`, cls: 'text-orange-300 bg-orange-500/10 border-orange-500/20' }
  if (p.estado === 'presente') return { label: 'Trabajando', cls: 'text-green-300 bg-green-500/10 border-green-500/20' }
  if (p.estado === 'salio') return { label: 'Salió', cls: 'text-gray-300 bg-gray-500/10 border-gray-500/20' }
  return { label: p.estado || 'Sin estado', cls: 'text-gray-300 bg-gray-500/10 border-gray-500/20' }
}

export default function DashboardAdmin() {
  const { showToast } = useToast()
  const ahora = new Date()
  const [mes, setMes] = useState(`${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}`)
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [personal, setPersonal] = useState<PersonalHoy[]>([])
  const [asistencia, setAsistencia] = useState<AsistenciaMes[]>([])
  const [justificaciones, setJustificaciones] = useState<Justificacion[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [justificarOpen, setJustificarOpen] = useState(false)

  const cargar = async (manual = false) => {
    manual ? setRefreshing(true) : setLoading(true)
    const mesFecha = `${mes}-01`
    const [d, p, a, j] = await Promise.all([
      supabase.rpc('dashboard_operativo_admin'),
      supabase.rpc('personal_activo_hoy'),
      supabase.rpc('asistencia_mensual_admin', { p_mes: mesFecha }),
      supabase.rpc('justificaciones_asistencia_admin', { p_mes: mesFecha }),
    ])

    if (d.error || p.error || a.error || j.error) {
      showToast('No se pudo cargar el dashboard operativo', 'error')
    }
    setDashboard((d.data as DashboardData | null) || null)
    setPersonal((p.data as PersonalHoy[] | null) || [])
    setAsistencia((a.data as AsistenciaMes[] | null) || [])
    setJustificaciones((j.data as Justificacion[] | null) || [])
    setLoading(false)
    setRefreshing(false)
  }

  useEffect(() => { cargar() }, [mes])

  const quitarJustificacion = async (item: Justificacion) => {
    if (!window.confirm(`¿Retirar la justificación de ${item.nombre} del ${fechaCorta(item.fecha)}?`)) return
    const { data, error } = await supabase.rpc('quitar_justificacion_asistencia', { p_asistencia_id: item.asistencia_id })
    if (error || !data) { showToast('No se pudo retirar la justificación', 'error'); return }
    showToast('Justificación retirada', 'success')
    await cargar(true)
  }

  const resumenAsistencia = useMemo(() => asistencia.reduce((acc, r) => ({
    tardanzas: acc.tardanzas + Number(r.tardanzas || 0),
    minutos: acc.minutos + Number(r.minutos_tarde || 0),
    ausencias: acc.ausencias + Number(r.ausencias || 0),
    justificados: acc.justificados + Number(r.justificados || 0),
    horasProgramadas: acc.horasProgramadas + Number(r.horas_programadas_hasta_hoy || 0),
    horas: acc.horas + Number(r.horas_trabajadas || 0),
    incompletas: acc.incompletas + Number(r.jornadas_incompletas || 0),
  }), { tardanzas: 0, minutos: 0, ausencias: 0, justificados: 0, horasProgramadas: 0, horas: 0, incompletas: 0 }), [asistencia])

  const cards = dashboard ? [
    { label: 'Ventas de hoy', value: soles(dashboard.ventas_total), sub: `${dashboard.ventas_cantidad} venta${dashboard.ventas_cantidad === 1 ? '' : 's'}`, icon: ShoppingCart },
    { label: 'Cajas abiertas', value: String(dashboard.cajas_abiertas), sub: dashboard.cajas_abiertas ? 'Requieren cierre al terminar' : 'Sin cajas abiertas', icon: Wallet },
    { label: 'Personal trabajando', value: String(dashboard.personal_trabajando), sub: `${dashboard.personal_pendiente} pendiente · ${dashboard.personal_descanso} descanso`, icon: UserCheck },
    { label: 'Llegadas tarde', value: String(dashboard.personal_tarde), sub: 'Personal de hoy', icon: Clock3 },
    { label: 'Órdenes pendientes', value: String(dashboard.ordenes_pendientes), sub: `${dashboard.ordenes_listas} lista${dashboard.ordenes_listas === 1 ? '' : 's'} para entregar`, icon: Wrench },
    { label: 'Stock crítico', value: String(dashboard.stock_critico), sub: 'Variantes en mínimo o menos', icon: Boxes },
  ] : []

  return (
    <div className="p-3 md:p-5 max-w-[1500px] mx-auto">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-5">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-display font-bold text-xl text-white">Dashboard operativo</h1>
            <span className="text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-full bg-orange-500/10 text-orange-300 border border-orange-500/20">Administración</span>
          </div>
          <p className="text-xs text-gray-500 mt-1">Estado de tienda, personal, caja, ventas, órdenes e inventario.</p>
        </div>
        <button onClick={() => cargar(true)} disabled={refreshing} className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-[#161b22] border border-[#30363d] text-sm text-gray-300 hover:text-white disabled:opacity-50">
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} /> Actualizar
        </button>
      </div>

      {dashboard?.config_incompleta ? (
        <div className="mb-4 rounded-xl border border-orange-500/30 bg-orange-500/10 px-4 py-3 flex items-start gap-3">
          <AlertTriangle size={18} className="text-orange-400 mt-0.5" />
          <div><p className="text-sm font-bold text-orange-300">{dashboard.config_incompleta} perfil{dashboard.config_incompleta === 1 ? '' : 'es'} con configuración pendiente</p><p className="text-xs text-orange-200/60 mt-0.5">Revisa Personal para completar acceso, puesto u horario.</p></div>
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-2xl border border-[#30363d] bg-[#161b22] p-10 text-center text-sm text-gray-500">Cargando dashboard...</div>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3 mb-5">
            {cards.map(({ label, value, sub, icon: Icon }) => (
              <div key={label} className="rounded-2xl border border-[#30363d] bg-[#161b22] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div><p className="text-xs text-gray-500">{label}</p><p className="text-2xl font-bold text-white mt-1">{value}</p><p className="text-[11px] text-gray-600 mt-1">{sub}</p></div>
                  <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/15 flex items-center justify-center"><Icon size={18} className="text-cyan-400" /></div>
                </div>
              </div>
            ))}
          </div>

          <div className="grid xl:grid-cols-[1.15fr_1fr] gap-4 mb-5">
            <section className="rounded-2xl border border-[#30363d] bg-[#161b22] overflow-hidden">
              <div className="px-4 py-3 border-b border-[#30363d] flex items-center justify-between"><div><h2 className="text-sm font-bold text-white">Personal de hoy</h2><p className="text-[11px] text-gray-500">{dashboard?.personal_total || 0} perfiles activos</p></div><Users size={17} className="text-gray-500" /></div>
              <div className="divide-y divide-[#21262d]">
                {personal.map((p) => {
                  const est = estadoPersonal(p)
                  return <div key={p.staff_id} className="px-4 py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0"><p className="text-sm font-semibold text-white truncate">{p.nombre}</p><p className="text-[11px] text-gray-500 capitalize">{p.puesto || p.rol} · {p.turno_nombre || 'Sin turno'} {p.hora_inicio && `· ${hora(p.hora_inicio)}–${hora(p.hora_fin)}`}</p></div>
                    <div className="text-right shrink-0"><span className={`inline-flex px-2 py-1 rounded-full border text-[10px] font-bold ${est.cls}`}>{est.label}</span>{p.entrada && <p className="text-[10px] text-gray-600 mt-1">Entrada {hora(p.entrada)}{p.salida ? ` · Salida ${hora(p.salida)}` : ''}</p>}</div>
                  </div>
                })}
              </div>
            </section>

            <section className="rounded-2xl border border-[#30363d] bg-[#161b22] p-4">
              <div className="flex items-start justify-between gap-3 mb-4">
                <div className="flex items-center gap-2"><CalendarDays size={17} className="text-cyan-400" /><div><h2 className="text-sm font-bold text-white">Asistencia mensual</h2><p className="text-[11px] text-gray-500">Resumen del periodo seleccionado</p></div></div>
                <button onClick={() => setJustificarOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/25 bg-cyan-500/10 px-2.5 py-1.5 text-[11px] font-bold text-cyan-300 hover:bg-cyan-500/15"><FileCheck2 size={13} /> Justificar</button>
              </div>
              <input type="month" value={mes} onChange={(e) => setMes(e.target.value)} className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-cyan-500 mb-4" />
              <div className="grid grid-cols-2 gap-2">
                <Mini label="Tardanzas" value={resumenAsistencia.tardanzas} />
                <Mini label="Min. tarde" value={resumenAsistencia.minutos} />
                <Mini label="Ausencias" value={resumenAsistencia.ausencias} />
                <Mini label="Justificados" value={resumenAsistencia.justificados} />
                <Mini label="H. programadas" value={resumenAsistencia.horasProgramadas.toFixed(1)} />
                <Mini label="H. registradas" value={resumenAsistencia.horas.toFixed(1)} />
                <Mini label="Sin salida" value={resumenAsistencia.incompletas} />
              </div>
              <p className="text-[10px] text-gray-600 mt-3">Las horas programadas son una referencia operativa del horario asignado; no representan por sí solas horas extra, descuentos ni reglas de pago.</p>
            </section>
          </div>

          <section className="rounded-2xl border border-[#30363d] bg-[#161b22] overflow-hidden mb-5">
            <div className="px-4 py-3 border-b border-[#30363d]"><h2 className="text-sm font-bold text-white">Detalle mensual por persona</h2><p className="text-[11px] text-gray-500">Programación, marcas, tardanzas, faltas y horas registradas.</p></div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[1160px]">
                <thead className="bg-[#0d1117] text-gray-500"><tr><Th>Personal</Th><Th>Programados</Th><Th>Marcados</Th><Th>Tardanzas</Th><Th>Min. tarde</Th><Th>Ausencias</Th><Th>Justificados</Th><Th>H. prog.</Th><Th>H. registradas</Th><Th>Sin salida</Th></tr></thead>
                <tbody className="divide-y divide-[#21262d]">
                  {asistencia.map((r) => <tr key={r.staff_id} className="text-gray-300"><td className="px-4 py-3"><p className="font-semibold text-white">{r.nombre}</p><p className="text-[10px] text-gray-600">@{r.username} · {r.puesto || 'sin puesto'}</p></td><Td>{r.dias_programados_hasta_hoy}/{r.dias_programados_mes}</Td><Td>{r.dias_con_entrada}</Td><Td>{r.tardanzas}</Td><Td>{r.minutos_tarde}</Td><Td>{r.ausencias}</Td><Td>{r.justificados}</Td><Td>{Number(r.horas_programadas_hasta_hoy || 0).toFixed(2)} / {Number(r.horas_programadas_mes || 0).toFixed(2)} h</Td><Td>{Number(r.horas_trabajadas || 0).toFixed(2)} h</Td><Td>{r.jornadas_incompletas}</Td></tr>)}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-2xl border border-[#30363d] bg-[#161b22] overflow-hidden">
            <div className="px-4 py-3 border-b border-[#30363d] flex items-center justify-between gap-3"><div><h2 className="text-sm font-bold text-white">Justificaciones del mes</h2><p className="text-[11px] text-gray-500">Ausencias justificadas registradas por administración.</p></div><CheckCircle2 size={17} className="text-green-400" /></div>
            {justificaciones.length === 0 ? <div className="px-4 py-8 text-center text-xs text-gray-600">No hay justificaciones registradas en este mes.</div> : (
              <div className="divide-y divide-[#21262d]">
                {justificaciones.map((j) => <div key={j.asistencia_id} className="px-4 py-3 flex flex-col md:flex-row md:items-center justify-between gap-3">
                  <div className="min-w-0"><div className="flex items-center flex-wrap gap-2"><p className="text-sm font-semibold text-white">{j.nombre}</p><span className="text-[10px] rounded-full border border-green-500/20 bg-green-500/10 text-green-300 px-2 py-0.5">Justificado</span></div><p className="text-[11px] text-gray-500 mt-0.5">{fechaCorta(j.fecha)} · {j.turno_nombre || 'Turno programado'} · @{j.username}</p><p className="text-xs text-gray-300 mt-1.5">{j.observacion || 'Sin observación'}</p>{j.registrado_por_nombre && <p className="text-[10px] text-gray-600 mt-1">Registrado por {j.registrado_por_nombre}</p>}</div>
                  <button onClick={() => quitarJustificacion(j)} className="self-start md:self-auto inline-flex items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-red-300 hover:bg-red-500/15"><Trash2 size={12} /> Retirar</button>
                </div>)}
              </div>
            )}
          </section>
        </>
      )}

      {justificarOpen && <ModalJustificar personal={asistencia} mes={mes} onClose={() => setJustificarOpen(false)} onSaved={async () => { setJustificarOpen(false); await cargar(true); showToast('Ausencia justificada', 'success') }} />}
    </div>
  )
}

function ModalJustificar({ personal, mes, onClose, onSaved }: { personal: AsistenciaMes[]; mes: string; onClose: () => void; onSaved: () => void }) {
  const hoy = new Date().toISOString().slice(0, 10)
  const fechaInicial = hoy.startsWith(mes) ? hoy : `${mes}-01`
  const [staffId, setStaffId] = useState(personal[0]?.staff_id || '')
  const [fecha, setFecha] = useState(fechaInicial)
  const [motivo, setMotivo] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')

  const guardar = async () => {
    setError('')
    if (!staffId || !fecha || motivo.trim().length < 3) { setError('Selecciona personal, fecha e ingresa el motivo'); return }
    setGuardando(true)
    const { error: rpcError } = await supabase.rpc('registrar_justificacion_asistencia', { p_staff_id: staffId, p_fecha: fecha, p_observacion: motivo.trim() })
    setGuardando(false)
    if (rpcError) { setError(rpcError.message || 'No se pudo registrar la justificación'); return }
    onSaved()
  }

  return <div className="fixed inset-0 z-[70] bg-black/65 backdrop-blur-sm flex items-end md:items-center justify-center p-0 md:p-4">
    <div className="relative w-full max-w-md rounded-t-2xl md:rounded-2xl border border-[#30363d] bg-[#161b22] p-5 shadow-2xl">
      <button onClick={onClose} className="absolute right-4 top-4 text-gray-500 hover:text-white" aria-label="Cerrar"><X size={19} /></button>
      <div className="flex items-center gap-3 mb-5"><div className="w-10 h-10 rounded-xl border border-cyan-500/20 bg-cyan-500/10 flex items-center justify-center"><FileCheck2 size={18} className="text-cyan-400" /></div><div><h3 className="font-bold text-white">Justificar ausencia</h3><p className="text-xs text-gray-500">Registra una ausencia válida sin crear una entrada falsa.</p></div></div>
      <label className="text-xs font-semibold text-gray-500">Personal</label>
      <select value={staffId} onChange={(e) => setStaffId(e.target.value)} className="mt-1 w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-cyan-500">{personal.map((p) => <option key={p.staff_id} value={p.staff_id}>{p.nombre} · @{p.username}</option>)}</select>
      <label className="block text-xs font-semibold text-gray-500 mt-4">Fecha</label>
      <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} max={hoy} className="mt-1 w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-cyan-500" />
      <label className="block text-xs font-semibold text-gray-500 mt-4">Motivo</label>
      <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={3} placeholder="Ej. permiso coordinado, emergencia familiar..." className="mt-1 w-full resize-none bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-gray-700 focus:outline-none focus:ring-1 focus:ring-cyan-500" />
      <p className="text-[10px] text-gray-600 mt-2">El servidor verificará que esa persona realmente estuviera programada y que no tenga una entrada registrada.</p>
      {error && <p className="mt-3 rounded-lg bg-red-500/10 p-2 text-xs text-red-400">{error}</p>}
      <div className="flex gap-2 mt-5"><button onClick={onClose} className="flex-1 rounded-xl border border-[#30363d] bg-[#21262d] py-2.5 text-sm font-semibold text-gray-300">Cancelar</button><button onClick={guardar} disabled={guardando || !staffId || !fecha || motivo.trim().length < 3} className="flex-1 rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 py-2.5 text-sm font-bold text-black disabled:opacity-40">{guardando ? 'Guardando...' : 'Justificar ausencia'}</button></div>
    </div>
  </div>
}

function Mini({ label, value }: { label: string; value: string | number }) {
  return <div className="rounded-xl border border-[#30363d] bg-[#0d1117] p-3"><p className="text-[10px] text-gray-600">{label}</p><p className="text-lg font-bold text-white mt-0.5">{value}</p></div>
}

function Th({ children }: { children: React.ReactNode }) { return <th className="text-left font-semibold px-4 py-2.5">{children}</th> }
function Td({ children }: { children: React.ReactNode }) { return <td className="px-4 py-3">{children}</td> }
