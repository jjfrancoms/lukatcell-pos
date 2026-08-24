import { useEffect, useState } from 'react'
import { Printer, X, AlertTriangle, FileText, Loader2 } from 'lucide-react'
import { useConfig } from '../lib/config'
import { supabase } from '../lib/supabase'
import { imprimirHtmlHardware } from '../lib/hardware'
import type { PagoDetalle, ReciboLineaItem, EstadoComprobante } from '../types'

interface Props {
  saleId: string
  numero: number | null
  fecha: string
  cart: ReciboLineaItem[]
  subtotal: number
  impuesto: number
  total: number
  pagos: PagoDetalle[]
  clienteNombre?: string | null
  cajeroNombre?: string | null
  autoImprimir?: boolean
  onClose: () => void
}

function formatearNumero(numero: number | null): string {
  if (numero === null) return 'Pendiente de sincronización'
  return `V-${String(numero).padStart(6, '0')}`
}

const MAX_INTENTOS_POLL_COMPROBANTE = 10

export default function ReciboVenta({ saleId, numero, fecha, cart, subtotal, impuesto, total, pagos, clienteNombre, cajeroNombre, autoImprimir, onClose }: Props) {
  const { config } = useConfig()
  const [errorImpresion, setErrorImpresion] = useState(false)
  const [comprobante, setComprobante] = useState<{ estado: EstadoComprobante; enlace_pdf: string | null } | null>(null)

  useEffect(() => {
    if (!config.nubefact_activo || numero === null) return
    let cancelado = false
    let intentos = 0
    const poll = async () => {
      const { data } = await supabase.from('comprobantes_electronicos').select('estado, enlace_pdf').eq('sale_id', saleId).maybeSingle()
      if (cancelado) return
      if (data) setComprobante(data)
      intentos++
      if (!data || (data.estado === 'pendiente' && intentos < MAX_INTENTOS_POLL_COMPROBANTE)) setTimeout(poll, 2000)
    }
    poll()
    return () => { cancelado = true }
  }, [config.nubefact_activo, numero, saleId])

  const imprimir = async () => {
    setErrorImpresion(false)
    try {
      const area=document.querySelector('.print-area') as HTMLElement|null
      const paper=config.tamano_papel==='58mm'?'58mm':'80mm'
      if(area){
        const ok=await imprimirHtmlHardware(area.outerHTML,paper)
        if(ok)return
      }
      window.print()
    } catch {
      // La venta ya está guardada — un fallo de impresión nunca la cancela.
      setErrorImpresion(true)
    }
  }

  useEffect(() => {
    if (!autoImprimir) return
    const t = setTimeout(() => { void imprimir() }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoImprimir])

  const anchoTicket = config.tamano_papel === '58mm' ? 'w-[58mm]' : 'w-[80mm]'

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="no-print absolute inset-0" onClick={onClose} />
      <div className="relative bg-white text-black rounded-2xl max-w-xs w-full max-h-[85vh] overflow-y-auto overflow-x-hidden shadow-2xl">
        <div className={`print-area ${anchoTicket} mx-auto p-4 font-mono text-[11px] leading-snug`}>
          <div className="text-center mb-2">
            <p className="font-bold text-sm">{config.negocio_nombre}</p>
            {config.negocio_ruc && <p>RUC: {config.negocio_ruc}</p>}
            {config.negocio_direccion && <p>{config.negocio_direccion}</p>}
          </div>
          <div className="border-t border-dashed border-black my-1.5 pt-1.5">
            <p>Ticket: {formatearNumero(numero)}</p>
            <p>Fecha: {new Date(fecha).toLocaleString('es-PE')}</p>
            {cajeroNombre && <p>Cajero: {cajeroNombre}</p>}
            {clienteNombre && <p>Cliente: {clienteNombre}</p>}
          </div>
          <div className="border-t border-b border-dashed border-black my-1.5 py-1.5">
            {cart.map((i) => {
              const pf = i.precio_unitario - (i.descuento || 0)
              return (
                <div key={i.variant.id} className="mb-0.5">
                  <p>{i.variant.product?.nombre}</p>
                  <div className="flex justify-between gap-2 text-gray-700">
                    <span>{i.cantidad} × S/{i.precio_unitario.toFixed(2)}</span>
                    <span>S/ {(pf * i.cantidad).toFixed(2)}</span>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="flex justify-between"><span>SUBTOTAL</span><span>S/ {subtotal.toFixed(2)}</span></div>
          {config.igv_activo && <div className="flex justify-between"><span>IGV ({config.igv_porcentaje}%)</span><span>S/ {impuesto.toFixed(2)}</span></div>}
          <div className="flex justify-between"><span>DESCUENTO</span><span>S/ {cart.reduce((s, i) => s + (i.descuento || 0) * i.cantidad, 0).toFixed(2)}</span></div>
          <div className="flex justify-between font-bold text-sm border-t border-black mt-1 pt-1"><span>TOTAL</span><span>S/ {total.toFixed(2)}</span></div>
          <div className="mt-2 pt-1.5 border-t border-dashed border-black">
            {pagos.map((p, idx) => (
              <div key={idx} className="flex justify-between capitalize"><span>{p.metodo}</span><span>S/ {p.monto.toFixed(2)}</span></div>
            ))}
          </div>
          <p className="text-center mt-3">GRACIAS POR SU COMPRA</p>
          <p className="text-center font-bold">{config.negocio_nombre}</p>
          {numero === null && <p className="text-center mt-2 text-[10px]">(Boleta provisional #{saleId.slice(0, 8).toUpperCase()} — se asignará número al sincronizar)</p>}
        </div>
        <div className="no-print p-3 border-t border-gray-200">
          {config.nubefact_activo && numero !== null && comprobante && (
            comprobante.estado === 'emitido' ? (
              <p className="flex items-center gap-1.5 text-xs text-green-600 bg-green-50 rounded-lg p-2 mb-2">
                <FileText size={14} className="shrink-0" /> Comprobante electrónico emitido
                {comprobante.enlace_pdf && <a href={comprobante.enlace_pdf} target="_blank" rel="noreferrer" className="font-semibold underline ml-1">Ver PDF</a>}
              </p>
            ) : comprobante.estado === 'error' ? (
              <p className="flex items-center gap-1.5 text-xs text-orange-600 bg-orange-50 rounded-lg p-2 mb-2">
                <AlertTriangle size={14} className="shrink-0" /> No se pudo emitir el comprobante electrónico. Reintenta desde Reportes.
              </p>
            ) : (
              <p className="flex items-center gap-1.5 text-xs text-gray-500 bg-gray-50 rounded-lg p-2 mb-2">
                <Loader2 size={14} className="shrink-0 animate-spin" /> Generando comprobante electrónico...
              </p>
            )
          )}
          {errorImpresion && (
            <p className="flex items-center gap-1.5 text-xs text-orange-600 bg-orange-50 rounded-lg p-2 mb-2">
              <AlertTriangle size={14} className="shrink-0" /> Venta completada. No se pudo imprimir.
            </p>
          )}
          <div className="flex gap-2">
            <button onClick={onClose} className="flex-1 flex items-center justify-center gap-1.5 bg-gray-100 text-gray-700 font-semibold py-2.5 rounded-xl text-sm"><X size={15} /> Cerrar</button>
            <button onClick={() => { void imprimir() }} className="flex-1 flex items-center justify-center gap-1.5 bg-cyan-500 text-black font-bold py-2.5 rounded-xl text-sm">
              <Printer size={15} /> {errorImpresion ? 'Reintentar' : 'Imprimir'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
