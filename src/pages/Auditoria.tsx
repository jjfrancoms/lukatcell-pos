import { useEffect, useMemo, useState } from 'react'
import { Activity, RefreshCw, Search, ShieldCheck } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useToast } from '../lib/toast'

interface AuditEvent {
  id: number
  fecha: string
  actor_nombre: string
  accion: 'INSERT' | 'UPDATE' | 'DELETE'
  tabla: string
  registro_id: string | null
  datos_anteriores: Record<string, unknown> | null
  datos_nuevos: Record<string, unknown> | null
}

const TABLAS: Record<string, string> = {
  staff: 'Personal',
  staff_turnos: 'Turnos',
  asistencias: 'Asistencia',
  cash_sessions: 'Caja',
  ordenes_servicio: 'Órdenes',
  products: 'Productos',
  product_variants: 'Variantes',
}

const IGNORAR = new Set(['updated_at', 'created_at'])

function fechaHora(valor: string) {
  return new Date(valor).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' })
}

function accionInfo(accion: AuditEvent['accion']) {
  if (accion === 'INSERT') return { label: 'Creó', cls: 'bg-green-500/10 border-green-500/20 text-green-300' }
  if (accion === 'DELETE') return { label: 'Eliminó', cls: 'bg-red-500/10 border-red-500/20 text-red-300' }
  return { label: 'Modificó', cls: 'bg-cyan-500/10 border-cyan-500/20 text-cyan-300' }
}

function resumenCambio(e: AuditEvent) {
  if (e.accion === 'INSERT') return 'Nuevo registro creado.'
  if (e.accion === 'DELETE') return 'Registro eliminado.'
  const antes = e.datos_anteriores || {}
  const despues = e.datos_nuevos || {}
  const cambios = Object.keys(despues).filter((k) => !IGNORAR.has(k) && JSON.stringify(antes[k]) !== JSON.stringify(despues[k]))
  if (!cambios.length) return 'Actualización sin cambios visibles.'
  return `Campos modificados: ${cambios.slice(0, 6).join(', ')}${cambios.length > 6 ? '…' : ''}`
}

export default function Auditoria() {
  const { showToast } = useToast()
  const [eventos, setEventos] = useState<AuditEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [buscar, setBuscar] = useState('')
  const [tabla, setTabla] = useState('todas')
  const [accion, setAccion] = useState('todas')

  const cargar = async (manual = false) => {
    manual ? setRefreshing(true) : setLoading(true)
    const { data, error } = await supabase.rpc('auditoria_reciente_admin', { p_limite: 300 })
    if (error) showToast('No se pudo cargar la auditoría', 'error')
    setEventos((data as AuditEvent[] | null) || [])
    setLoading(false)
    setRefreshing(false)
  }

  useEffect(() => { cargar() }, [])

  const filtrados = useMemo(() => eventos.filter((e) => {
    if (tabla !== 'todas' && e.tabla !== tabla) return false
    if (accion !== 'todas' && e.accion !== accion) return false
    if (!buscar.trim()) return true
    const q = buscar.toLowerCase()
    return `${e.actor_nombre} ${TABLAS[e.tabla] || e.tabla} ${e.registro_id || ''} ${resumenCambio(e)}`.toLowerCase().includes(q)
  }), [eventos, tabla, accion, buscar])

  return <div className="p-3 md:p-5 max-w-[1450px] mx-auto">
    <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-5">
      <div>
        <div className="flex items-center gap-2"><ShieldCheck size={20} className="text-cyan-400" /><h1 className="font-display font-bold text-xl text-white">Auditoría</h1><span className="text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-full bg-orange-500/10 text-orange-300 border border-orange-500/20">Solo administración</span></div>
        <p className="text-xs text-gray-500 mt-1">Historial de cambios sensibles en personal, turnos, asistencia, caja, órdenes y catálogo.</p>
      </div>
      <button onClick={() => cargar(true)} disabled={refreshing} className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-[#161b22] border border-[#30363d] text-sm text-gray-300 hover:text-white disabled:opacity-50"><RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} /> Actualizar</button>
    </div>

    <div className="grid md:grid-cols-[1fr_190px_170px] gap-2 mb-4">
      <label className="relative"><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" /><input value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="Buscar actor, módulo o cambio..." className="w-full bg-[#161b22] border border-[#30363d] rounded-xl pl-9 pr-3 py-2.5 text-sm text-white placeholder:text-gray-700 focus:outline-none focus:ring-1 focus:ring-cyan-500" /></label>
      <select value={tabla} onChange={(e) => setTabla(e.target.value)} className="bg-[#161b22] border border-[#30363d] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-cyan-500"><option value="todas">Todos los módulos</option>{Object.entries(TABLAS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <select value={accion} onChange={(e) => setAccion(e.target.value)} className="bg-[#161b22] border border-[#30363d] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-cyan-500"><option value="todas">Todas las acciones</option><option value="INSERT">Creaciones</option><option value="UPDATE">Modificaciones</option><option value="DELETE">Eliminaciones</option></select>
    </div>

    <div className="rounded-2xl border border-[#30363d] bg-[#161b22] overflow-hidden">
      <div className="px-4 py-3 border-b border-[#30363d] flex items-center justify-between"><div><h2 className="text-sm font-bold text-white">Actividad reciente</h2><p className="text-[11px] text-gray-500">{filtrados.length} evento{filtrados.length === 1 ? '' : 's'} mostrado{filtrados.length === 1 ? '' : 's'} · máximo 300 recientes</p></div><Activity size={17} className="text-gray-500" /></div>
      {loading ? <div className="p-10 text-center text-sm text-gray-500">Cargando auditoría...</div> : filtrados.length === 0 ? <div className="p-10 text-center text-sm text-gray-600">No hay eventos que coincidan con los filtros.</div> : <div className="divide-y divide-[#21262d]">
        {filtrados.map((e) => {
          const info = accionInfo(e.accion)
          return <div key={e.id} className="px-4 py-3 grid md:grid-cols-[155px_150px_125px_1fr] gap-2 md:gap-4 md:items-center">
            <div><p className="text-xs font-semibold text-white">{e.actor_nombre}</p><p className="text-[10px] text-gray-600">{fechaHora(e.fecha)}</p></div>
            <div><span className="text-xs text-gray-300">{TABLAS[e.tabla] || e.tabla}</span>{e.registro_id && <p className="text-[9px] text-gray-700 font-mono truncate" title={e.registro_id}>{e.registro_id}</p>}</div>
            <div><span className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-bold ${info.cls}`}>{info.label}</span></div>
            <p className="text-xs text-gray-400">{resumenCambio(e)}</p>
          </div>
        })}
      </div>}
    </div>

    <p className="text-[10px] text-gray-700 mt-3">Los eventos generados por procesos internos pueden aparecer con actor “Sistema”. La auditoría no sustituye los movimientos de inventario ni los comprobantes de venta; complementa la trazabilidad administrativa.</p>
  </div>
}
