import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRightLeft, Eye, Plus, RefreshCw, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'

type Loc = { id: string; nombre: string }
type Variant = { id: string; color: string | null; product: { nombre: string; control_serial?: boolean } | null }
type Serial = { id: string; serial_number: string; imei2: string | null }
type Linea = { variant_id: string; cantidad: number; serial_ids: string[]; seriales: Serial[] }
type T = {
  id: string; numero: number; origen_id: string; destino_id: string; estado: string; fecha_creacion: string
  tiene_diferencias?: boolean
  origen: { nombre: string } | null; destino: { nombre: string } | null
}

// Contrato de public.transferencia_detalle (_p1_a_transferencias_parciales.sql §6).
type SerialDetalle = { serial_id: string; serial_number: string; resultado: 'ok' | 'danado' | 'faltante' | null; estado: string }
type LineaDetalle = {
  item_id: string; variant_id: string
  cantidad_enviada: number; cantidad_recibida: number; cantidad_danada: number
  cantidad_faltante: number; cantidad_sobrante: number; pendiente: number
  estado_linea: 'pendiente' | 'parcial' | 'completa' | 'con_diferencia'
  seriales: SerialDetalle[]
}
type Detalle = { id: string; numero: number; estado: string; tiene_diferencias: boolean; origen_id: string; destino_id: string; lineas: LineaDetalle[] }

type MarcaSerial = 'ok' | 'danado' | 'faltante'
type Captura = { ok: string; danada: string; seriales: Record<string, MarcaSerial> }

// Un envío que no responde en este plazo se aborta; el reintento reutiliza la MISMA clave.
const TIMEOUT_MS = 30000
const PUESTOS_OPERATIVOS = ['administrador', 'jefa', 'tecnico', 'encargado']
const ESTADOS_RECIBIBLES = ['en_transito', 'recibida_parcial']

const ESTADO_CAB: Record<string, string> = {
  borrador: 'text-gray-400', en_transito: 'text-cyan-400', recibida_parcial: 'text-amber-300', recibida: 'text-green-400', cancelada: 'text-red-400',
}
const ESTADO_LINEA: Record<string, string> = {
  pendiente: 'border-gray-500/30 text-gray-400', parcial: 'border-amber-500/30 text-amber-300',
  completa: 'border-green-500/30 text-green-400', con_diferencia: 'border-red-500/30 text-red-400',
}
const MARCA_ESTILO: Record<MarcaSerial, string> = {
  ok: 'border-green-500/40 bg-green-500/10 text-green-300',
  danado: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  faltante: 'border-red-500/40 bg-red-500/10 text-red-300',
}
const MARCA_TEXTO: Record<MarcaSerial, string> = { ok: 'Llegó bien', danado: 'Dañado', faltante: 'No llegó' }

const esFuncionAusente = (e: { code?: string } | null) => e?.code === 'PGRST202'

// El catálogo QA (is_test) se excluye del selector de variantes; products!inner es obligatorio porque un filtro sobre un embed left join solo vaciaría el embed sin descartar la variante.
export default function Transferencias() {
  const { staff, isAdmin } = useAuth()
  const { showToast } = useToast()
  const [rows, setRows] = useState<T[]>([])
  const [locs, setLocs] = useState<Loc[]>([])
  const [vars, setVars] = useState<Variant[]>([])
  const [open, setOpen] = useState(false)
  const [detalleDe, setDetalleDe] = useState<T | null>(null)
  const [despachando, setDespachando] = useState<string | null>(null)
  const despachoEnCurso = useRef(false)

  const load = useCallback(async () => {
    // select * para tolerar el esquema antes y después de la migración (tiene_diferencias).
    const [t, l, v] = await Promise.all([
      supabase.from('transferencias_stock').select('*,origen:locations!transferencias_stock_origen_id_fkey(nombre),destino:locations!transferencias_stock_destino_id_fkey(nombre)').order('fecha_creacion', { ascending: false }),
      supabase.from('locations').select('id,nombre').eq('activo', true),
      supabase.from('product_variants').select('id,color,product:products!inner(nombre,control_serial)').eq('product.is_test', false).limit(500),
    ])
    if (t.error || l.error || v.error) showToast(t.error?.message || l.error?.message || v.error?.message || 'No se pudieron cargar transferencias', 'error')
    setRows((t.data as unknown as T[]) || [])
    setLocs(l.data || [])
    setVars((v.data as unknown as Variant[]) || [])
  }, [showToast])

  useEffect(() => { load() }, [load])

  const rolOperativo = PUESTOS_OPERATIVOS.includes(isAdmin ? 'administrador' : staff?.puesto || '')
  // Sólo orienta la interfaz: quien decide es el servidor (origen despacha, destino recibe).
  const puedeDespachar = (t: T) => rolOperativo && t.estado === 'borrador' && t.origen_id === staff?.location_id

  // El despacho no recibe clave idempotente: es idempotente por estado en servidor
  // (un segundo despacho de una transferencia ya en tránsito devuelve la fila sin tocar stock).
  const despachar = async (t: T) => {
    if (despachoEnCurso.current) return
    despachoEnCurso.current = true
    setDespachando(t.id)
    try {
      const { error } = await supabase.rpc('despachar_transferencia_stock', { p_transferencia_id: t.id }).abortSignal(AbortSignal.timeout(TIMEOUT_MS))
      if (error) { showToast(error.message, 'error'); return }
      showToast('Transferencia despachada', 'success')
    } finally {
      despachoEnCurso.current = false
      setDespachando(null)
      await load()
    }
  }

  return <div className="p-3 md:p-5 max-w-6xl mx-auto">
    <div className="flex justify-between items-center gap-3 mb-5">
      <div>
        <div className="flex gap-2 items-center"><ArrowRightLeft className="text-cyan-400" size={20} /><h1 className="text-xl font-bold text-white">Transferencias</h1></div>
        <p className="text-xs text-gray-500 mt-1">Movimiento controlado entre sucursales: borrador → tránsito → recibida (parcial o completa).</p>
      </div>
      {isAdmin && locs.length > 1 && <button onClick={() => setOpen(true)} className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-bold text-black inline-flex gap-2"><Plus size={15} />Nueva</button>}
    </div>
    <div className="rounded-2xl border border-[#30363d] bg-[#161b22] divide-y divide-[#21262d]">
      {rows.map(t => {
        const esDestino = t.destino_id === staff?.location_id
        const recibible = ESTADOS_RECIBIBLES.includes(t.estado)
        return <div key={t.id} className="p-4 flex flex-wrap justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white">Transferencia #{t.numero}</p>
            <p className="text-xs text-gray-500">{t.origen?.nombre || 'Origen'} → {t.destino?.nombre || 'Destino'} · {new Date(t.fecha_creacion).toLocaleString('es-PE')}</p>
          </div>
          <div className="text-right">
            <span className={`text-[10px] uppercase font-semibold ${ESTADO_CAB[t.estado] || 'text-cyan-400'}`}>{t.estado.replace('_', ' ')}</span>
            {t.tiene_diferencias && <span className="ml-2 text-[10px] uppercase font-semibold text-red-400">con diferencias</span>}
            <div className="mt-2 flex flex-wrap justify-end gap-2">
              {puedeDespachar(t) && <button disabled={despachando !== null} onClick={() => despachar(t)} className="rounded-lg border border-cyan-500/30 px-3 py-1.5 text-xs text-cyan-300 disabled:opacity-40">{despachando === t.id ? 'Despachando...' : 'Despachar'}</button>}
              {t.estado !== 'borrador' && <button onClick={() => setDetalleDe(t)} className="inline-flex items-center gap-1 rounded-lg border border-cyan-500/30 px-3 py-1.5 text-xs text-cyan-300"><Eye size={13} />{rolOperativo && esDestino && recibible ? 'Recibir' : 'Detalle'}</button>}
            </div>
          </div>
        </div>
      })}
      {rows.length === 0 && <div className="p-10 text-center text-sm text-gray-600">No hay transferencias registradas.</div>}
    </div>
    {open && <Nueva locs={locs.filter(l => l.id !== staff?.location_id)} vars={vars} onClose={() => setOpen(false)} onSaved={async () => { setOpen(false); await load() }} />}
    {detalleDe && <Recepcion transferencia={detalleDe} operable={rolOperativo && detalleDe.destino_id === staff?.location_id} onClose={() => setDetalleDe(null)} onChanged={load} />}
  </div>
}

// ---------------------------------------------------------------------------
// RECEPCIÓN PARCIAL
//
// IDEMPOTENCIA. recibir_transferencia_parcial y cerrar_transferencia_stock exigen
// p_client_transaction_id. La clave pertenece a una INTENCIÓN, no a un intento:
//   · se genera una vez al abrir el formulario;
//   · se liga a la huella del contenido en el primer envío;
//   · un reintento con el mismo contenido (tras error o timeout) reutiliza la clave;
//   · si el operador cambia el contenido, la huella difiere y se genera otra;
//   · tras un éxito confirmado se genera una nueva.
// El servidor NO compara el contenido: la misma clave con otro contenido devuelve el
// estado vigente sin aplicar nada. Por eso la huella es obligatoria aquí.
// ---------------------------------------------------------------------------

function Recepcion({ transferencia, operable, onClose, onChanged }: { transferencia: T; operable: boolean; onClose: () => void; onChanged: () => Promise<void> }) {
  const { showToast } = useToast()
  const [det, setDet] = useState<Detalle | null>(null)
  const [nombres, setNombres] = useState<Record<string, Variant>>({})
  const [errorCarga, setErrorCarga] = useState<string | null>(null)
  const [cargando, setCargando] = useState(true)
  const [captura, setCaptura] = useState<Record<string, Captura>>({})
  const [obs, setObs] = useState('')
  const [scan, setScan] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [ultimoError, setUltimoError] = useState<string | null>(null)
  const enCurso = useRef(false)
  const clave = useRef<string>(crypto.randomUUID())
  const huellaLigada = useRef<string | null>(null)

  const cargar = useCallback(async () => {
    setCargando(true)
    const { data, error } = await supabase.rpc('transferencia_detalle', { p_transferencia_id: transferencia.id })
    setCargando(false)
    if (error) { setErrorCarga(error.message); return }
    if (!data) { setErrorCarga('El servidor no devolvió el detalle de esta transferencia para tu sucursal.'); return }
    setErrorCarga(null)
    const d = data as Detalle
    setDet(d)
    const ids = [...new Set(d.lineas.map(l => l.variant_id))]
    if (ids.length) {
      const { data: v, error: ev } = await supabase.from('product_variants').select('id,color,product:products(nombre,control_serial)').in('id', ids)
      if (ev) showToast(ev.message, 'error')
      setNombres(Object.fromEntries(((v as unknown as Variant[]) || []).map(x => [x.id, x])))
    }
  }, [transferencia.id, showToast])

  useEffect(() => { cargar() }, [cargar])

  const recibible = det ? ESTADOS_RECIBIBLES.includes(det.estado) : ESTADOS_RECIBIBLES.includes(transferencia.estado)
  const editable = operable && recibible

  const esSerial = (l: LineaDetalle) => nombres[l.variant_id]?.product?.control_serial ?? l.seriales.length > 0
  const cap = (id: string): Captura => captura[id] || { ok: '', danada: '', seriales: {} }
  const setCap = (id: string, cambio: Partial<Captura>) => setCaptura(c => ({ ...c, [id]: { ...cap(id), ...cambio } }))
  const marcar = (item: string, serial: string, marca: MarcaSerial | null) => {
    const actual = { ...cap(item).seriales }
    if (marca === null || actual[serial] === marca) delete actual[serial]
    else actual[serial] = marca
    setCap(item, { seriales: actual })
  }
  const enVuelo = (l: LineaDetalle) => l.seriales.filter(s => s.resultado === null)

  // Payload con la forma exacta de §7: [{item_id, cantidad_ok, cantidad_danada} | {item_id, serials:[...]}].
  // No se valida aquí lo que valida el servidor (negativos, IMEI fuera de vuelo, pertenencia).
  const construirItems = () => {
    if (!det) return []
    const items: Record<string, unknown>[] = []
    for (const l of det.lineas) {
      const c = cap(l.item_id)
      if (esSerial(l)) {
        const serials = Object.entries(c.seriales).map(([serial_id, resultado]) => ({ serial_id, resultado }))
        if (serials.length) items.push({ item_id: l.item_id, serials })
      } else if (c.ok !== '' || c.danada !== '') {
        items.push({ item_id: l.item_id, cantidad_ok: c.ok === '' ? 0 : Number(c.ok), cantidad_danada: c.danada === '' ? 0 : Number(c.danada) })
      }
    }
    return items
  }

  type Intento = { tipo: 'parcial'; items: Record<string, unknown>[] | null; cerrar: boolean } | { tipo: 'cerrar' }

  const enviar = async (intento: Intento) => {
    if (enCurso.current) return
    const observacion = obs.trim() || null
    const huella = JSON.stringify({ transferencia: transferencia.id, intento, observacion })
    if (huellaLigada.current !== null && huellaLigada.current !== huella) clave.current = crypto.randomUUID()
    huellaLigada.current = huella
    enCurso.current = true
    setEnviando(true)
    setUltimoError(null)
    try {
      const senal = AbortSignal.timeout(TIMEOUT_MS)
      const res = intento.tipo === 'cerrar'
        ? await supabase.rpc('cerrar_transferencia_stock', { p_transferencia_id: transferencia.id, p_client_transaction_id: clave.current, p_observacion: observacion }).abortSignal(senal)
        : await supabase.rpc('recibir_transferencia_parcial', { p_transferencia_id: transferencia.id, p_client_transaction_id: clave.current, p_items: intento.items, p_observacion: observacion, p_cerrar: intento.cerrar }).abortSignal(senal)

      if (res.error) {
        // Compatibilidad: sin la migración P1.A aplicada sólo existe la recepción total.
        if (intento.tipo === 'parcial' && intento.items === null && esFuncionAusente(res.error)) {
          const legacy = await supabase.rpc('recibir_transferencia_stock', { p_transferencia_id: transferencia.id }).abortSignal(AbortSignal.timeout(TIMEOUT_MS))
          if (legacy.error) { setUltimoError(legacy.error.message); showToast(legacy.error.message, 'error'); return }
        } else {
          // Se conserva la clave y su huella: reintentar lo mismo no puede duplicar.
          setUltimoError(res.error.message)
          showToast(res.error.message, 'error')
          // Si fue un timeout que sí llegó a aplicarse, el detalle lo muestra.
          await cargar()
          return
        }
      }

      clave.current = crypto.randomUUID()
      huellaLigada.current = null
      setCaptura({})
      setObs('')
      if (res.data) setDet(res.data as Detalle)
      showToast(intento.tipo === 'cerrar' ? 'Transferencia cerrada' : 'Recepción registrada', 'success')
      await Promise.all([cargar(), onChanged()])
    } finally {
      enCurso.current = false
      setEnviando(false)
    }
  }

  const escanear = () => {
    const codigo = scan.trim()
    if (!codigo || !det) return
    for (const l of det.lineas) {
      const s = enVuelo(l).find(x => x.serial_number === codigo)
      if (s) { marcar(l.item_id, s.serial_id, 'ok'); setScan(''); return }
    }
    showToast(`${codigo}: no figura entre las unidades en vuelo de esta transferencia`, 'info')
  }

  const items = construirItems()
  const hayCaptura = items.length > 0

  return <div className="fixed inset-0 z-[70] bg-black/65 flex items-end md:items-center justify-center">
    <div className="w-full max-w-4xl max-h-[92vh] overflow-y-auto bg-[#161b22] border border-[#30363d] rounded-t-2xl md:rounded-2xl p-5 relative">
      <button onClick={onClose} className="absolute right-4 top-4 text-gray-500"><X size={18} /></button>
      <div className="flex items-center gap-3 mb-1 pr-8">
        <h3 className="font-bold text-white">Transferencia #{transferencia.numero}</h3>
        {det && <span className={`text-[10px] uppercase font-semibold ${ESTADO_CAB[det.estado] || 'text-cyan-400'}`}>{det.estado.replace('_', ' ')}</span>}
        {det?.tiene_diferencias && <span className="text-[10px] uppercase font-semibold text-red-400">con diferencias</span>}
        <button onClick={cargar} disabled={cargando} className="text-gray-500 disabled:opacity-40" title="Actualizar"><RefreshCw size={14} /></button>
      </div>
      <p className="text-xs text-gray-500 mb-4">{transferencia.origen?.nombre || 'Origen'} → {transferencia.destino?.nombre || 'Destino'}</p>

      {errorCarga && <p className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300 mb-3">{errorCarga}</p>}
      {cargando && !det && <p className="text-xs text-gray-500">Cargando detalle...</p>}
      {!operable && recibible && <p className="rounded-xl border border-[#30363d] p-3 text-xs text-gray-400 mb-3">Sólo la sucursal de destino puede registrar la recepción. Vista de consulta.</p>}

      {editable && det && det.lineas.some(esSerial) && <div className="flex gap-2 mb-3">
        <input value={scan} onChange={e => setScan(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); escanear() } }} placeholder="Escanear IMEI / serie que llegó bien" className="input-personal flex-1 font-mono" />
        <button onClick={escanear} className="rounded-xl border border-cyan-500/30 px-3 text-xs text-cyan-300">Marcar</button>
      </div>}

      <div className="space-y-3">
        {det?.lineas.map(l => {
          const v = nombres[l.variant_id]
          const serial = esSerial(l)
          const c = cap(l.item_id)
          const vuelo = enVuelo(l)
          const pendienteReal = serial ? vuelo.length : l.pendiente
          const nuevo = serial ? 0 : (Number(c.ok) || 0) + (Number(c.danada) || 0)
          const sobrantePrevisto = serial ? 0 : Math.max(0, l.cantidad_recibida + l.cantidad_danada + nuevo - l.cantidad_enviada) - l.cantidad_sobrante
          return <div key={l.item_id} className="rounded-xl border border-[#30363d] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-white">{v?.product?.nombre || 'Producto'}{v?.color ? ` · ${v.color}` : ''}{serial ? <span className="ml-2 text-[10px] text-cyan-400">IMEI</span> : null}</p>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase font-semibold ${ESTADO_LINEA[l.estado_linea] || 'border-gray-500/30 text-gray-400'}`}>{l.estado_linea.replace('_', ' ')}</span>
            </div>
            <div className="mt-2 grid grid-cols-3 sm:grid-cols-6 gap-2 text-center">
              <Cifra label="Enviada" valor={l.cantidad_enviada} />
              <Cifra label="Recibida" valor={l.cantidad_recibida} tono="text-green-400" />
              <Cifra label="Dañada" valor={l.cantidad_danada} tono={l.cantidad_danada ? 'text-amber-300' : undefined} />
              <Cifra label="Faltante" valor={l.cantidad_faltante} tono={l.cantidad_faltante ? 'text-red-400' : undefined} />
              <Cifra label="Sobrante" valor={l.cantidad_sobrante} tono={l.cantidad_sobrante ? 'text-red-400' : undefined} />
              <Cifra label="Pendiente" valor={pendienteReal} tono={pendienteReal ? 'text-cyan-300' : undefined} />
            </div>

            {serial && <div className="mt-3">
              {editable && vuelo.length > 0 && <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                <p className="text-[10px] text-gray-600">Identifica cada unidad. Las que no marques siguen en vuelo; al cerrar quedan como faltantes.</p>
                <button type="button" onClick={() => setCap(l.item_id, { seriales: { ...c.seriales, ...Object.fromEntries(vuelo.filter(s => !c.seriales[s.serial_id]).map(s => [s.serial_id, 'ok' as MarcaSerial])) } })} className="text-[10px] text-cyan-400">Marcar sin marcar como "llegó bien"</button>
              </div>}
              <div className="space-y-1 max-h-60 overflow-y-auto">
                {l.seriales.map(s => {
                  const marca = c.seriales[s.serial_id]
                  return <div key={s.serial_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#21262d] px-2 py-1.5">
                    <span className="text-xs font-mono text-gray-300">{s.serial_number}</span>
                    {s.resultado !== null
                      ? <span className={`rounded-md border px-2 py-0.5 text-[10px] ${MARCA_ESTILO[s.resultado]}`}>{MARCA_TEXTO[s.resultado]} · {s.estado}</span>
                      : editable
                        ? <div className="flex gap-1">{(['ok', 'danado', 'faltante'] as MarcaSerial[]).map(m => <button type="button" key={m} onClick={() => marcar(l.item_id, s.serial_id, m)} className={`rounded-md border px-2 py-0.5 text-[10px] ${marca === m ? MARCA_ESTILO[m] : 'border-[#30363d] text-gray-500'}`}>{MARCA_TEXTO[m]}</button>)}</div>
                        : <span className="text-[10px] text-gray-500">en vuelo · {s.estado}</span>}
                  </div>
                })}
              </div>
            </div>}

            {!serial && editable && <div className="mt-3 grid grid-cols-2 gap-2">
              <label className="text-[10px] text-gray-500">Llegó bien
                <input type="number" min={0} step={1} value={c.ok} onChange={e => setCap(l.item_id, { ok: e.target.value })} className="input-personal mt-1 w-full" />
              </label>
              <label className="text-[10px] text-gray-500">Llegó dañada (no entra a stock)
                <input type="number" min={0} step={1} value={c.danada} onChange={e => setCap(l.item_id, { danada: e.target.value })} className="input-personal mt-1 w-full" />
              </label>
              {sobrantePrevisto > 0 && <p className="col-span-2 text-[10px] text-amber-300">Supera lo pendiente: el servidor lo registrará como sobrante (+{sobrantePrevisto}).</p>}
            </div>}
          </div>
        })}
      </div>

      {editable && det && <div className="mt-4 space-y-2">
        <p className="text-[10px] text-gray-600">Sin IMEI: lo que no se registre como recibido o dañado queda como faltante al cerrar. Las unidades dañadas no entran al stock vendible; los IMEI dañados pasan a cuarentena.</p>
        <textarea value={obs} onChange={e => setObs(e.target.value)} placeholder="Observación (opcional)" className="input-personal w-full" />
        {ultimoError && <p className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">{ultimoError}<br /><span className="text-red-400/70">Reintentar el mismo envío no duplica la recepción.</span></p>}
        <div className="grid sm:grid-cols-2 gap-2">
          <button disabled={enviando || !hayCaptura} onClick={() => enviar({ tipo: 'parcial', items, cerrar: false })} className="rounded-xl bg-cyan-500 py-2.5 text-sm font-bold text-black disabled:opacity-40">{enviando ? 'Enviando...' : 'Registrar recepción'}</button>
          <button disabled={enviando || !hayCaptura} onClick={() => { if (window.confirm('Se registrará lo marcado y la transferencia se cerrará: lo que siga pendiente quedará como faltante.')) enviar({ tipo: 'parcial', items, cerrar: true }) }} className="rounded-xl border border-cyan-500/40 py-2.5 text-sm font-bold text-cyan-300 disabled:opacity-40">Registrar y cerrar</button>
          <button disabled={enviando} onClick={() => { if (window.confirm('Se recibirá como correcto todo lo pendiente.')) enviar({ tipo: 'parcial', items: null, cerrar: true }) }} className="rounded-xl border border-green-500/30 py-2.5 text-sm text-green-300 disabled:opacity-40">Recibir todo lo pendiente</button>
          <button disabled={enviando} onClick={() => { if (window.confirm('Cerrar sin registrar más: todo lo pendiente quedará como faltante. No se puede deshacer.')) enviar({ tipo: 'cerrar' }) }} className="rounded-xl border border-red-500/30 py-2.5 text-sm text-red-300 disabled:opacity-40">Cerrar con faltantes</button>
        </div>
      </div>}

      {editable && !det && errorCarga && <div className="mt-3 space-y-2">
        {ultimoError && <p className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">{ultimoError}</p>}
        <button disabled={enviando} onClick={() => { if (window.confirm('Se recibirá como correcto todo lo pendiente.')) enviar({ tipo: 'parcial', items: null, cerrar: true }) }} className="w-full rounded-xl border border-green-500/30 py-2.5 text-sm text-green-300 disabled:opacity-40">{enviando ? 'Enviando...' : 'Recibir todo lo pendiente'}</button>
      </div>}
    </div>
  </div>
}

function Cifra({ label, valor, tono }: { label: string; valor: number; tono?: string }) {
  return <div className="rounded-lg bg-[#0d1117] px-1 py-1.5"><p className="text-[9px] uppercase text-gray-600">{label}</p><p className={`text-sm font-bold ${tono || 'text-gray-300'}`}>{valor}</p></div>
}

// crear_transferencia_stock no recibe clave idempotente: el botón se bloquea durante el envío.
function Nueva({ locs, vars, onClose, onSaved }: { locs: Loc[]; vars: Variant[]; onClose: () => void; onSaved: () => void }) {
  const { showToast } = useToast()
  const [dest, setDest] = useState(locs[0]?.id || '')
  const [items, setItems] = useState<Linea[]>([{ variant_id: '', cantidad: 1, serial_ids: [], seriales: [] }])
  const [obs, setObs] = useState('')
  const [saving, setSaving] = useState(false)
  const enCurso = useRef(false)
  const cambiarVar = async (idx: number, variant_id: string) => {
    let seriales: Serial[] = []
    const v = vars.find(x => x.id === variant_id)
    if (v?.product?.control_serial && variant_id) {
      const { data, error } = await supabase.rpc('seriales_disponibles', { p_variant_id: variant_id })
      if (error) { showToast(error.message, 'error'); return }
      seriales = (data as Serial[]) || []
    }
    setItems(xs => xs.map((q, j) => j === idx ? { ...q, variant_id, serial_ids: [], seriales } : q))
  }
  const toggleSerial = (idx: number, id: string) => setItems(xs => xs.map((q, j) => {
    if (j !== idx) return q
    const selected = q.serial_ids.includes(id) ? q.serial_ids.filter(x => x !== id) : [...q.serial_ids, id]
    return { ...q, serial_ids: selected, cantidad: selected.length || q.cantidad }
  }))
  const save = async () => {
    if (enCurso.current) return
    const clean = items.filter(i => i.variant_id && i.cantidad > 0)
    if (!dest || clean.length === 0) return
    for (const i of clean) {
      const v = vars.find(x => x.id === i.variant_id)
      if (v?.product?.control_serial && i.serial_ids.length !== i.cantidad) { showToast(`${v.product.nombre}: selecciona exactamente ${i.cantidad} serial(es)`, 'error'); return }
    }
    const payload = clean.map(({ variant_id, cantidad, serial_ids }) => ({ variant_id, cantidad, serial_ids }))
    enCurso.current = true
    setSaving(true)
    try {
      const { error } = await supabase.rpc('crear_transferencia_stock', { p_destino_id: dest, p_items: payload, p_observacion: obs || null })
      if (error) { showToast(error.message, 'error'); return }
      showToast('Transferencia creada', 'success')
      onSaved()
    } finally {
      enCurso.current = false
      setSaving(false)
    }
  }
  return <div className="fixed inset-0 z-[70] bg-black/65 flex items-end md:items-center justify-center"><div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto bg-[#161b22] border border-[#30363d] rounded-t-2xl md:rounded-2xl p-5 relative">
    <button onClick={onClose} className="absolute right-4 top-4 text-gray-500"><X size={18} /></button>
    <h3 className="font-bold text-white mb-4">Nueva transferencia</h3>
    <label className="text-xs text-gray-500">Destino</label>
    <select value={dest} onChange={e => setDest(e.target.value)} className="input-personal mt-1 w-full">{locs.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}</select>
    <div className="mt-4 space-y-3">{items.map((i, n) => {
      const v = vars.find(x => x.id === i.variant_id)
      const serial = v?.product?.control_serial
      return <div key={n} className="rounded-xl border border-[#30363d] p-3">
        <div className="grid grid-cols-[1fr_90px_30px] gap-2">
          <select value={i.variant_id} onChange={e => cambiarVar(n, e.target.value)} className="input-personal"><option value="">Producto...</option>{vars.map(v => <option key={v.id} value={v.id}>{v.product?.nombre || 'Producto'}{v.color ? ` · ${v.color}` : ''}{v.product?.control_serial ? ' · IMEI' : ''}</option>)}</select>
          <input type="number" min={1} readOnly={serial} value={i.cantidad} onChange={e => setItems(x => x.map((q, j) => j === n ? { ...q, cantidad: Number(e.target.value) } : q))} className="input-personal" />
          <button onClick={() => setItems(x => x.filter((_, j) => j !== n))} className="text-red-400">×</button>
        </div>
        {serial && <div className="mt-2"><p className="text-[10px] text-gray-600 mb-1">Selecciona las unidades exactas. La cantidad se ajusta a los seriales marcados.</p><div className="grid sm:grid-cols-2 gap-1 max-h-36 overflow-y-auto">{i.seriales.map(s => <button type="button" key={s.id} onClick={() => toggleSerial(n, s.id)} className={`text-left rounded-lg border px-2 py-1.5 text-xs font-mono ${i.serial_ids.includes(s.id) ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300' : 'border-[#30363d] text-gray-500'}`}>{s.serial_number}{s.imei2 ? ` / ${s.imei2}` : ''}</button>)}{i.seriales.length === 0 && <p className="text-xs text-red-400">No hay unidades serializadas disponibles.</p>}</div></div>}
      </div>
    })}</div>
    <button onClick={() => setItems(x => [...x, { variant_id: '', cantidad: 1, serial_ids: [], seriales: [] }])} className="mt-2 text-xs text-cyan-400">+ Agregar producto</button>
    <textarea value={obs} onChange={e => setObs(e.target.value)} placeholder="Observación" className="input-personal mt-3 w-full" />
    <button onClick={save} disabled={saving} className="mt-4 w-full rounded-xl bg-cyan-500 py-2.5 text-sm font-bold text-black disabled:opacity-40">{saving ? 'Creando...' : 'Crear transferencia'}</button>
  </div></div>
}
