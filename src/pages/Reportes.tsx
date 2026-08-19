import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Download, TrendingUp, Receipt, CreditCard, DollarSign, Percent, Trophy, AlertTriangle, Clock, ChevronRight, Printer, Loader2, FileText, RefreshCw } from 'lucide-react'
import ExcelJS from 'exceljs'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useConfig } from '../lib/config'
import { sumarMontos } from '../lib/money'
import ReciboVenta from '../components/ReciboVenta'
import type { ReciboLineaItem, PagoDetalle, EstadoComprobante } from '../types'

interface ComprobanteResumen { id: string; estado: EstadoComprobante; tipo_comprobante: string; serie: string; numero: number; enlace_pdf: string | null }
interface VentaFila { id: string; numero: number; fecha: string; total: number; estado: string; comprobante?: ComprobanteResumen }
interface ReimpresionData {
  saleId: string; numero: number | null; fecha: string; cart: ReciboLineaItem[]
  subtotal: number; impuesto: number; total: number; pagos: PagoDetalle[]; clienteNombre: string | null
}
interface Ganancias { total_ventas: number; total_costo: number; total_ganancia: number; margen_promedio: number; num_ventas: number }
interface TopProducto { producto_nombre: string; producto_sku: string | null; unidades_vendidas: number; ingreso: number; costo_total: number; ganancia: number; margen: number }
interface StockBajoFila { variant_id: string; cantidad: number; stock_minimo: number; variant: { product: { nombre: string } | null } | null }
interface OrdenEstancada { id: string; numero: number; cliente_nombre: string; estado: string; fecha_recepcion: string }

const ORDEN_ESTANCADA_DIAS = 3

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
  const { isAdmin } = useAuth()
  const { config } = useConfig()
  const [ventas, setVentas] = useState<VentaFila[]>([])
  const [totalHoy, setTotalHoy] = useState(0)
  const [ticketPromedio, setTicketPromedio] = useState(0)
  const [cantHoy, setCantHoy] = useState(0)
  const [rango, setRango] = useState<Rango>('semana')
  const [ganancias, setGanancias] = useState<Ganancias | null>(null)
  const [topProductos, setTopProductos] = useState<TopProducto[]>([])
  const [stockBajo, setStockBajo] = useState<StockBajoFila[]>([])
  const [ordenesEstancadas, setOrdenesEstancadas] = useState<OrdenEstancada[]>([])
  const [reimprimir, setReimprimir] = useState<ReimpresionData | null>(null)
  const [cargandoReimpresion, setCargandoReimpresion] = useState<string | null>(null)
  const [reintentandoComprobante, setReintentandoComprobante] = useState<string | null>(null)

  useEffect(() => {
    if (!isAdmin) return
    supabase.from('inventory').select('variant_id, cantidad, stock_minimo, variant:product_variants(product:products(nombre))')
      .order('cantidad', { ascending: true }).limit(200)
      .then(({ data }) => setStockBajo(((data as unknown as StockBajoFila[]) || []).filter((f) => f.cantidad <= f.stock_minimo).slice(0, 6)))

    const limite = new Date(); limite.setDate(limite.getDate() - ORDEN_ESTANCADA_DIAS)
    supabase.from('ordenes_servicio').select('id, numero, cliente_nombre, estado, fecha_recepcion')
      .not('estado', 'in', '(entregado,cancelado)').lt('fecha_recepcion', limite.toISOString())
      .order('fecha_recepcion', { ascending: true }).limit(6)
      .then(({ data }) => setOrdenesEstancadas(data || []))
  }, [isAdmin])

  useEffect(() => {
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0)
    supabase.from('sales').select('id, numero, fecha, total, estado').order('fecha', { ascending: false }).limit(200)
      .then(async ({ data }) => {
        const filas: VentaFila[] = data || []
        const vh = filas.filter((v) => new Date(v.fecha) >= hoy)
        const t = sumarMontos(vh.map((v) => Number(v.total)))
        setTotalHoy(t); setCantHoy(vh.length); setTicketPromedio(vh.length ? t / vh.length : 0)

        if (config.nubefact_activo && filas.length > 0) {
          const { data: comprobantes } = await supabase.from('comprobantes_electronicos')
            .select('id, sale_id, estado, tipo_comprobante, serie, numero, enlace_pdf')
            .in('sale_id', filas.map((v) => v.id))
          const porVenta = new Map((comprobantes || []).map((c) => [c.sale_id, c as ComprobanteResumen]))
          setVentas(filas.map((v) => ({ ...v, comprobante: porVenta.get(v.id) })))
        } else {
          setVentas(filas)
        }
      })
  }, [config.nubefact_activo])

  const reintentarComprobante = async (comprobanteId: string) => {
    setReintentandoComprobante(comprobanteId)
    await supabase.functions.invoke('emitir-comprobante', { body: { comprobante_id: comprobanteId } })
    const { data: c } = await supabase.from('comprobantes_electronicos').select('id, sale_id, estado, tipo_comprobante, serie, numero, enlace_pdf').eq('id', comprobanteId).single()
    if (c) setVentas((vs) => vs.map((v) => v.id === c.sale_id ? { ...v, comprobante: c as ComprobanteResumen } : v))
    setReintentandoComprobante(null)
  }

  const abrirReimpresion = async (ventaId: string) => {
    setCargandoReimpresion(ventaId)
    const [{ data: venta }, { data: items }, { data: pagos }] = await Promise.all([
      supabase.from('sales').select('id, numero, fecha, subtotal, impuesto, total, cliente_id').eq('id', ventaId).single(),
      supabase.from('sale_items').select('cantidad, precio_unitario, descuento, producto_nombre_snapshot, variant_id').eq('sale_id', ventaId),
      supabase.from('payments').select('metodo, monto, referencia').eq('sale_id', ventaId),
    ])
    let clienteNombre: string | null = null
    if (venta?.cliente_id) {
      const { data: cliente } = await supabase.from('clientes').select('nombre').eq('id', venta.cliente_id).maybeSingle()
      clienteNombre = cliente?.nombre ?? null
    }
    setCargandoReimpresion(null)
    if (!venta || !items) return
    setReimprimir({
      saleId: venta.id,
      numero: venta.numero,
      fecha: venta.fecha,
      cart: items.map((i) => ({
        variant: { id: i.variant_id, product: { nombre: i.producto_nombre_snapshot || 'Producto' } },
        cantidad: i.cantidad,
        precio_unitario: Number(i.precio_unitario),
        descuento: Number(i.descuento || 0),
      })),
      subtotal: Number(venta.subtotal),
      impuesto: Number(venta.impuesto),
      total: Number(venta.total),
      pagos: (pagos || []).map((p) => ({ metodo: p.metodo, monto: Number(p.monto), referencia: p.referencia ?? undefined })) as PagoDetalle[],
      clienteNombre,
    })
  }

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

  const BadgeComprobante = ({ v }: { v: VentaFila }) => {
    if (!config.nubefact_activo) return null
    if (!v.comprobante) return <span className="text-[11px] text-gray-600">—</span>
    const c = v.comprobante
    const etiqueta = c.tipo_comprobante === 'factura' ? 'Factura' : 'Boleta'
    if (c.estado === 'emitido') {
      return c.enlace_pdf ? (
        <a href={c.enlace_pdf} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-green-500/15 text-green-400 hover:bg-green-500/25">
          <FileText size={11} /> {etiqueta} {c.serie}-{c.numero}
        </a>
      ) : (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-green-500/15 text-green-400"><FileText size={11} /> {etiqueta} {c.serie}-{c.numero}</span>
      )
    }
    if (c.estado === 'error') {
      return (
        <button onClick={() => reintentarComprobante(c.id)} disabled={reintentandoComprobante === c.id}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-500/15 text-red-400 hover:bg-red-500/25">
          {reintentandoComprobante === c.id ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} {etiqueta} con error
        </button>
      )
    }
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-yellow-500/15 text-yellow-400"><Loader2 size={11} className="animate-spin" /> {etiqueta} pendiente</span>
  }

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

      {isAdmin && (stockBajo.length > 0 || ordenesEstancadas.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          {stockBajo.length > 0 && (
            <div className="bg-[#161b22] rounded-2xl border border-orange-500/20 p-4 md:p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-white flex items-center gap-2"><AlertTriangle size={15} className="text-orange-400" /> Stock bajo</h3>
                <Link to="/inventario" className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-0.5">Ver todo <ChevronRight size={13} /></Link>
              </div>
              <div className="space-y-2">
                {stockBajo.map((f) => (
                  <div key={f.variant_id} className="flex justify-between items-center text-xs">
                    <span className="text-gray-300 truncate">{f.variant?.product?.nombre ?? 'Producto'}</span>
                    <span className="text-orange-400 font-bold shrink-0 ml-2">{f.cantidad} / {f.stock_minimo}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {ordenesEstancadas.length > 0 && (
            <div className="bg-[#161b22] rounded-2xl border border-red-500/20 p-4 md:p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-white flex items-center gap-2"><Clock size={15} className="text-red-400" /> Órdenes estancadas (+{ORDEN_ESTANCADA_DIAS}d)</h3>
                <Link to="/ordenes" className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-0.5">Ver todo <ChevronRight size={13} /></Link>
              </div>
              <div className="space-y-2">
                {ordenesEstancadas.map((o) => (
                  <div key={o.id} className="flex justify-between items-center text-xs">
                    <span className="text-gray-300 truncate">#{o.numero} · {o.cliente_nombre}</span>
                    <span className="text-red-400 font-semibold shrink-0 ml-2">{new Date(o.fecha_recepcion).toLocaleDateString('es-PE')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

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

      <div className="md:hidden space-y-2">
        {ventas.map((v) => (
          <div key={v.id} className="bg-[#161b22] rounded-xl border border-[#30363d] p-3 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm text-gray-300 truncate">V-{String(v.numero).padStart(6, '0')} · {new Date(v.fecha).toLocaleString('es-PE')}</p>
              <div className="flex items-center gap-1.5 flex-wrap mt-1">
                <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ${v.estado === 'completada' ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>{v.estado}</span>
                <BadgeComprobante v={v} />
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <p className="font-bold text-white">S/ {Number(v.total).toFixed(2)}</p>
              <button onClick={() => abrirReimpresion(v.id)} disabled={cargandoReimpresion === v.id}
                className="p-2 rounded-lg bg-cyan-500/10 text-cyan-400 active:bg-cyan-500/20" aria-label={`Reimprimir venta V-${v.numero}`}>
                {cargandoReimpresion === v.id ? <Loader2 size={15} className="animate-spin" /> : <Printer size={15} />}
              </button>
            </div>
          </div>
        ))}
        {ventas.length === 0 && <p className="py-10 text-center text-gray-500 bg-[#161b22] rounded-2xl border border-[#30363d]">Sin ventas registradas</p>}
      </div>

      <div className="hidden md:block bg-[#161b22] rounded-2xl border border-[#30363d] overflow-x-auto">
        <table className="w-full text-sm min-w-[500px]">
          <thead><tr className="border-b border-[#30363d]">
            <th className="text-left px-4 py-3 text-xs text-gray-500 uppercase">Ticket</th>
            <th className="text-left px-4 py-3 text-xs text-gray-500 uppercase">Fecha</th>
            <th className="text-right px-4 py-3 text-xs text-gray-500 uppercase">Total</th>
            <th className="text-left px-4 py-3 text-xs text-gray-500 uppercase">Estado</th>
            {config.nubefact_activo && <th className="text-left px-4 py-3 text-xs text-gray-500 uppercase">Comprobante</th>}
            <th className="text-center px-4 py-3 text-xs text-gray-500 uppercase">Reimprimir</th>
          </tr></thead>
          <tbody className="divide-y divide-[#30363d]">
            {ventas.map((v) => (
              <tr key={v.id} className="hover:bg-[#21262d] transition-colors">
                <td className="px-4 py-3 text-gray-400 font-mono text-xs">V-{String(v.numero).padStart(6, '0')}</td>
                <td className="px-4 py-3 text-gray-300">{new Date(v.fecha).toLocaleString('es-PE')}</td>
                <td className="px-4 py-3 text-right font-semibold text-white">S/ {Number(v.total).toFixed(2)}</td>
                <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${v.estado === 'completada' ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>{v.estado}</span></td>
                {config.nubefact_activo && <td className="px-4 py-3"><BadgeComprobante v={v} /></td>}
                <td className="px-4 py-3 text-center">
                  <button onClick={() => abrirReimpresion(v.id)} disabled={cargandoReimpresion === v.id}
                    className="p-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 transition-colors" title="Reimprimir" aria-label={`Reimprimir venta V-${v.numero}`}>
                    {cargandoReimpresion === v.id ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />}
                  </button>
                </td>
              </tr>
            ))}
            {ventas.length === 0 && <tr><td colSpan={config.nubefact_activo ? 6 : 5} className="px-4 py-10 text-center text-gray-500">Sin ventas registradas</td></tr>}
          </tbody>
        </table>
      </div>

      {reimprimir && <ReciboVenta {...reimprimir} onClose={() => setReimprimir(null)} />}
    </div>
  )
}
