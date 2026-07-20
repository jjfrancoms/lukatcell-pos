import { useState, useEffect } from 'react'
import { Download, TrendingUp, Receipt, CreditCard } from 'lucide-react'
import ExcelJS from 'exceljs'
import { supabase } from '../lib/supabase'

interface VentaFila { id: string; fecha: string; total: number; estado: string }

export default function Reportes() {
  const [ventas, setVentas] = useState<VentaFila[]>([])
  const [totalHoy, setTotalHoy] = useState(0)
  const [ticketPromedio, setTicketPromedio] = useState(0)
  const [cantHoy, setCantHoy] = useState(0)

  useEffect(() => {
    const cargar = async () => {
      const hoy = new Date(); hoy.setHours(0, 0, 0, 0)
      const { data } = await supabase.from('sales').select('id, fecha, total, estado').order('fecha', { ascending: false }).limit(200)
      setVentas(data || [])
      const vh = (data || []).filter((v) => new Date(v.fecha) >= hoy)
      const t = vh.reduce((s, v) => s + Number(v.total), 0)
      setTotalHoy(t); setCantHoy(vh.length); setTicketPromedio(vh.length ? t / vh.length : 0)
    }; cargar()
  }, [])

  const exportarExcel = async () => {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Ventas')
    ws.columns = [{ header: 'ID', key: 'id', width: 12 }, { header: 'Fecha', key: 'fecha', width: 20 }, { header: 'Total (S/)', key: 'total', width: 14 }, { header: 'Estado', key: 'estado', width: 14 }]
    ws.getRow(1).font = { bold: true }; ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17BFE0' } }
    ventas.forEach((v) => ws.addRow({ id: v.id.slice(0, 8), fecha: new Date(v.fecha).toLocaleString('es-PE'), total: Number(v.total), estado: v.estado }))
    const buf = await wb.xlsx.writeBuffer(); const blob = new Blob([buf], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `ventas_lukatcell_${new Date().toISOString().slice(0, 10)}.xlsx`; a.click(); URL.revokeObjectURL(url)
  }

  return (
    <div className="p-5">
      <div className="flex items-center justify-between mb-5">
        <h1 className="font-display font-bold text-xl text-white">Reportes</h1>
        <button onClick={exportarExcel} className="flex items-center gap-2 bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-semibold px-4 py-2.5 rounded-xl hover:shadow-lg hover:shadow-cyan-500/30 transition-all text-sm">
          <Download size={16} /> Exportar Excel
        </button>
      </div>
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-5">
          <div className="flex items-center gap-3 mb-2"><div className="w-9 h-9 rounded-xl bg-cyan-500/15 flex items-center justify-center"><TrendingUp size={18} className="text-cyan-400" /></div><p className="text-xs text-gray-500">Ventas de hoy</p></div>
          <p className="text-2xl font-bold text-cyan-400">S/ {totalHoy.toFixed(2)}</p>
        </div>
        <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-5">
          <div className="flex items-center gap-3 mb-2"><div className="w-9 h-9 rounded-xl bg-orange-500/15 flex items-center justify-center"><Receipt size={18} className="text-orange-400" /></div><p className="text-xs text-gray-500">Ticket promedio</p></div>
          <p className="text-2xl font-bold text-white">S/ {ticketPromedio.toFixed(2)}</p>
        </div>
        <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-5">
          <div className="flex items-center gap-3 mb-2"><div className="w-9 h-9 rounded-xl bg-green-500/15 flex items-center justify-center"><CreditCard size={18} className="text-green-400" /></div><p className="text-xs text-gray-500">Transacciones hoy</p></div>
          <p className="text-2xl font-bold text-white">{cantHoy}</p>
        </div>
      </div>
      <div className="bg-[#161b22] rounded-2xl border border-[#30363d] overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-[#30363d]">
            <th className="text-left px-4 py-3 text-xs text-gray-500 uppercase">Fecha</th>
            <th className="text-right px-4 py-3 text-xs text-gray-500 uppercase">Total</th>
            <th className="text-left px-4 py-3 text-xs text-gray-500 uppercase">Estado</th>
          </tr></thead>
          <tbody className="divide-y divide-[#30363d]">
            {ventas.map((v) => (
              <tr key={v.id} className="hover:bg-[#21262d] transition-colors">
                <td className="px-4 py-3 text-gray-300">{new Date(v.fecha).toLocaleString('es-PE')}</td>
                <td className="px-4 py-3 text-right font-semibold text-white">S/ {Number(v.total).toFixed(2)}</td>
                <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${v.estado === 'completada' ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>{v.estado}</span></td>
              </tr>
            ))}
            {ventas.length === 0 && <tr><td colSpan={3} className="px-4 py-10 text-center text-gray-500">Sin ventas registradas</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
