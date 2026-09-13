import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw, Radar } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useToast } from '../lib/toast'
import { getBusinessDateLima } from '../lib/businessDate'

// Centro de incidencias (Fase 21). Toda la lógica vive en el servidor:
// detectar_incidencias_admin usa las mismas verificaciones que el cierre diario,
// y actualizar_incidencia_admin impone las reglas (una P0 no se descarta,
// resolver exige nota, una cerrada no se reabre).

type Severidad = 'P0' | 'P1' | 'warning'
type Estado = 'abierta' | 'en_revision' | 'resuelta' | 'descartada'
interface Incidencia {
  id: string
  codigo: string
  severidad: Severidad
  estado: Estado
  titulo: string
  accion_sugerida: string | null
  detalle: { detalle?: unknown; cantidad?: number | null } | null
  veces: number
  detectada_at: string
  ultima_deteccion_at: string
  fecha_operativa: string | null
  sucursal: string | null
  asignada_nombre: string | null
  resolucion: string | null
  resuelta_at: string | null
}

const FILTROS: { valor: Estado | ''; etiqueta: string }[] = [
  { valor: 'abierta', etiqueta: 'Abiertas' },
  { valor: 'en_revision', etiqueta: 'En revisión' },
  { valor: 'resuelta', etiqueta: 'Resueltas' },
  { valor: 'descartada', etiqueta: 'Descartadas' },
  { valor: '', etiqueta: 'Todas' },
]

const ESTILO_SEVERIDAD: Record<Severidad, string> = {
  P0: 'border-red-500/30 bg-red-500/10 text-red-300',
  P1: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  warning: 'border-yellow-500/20 bg-yellow-500/5 text-yellow-200',
}
const ETIQUETA_SEVERIDAD: Record<Severidad, string> = { P0: 'P0 · bloqueante', P1: 'P1 · autorización', warning: 'Advertencia' }
const ETIQUETA_ESTADO: Record<Estado, string> = { abierta: 'Abierta', en_revision: 'En revisión', resuelta: 'Resuelta', descartada: 'Descartada' }

const fechaHora = (v: string | null) => (v ? new Date(v).toLocaleString('es-PE', { timeZone: 'America/Lima' }) : '—')

export default function Incidencias() {
  const { showToast } = useToast()
  const [filtro, setFiltro] = useState<Estado | ''>('abierta')
  const [items, setItems] = useState<Incidencia[]>([])
  const [cargando, setCargando] = useState(false)
  const [detectando, setDetectando] = useState(false)
  const [guardando, setGuardando] = useState<string | null>(null)

  const cargar = useCallback(async () => {
    setCargando(true)
    const { data, error } = await supabase.rpc('incidencias_admin', { p_estado: filtro || null, p_limite: 200 })
    setCargando(false)
    if (error) { showToast(error.message, 'error'); return }
    setItems((data as Incidencia[] | null) || [])
  }, [filtro, showToast])

  useEffect(() => { cargar() }, [cargar])

  const detectar = async () => {
    setDetectando(true)
    const { data, error } = await supabase.rpc('detectar_incidencias_admin', { p_fecha: getBusinessDateLima() })
    setDetectando(false)
    if (error) { showToast(error.message, 'error'); return }
    const r = data as { nuevas: number; redetectadas: number; auto_resueltas: number }
    showToast(`Detección: ${r.nuevas} nueva(s), ${r.redetectadas} persisten, ${r.auto_resueltas} resuelta(s) automáticamente`, 'success')
    await cargar()
  }

  const cambiarEstado = async (inc: Incidencia, estado: Estado) => {
    let nota: string | null = null
    if (estado === 'resuelta' || estado === 'descartada') {
      nota = window.prompt(estado === 'resuelta' ? '¿Cómo se resolvió?' : '¿Por qué se descarta?')
      if (nota === null) return
    }
    setGuardando(inc.id)
    const { error } = await supabase.rpc('actualizar_incidencia_admin', { p_id: inc.id, p_estado: estado, p_nota: nota })
    setGuardando(null)
    if (error) { showToast(error.message, 'error'); return }
    showToast(`Incidencia ${ETIQUETA_ESTADO[estado].toLowerCase()}`, 'success')
    await cargar()
  }

  return (
    <div className="p-3 md:p-5 max-w-6xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-5">
        <div>
          <div className="flex items-center gap-2">
            <AlertTriangle size={20} className="text-cyan-400" />
            <h1 className="text-xl font-bold text-white">Incidencias</h1>
          </div>
          <p className="text-xs text-gray-500 mt-1">Problemas detectados con las mismas verificaciones del cierre diario, con responsable e historial.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={cargar} className="btn-secondary" aria-label="Recargar"><RefreshCw size={15} /></button>
          <button onClick={detectar} disabled={detectando} className="rounded-xl bg-cyan-500 px-3 py-2 text-sm font-bold text-black inline-flex gap-2 items-center disabled:opacity-40">
            <Radar size={15} />{detectando ? 'Detectando...' : 'Detectar ahora'}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-4" role="tablist" aria-label="Estado">
        {FILTROS.map((f) => (
          <button key={f.etiqueta} role="tab" aria-selected={filtro === f.valor} onClick={() => setFiltro(f.valor)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${filtro === f.valor ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300' : 'border-[#30363d] text-gray-400'}`}>
            {f.etiqueta}
          </button>
        ))}
      </div>

      {cargando ? (
        <p className="p-10 text-center text-sm text-gray-500">Cargando...</p>
      ) : items.length === 0 ? (
        <p className="rounded-2xl border border-[#30363d] bg-[#161b22] p-8 text-center text-sm text-gray-500">No hay incidencias en este estado.</p>
      ) : (
        <div className="space-y-3">
          {items.map((inc) => {
            const cerrada = inc.estado === 'resuelta' || inc.estado === 'descartada'
            const detalleTexto = typeof inc.detalle?.detalle === 'string' ? inc.detalle.detalle : null
            return (
              <article key={inc.id} className={`rounded-2xl border p-4 ${ESTILO_SEVERIDAD[inc.severidad]}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-wide">{ETIQUETA_SEVERIDAD[inc.severidad]} · {ETIQUETA_ESTADO[inc.estado]}</p>
                    <h2 className="text-sm font-bold text-white mt-0.5">{inc.titulo}</h2>
                    {detalleTexto && <p className="text-xs text-gray-300 mt-1">{detalleTexto}</p>}
                    {inc.accion_sugerida && !cerrada && <p className="text-xs text-gray-400 mt-1">Acción: {inc.accion_sugerida}</p>}
                    <p className="text-[11px] text-gray-500 mt-2">
                      {inc.sucursal || 'Sin sucursal'}{inc.fecha_operativa ? ` · día ${inc.fecha_operativa}` : ''} · detectada {fechaHora(inc.detectada_at)}
                      {inc.veces > 1 ? ` · vista ${inc.veces} veces (última ${fechaHora(inc.ultima_deteccion_at)})` : ''}
                      {inc.asignada_nombre ? ` · responsable ${inc.asignada_nombre}` : ''}
                    </p>
                    {cerrada && inc.resolucion && <p className="text-xs text-gray-300 mt-2">Resolución: {inc.resolucion} ({fechaHora(inc.resuelta_at)})</p>}
                  </div>
                  {!cerrada && (
                    <div className="flex flex-wrap gap-2">
                      {inc.estado === 'abierta' && (
                        <button disabled={guardando === inc.id} onClick={() => cambiarEstado(inc, 'en_revision')} className="btn-secondary text-xs">En revisión</button>
                      )}
                      <button disabled={guardando === inc.id} onClick={() => cambiarEstado(inc, 'resuelta')} className="rounded-lg bg-green-500/15 border border-green-500/30 px-3 py-1.5 text-xs font-bold text-green-300">Resolver</button>
                      {inc.severidad !== 'P0' && (
                        <button disabled={guardando === inc.id} onClick={() => cambiarEstado(inc, 'descartada')} className="rounded-lg border border-[#30363d] px-3 py-1.5 text-xs text-gray-400">Descartar</button>
                      )}
                    </div>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
