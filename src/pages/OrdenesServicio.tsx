import { useState, useEffect } from 'react'
import { Plus, X, Wrench, Search, Printer, Phone, CreditCard, CheckCircle2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useConfig } from '../lib/config'
import { useOnlineStatus } from '../lib/offline'
import { calcularTotalesCarrito } from '../lib/money'
import { useToast } from '../lib/toast'
import type { OrdenServicio, EstadoOrden, CartItem, Cliente, ProductVariant } from '../types'
import ReciboOrden from '../components/ReciboOrden'
import ReciboVenta from '../components/ReciboVenta'
import ModalPago, { type ResultadoVenta } from '../components/ModalPago'

const ESTADOS: { value: EstadoOrden; label: string; color: string }[] = [
  { value: 'recibido', label: 'Recibido', color: 'bg-gray-500/15 text-gray-300 border-gray-500/30' },
  { value: 'diagnosticado', label: 'Diagnosticado', color: 'bg-orange-500/15 text-orange-400 border-orange-500/30' },
  { value: 'en_reparacion', label: 'En reparación', color: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30' },
  { value: 'listo', label: 'Listo', color: 'bg-green-500/15 text-green-400 border-green-500/30' },
  { value: 'entregado', label: 'Entregado', color: 'bg-gray-500/15 text-gray-500 border-gray-500/30' },
  { value: 'cancelado', label: 'Cancelado', color: 'bg-red-500/15 text-red-400 border-red-500/30' },
]

export default function OrdenesServicio() {
  const { staff, cashSessionId } = useAuth()
  const { config } = useConfig()
  const { online } = useOnlineStatus()
  const { showToast } = useToast()
  const [ordenes, setOrdenes] = useState<OrdenServicio[]>([])
  const [filtro, setFiltro] = useState<EstadoOrden | 'todos'>('todos')
  const [busqueda, setBusqueda] = useState('')
  const [nuevaOpen, setNuevaOpen] = useState(false)
  const [detalle, setDetalle] = useState<OrdenServicio | null>(null)
  const [imprimir, setImprimir] = useState<OrdenServicio | null>(null)
  const [loading, setLoading] = useState(true)
  const [cobrarOrden, setCobrarOrden] = useState<OrdenServicio | null>(null)
  const [servicioVariant, setServicioVariant] = useState<ProductVariant | null>(null)
  const [reciboVenta, setReciboVenta] = useState<(ResultadoVenta & { cajeroNombre: string | null }) | null>(null)

  const cargar = async () => {
    const { data } = await supabase.from('ordenes_servicio').select('*').order('numero', { ascending: false })
    setOrdenes(data || [])
    setLoading(false)
  }
  useEffect(() => { cargar() }, [])

  // Producto genérico "Servicio técnico" (creado por la migración) — es la variante
  // que se usa para cobrar cualquier orden; el precio real es el costo final de cada
  // orden, no el precio de este producto.
  useEffect(() => {
    supabase.from('products').select('id, nombre, sku, precio_base, imagen_url').eq('nombre', 'Servicio técnico').maybeSingle()
      .then(async ({ data: prod }) => {
        if (!prod) return
        const { data: variant } = await supabase.from('product_variants')
          .select('id, product_id, color, modelo_celular_id, precio_override, codigo_barras').eq('product_id', prod.id).limit(1).maybeSingle()
        if (variant) setServicioVariant({ ...variant, product: prod } as unknown as ProductVariant)
      })
  }, [])

  const IGV = config.igv_activo ? config.igv_porcentaje / 100 : 0

  const filtradas = ordenes.filter((o) => {
    if (filtro !== 'todos' && o.estado !== filtro) return false
    const t = `${o.cliente_nombre} ${o.cliente_telefono || ''} ${o.equipo_marca || ''} ${o.equipo_modelo || ''} ${o.numero}`.toLowerCase()
    return t.includes(busqueda.toLowerCase())
  })

  return (
    <div className="p-3 md:p-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <h1 className="font-display font-bold text-xl text-white">Órdenes de servicio</h1>
        <button onClick={() => setNuevaOpen(true)}
          className="flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-bold px-4 py-2.5 rounded-xl hover:shadow-lg hover:shadow-cyan-500/30 transition-all text-sm">
          <Plus size={16} /> Nueva orden
        </button>
      </div>

      <div className="relative mb-3">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" size={16} />
        <input value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="Buscar por cliente, teléfono o equipo..."
          className="w-full pl-10 pr-3 py-2.5 rounded-xl bg-[#161b22] border border-[#30363d] text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500" />
      </div>

      <div className="flex gap-2 mb-4 overflow-x-auto pb-1 scrollbar-hide">
        <button onClick={() => setFiltro('todos')}
          className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap border shrink-0 ${filtro === 'todos' ? 'bg-cyan-500 text-black border-cyan-500' : 'bg-[#161b22] border-[#30363d] text-gray-400'}`}>
          Todos
        </button>
        {ESTADOS.map((e) => (
          <button key={e.value} onClick={() => setFiltro(e.value)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap border shrink-0 ${filtro === e.value ? 'bg-cyan-500 text-black border-cyan-500' : `${e.color}`}`}>
            {e.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
        {loading && <p className="text-gray-500 text-sm col-span-full py-10 text-center">Cargando...</p>}
        {!loading && filtradas.map((o) => {
          const est = ESTADOS.find((e) => e.value === o.estado)
          return (
            <button key={o.id} onClick={() => setDetalle(o)}
              className="text-left bg-[#161b22] rounded-2xl border border-[#30363d] p-4 hover:border-cyan-500/50 transition-all">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <p className="font-bold text-white text-sm">#{o.numero} · {o.cliente_nombre}</p>
                  {o.cliente_telefono && <p className="text-xs text-gray-500 flex items-center gap-1 mt-0.5"><Phone size={11} /> {o.cliente_telefono}</p>}
                </div>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border shrink-0 ${est?.color}`}>{est?.label}</span>
              </div>
              <p className="text-xs text-gray-400 mb-1">{[o.equipo_marca, o.equipo_modelo].filter(Boolean).join(' ') || 'Equipo no especificado'}</p>
              <p className="text-xs text-gray-500 line-clamp-2">{o.problema}</p>
              <div className="flex items-center justify-between mt-2">
                <p className="text-[10px] text-gray-600">{new Date(o.fecha_recepcion).toLocaleDateString('es-PE')}</p>
                {o.venta_id && <span className="flex items-center gap-1 text-[10px] font-bold text-green-400"><CheckCircle2 size={11} /> Pagado</span>}
              </div>
            </button>
          )
        })}
        {!loading && filtradas.length === 0 && (
          <div className="col-span-full py-16 text-center text-gray-500">
            <Wrench size={32} className="mx-auto mb-2 text-gray-600" />
            <p className="text-sm">Sin órdenes de servicio</p>
          </div>
        )}
      </div>

      {nuevaOpen && <ModalNuevaOrden locationId={staff?.location_id ?? null} onClose={() => setNuevaOpen(false)} onCreated={() => { setNuevaOpen(false); cargar(); showToast('Orden registrada', 'success') }} />}
      {detalle && (
        <ModalDetalleOrden orden={detalle} onClose={() => setDetalle(null)}
          onUpdated={(o) => { setDetalle(null); cargar(); setImprimir(o); showToast('Orden actualizada', 'success') }}
          onImprimir={() => setImprimir(detalle)}
          onCobrar={servicioVariant ? (o) => { setCobrarOrden(o); setDetalle(null); cargar() } : undefined} />
      )}
      {imprimir && <ReciboOrden orden={imprimir} onClose={() => setImprimir(null)} />}

      {cobrarOrden && servicioVariant && (() => {
        const costo = Number(cobrarOrden.costo_final) || 0
        const cart: CartItem[] = [{ variant: servicioVariant, cantidad: 1, precio_unitario: costo, descuento: 0 }]
        const { subtotal, impuesto, total } = calcularTotalesCarrito(cart, IGV)
        const clienteInicial: Cliente | null = cobrarOrden.cliente_id
          ? { id: cobrarOrden.cliente_id, nombre: cobrarOrden.cliente_nombre, telefono: cobrarOrden.cliente_telefono, email: null, notas: null, created_at: '' }
          : null
        return (
          <ModalPago total={total} subtotal={subtotal} impuesto={impuesto} cart={cart} online={online}
            nubefactActivo={config.nubefact_activo} culqiActivo={config.culqi_activo}
            locationId={staff?.location_id ?? null} cajeroId={staff?.id ?? null} cashSessionId={cashSessionId}
            clienteInicial={clienteInicial} titulo={`Cobrar orden #${cobrarOrden.numero}`}
            onClose={() => setCobrarOrden(null)}
            onConfirm={(res) => {
              setCobrarOrden(null)
              if (!res) return
              // Una venta 'pendiente-sync' (offline) aún no tiene id real — se vincula
              // cuando el propio flujo de sincronización la registre más adelante.
              if (res.saleId !== 'pendiente-sync') {
                supabase.from('ordenes_servicio').update({ venta_id: res.saleId }).eq('id', cobrarOrden.id).then(() => cargar())
              }
              setReciboVenta({ ...res, cajeroNombre: staff?.nombre ?? null })
              if (res.saleId === 'pendiente-sync') showToast('Cobro guardado sin conexión, se sincronizará automáticamente', 'info')
            }} />
        )
      })()}
      {reciboVenta && <ReciboVenta {...reciboVenta} autoImprimir={config.auto_imprimir_ticket} onClose={() => setReciboVenta(null)} />}
    </div>
  )
}

function ModalNuevaOrden({ locationId, onClose, onCreated }: { locationId: string | null; onClose: () => void; onCreated: () => void }) {
  const [clienteNombre, setClienteNombre] = useState('')
  const [clienteTelefono, setClienteTelefono] = useState('')
  const [equipoMarca, setEquipoMarca] = useState('')
  const [equipoModelo, setEquipoModelo] = useState('')
  const [problema, setProblema] = useState('')
  const [costoEstimado, setCostoEstimado] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')

  const guardar = async () => {
    if (!clienteNombre.trim() || !problema.trim()) { setError('Nombre del cliente y problema son obligatorios'); return }
    setGuardando(true); setError('')
    let clienteId: string | null = null
    if (clienteTelefono.trim()) {
      const { data: existente } = await supabase.from('clientes').select('id').eq('telefono', clienteTelefono.trim()).maybeSingle()
      if (existente) clienteId = existente.id
      else {
        const { data: nuevo } = await supabase.from('clientes').insert({ nombre: clienteNombre.trim(), telefono: clienteTelefono.trim() }).select('id').single()
        clienteId = nuevo?.id ?? null
      }
    }
    const { error: err } = await supabase.from('ordenes_servicio').insert({
      cliente_id: clienteId, cliente_nombre: clienteNombre.trim(), cliente_telefono: clienteTelefono.trim() || null,
      equipo_marca: equipoMarca.trim() || null, equipo_modelo: equipoModelo.trim() || null,
      problema: problema.trim(), costo_estimado: Number(costoEstimado) || 0, location_id: locationId,
    })
    setGuardando(false)
    if (err) { setError(err.message); return }
    onCreated()
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end md:items-center justify-center z-50 p-0 md:p-4">
      <div className="bg-[#161b22] rounded-t-2xl md:rounded-2xl w-full max-w-md p-5 border border-[#30363d] shadow-2xl relative max-h-[90vh] overflow-y-auto overflow-x-hidden">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-500 hover:text-white" aria-label="Cerrar"><X size={20} /></button>
        <h3 className="font-display font-bold text-lg text-white mb-4">Nueva orden de servicio</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500 font-semibold">Nombre del cliente *</label>
            <input autoFocus value={clienteNombre} onChange={(e) => setClienteNombre(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
          <div>
            <label className="text-xs text-gray-500 font-semibold">Teléfono</label>
            <input value={clienteTelefono} onChange={(e) => setClienteTelefono(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-500 font-semibold">Marca del equipo</label>
              <input value={equipoMarca} onChange={(e) => setEquipoMarca(e.target.value)}
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
            </div>
            <div>
              <label className="text-xs text-gray-500 font-semibold">Modelo</label>
              <input value={equipoModelo} onChange={(e) => setEquipoModelo(e.target.value)}
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-500 font-semibold">Problema reportado *</label>
            <textarea value={problema} onChange={(e) => setProblema(e.target.value)} rows={3}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-none" />
          </div>
          <div>
            <label className="text-xs text-gray-500 font-semibold">Costo estimado (S/)</label>
            <input type="number" value={costoEstimado} onChange={(e) => setCostoEstimado(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
          {error && <p className="text-red-400 text-xs bg-red-500/10 rounded-lg p-2">{error}</p>}
          <button onClick={guardar} disabled={guardando}
            className="w-full bg-gradient-to-r from-cyan-500 to-cyan-600 disabled:opacity-40 text-black font-bold py-3 rounded-xl transition-all active:scale-[0.98] mt-1">
            {guardando ? 'Guardando...' : 'Registrar orden'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ModalDetalleOrden({ orden, onClose, onUpdated, onImprimir, onCobrar }: { orden: OrdenServicio; onClose: () => void; onUpdated: (o: OrdenServicio) => void; onImprimir: () => void; onCobrar?: (o: OrdenServicio) => void }) {
  const [estado, setEstado] = useState<EstadoOrden>(orden.estado)
  const [diagnostico, setDiagnostico] = useState(orden.diagnostico || '')
  const [costoFinal, setCostoFinal] = useState(orden.costo_final != null ? String(orden.costo_final) : '')
  const [notas, setNotas] = useState(orden.notas || '')
  const [guardando, setGuardando] = useState(false)
  const yaPagada = !!orden.venta_id
  const puedeCobrar = !yaPagada && Number(costoFinal) > 0

  const guardar = async (opts?: { silencioso?: boolean }): Promise<OrdenServicio | null> => {
    setGuardando(true)
    const patch: Record<string, unknown> = { estado, diagnostico: diagnostico.trim() || null, notas: notas.trim() || null }
    if (costoFinal) patch.costo_final = Number(costoFinal)
    if (estado === 'entregado' && !orden.fecha_entrega) patch.fecha_entrega = new Date().toISOString()
    const { data } = await supabase.from('ordenes_servicio').update(patch).eq('id', orden.id).select().single()
    setGuardando(false)
    if (!opts?.silencioso) onUpdated(data || orden)
    return data
  }

  // Guarda cualquier cambio pendiente (ej. un costo final recién tecleado) antes de
  // cobrar, para que el monto que se cobra sea siempre el que se ve en pantalla.
  const handleCobrar = async () => {
    const actualizado = await guardar({ silencioso: true })
    if (actualizado && onCobrar) onCobrar(actualizado)
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end md:items-center justify-center z-50 p-0 md:p-4">
      <div className="bg-[#161b22] rounded-t-2xl md:rounded-2xl w-full max-w-md p-5 border border-[#30363d] shadow-2xl relative max-h-[90vh] overflow-y-auto overflow-x-hidden">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-500 hover:text-white" aria-label="Cerrar"><X size={20} /></button>
        <h3 className="font-display font-bold text-lg text-white mb-1">Orden #{orden.numero}</h3>
        <p className="text-sm text-gray-400 mb-4">{orden.cliente_nombre} {orden.cliente_telefono && `· ${orden.cliente_telefono}`}</p>
        <div className="space-y-3">
          <div>
            <p className="text-xs text-gray-500 font-semibold mb-1">Equipo</p>
            <p className="text-sm text-white">{[orden.equipo_marca, orden.equipo_modelo].filter(Boolean).join(' ') || '—'}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 font-semibold mb-1">Problema reportado</p>
            <p className="text-sm text-gray-300">{orden.problema}</p>
          </div>
          <div>
            <label className="text-xs text-gray-500 font-semibold">Estado</label>
            <select value={estado} onChange={(e) => setEstado(e.target.value as EstadoOrden)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500">
              {ESTADOS.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 font-semibold">Diagnóstico</label>
            <textarea value={diagnostico} onChange={(e) => setDiagnostico(e.target.value)} rows={2}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-none" />
          </div>
          <div>
            <label className="text-xs text-gray-500 font-semibold">Costo final (S/)</label>
            <input type="number" value={costoFinal} onChange={(e) => setCostoFinal(e.target.value)} disabled={yaPagada}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 disabled:opacity-50" />
            {yaPagada
              ? <p className="flex items-center gap-1.5 text-xs text-green-400 mt-1.5"><CheckCircle2 size={13} /> Ya cobrada — el monto no se puede editar</p>
              : onCobrar && <p className="text-xs text-gray-600 mt-1.5">Guarda el costo final y luego usa "Cobrar" para generar el comprobante de pago.</p>}
          </div>
          <div>
            <label className="text-xs text-gray-500 font-semibold">Notas internas</label>
            <textarea value={notas} onChange={(e) => setNotas(e.target.value)} rows={2}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-none" />
          </div>
          {onCobrar && (
            <button onClick={handleCobrar} disabled={!puedeCobrar || guardando}
              className="w-full flex items-center justify-center gap-1.5 bg-gradient-to-r from-green-500 to-green-600 disabled:opacity-30 disabled:from-[#21262d] disabled:to-[#21262d] disabled:text-gray-600 text-black font-bold py-3 rounded-xl transition-all active:scale-[0.98] text-sm">
              <CreditCard size={15} /> {yaPagada ? 'Ya cobrada' : 'Cobrar orden'}
            </button>
          )}
          <div className="flex gap-2 pt-1">
            <button onClick={onImprimir} className="flex-1 flex items-center justify-center gap-1.5 bg-[#21262d] border border-[#30363d] text-gray-300 font-semibold py-3 rounded-xl text-sm">
              <Printer size={15} /> Comprobante
            </button>
            <button onClick={() => guardar()} disabled={guardando}
              className="flex-1 bg-gradient-to-r from-cyan-500 to-cyan-600 disabled:opacity-40 text-black font-bold py-3 rounded-xl transition-all active:scale-[0.98] text-sm">
              {guardando ? 'Guardando...' : 'Guardar cambios'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
