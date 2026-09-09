import { useEffect, useMemo, useState } from 'react'
import { ClipboardCheck, PlayCircle, CheckCircle2, ScanLine, AlertTriangle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'

type Conteo = { id: string; estado: string; fecha_inicio: string; fecha_cierre: string | null; observacion: string | null }
type Item = {
  id: string; variant_id: string; cantidad_sistema: number; cantidad_contada: number | null
  variant: { color: string | null; product: { nombre: string; control_serial: boolean } | null } | null
}
// cantidad_esperada/diferencia_real vienen de detalle_inventario_fisico (backend) — la UI
// ya no recalcula `contado - cantidad_sistema` (esa fórmula ignora movimientos posteriores
// a la apertura del conteo y es la que P0.1/P0.2 corrigieron en el backend).
type Detalle = {
  item_id: string; cantidad_sistema: number; movimientos_hasta_contar: number; cantidad_esperada: number
  cantidad_contada: number | null; diferencia_real: number | null
  seriales_esperados: number; seriales_encontrados: number; seriales_pendientes_reconciliar: number
}
type SerialPendiente = { id: string; variant_id: string; serial_number: string; esperado: boolean; encontrado: boolean }

export default function ConteoInventario() {
  const { staff, isAdmin } = useAuth()
  const { showToast } = useToast()
  const [conteos, setConteos] = useState<Conteo[]>([])
  const [actual, setActual] = useState<Conteo | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [detalles, setDetalles] = useState<Record<string, Detalle>>({})
  const [scans, setScans] = useState<Record<string, string>>({})
  const [pendientesSeriales, setPendientesSeriales] = useState<SerialPendiente[]>([])
  const [resolviendo, setResolviendo] = useState<SerialPendiente | null>(null)
  const [resolucionTexto, setResolucionTexto] = useState('')
  const [tipoResolucion, setTipoResolucion] = useState('')
  const puedeContar = isAdmin || ['tecnico', 'encargado', 'jefa'].includes(staff?.puesto || '')
  const puedeCerrar = isAdmin || ['encargado', 'jefa'].includes(staff?.puesto || '')

  const load = async () => {
    const { data } = await supabase.from('inventarios_fisicos').select('id,estado,fecha_inicio,fecha_cierre,observacion').order('fecha_inicio', { ascending: false })
    setConteos(data || [])
    const abierto = (data || []).find((x: any) => x.estado === 'abierto') || null
    setActual(abierto)
    if (!abierto) { setItems([]); setDetalles({}); setPendientesSeriales([]); return }
    const { data: i } = await supabase.from('inventario_fisico_items')
      .select('id,variant_id,cantidad_sistema,cantidad_contada,variant:product_variants(color,product:products(nombre,control_serial))')
      .eq('inventario_id', abierto.id).order('cantidad_sistema', { ascending: false })
    setItems((i as unknown as Item[]) || [])
    const { data: d } = await supabase.rpc('detalle_inventario_fisico', { p_inventario_id: abierto.id })
    setDetalles(Object.fromEntries(((d || []) as Detalle[]).map((x) => [x.item_id, x])))
    const { data: p } = await supabase.from('inventario_fisico_seriales')
      .select('id,variant_id,serial_number,esperado,encontrado')
      .eq('inventario_id', abierto.id).not('estado_reconciliacion', 'in', '(coincide,resuelto)')
    setPendientesSeriales((p as SerialPendiente[]) || [])
  }
  useEffect(() => { load() }, [])

  const iniciar = async () => {
    const { error } = await supabase.rpc('iniciar_inventario_fisico', { p_observacion: null })
    if (error) { showToast(error.message, 'error'); return }
    showToast('Conteo iniciado', 'success'); await load()
  }

  const registrar = async (i: Item, v: number) => {
    const { error } = await supabase.rpc('registrar_conteo_fisico', { p_inventario_id: actual?.id, p_variant_id: i.variant_id, p_cantidad: v })
    if (error) { showToast(error.message, 'error'); return }
    await load()
  }

  const escanear = async (i: Item) => {
    const serial = (scans[i.variant_id] || '').trim()
    if (!serial) return
    const { data, error } = await supabase.rpc('registrar_serial_contado', { p_inventario_id: actual?.id, p_variant_id: i.variant_id, p_serial_number: serial })
    setScans((s) => ({ ...s, [i.variant_id]: '' }))
    if (error) { showToast(error.message, 'error'); return }
    const r = data as { coincide: boolean; serial_conocido: boolean } | null
    showToast(r?.coincide ? 'Serial coincide' : (r?.serial_conocido ? 'Serial inesperado aquí: requiere resolución' : 'Serial desconocido: requiere resolución'), r?.coincide ? 'success' : 'error')
    await load()
  }

  const resolver = async () => {
    if (!resolviendo || !tipoResolucion) return
    const { data, error } = await supabase.rpc('resolver_reconciliacion_serial', {
      p_item_id: resolviendo.id, p_tipo: tipoResolucion, p_nota: resolucionTexto.trim() || null,
    })
    if (error) { showToast(error.message, 'error'); return }
    const r = data as { efecto: string; bloquea_cierre: boolean } | null
    setResolviendo(null); setResolucionTexto(''); setTipoResolucion('')
    showToast(r?.bloquea_cierre ? `Registrado, pero sigue bloqueando el cierre: ${r.efecto}` : `Resuelto — ${r?.efecto ?? ''}`, r?.bloquea_cierre ? 'info' : 'success')
    await load()
  }

  const cerrar = async () => {
    if (!actual || !window.confirm('¿Cerrar el conteo y aplicar las diferencias al stock?')) return
    const { error } = await supabase.rpc('cerrar_inventario_fisico', { p_inventario_id: actual.id })
    if (error) { showToast(error.message, 'error'); return }
    showToast('Conteo cerrado y stock ajustado', 'success'); await load()
  }

  const pendientes = useMemo(() => items.filter((i) => i.cantidad_contada === null).length, [items])
  const diferencias = useMemo(() => Object.values(detalles).filter((d) => (d.diferencia_real || 0) !== 0).length, [detalles])
  const seriesSinReconciliar = pendientesSeriales.length

  return (
    <div className="p-3 md:p-5 max-w-6xl mx-auto">
      <div className="flex flex-wrap justify-between gap-3 mb-5">
        <div>
          <div className="flex items-center gap-2"><ClipboardCheck size={20} className="text-cyan-400" /><h1 className="text-xl font-bold text-white">Conteo físico</h1></div>
          <p className="text-xs text-gray-500 mt-1">El stock solo cambia cuando el conteo se cierra.</p>
        </div>
        {puedeContar && !actual && <button onClick={iniciar} className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-bold text-black inline-flex gap-2 items-center"><PlayCircle size={15} />Iniciar conteo</button>}
      </div>

      {actual ? (
        <>
          <div className="grid grid-cols-4 gap-3 mb-4">
            <Card n={items.length} t="Productos" />
            <Card n={pendientes} t="Pendientes" />
            <Card n={diferencias} t="Con diferencia" />
            <Card n={seriesSinReconciliar} t="Series sin reconciliar" alerta={seriesSinReconciliar > 0} />
          </div>

          <div className="rounded-2xl border border-[#30363d] bg-[#161b22] overflow-hidden">
            <div className="divide-y divide-[#21262d]">
              {items.map((i) => {
                const d = detalles[i.id]
                const serializado = !!i.variant?.product?.control_serial
                const diff = d?.diferencia_real ?? null
                return (
                  <div key={i.id} className="p-3">
                    <div className="grid grid-cols-[1fr_80px_90px_70px] gap-2 items-center">
                      <div>
                        <p className="text-sm text-white">{i.variant?.product?.nombre || 'Producto'}{i.variant?.color ? ` · ${i.variant.color}` : ''}</p>
                        <p className="text-[10px] text-gray-600">
                          Sistema: {i.cantidad_sistema}
                          {d && d.movimientos_hasta_contar !== 0 ? ` · movimientos: ${d.movimientos_hasta_contar > 0 ? '+' : ''}${d.movimientos_hasta_contar}` : ''}
                        </p>
                      </div>
                      <span className="text-xs text-gray-400 text-center">{d?.cantidad_esperada ?? i.cantidad_sistema}</span>
                      {serializado ? (
                        <span className="text-xs text-gray-300 text-center">{i.cantidad_contada ?? 0}/{d?.seriales_esperados ?? 0}</span>
                      ) : (
                        <input type="number" min={0} value={i.cantidad_contada ?? ''} onChange={(e) => registrar(i, Math.max(0, Number(e.target.value)))} className="input-personal text-center" placeholder="Contado" />
                      )}
                      <span className={`text-xs font-bold text-right ${(diff || 0) > 0 ? 'text-green-400' : (diff || 0) < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                        {diff === null ? '—' : `${diff > 0 ? '+' : ''}${diff}`}
                      </span>
                    </div>
                    {serializado && (
                      <div className="mt-2 pl-1">
                        <div className="flex gap-2">
                          <input value={scans[i.variant_id] || ''} onChange={(e) => setScans((s) => ({ ...s, [i.variant_id]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === 'Enter') escanear(i) }}
                            placeholder="Escanear/escribir IMEI o serie" className="input-personal flex-1 text-xs" />
                          <button onClick={() => escanear(i)} className="rounded-lg bg-cyan-500/20 text-cyan-300 px-3 text-xs font-semibold inline-flex items-center gap-1"><ScanLine size={13} />Escanear</button>
                        </div>
                        <div className="flex gap-3 mt-1.5 text-[10px] text-gray-500">
                          <span>Esperados: {d?.seriales_esperados ?? '—'}</span>
                          <span>Escaneados: {d?.seriales_encontrados ?? '—'}</span>
                          {(d?.seriales_pendientes_reconciliar ?? 0) > 0 && (
                            <span className="text-orange-400 font-semibold inline-flex items-center gap-1"><AlertTriangle size={11} />{d?.seriales_pendientes_reconciliar} sin reconciliar</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {pendientesSeriales.length > 0 && (
            <div className="mt-4 rounded-2xl border border-orange-500/30 bg-orange-500/5 p-4">
              <h3 className="text-sm font-bold text-orange-300 mb-2 inline-flex items-center gap-1.5"><AlertTriangle size={14} />Series por reconciliar</h3>
              <div className="space-y-1.5">
                {pendientesSeriales.map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-2 bg-[#0d1117] rounded-lg px-3 py-2">
                    <div>
                      <p className="text-xs text-white font-mono">{p.serial_number}</p>
                      <p className="text-[10px] text-gray-500">{p.esperado && !p.encontrado ? 'Faltante: esperado y no escaneado' : 'Inesperado: escaneado sin estar en la lista esperada'}</p>
                    </div>
                    {puedeCerrar && <button onClick={() => setResolviendo(p)} className="text-[11px] font-semibold text-cyan-400 shrink-0">Resolver</button>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {puedeCerrar && (
            <button onClick={cerrar} disabled={pendientes > 0 || seriesSinReconciliar > 0}
              className="mt-4 w-full rounded-xl bg-green-500 px-4 py-2.5 text-sm font-bold text-black disabled:opacity-40 inline-flex justify-center gap-2 items-center">
              <CheckCircle2 size={16} />Cerrar conteo y aplicar diferencias
            </button>
          )}
        </>
      ) : (
        <div className="rounded-2xl border border-[#30363d] bg-[#161b22] p-10 text-center text-sm text-gray-600">No hay un conteo abierto.</div>
      )}

      <div className="mt-6">
        <h2 className="text-sm font-bold text-white mb-2">Historial</h2>
        <div className="space-y-2">
          {conteos.filter((c) => c.estado !== 'abierto').slice(0, 20).map((c) => (
            <div key={c.id} className="rounded-xl border border-[#30363d] bg-[#161b22] px-4 py-3 flex justify-between">
              <span className="text-xs text-gray-300">{new Date(c.fecha_inicio).toLocaleString('es-PE')}</span>
              <span className="text-[10px] uppercase text-gray-500">{c.estado}</span>
            </div>
          ))}
        </div>
      </div>

      {resolviendo && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#161b22] rounded-2xl w-full max-w-sm p-5 border border-[#30363d]">
            <h3 className="font-bold text-white mb-1">Resolver: {resolviendo.serial_number}</h3>
            <p className="text-xs text-gray-500 mb-3">{resolviendo.esperado && !resolviendo.encontrado ? 'Faltante — el sistema lo esperaba aquí y no apareció.' : 'Inesperado — apareció físicamente sin estar en la lista esperada.'}</p>
            <div className="space-y-1.5 mb-3">
              {opcionesResolucion(resolviendo).map((o) => (
                <button key={o.tipo} onClick={() => setTipoResolucion(o.tipo)}
                  className={`w-full text-left rounded-xl border px-3 py-2 transition-colors ${tipoResolucion === o.tipo ? 'border-cyan-500 bg-cyan-500/10' : 'border-[#30363d] bg-[#0d1117] hover:border-gray-600'}`}>
                  <p className="text-xs font-semibold text-white">{o.titulo}{o.bloquea && <span className="ml-1.5 text-[9px] uppercase text-orange-400">no cierra</span>}</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">{o.efecto}</p>
                </button>
              ))}
            </div>
            <textarea value={resolucionTexto} onChange={(e) => setResolucionTexto(e.target.value)} placeholder="Nota (opcional): detalle de lo que pasó"
              className="input-personal w-full text-sm mb-3" rows={2} />
            <div className="flex gap-2">
              <button onClick={() => { setResolviendo(null); setResolucionTexto(''); setTipoResolucion('') }} className="flex-1 bg-[#21262d] text-gray-300 font-semibold py-2 rounded-xl text-sm">Cancelar</button>
              <button onClick={resolver} disabled={!tipoResolucion} className="flex-1 bg-cyan-500 text-black font-bold py-2 rounded-xl text-sm disabled:opacity-40">Aplicar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Espeja exactamente las reglas de resolver_reconciliacion_serial: cada
// opción dice qué le pasa de verdad a la unidad, no solo qué texto se guarda.
// Esta lista es solo una guía para el usuario: la matriz de transiciones válidas
// la valida el backend contra el estado real del serial, y si rechaza la combinación
// el mensaje del RPC se muestra tal cual (ver `resolver`).
function opcionesResolucion(s: SerialPendiente) {
  const faltante = s.esperado && !s.encontrado
  const comunes = [
    { tipo: 'cuarentena', titulo: 'Enviar a cuarentena', efecto: 'La unidad queda no vendible hasta revisarla; baja del stock.', bloquea: false },
    { tipo: 'investigacion', titulo: 'Abrir investigación', efecto: 'Marca la unidad en investigación y baja del stock. Impide cerrar el conteo hasta darle un desenlace.', bloquea: true },
    { tipo: 'baja', titulo: 'Dar de baja', efecto: 'Retira la unidad definitivamente del inventario. Solo administración.', bloquea: false },
  ]
  return faltante
    ? [
        { tipo: 'faltante_confirmado', titulo: 'Faltante confirmado', efecto: 'La unidad deja de estar disponible y baja del stock: no se puede vender.', bloquea: false },
        // No es un faltante: la unidad salió por una venta o despacho legítimo mientras se contaba,
        // así que no se toca product_serials ni se penaliza el cierre.
        { tipo: 'movimiento_posterior', titulo: 'Se movió durante el conteo', efecto: 'Otra operación (venta, transferencia, taller) movió la unidad mientras contabas. No cambia el catálogo y no bloquea el cierre. Solo aplica si el catálogo ya no la da por disponible.', bloquea: false },
        ...comunes,
      ]
    : [
        { tipo: 'error_escaneo', titulo: 'Error de escaneo', efecto: 'Descarta el escaneo. No cambia nada de la unidad.', bloquea: false },
        { tipo: 'corregir_ubicacion', titulo: 'Corregir ubicación', efecto: 'La unidad existe en otra sucursal: se mueve a esta, con movimiento de stock en ambas.', bloquea: false },
        { tipo: 'recepcion_omitida', titulo: 'Recepción omitida', efecto: 'No inventa stock: hay que registrar la recepción real. Impide cerrar el conteo.', bloquea: true },
        ...comunes,
      ]
}

function Card({ n, t, alerta }: { n: number; t: string; alerta?: boolean }) {
  return (
    <div className={`rounded-xl border p-3 ${alerta ? 'border-orange-500/40 bg-orange-500/5' : 'border-[#30363d] bg-[#161b22]'}`}>
      <p className={`text-xl font-bold ${alerta ? 'text-orange-400' : 'text-white'}`}>{n}</p>
      <p className="text-[10px] text-gray-500 uppercase">{t}</p>
    </div>
  )
}
