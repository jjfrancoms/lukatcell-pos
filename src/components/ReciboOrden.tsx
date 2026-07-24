import { Printer, X } from 'lucide-react'
import type { OrdenServicio } from '../types'

const estadoLabel: Record<string, string> = {
  recibido: 'Recibido', diagnosticado: 'Diagnosticado', en_reparacion: 'En reparación',
  listo: 'Listo para entrega', entregado: 'Entregado', cancelado: 'Cancelado',
}

export default function ReciboOrden({ orden, onClose }: { orden: OrdenServicio; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="no-print absolute inset-0" onClick={onClose} />
      <div className="relative bg-white text-black rounded-2xl max-w-xs w-full max-h-[85vh] overflow-y-auto overflow-x-hidden shadow-2xl">
        <div className="print-area p-4 font-mono text-[11px] leading-snug">
          <div className="text-center mb-2">
            <p className="font-bold text-sm">LUKATCELL</p>
            <p>Comprobante de reparación</p>
            <p>{new Date(orden.fecha_recepcion).toLocaleString('es-PE')}</p>
            <p className="font-bold">Orden #{orden.numero}</p>
          </div>
          <div className="border-t border-b border-dashed border-black my-1.5 py-1.5 space-y-0.5">
            <p><b>Cliente:</b> {orden.cliente_nombre}</p>
            {orden.cliente_telefono && <p><b>Teléfono:</b> {orden.cliente_telefono}</p>}
            {(orden.equipo_marca || orden.equipo_modelo) && <p><b>Equipo:</b> {[orden.equipo_marca, orden.equipo_modelo].filter(Boolean).join(' ')}</p>}
            <p><b>Estado:</b> {estadoLabel[orden.estado] || orden.estado}</p>
          </div>
          <p className="mb-1"><b>Problema reportado:</b></p>
          <p className="mb-2">{orden.problema}</p>
          {orden.diagnostico && (<><p className="mb-1"><b>Diagnóstico:</b></p><p className="mb-2">{orden.diagnostico}</p></>)}
          <div className="border-t border-dashed border-black pt-1.5">
            {orden.costo_estimado != null && <div className="flex justify-between"><span>Costo estimado</span><span>S/ {Number(orden.costo_estimado).toFixed(2)}</span></div>}
            {orden.costo_final != null && <div className="flex justify-between font-bold"><span>Costo final</span><span>S/ {Number(orden.costo_final).toFixed(2)}</span></div>}
          </div>
          <p className="text-center mt-3 text-[10px]">Conserve este comprobante para recoger su equipo.</p>
        </div>
        <div className="no-print flex gap-2 p-3 border-t border-gray-200">
          <button onClick={onClose} className="flex-1 flex items-center justify-center gap-1.5 bg-gray-100 text-gray-700 font-semibold py-2.5 rounded-xl text-sm"><X size={15} /> Cerrar</button>
          <button onClick={() => window.print()} className="flex-1 flex items-center justify-center gap-1.5 bg-cyan-500 text-black font-bold py-2.5 rounded-xl text-sm"><Printer size={15} /> Imprimir</button>
        </div>
      </div>
    </div>
  )
}
