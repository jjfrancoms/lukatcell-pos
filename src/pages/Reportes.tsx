import { useState, useEffect } from 'react'
import { Download } from 'lucide-react'
import ExcelJS from 'exceljs'
import { supabase } from '../lib/supabase'

interface VentaFila {
  id: string
  fecha: string
  total: number
  estado: string
}

export default function Reportes() {
  const [ventas, setVentas] = useState<VentaFila[]>([])
  const [totalHoy, setTotalHoy] = useState(0)
  const [ticketPromedio, setTicketPromedio] = useState(0)

  useEffect(() => {
    const cargar = async () => {
      const hoy = new Date()
      hoy.setHours(0, 0, 0, 0)
      const { data } = await supabase
        .from('sales')
        .select('id, fecha, total, estado')
        .order('fecha', { ascending: false })
        .limit(200)
      setVentas(data || [])

      const ventasHoy = (data || []).filter((v) => new Date(v.fecha) >= hoy)
      const total = ventasHoy.reduce((sum, v) => sum + Number(v.total), 0)
      setTotalHoy(total)
      setTicketPromedio(ventasHoy.length ? total / ventasHoy.length : 0)
    }
    cargar()
  }, [])

  const exportarExcel = async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Ventas')
    sheet.columns = [
      { header: 'ID', key: 'id', width: 12 },
      { header: 'Fecha', key: 'fecha', width: 20 },
      { header: 'Total (S/)', key: 'total', width: 14 },
      { header: 'Estado', key: 'estado', width: 14 },
    ]
    sheet.getRow(1).font = { bold: true }
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17BFE0' } }

    ventas.forEach((v) => {
      sheet.addRow({
        id: v.id.slice(0, 8),
        fecha: new Date(v.fecha).toLocaleString('es-PE'),
        total: Number(v.total),
        estado: v.estado,
      })
    })

    const buffer = await workbook.xlsx.writeBuffer()
    const blob = new Blob([buffer], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ventas_lukatcell_${new Date().toISOString().slice(0, 10)}.xlsx`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display font-bold text-xl text-ink-900">Reportes</h1>
        <button
          onClick={exportarExcel}
          className="flex items-center gap-2 bg-cyan-500 text-ink-900 font-semibold px-4 py-2 rounded-xl hover:bg-cyan-600"
        >
          <Download size={16} /> Exportar Excel
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-2xl border border-ink-100 p-4">
          <p className="text-xs text-ink-400">Ventas de hoy</p>
          <p className="text-2xl font-bold text-cyan-700">S/ {totalHoy.toFixed(2)}</p>
        </div>
        <div className="bg-white rounded-2xl border border-ink-100 p-4">
          <p className="text-xs text-ink-400">Ticket promedio</p>
          <p className="text-2xl font-bold text-ink-900">S/ {ticketPromedio.toFixed(2)}</p>
        </div>
        <div className="bg-white rounded-2xl border border-ink-100 p-4">
          <p className="text-xs text-ink-400">Transacciones (últimas 200)</p>
          <p className="text-2xl font-bold text-ink-900">{ventas.length}</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-ink-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ink-100/60 text-ink-400 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-3">Fecha</th>
              <th className="text-right px-4 py-3">Total</th>
              <th className="text-left px-4 py-3">Estado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {ventas.map((v) => (
              <tr key={v.id}>
                <td className="px-4 py-3">{new Date(v.fecha).toLocaleString('es-PE')}</td>
                <td className="px-4 py-3 text-right font-semibold">S/ {Number(v.total).toFixed(2)}</td>
                <td className="px-4 py-3 capitalize text-ink-700">{v.estado}</td>
              </tr>
            ))}
            {ventas.length === 0 && (
              <tr><td colSpan={3} className="px-4 py-8 text-center text-ink-400">Sin ventas registradas</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
