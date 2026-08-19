import { useState, useEffect } from 'react'
import { X, UserPlus, User, Trash2, Plus } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { queueVenta, registrarVenta as registrarVentaRPC, ErrorRegistroVenta } from '../lib/offline'
import { calcularVuelto, sumarMontos, restarMontos } from '../lib/money'
import type { CartItem, MetodoPago, PagoDetalle, Cliente, Sale, TipoComprobante, TipoDocumentoCliente } from '../types'
import PagoDigitalCulqi from './PagoDigitalCulqi'

export interface ResultadoVenta { saleId: string; numero: number | null; fecha: string; cart: CartItem[]; subtotal: number; impuesto: number; total: number; pagos: PagoDetalle[]; clienteNombre: string | null }

export default function ModalPago({ total, subtotal, impuesto, cart, online, nubefactActivo, culqiActivo, locationId, cajeroId, cashSessionId, clienteInicial, titulo, onClose, onConfirm }: {
  total: number; subtotal: number; impuesto: number; cart: CartItem[]; online: boolean; nubefactActivo: boolean; culqiActivo: boolean
  locationId: string | null; cajeroId: string | null; cashSessionId: string | null
  clienteInicial?: Cliente | null; titulo?: string
  onClose: () => void; onConfirm: (r: ResultadoVenta | null) => void
}) {
  const [mixto, setMixto] = useState(false)
  const [metodo, setMetodo] = useState<MetodoPago>('efectivo')
  const [recibido, setRecibido] = useState('')
  const [referencia, setReferencia] = useState('')
  const [lineas, setLineas] = useState<PagoDetalle[]>([{ metodo: 'efectivo', monto: total }])
  const [clienteQuery, setClienteQuery] = useState('')
  const [clienteSel, setClienteSel] = useState<Cliente | null>(clienteInicial ?? null)
  const [clienteOpts, setClienteOpts] = useState<Cliente[]>([])
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')
  const [tipoComprobante, setTipoComprobante] = useState<TipoComprobante>('boleta')
  const [docCliente, setDocCliente] = useState('')
  const [denominacion, setDenominacion] = useState('')
  const [direccionCliente, setDireccionCliente] = useState('')
  // El pago con Yape/Plin verificado por Culqi solo se soporta como método único (no
  // dentro de "Pago mixto" todavía) — requiere QR real con confirmación por webhook,
  // así que sin conexión no se puede ofrecer (no hay forma de verificar un pago real).
  const pagoDigitalDisponible = culqiActivo && online && !mixto && (metodo === 'yape' || metodo === 'plin')
  // Generado UNA vez al abrir el modal y reutilizado en todos los reintentos: garantiza
  // que un doble clic o un timeout de red nunca creen dos ventas (idempotencia real vive en el backend).
  const [clientTransactionId] = useState(() => crypto.randomUUID())
  const vuelto = metodo === 'efectivo' ? calcularVuelto(Number(recibido || 0), total) : 0

  useEffect(() => {
    if (!mixto) return
    setLineas((ls) => ls.length === 1 ? [{ ...ls[0], monto: total }] : ls)
  }, [total, mixto])

  const buscarCliente = async (texto: string) => {
    setClienteQuery(texto); setClienteSel(null)
    if (texto.length < 2 || !online) { setClienteOpts([]); return }
    const { data } = await supabase.from('clientes').select('*').or(`nombre.ilike.%${texto}%,telefono.ilike.%${texto}%`).limit(6)
    setClienteOpts(data || [])
  }

  const sumaLineas = sumarMontos(lineas.map((l) => Number(l.monto) || 0))
  const faltante = restarMontos(total, sumaLineas)
  const vueltoMixto = sumaLineas > total ? restarMontos(sumaLineas, total) : 0

  const agregarLinea = () => setLineas((l) => [...l, { metodo: 'efectivo', monto: Math.max(0, faltante) }])
  const quitarLinea = (idx: number) => setLineas((l) => l.filter((_, i) => i !== idx))
  const actualizarLinea = (idx: number, patch: Partial<PagoDetalle>) => setLineas((l) => l.map((x, i) => i === idx ? { ...x, ...patch } : x))

  const confirmar = async (pagoDigitalId?: string) => {
    setGuardando(true); setError('')
    const pagos: PagoDetalle[] = mixto
      ? lineas.filter((l) => l.monto > 0)
      : [{ metodo, monto: total, referencia: metodo !== 'efectivo' ? referencia : undefined, pagoDigitalId }]
    if (mixto && sumaLineas < total - 0.005) { setError('La suma de los pagos no cubre el total'); setGuardando(false); return }
    if (pagoDigitalDisponible && !pagoDigitalId) { setGuardando(false); return }
    if (nubefactActivo && tipoComprobante === 'factura') {
      if (!/^\d{11}$/.test(docCliente)) { setError('Para factura, ingresa un RUC válido (11 dígitos)'); setGuardando(false); return }
      if (!denominacion.trim()) { setError('Para factura, ingresa la razón social del cliente'); setGuardando(false); return }
    }
    if (nubefactActivo && tipoComprobante === 'boleta' && docCliente && !/^\d{8}$/.test(docCliente)) {
      setError('El DNI debe tener 8 dígitos'); setGuardando(false); return
    }
    const clienteId = clienteSel?.id ?? null
    const ventaBase = {
      clientTransactionId, cart, subtotal, impuesto, total, pagos,
      clienteId, clienteDoc: null, cashSessionId, locationId, cajeroId,
      comprobante: nubefactActivo ? {
        tipoComprobante,
        clienteTipoDoc: (tipoComprobante === 'factura' ? 'ruc' : docCliente ? 'dni' : null) as TipoDocumentoCliente | null,
        clienteNumDoc: docCliente || null,
        clienteDenominacion: denominacion.trim() || clienteSel?.nombre || null,
        clienteDireccion: direccionCliente.trim() || null,
      } : { tipoComprobante: 'boleta' as TipoComprobante, clienteTipoDoc: null, clienteNumDoc: null, clienteDenominacion: null, clienteDireccion: null },
    }
    try {
      if (!online) throw new ErrorRegistroVenta('offline', false)
      const sale: Sale = await registrarVentaRPC(ventaBase)
      onConfirm({ saleId: sale.id, numero: sale.numero, fecha: sale.fecha, cart, subtotal, impuesto, total, pagos, clienteNombre: clienteSel?.nombre ?? null })
    } catch (e) {
      // esErrorDeServidor = el request SÍ llegó al backend y fue rechazado por una
      // regla de negocio (ej. stock insuficiente) -> no se debe encolar, hay que
      // mostrárselo al cajero. Cualquier otro fallo (nunca llegó respuesta, fetch
      // roto, timeout) se trata como desconexión y se encola — más confiable que
      // adivinar por el texto del error, que varía entre navegadores.
      const esErrorDeServidor = e instanceof ErrorRegistroVenta && e.esErrorDeServidor
      if (!esErrorDeServidor) {
        await queueVenta({ ...ventaBase, createdAt: new Date().toISOString() })
        onConfirm({ saleId: 'pendiente-sync', numero: null, fecha: new Date().toISOString(), cart, subtotal, impuesto, total, pagos, clienteNombre: clienteSel?.nombre ?? null })
      } else {
        // Mensaje humano tal como lo produce la RPC (ej. "Stock insuficiente para completar la venta")
        setError(e instanceof Error ? e.message : 'No se pudo registrar la venta')
      }
    } finally { setGuardando(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end md:items-center justify-center z-50 p-0 md:p-4">
      <div className="bg-[#161b22] rounded-t-2xl md:rounded-2xl w-full max-w-sm p-5 relative border border-[#30363d] shadow-2xl max-h-[92vh] overflow-y-auto overflow-x-hidden">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-500 hover:text-white" aria-label="Cerrar"><X size={20} /></button>
        <h3 className="font-display font-bold text-lg text-white mb-1">{titulo || 'Cobrar venta'}</h3>
        <p className="text-3xl font-bold text-cyan-400 mb-4">S/ {total.toFixed(2)}</p>

        {/* Cliente */}
        <div className="mb-4">
          {clienteSel ? (
            <div className="flex items-center justify-between bg-cyan-500/10 border border-cyan-500/30 rounded-xl px-3 py-2">
              <span className="flex items-center gap-2 text-sm text-cyan-300"><User size={14} /> {clienteSel.nombre}</span>
              <button onClick={() => { setClienteSel(null); setClienteQuery('') }} className="text-gray-400 hover:text-white" aria-label="Quitar cliente seleccionado"><X size={14} /></button>
            </div>
          ) : (
            <div className="relative">
              <UserPlus size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
              <input value={clienteQuery} onChange={(e) => buscarCliente(e.target.value)} placeholder="Cliente (opcional)"
                className="w-full pl-8 pr-3 py-2 rounded-lg bg-[#0d1117] border border-[#30363d] text-white text-xs placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500" />
              {clienteOpts.length > 0 && (
                <div className="absolute z-10 top-full mt-1 left-0 right-0 bg-[#21262d] border border-[#30363d] rounded-lg overflow-hidden max-h-32 overflow-y-auto overflow-x-hidden">
                  {clienteOpts.map((c) => (
                    <button key={c.id} onClick={() => { setClienteSel(c); setClienteOpts([]) }}
                      className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-cyan-500/10">{c.nombre} {c.telefono && `· ${c.telefono}`}</button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {nubefactActivo && (
          <div className="mb-4">
            <div className="flex bg-[#0d1117] rounded-lg border border-[#30363d] overflow-hidden mb-2">
              <button onClick={() => setTipoComprobante('boleta')} className={`flex-1 py-2 text-xs font-bold ${tipoComprobante === 'boleta' ? 'bg-cyan-500 text-black' : 'text-gray-400'}`}>Boleta</button>
              <button onClick={() => setTipoComprobante('factura')} className={`flex-1 py-2 text-xs font-bold ${tipoComprobante === 'factura' ? 'bg-cyan-500 text-black' : 'text-gray-400'}`}>Factura</button>
            </div>
            {tipoComprobante === 'factura' ? (
              <div className="space-y-2">
                <input value={docCliente} onChange={(e) => setDocCliente(e.target.value.replace(/\D/g, '').slice(0, 11))} placeholder="RUC (11 dígitos)" inputMode="numeric"
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500" />
                <input value={denominacion} onChange={(e) => setDenominacion(e.target.value)} placeholder="Razón social"
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500" />
                <input value={direccionCliente} onChange={(e) => setDireccionCliente(e.target.value)} placeholder="Dirección fiscal (opcional)"
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500" />
              </div>
            ) : (
              <input value={docCliente} onChange={(e) => setDocCliente(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="DNI (opcional)" inputMode="numeric"
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500" />
            )}
          </div>
        )}

        <div className="flex bg-[#0d1117] rounded-lg border border-[#30363d] overflow-hidden mb-4">
          <button onClick={() => setMixto(false)} className={`flex-1 py-2 text-xs font-bold ${!mixto ? 'bg-cyan-500 text-black' : 'text-gray-400'}`}>Un método</button>
          <button onClick={() => setMixto(true)} className={`flex-1 py-2 text-xs font-bold ${mixto ? 'bg-cyan-500 text-black' : 'text-gray-400'}`}>Pago mixto</button>
        </div>

        {!mixto ? (
          <>
            <div className="grid grid-cols-4 gap-2 mb-4">
              {(['efectivo', 'tarjeta', 'yape', 'plin'] as MetodoPago[]).map((m) => {
                const deshabilitado = culqiActivo && !online && (m === 'yape' || m === 'plin')
                return (
                  <button key={m} onClick={() => !deshabilitado && setMetodo(m)} disabled={deshabilitado}
                    title={deshabilitado ? 'Sin conexión: no se puede verificar un pago digital real' : undefined}
                    className={`py-2.5 rounded-xl text-xs font-bold capitalize transition-all ${metodo === m ? 'bg-cyan-500 text-black' : 'bg-[#21262d] border border-[#30363d] text-gray-400'} ${deshabilitado ? 'opacity-30 cursor-not-allowed' : ''}`}>{m}</button>
                )
              })}
            </div>
            {metodo === 'efectivo' ? (
              <div className="mb-4">
                <label className="text-xs text-gray-500 font-semibold">Monto recibido</label>
                <input autoFocus type="number" value={recibido} onChange={(e) => setRecibido(e.target.value)}
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mt-1 text-white text-lg focus:outline-none focus:ring-2 focus:ring-cyan-500" />
                <div className="flex justify-between mt-2 bg-[#21262d] rounded-lg p-3">
                  <span className="text-gray-400 text-sm">Vuelto</span>
                  <span className="text-green-400 font-bold text-lg">S/ {vuelto.toFixed(2)}</span>
                </div>
              </div>
            ) : pagoDigitalDisponible ? (
              <div className="mb-4">
                <PagoDigitalCulqi monto={total} metodo={metodo as 'yape' | 'plin'} cajeroId={cajeroId} locationId={locationId}
                  clienteNombre={clienteSel?.nombre}
                  onConfirmado={(pagoId) => confirmar(pagoId)}
                  onCancelar={() => setMetodo('efectivo')} />
              </div>
            ) : (
              <div className="mb-4">
                <label className="text-xs text-gray-500 font-semibold">Código de operación</label>
                <input autoFocus value={referencia} onChange={(e) => setReferencia(e.target.value)}
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mt-1 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500" />
              </div>
            )}
          </>
        ) : (
          <div className="mb-4 space-y-2">
            {lineas.map((l, idx) => (
              <div key={idx} className="bg-[#0d1117] rounded-xl border border-[#30363d] p-2.5">
                <div className="flex items-center gap-2 mb-2">
                  <select value={l.metodo} onChange={(e) => actualizarLinea(idx, { metodo: e.target.value as MetodoPago })}
                    className="flex-1 bg-[#161b22] border border-[#30363d] rounded-lg px-2 py-1.5 text-xs text-white capitalize focus:outline-none">
                    {(['efectivo', 'tarjeta', 'yape', 'plin'] as MetodoPago[])
                      .filter((m) => !culqiActivo || (m !== 'yape' && m !== 'plin'))
                      .map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <input type="number" value={l.monto || ''} onChange={(e) => actualizarLinea(idx, { monto: Number(e.target.value) || 0 })}
                    placeholder="Monto" className="w-24 bg-[#161b22] border border-[#30363d] rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none" />
                  {lineas.length > 1 && <button onClick={() => quitarLinea(idx)} className="text-gray-500 hover:text-red-400"><Trash2 size={14} /></button>}
                </div>
                {l.metodo !== 'efectivo' && (
                  <input value={l.referencia || ''} onChange={(e) => actualizarLinea(idx, { referencia: e.target.value })} placeholder="Código de operación (opcional)"
                    className="w-full bg-[#161b22] border border-[#30363d] rounded-lg px-2 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none" />
                )}
              </div>
            ))}
            <button onClick={agregarLinea} className="w-full flex items-center justify-center gap-1.5 border border-dashed border-[#30363d] text-gray-400 text-xs font-semibold py-2 rounded-lg hover:border-cyan-500/50">
              <Plus size={13} /> Agregar método de pago
            </button>
            <div className="flex justify-between bg-[#21262d] rounded-lg p-3 text-sm">
              <span className="text-gray-400">{faltante > 0.005 ? 'Falta cubrir' : 'Vuelto'}</span>
              <span className={`font-bold ${faltante > 0.005 ? 'text-orange-400' : 'text-green-400'}`}>S/ {(faltante > 0.005 ? faltante : vueltoMixto).toFixed(2)}</span>
            </div>
          </div>
        )}

        {error && <p className="text-red-400 text-xs mb-3 bg-red-500/10 rounded-lg p-2">{error}</p>}
        {!online && <p className="text-orange-400 text-xs mb-3 bg-orange-500/10 rounded-lg p-2">Sin conexión: la venta se guardará y sincronizará automáticamente.</p>}
        {!pagoDigitalDisponible && (
          <button onClick={() => confirmar()} disabled={guardando || (mixto && sumaLineas < total - 0.005)}
            className="w-full bg-gradient-to-r from-cyan-500 to-cyan-600 disabled:opacity-40 text-black font-bold py-3.5 rounded-xl transition-all active:scale-[0.98]">
            {guardando ? 'Procesando...' : '✓ Confirmar pago'}</button>
        )}
      </div>
    </div>
  )
}
