import { useState, useEffect, useCallback } from 'react'
import { Download, TrendingUp, Receipt, CreditCard, DollarSign, Percent, Trophy } from 'lucide-react'
import ExcelJS from 'exceljs'
import { supabase } from '../lib/supabase'

interface VentaFila { id: string; fecha: string; total: number; estado: string }
interface Ganancias { total_ventas: number; total_costo: number; total_ganancia: number; margen_promedio: number; num_ventas: number }
interface TopProducto { producto_nombre: string; producto_sku: string | null; unidades_vendidas: number; ingreso: number; costo_total: number; ganancia: number; margen: number }

type Rango = 'hoy' | 'semana' | 'mes'

function rangoFechas(rango: Rango) {
  const hasta = new Date()
  const desde = new Date()
  if (rango === 'hoy') desde.setHours(0, 0, 0, 0)
  else if (rango === 'semana') desde.setDate(desde.getDate() - 7)
  else desde.setDate(desde.getDate() - 30)
  return { desde: desde.toISOString(), hasta: hasta.toISOString() }
}

export default function Reportes() {
  const [ventas, setVentas] = useState<VentaFila[]>([])
  const [totalHoy, setTotalHoy] = useState(0)
  const [ticketPromedio, setTicketPromedio] = useState(0)
  const [cantHoy, setCantHoy] = useState(0)
  const [rango, setRango] = useState<Rango>('semana')
  const [ganancias, setGanancias] = useState<Ganancias | null>(null)
  const [topProductos, setTopProductos] = useState<TopProducto[]>([])

  useEffect(() => {
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0)
    supabase.from('sales').select('id, fecha, total, estado').order('fecha', { ascending: false }).limit(200)
      .then(({ data }) => {
        setVentas(data || [])
        const vh = (data || []).filter((v) => new Date(v.fecha) >= hoy)
        const t = vh.reduce((s, v) => s + Number(v.total), 0)
        setTotalHoy(t); setCantHoy(vh.length); setTicketPromedio(vh.length ? t / vh.length : 0)
      })
  }, [])

  const cargarGanancias = useCallback(async () => {
    const { desde, hasta } = rangoFechas(rango)
    const [resumenRes, topRes] = await Promise.all([
      supabase.rpc('resumen_ganancias', { fecha_desde: desde, fecha_hasta: hasta }),
      supabase.rpc('top_productos_ganancia', { fecha_desde: desde, fecha_hasta: hasta, lim: 8 }),
    ])
    setGanancias(resumenRes.data?.[0] ?? null)
    setTopProductos(topRes.data || [])
  }, [rango])

  useEffect(() => { cargarGanancias() }, [cargarGanancias])

  const exportarExcel = async () => {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Ventas')
    ws.columns = [{ header: 'ID', key: 'id', width: 12 }, { header: 'Fecha', key: 'fecha', width: 20 }, { header: 'Total (S/)', key: 'total', width: 14 }, { header: 'Estado', key: 'estado', width: 14 }]
    ws.getRow(1).font = { bold: true }; ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17BFE0' } }
    ventas.forEach((v) => ws.addRow({ id: v.id.slice(0, 8), fecha: new Date(v.fecha).toLocaleString('es-PE'), total: Number(v.total), estado: v.estado }))
    const buf = await wb.xlsx.writeBuffer(); const blob = new Blob([buf], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `ventas_lukatcell_${new Date().toISOString().slice(0, 10)}.xlsx`; a.click(); URL.revokeObjectURL(url)
  }

  const maxGanancia = Math.max(1, ...topProductos.map((p) => Number(p.ganancia)))

  return (
    <div className="p-3 md:p-5">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-2">
        <h1 className="font-display font-bold text-xl text-white">Reportes</h1>
        <button onClick={exportarExcel} className="flex items-center gap-2 bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-semibold px-4 py-2.5 rounded-xl hover:shadow-lg hover:shadow-cyan-500/30 transition-all text-sm">
          <Download size={16} /> Exportar Excel
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 md:gap-4 mb-6">
        <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-4 md:p-5">
          <div className="flex items-center gap-3 mb-2"><div className="w-9 h-9 rounded-xl bg-cyan-500/15 flex items-center justify-center shrink-0"><TrendingUp size={18} className="text-cyan-400" /></div><p className="text-xs text-gray-500">Ventas de hoy</p></div>
          <p className="text-xl md:text-2xl font-bold text-cyan-400">S/ {totalHoy.toFixed(2)}</p>
        </div>
        <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-4 md:p-5">
          <div className="flex items-center gap-3 mb-2"><div className="w-9 h-9 rounded-xl bg-orange-500/15 flex items-center justify-center shrink-0"><Receipt size={18} className="text-orange-400" /></div><p className="text-xs text-gray-500">Ticket promedio</p></div>
          <p className="text-xl md:text-2xl font-bold text-white">S/ {ticketPromedio.toFixed(2)}</p>
        </div>
        <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-4 md:p-5">
          <div className="flex items-center gap-3 mb-2"><div className="w-9 h-9 rounded-xl bg-green-500/15 flex items-center justify-center shrink-0"><CreditCard size={18} className="text-green-400" /></div><p className="text-xs text-gray-500">Transacciones hoy</p></div>
          <p className="text-xl md:text-2xl font-bold text-white">{cantHoy}</p>
        </div>
      </div>

      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h2 className="font-display font-bold text-white text-base">Ganancias</h2>
        <div className="flex bg-[#161b22] rounded-lg border border-[#30363d] overflow-hidden">
          {(['hoy', 'semana', 'mes'] as Rango[]).map((r) => (
            <button key={r} onClick={() => setRango(r)} className={`px-3 py-1.5 text-xs font-bold capitalize ${rango === r ? 'bg-cyan-500 text-black' : 'text-gray-400'}`}>{r}</button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-4">
          <div className="flex items-center gap-2 mb-1.5"><DollarSign size={14} className="text-gray-500" /><p className="text-[11px] text-gray-500">Ingresos</p></div>
          <p className="text-lg font-bold text-white">S/ {(ganancias?.total_ventas ?? 0).toFixed(2)}</p>
        </div>
        <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-4">
          <div className="flex items-center gap-2 mb-1.5"><Receipt size={14} className="text-gray-500" /><p className="text-[11px] text-gray-500">Costo</p></div>
          <p className="text-lg font-bold text-gray-300">S/ {(ganancias?.total_costo ?? 0).toFixed(2)}</p>
        </div>
        <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-4">
          <div className="flex items-center gap-2 mb-1.5"><TrendingUp size={14} className="text-cyan-500" /><p className="text-[11px] text-gray-500">Ganancia</p></div>
          <p className="text-lg font-bold text-cyan-400">S/ {(ganancias?.total_ganancia ?? 0).toFixed(2)}</p>
        </div>
        <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-4">
          <div className="flex items-center gap-2 mb-1.5"><Percent size={14} className="text-orange-400" /><p className="text-[11px] text-gray-500">Margen</p></div>
          <p className="text-lg font-bold text-orange-400">{(ganancias?.margen_promedio ?? 0).toFixed(1)}%</p>
        </div>
      </div>

      <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-4 md:p-5 mb-6">
        <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2"><Trophy size={15} className="text-orange-400" /> Top productos por ganancia</h3>
        <div className="space-y-3">
          {topProductos.map((p) => {
            const pct = Math.max(4, (Number(p.ganancia) / maxGanancia) * 100)
            return (
              <div key={p.producto_sku || p.producto_nombre}>
                <div className="flex justify-between items-baseline mb-1 gap-2">
                  <span className="text-xs text-gray-300 truncate">{p.producto_nombre}</span>
                  <span className="text-xs font-bold text-cyan-400 shrink-0">S/ {Number(p.ganancia).toFixed(2)} <span className="text-gray-600 font-normal">· {p.unidades_vendidas}u</span></span>
                </div>
                <div className="h-2 rounded-full bg-[#0d1117] overflow-hidden">
                  <div className="h-full rounded-full bg-gradient-to-r from-cyan-600 to-cyan-400" style={{ width: `${pct}%` }} />
                </div>
              </div>
            )
          })}
          {topProductos.length === 0 && <p className="text-gray-500 text-sm text-center py-6">Sin ventas en este período</p>}
        </div>
      </div>

      <div className="bg-[#161b22] rounded-2xl border border-[#30363d] overflow-x-auto">
        <table className="w-full text-sm min-w-[420px]">
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
