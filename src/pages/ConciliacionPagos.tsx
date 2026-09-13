import { useEffect, useMemo, useRef, useState } from 'react'
import { BadgeCheck, RefreshCw, AlertTriangle, XCircle, WandSparkles, Lock, FlaskConical, Scale, Undo2, Monitor } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useToast } from '../lib/toast'
import { getBusinessDateLima, startOfBusinessDayLima } from '../lib/businessDate'

// La conciliación SIEMPRE se agrupa por `fecha_venta`, que el servidor copia de
// `sales.business_date` (America/Lima, calculado por trigger). Nunca por
// `created_at` de la conciliación, y nunca por la fecha UTC del navegador: una
// venta de las 22:30 en Lima ya es el día siguiente en UTC.
type Row = {
  id: string; payment_id: string; sale_id: string; metodo: string
  monto_esperado: number; monto_confirmado: number | null; monto_venta: number | null
  referencia_venta: string | null; referencia_proveedor: string | null; proveedor: string | null
  estado: string; observacion: string | null
  fecha_venta: string; venta_at: string | null; conciliado_at: string | null
  is_test: boolean; cash_session_id: string | null; terminal: string | null
  sale: { numero: number } | null
}
// Reembolso devuelto a través del proveedor (Fase 18). Cabecera inmutable; el estado es el último evento.
type EventoReembolso = { estado: string; referencia_proveedor: string | null; nota: string | null; created_at: string }
type Reembolso = {
  id: string; payment_id: string; sale_id: string; metodo: string; monto: number; motivo: string
  estado: 'solicitado' | 'enviado' | 'confirmado' | 'rechazado'; created_at: string; eventos: EventoReembolso[]
}
type Summary = {
  fecha: string; pendientes: number; conciliados: number; diferencias: number; rechazados: number
  monto_pendiente: number; monto_conciliado: number; monto_rechazado: number; monto_diferencia: number
  ventas_descuadradas: number; monto_descuadre: number
}
type Cuadre = {
  sale_id: string; numero: number; venta_at: string; total: number; pagado: number
  diferencia: number; mixto: boolean; metodos: string[]; cuadra: boolean
}

const money = (v: number) => new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' }).format(Number(v || 0))
// Hora de pared en Lima. El instante es un timestamptz real; lo que no puede
// pasar es mostrarlo en la zona del dispositivo, que puede no ser la del local.
const horaLima = (iso: string | null) => iso
  ? new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))
  : '—'

export default function ConciliacionPagos() {
  const { showToast } = useToast()
  const [fecha, setFecha] = useState(getBusinessDateLima())
  const [rows, setRows] = useState<Row[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [cuadre, setCuadre] = useState<Cuadre[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Row | null>(null)
  const [auto, setAuto] = useState(false)
  const [reembolsos, setReembolsos] = useState<Reembolso[]>([])
  const [reembolsar, setReembolsar] = useState<Row | null>(null)

  const load = async () => {
    setLoading(true)
    await supabase.rpc('sincronizar_conciliaciones_pago_admin', {})
    const [r, s, q, rb] = await Promise.all([
      supabase.from('conciliaciones_pago')
        .select('id,payment_id,sale_id,metodo,monto_esperado,monto_confirmado,monto_venta,referencia_venta,referencia_proveedor,proveedor,estado,observacion,fecha_venta,venta_at,conciliado_at,is_test,cash_session_id,terminal,sale:sales(numero)')
        .eq('fecha_venta', fecha).order('venta_at', { ascending: false }),
      supabase.rpc('resumen_conciliacion_pagos_admin', { p_fecha: fecha }),
      supabase.rpc('cuadre_pagos_venta_admin', { p_fecha: fecha }),
      supabase.rpc('reembolsos_proveedor_admin', { p_estado: null }),
    ])
    if (r.error || s.error || q.error || rb.error) showToast('No se pudo cargar la conciliación', 'error')
    setRows((r.data as unknown as Row[]) || [])
    setSummary((s.data as Summary) || null)
    setCuadre(((q.data as Cuadre[]) || []).filter((c) => !c.cuadra))
    setReembolsos((rb.data as Reembolso[]) || [])
    setLoading(false)
  }

  const registrarTerminal = async (row: Row) => {
    const terminal = window.prompt('Terminal o lote del datáfono con el que se concilió este pago', row.terminal || '')
    if (terminal === null) return
    const { error } = await supabase.rpc('registrar_terminal_conciliacion_admin', { p_conciliacion_id: row.id, p_terminal: terminal })
    if (error) { showToast(error.message, 'error'); return }
    showToast('Terminal registrado', 'success')
    await load()
  }

  const eventoReembolso = async (rb: Reembolso, estado: 'enviado' | 'confirmado' | 'rechazado') => {
    let referencia: string | null = null
    let nota: string | null = null
    if (estado === 'confirmado') { referencia = window.prompt('Referencia de la operación que devolvió el proveedor'); if (referencia === null) return }
    if (estado === 'rechazado') { nota = window.prompt('¿Por qué se rechazó el reembolso?'); if (nota === null) return }
    const { error } = await supabase.rpc('registrar_evento_reembolso_proveedor_admin', { p_reembolso_id: rb.id, p_estado: estado, p_referencia_proveedor: referencia, p_nota: nota })
    if (error) { showToast(error.message, 'error'); return }
    showToast(`Reembolso ${estado}`, 'success')
    await load()
  }
  useEffect(() => { load() }, [fecha])

  const autoConciliar = async () => {
    setAuto(true)
    // Ventana del día COMERCIAL de Lima, no del día UTC del navegador.
    const desde = startOfBusinessDayLima(fecha)
    const hasta = new Date(desde.getTime() + 86400000)
    const { data, error } = await supabase.rpc('auto_conciliar_pagos_digitales_admin', { p_desde: desde.toISOString(), p_hasta: hasta.toISOString() })
    setAuto(false)
    if (error) { showToast(error.message, 'error'); return }
    showToast(`${Number(data || 0)} pago(s) digital(es) conciliados automáticamente`, 'success')
    await load()
  }

  const porRevisar = useMemo(() => rows.filter((r) => r.estado !== 'conciliado' && !r.is_test), [rows])
  const qa = useMemo(() => rows.filter((r) => r.is_test).length, [rows])

  return <div className="p-3 md:p-5 max-w-7xl mx-auto">
    <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
      <div>
        <div className="flex items-center gap-2"><BadgeCheck size={20} className="text-cyan-400" /><h1 className="text-xl font-bold text-white">Conciliación de pagos</h1></div>
        <p className="text-xs text-gray-500 mt-1">Compara los pagos no efectivos con la confirmación del proveedor/POS. Agrupado por día comercial de Lima (no por la fecha del navegador).</p>
      </div>
      <div className="flex gap-2">
        <button onClick={autoConciliar} disabled={auto} className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-xs font-bold text-cyan-300 disabled:opacity-40 inline-flex items-center gap-2"><WandSparkles size={14} />{auto ? 'Conciliando...' : 'Auto-conciliar Culqi'}</button>
        <button onClick={load} className="rounded-xl border border-[#30363d] p-2.5 text-gray-400"><RefreshCw size={16} /></button>
      </div>
    </div>

    <div className="mb-4 flex items-center gap-3">
      <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className="rounded-xl border border-[#30363d] bg-[#161b22] px-3 py-2 text-sm text-white" />
      {qa > 0 && <span className="inline-flex items-center gap-1 text-[11px] text-purple-300"><FlaskConical size={12} />{qa} de prueba (fuera de las cifras)</span>}
    </div>

    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
      <Metric label="Pendientes" value={String(summary?.pendientes || 0)} sub={money(summary?.monto_pendiente || 0)} />
      <Metric label="Conciliados" value={String(summary?.conciliados || 0)} sub={money(summary?.monto_conciliado || 0)} />
      <Metric label="Diferencias" value={String(summary?.diferencias || 0)} sub={money(summary?.monto_diferencia || 0)} />
      <Metric label="Rechazados" value={String(summary?.rechazados || 0)} sub={`${money(summary?.monto_rechazado || 0)} por reclamar`} />
      <Metric label="Por revisar" value={String(porRevisar.length)} />
    </div>

    {/* Pago mixto: la suma de los pagos de la venta tiene que igualar su total.
        Un descuadre aquí no lo arregla la conciliación — es la venta la que está mal. */}
    {cuadre.length > 0 && <section className="rounded-2xl border border-orange-500/30 bg-orange-500/5 p-4 mb-4">
      <div className="flex items-center gap-2 mb-2"><Scale size={15} className="text-orange-300" /><p className="text-sm font-bold text-orange-200">{cuadre.length} venta(s) con los pagos descuadrados · {money(summary?.monto_descuadre || 0)}</p></div>
      <p className="text-[11px] text-orange-200/60 mb-3">La suma de los pagos registrados no llega al total de la venta. Revisa la venta antes de conciliar ningún tramo.</p>
      <div className="space-y-1">{cuadre.map((c) => <div key={c.sale_id} className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-gray-300">
        <span>Venta #{c.numero} · {horaLima(c.venta_at)} · {c.mixto ? `mixto (${c.metodos.join(' + ')})` : (c.metodos[0] || 'sin pagos')}</span>
        <span>total {money(c.total)} · pagado {money(c.pagado)} · <b className="text-orange-300">{money(c.diferencia)}</b></span>
      </div>)}</div>
    </section>}

    <section className="rounded-2xl border border-[#30363d] bg-[#161b22] overflow-hidden">
      {loading ? <p className="p-8 text-center text-sm text-gray-500">Sincronizando...</p> : <div className="divide-y divide-[#21262d]">
        {rows.map((r) => <div key={r.id} className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-white">Venta #{r.sale?.numero || '—'} · {r.metodo.toUpperCase()}</p>
              <Estado estado={r.estado} />
              {r.is_test && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] text-purple-300 bg-purple-500/10"><FlaskConical size={10} />prueba</span>}
            </div>
            <p className="text-[11px] text-gray-500 mt-1">
              {horaLima(r.venta_at)} · esperado {money(r.monto_esperado)}
              {r.monto_venta !== null && Number(r.monto_venta) !== Number(r.monto_esperado) ? ` de ${money(r.monto_venta)} (pago mixto)` : ''}
              {r.referencia_venta ? ` · ref. venta ${r.referencia_venta}` : ''}
              {r.referencia_proveedor ? ` · ${r.proveedor || 'proveedor'} ${r.referencia_proveedor}` : ''}
              {r.terminal ? ` · terminal ${r.terminal}` : ''}
            </p>
            {r.observacion && <p className="text-[11px] text-gray-600 mt-0.5 truncate">{r.observacion}</p>}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {!r.is_test && <button onClick={() => registrarTerminal(r)} title="Terminal / lote del datáfono" className="rounded-lg border border-[#30363d] px-2.5 py-2 text-[11px] text-gray-400 inline-flex items-center gap-1"><Monitor size={12} />{r.terminal || 'Terminal'}</button>}
            {/* Sólo se reembolsa por el proveedor lo que efectivamente llegó (conciliado o con diferencia). */}
            {!r.is_test && (r.estado === 'conciliado' || r.estado === 'diferencia') && <button onClick={() => setReembolsar(r)} className="rounded-lg border border-[#30363d] px-2.5 py-2 text-[11px] text-gray-400 inline-flex items-center gap-1"><Undo2 size={12} />Reembolso</button>}
            <p className={`font-bold ${r.estado === 'rechazado' ? 'text-red-300' : 'text-cyan-300'}`}>{money(r.monto_confirmado ?? r.monto_esperado)}</p>
            {r.estado === 'conciliado'
              // Un pago conciliado no se vuelve a conciliar: el servidor lo
              // rechaza igualmente, pero no se ofrece el botón que induce a ello.
              ? <span className="inline-flex items-center gap-1 text-[11px] text-gray-600"><Lock size={12} />cerrado {horaLima(r.conciliado_at)}</span>
              : <button onClick={() => setSelected(r)} className="rounded-lg border border-[#30363d] px-3 py-2 text-xs text-gray-300">Revisar</button>}
          </div>
        </div>)}
        {!rows.length && <p className="p-8 text-center text-xs text-gray-600">No hay pagos no efectivos para este día comercial.</p>}
      </div>}
    </section>

    <section className="rounded-2xl border border-[#30363d] bg-[#161b22] overflow-hidden mt-4">
      <div className="p-4 border-b border-[#21262d] flex items-center gap-2"><Undo2 size={15} className="text-cyan-400" /><h2 className="text-sm font-bold text-white">Reembolsos a través del proveedor</h2></div>
      <p className="px-4 pt-3 text-[11px] text-gray-500">El reembolso se ejecuta en el panel del proveedor (Yape, POS, Culqi); aquí queda el rastro: solicitado → enviado → confirmado con su referencia, o rechazado. Nada se edita ni se borra.</p>
      <div className="divide-y divide-[#21262d]">
        {reembolsos.map((rb) => <div key={rb.id} className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold text-white">{rb.metodo.toUpperCase()} · {money(rb.monto)}</p><Estado estado={rb.estado} /></div>
            <p className="text-[11px] text-gray-500 mt-1 truncate">{rb.motivo}</p>
            <p className="text-[11px] text-gray-600 mt-0.5">{(rb.eventos || []).map((e) => `${e.estado} ${horaLima(e.created_at)}${e.referencia_proveedor ? ` (${e.referencia_proveedor})` : ''}${e.nota ? ` — ${e.nota}` : ''}`).join(' → ')}</p>
          </div>
          <div className="flex gap-2 shrink-0">
            {rb.estado === 'solicitado' && <button onClick={() => eventoReembolso(rb, 'enviado')} className="rounded-lg border border-[#30363d] px-3 py-2 text-xs text-gray-300">Marcar enviado</button>}
            {rb.estado === 'enviado' && <button onClick={() => eventoReembolso(rb, 'confirmado')} className="rounded-lg bg-green-500/15 border border-green-500/30 px-3 py-2 text-xs font-bold text-green-300">Confirmar</button>}
            {(rb.estado === 'solicitado' || rb.estado === 'enviado') && <button onClick={() => eventoReembolso(rb, 'rechazado')} className="rounded-lg border border-red-500/30 px-3 py-2 text-xs text-red-300">Rechazado</button>}
          </div>
        </div>)}
        {!reembolsos.length && <p className="p-6 text-center text-xs text-gray-600">No hay reembolsos registrados en esta sucursal.</p>}
      </div>
    </section>

    {selected && <Resolver row={selected} onClose={() => setSelected(null)} onSaved={async () => { setSelected(null); await load() }} />}
    {reembolsar && <SolicitarReembolso row={reembolsar} onClose={() => setReembolsar(null)} onSaved={async () => { setReembolsar(null); await load() }} />}
  </div>
}

function SolicitarReembolso({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const { showToast } = useToast()
  const [monto, setMonto] = useState(String(row.monto_confirmado ?? row.monto_esperado))
  const [motivo, setMotivo] = useState('')
  const [enviando, setEnviando] = useState(false)
  // Misma clave mientras el contenido no cambie: un reintento tras un corte no duplica el reembolso;
  // cambiar monto o motivo es otra operación y recibe otra clave.
  const clave = useRef({ contenido: '', id: crypto.randomUUID() })
  const guardar = async () => {
    const contenido = `${monto}|${motivo.trim()}`
    if (clave.current.contenido !== contenido) clave.current = { contenido, id: crypto.randomUUID() }
    setEnviando(true)
    const { error } = await supabase.rpc('solicitar_reembolso_proveedor_admin', {
      p_payment_id: row.payment_id, p_monto: Number(monto), p_motivo: motivo, p_client_transaction_id: clave.current.id, p_devolucion_id: null,
    })
    setEnviando(false)
    if (error) { showToast(error.message, 'error'); return }
    showToast('Reembolso solicitado', 'success')
    onSaved()
  }
  return <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
    <div className="w-full max-w-md rounded-2xl border border-[#30363d] bg-[#161b22] p-5">
      <h2 className="text-sm font-bold text-white mb-1">Solicitar reembolso · Venta #{row.sale?.numero || '—'} · {row.metodo.toUpperCase()}</h2>
      <p className="text-[11px] text-gray-500 mb-3">El servidor no permite reembolsar más de lo pagado ni pagos en efectivo.</p>
      <label className="text-xs text-gray-400">Monto</label>
      <input type="number" min="0.01" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className="mt-1 mb-3 w-full rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2 text-sm text-white" />
      <label className="text-xs text-gray-400">Motivo</label>
      <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={3} className="mt-1 w-full resize-none rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2 text-sm text-white" />
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="rounded-xl border border-[#30363d] px-4 py-2 text-sm text-gray-300">Cancelar</button>
        <button onClick={guardar} disabled={enviando || Number(monto) <= 0 || motivo.trim().length < 5} className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-bold text-black disabled:opacity-40">{enviando ? 'Enviando...' : 'Solicitar'}</button>
      </div>
    </div>
  </div>
}

function Resolver({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const { showToast } = useToast()
  const [monto, setMonto] = useState(String(row.monto_esperado))
  const [ref, setRef] = useState(row.referencia_proveedor || '')
  const [obs, setObs] = useState('')
  const [enviando, setEnviando] = useState(false)

  const run = async (estado: 'conciliado' | 'diferencia' | 'rechazado') => {
    const referencia = ref.trim() || null
    if (estado !== 'rechazado' && !referencia) { showToast('Indica la referencia del proveedor/POS: es lo que impide aceptar dos veces el mismo cobro', 'error'); return }
    if (estado === 'rechazado' && !obs.trim()) { showToast('Un rechazo necesita una observación que explique por qué', 'error'); return }
    setEnviando(true)
    const { error } = await supabase.rpc('conciliar_pago_admin', {
      p_payment_id: row.payment_id,
      p_estado: estado,
      // En un rechazo el proveedor no confirmó NADA: enviar el importe
      // esperado como "confirmado" contaría el rechazo como cobrado.
      p_monto_confirmado: estado === 'rechazado' ? null : Number(monto),
      p_referencia_proveedor: referencia,
      p_observacion: obs.trim() || null,
    })
    setEnviando(false)
    if (error) { showToast(error.message, 'error'); return }
    showToast('Conciliación actualizada', 'success')
    onSaved()
  }

  const desvia = Math.abs(Number(monto) - Number(row.monto_esperado)) > 0.005

  return <div className="fixed inset-0 z-50 bg-black/60 flex items-end md:items-center justify-center">
    <div className="w-full max-w-md bg-[#161b22] border border-[#30363d] rounded-t-2xl md:rounded-2xl p-5 space-y-3">
      <div className="flex justify-between"><h3 className="font-bold text-white">Revisar pago</h3><button onClick={onClose} className="text-gray-500">×</button></div>
      <p className="text-[11px] text-gray-500">Venta #{row.sale?.numero || '—'} · {row.metodo.toUpperCase()} · {horaLima(row.venta_at)} · esperado {money(row.monto_esperado)}</p>
      <label className="block"><span className="text-xs text-gray-500">Monto confirmado por el proveedor</span>
        <input type="number" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className="input-personal w-full mt-1" /></label>
      {desvia && <p className="text-[11px] text-orange-300">No coincide con el esperado: se registrará como diferencia y el importe esperado ({money(row.monto_esperado)}) se conserva.</p>}
      <label className="block"><span className="text-xs text-gray-500">Referencia proveedor/POS</span>
        <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="p. ej. orden Culqi o voucher del POS" className="input-personal w-full mt-1" /></label>
      <p className="text-[10px] text-gray-600">Una referencia sólo se puede aceptar una vez en todo el sistema.</p>
      <textarea value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Observación" className="input-personal w-full" />
      <div className="grid grid-cols-3 gap-2">
        <button disabled={enviando} onClick={() => run('conciliado')} className="rounded-xl bg-green-500/15 text-green-300 py-2 text-xs font-bold disabled:opacity-40">Conciliar</button>
        <button disabled={enviando} onClick={() => run('diferencia')} className="rounded-xl bg-orange-500/15 text-orange-300 py-2 text-xs font-bold disabled:opacity-40">Diferencia</button>
        <button disabled={enviando} onClick={() => run('rechazado')} className="rounded-xl bg-red-500/15 text-red-300 py-2 text-xs font-bold disabled:opacity-40">Rechazar</button>
      </div>
      <p className="text-[10px] text-gray-600">Conciliar es definitivo: un pago aceptado no se vuelve a conciliar.</p>
    </div>
  </div>
}

function Estado({ estado }: { estado: string }) {
  // Sirve para conciliaciones y para reembolsos: confirmado es un final correcto, no una alerta.
  const ok = estado === 'conciliado' || estado === 'confirmado'
  const enCurso = estado === 'solicitado' || estado === 'enviado'
  const cls = ok ? 'text-green-300 bg-green-500/10' : estado === 'diferencia' ? 'text-orange-300 bg-orange-500/10' : estado === 'rechazado' ? 'text-red-300 bg-red-500/10' : enCurso ? 'text-cyan-300 bg-cyan-500/10' : 'text-yellow-300 bg-yellow-500/10'
  const Icon = ok ? BadgeCheck : estado === 'rechazado' ? XCircle : enCurso ? Undo2 : AlertTriangle
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] ${cls}`}><Icon size={10} />{estado}</span>
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="rounded-2xl border border-[#30363d] bg-[#161b22] p-4">
    <p className="text-[11px] text-gray-500">{label}</p>
    <p className="text-xl font-bold text-white mt-1">{value}</p>
    {sub && <p className="text-[10px] text-gray-600 mt-1">{sub}</p>}
  </div>
}
