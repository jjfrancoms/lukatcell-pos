import { Printer, X } from 'lucide-react'
import { useConfig } from '../lib/config'
import type { CartItem, PagoDetalle } from '../types'

interface Props {
  saleId: string
  fecha: string
  cart: CartItem[]
  subtotal: number
  impuesto: number
  total: number
  pagos: PagoDetalle[]
  clienteNombre?: string | null
  onClose: () => void
}

export default function ReciboVenta({ saleId, fecha, cart, subtotal, impuesto, total, pagos, clienteNombre, onClose }: Props) {
  const { config } = useConfig()
  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="no-print absolute inset-0" onClick={onClose} />
      <div className="relative bg-white text-black rounded-2xl max-w-xs w-full max-h-[85vh] overflow-y-auto overflow-x-hidden shadow-2xl">
        <div className="print-area p-4 font-mono text-[11px] leading-snug">
          <div className="text-center mb-2">
            <p className="font-bold text-sm">{config.negocio_nombre}</p>
            {config.negocio_ruc && <p>RUC: {config.negocio_ruc}</p>}
            {config.negocio_direccion && <p>{config.negocio_direccion}</p>}
            <p>{new Date(fecha).toLocaleString('es-PE')}</p>
            <p>Boleta #{saleId.slice(0, 8).toUpperCase()}</p>
          </div>
          {clienteNombre && <p className="mb-1">Cliente: {clienteNombre}</p>}
          <div className="border-t border-b border-dashed border-black my-1.5 py-1.5">
            {cart.map((i) => {
              const pf = i.precio_unitario - (i.descuento || 0)
              return (
                <div key={i.variant.id} className="flex justify-between gap-2">
                  <span className="flex-1">{i.cantidad}x {i.variant.product?.nombre}</span>
                  <span>S/ {(pf * i.cantidad).toFixed(2)}</span>
                </div>
              )
            })}
          </div>
          <div className="flex justify-between"><span>Subtotal</span><span>S/ {subtotal.toFixed(2)}</span></div>
          {config.igv_activo && <div className="flex justify-between"><span>IGV ({config.igv_porcentaje}%)</span><span>S/ {impuesto.toFixed(2)}</span></div>}
          <div className="flex justify-between font-bold text-sm border-t border-black mt-1 pt-1"><span>TOTAL</span><span>S/ {total.toFixed(2)}</span></div>
          <div className="mt-2 pt-1.5 border-t border-dashed border-black">
            {pagos.map((p, idx) => (
              <div key={idx} className="flex justify-between capitalize"><span>{p.metodo}</span><span>S/ {p.monto.toFixed(2)}</span></div>
            ))}
          </div>
          <p className="text-center mt-3">¡Gracias por su compra!</p>
        </div>
        <div className="no-print flex gap-2 p-3 border-t border-gray-200">
          <button onClick={onClose} className="flex-1 flex items-center justify-center gap-1.5 bg-gray-100 text-gray-700 font-semibold py-2.5 rounded-xl text-sm"><X size={15} /> Cerrar</button>
          <button onClick={() => window.print()} className="flex-1 flex items-center justify-center gap-1.5 bg-cyan-500 text-black font-bold py-2.5 rounded-xl text-sm"><Printer size={15} /> Imprimir</button>
        </div>
      </div>
    </div>
  )
}
