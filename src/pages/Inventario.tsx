import { useState, useEffect } from 'react'
import { AlertTriangle, Search } from 'lucide-react'
import { supabase } from '../lib/supabase'

interface FilaInventario { variant_id: string; cantidad: number; stock_minimo: number; variant: { id: string; color: string | null; codigo_barras: string | null; product: { nombre: string; sku: string | null }; modelo: { marca: string; modelo: string } | null } }

export default function Inventario() {
  const [filas, setFilas] = useState<FilaInventario[]>([])
  const [busqueda, setBusqueda] = useState('')
  const [soloStockBajo, setSoloStockBajo] = useState(false)
  const cargar = async () => {
    const { data } = await supabase.from('inventory').select('variant_id, cantidad, stock_minimo, variant:product_variants(id, color, codigo_barras, product:products(nombre, sku), modelo:modelos_celular(marca, modelo))').order('cantidad', { ascending: true })
    setFilas((data as unknown as FilaInventario[]) || [])
  }
  useEffect(() => { cargar() }, [])
  const filtradas = filas.filter((f) => {
    const t = `${f.variant?.product?.nombre} ${f.variant?.product?.sku} ${f.variant?.color}`.toLowerCase()
    return t.includes(busqueda.toLowerCase()) && (!soloStockBajo || f.cantidad <= f.stock_minimo)
  })
  const totalItems = filtradas.reduce((s, f) => s + f.cantidad, 0)
  const bajosStock = filas.filter(f => f.cantidad <= f.stock_minimo).length

  return (
    <div className="p-5">
      <div className="flex items-center justify-between mb-5">
        <h1 className="font-display font-bold text-xl text-white">Inventario</h1>
        <div className="flex gap-3">
          <div className="bg-[#161b22] border border-[#30363d] rounded-xl px-4 py-2 text-center">
            <p className="text-xs text-gray-500">Total items</p><p className="text-lg font-bold text-white">{totalItems}</p>
          </div>
          <div className="bg-[#161b22] border border-[#30363d] rounded-xl px-4 py-2 text-center">
            <p className="text-xs text-gray-500">Stock bajo</p><p className="text-lg font-bold text-orange-400">{bajosStock}</p>
          </div>
        </div>
      </div>
      <div className="flex gap-3 mb-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" size={16} />
          <input value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="Buscar producto o SKU"
            className="w-full pl-10 pr-3 py-2.5 rounded-xl bg-[#161b22] border border-[#30363d] text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500" />
        </div>
        <button onClick={() => setSoloStockBajo(!soloStockBajo)}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold transition-all ${soloStockBajo ? 'bg-orange-500/15 text-orange-400 border border-orange-500/30' : 'bg-[#161b22] border border-[#30363d] text-gray-400'}`}>
          <AlertTriangle size={14} /> Solo stock bajo
        </button>
      </div>
      <div className="bg-[#161b22] rounded-2xl border border-[#30363d] overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-[#30363d]">
            <th className="text-left px-4 py-3 text-xs text-gray-500 uppercase">Producto</th>
            <th className="text-left px-4 py-3 text-xs text-gray-500 uppercase">Variante</th>
            <th className="text-right px-4 py-3 text-xs text-gray-500 uppercase">Stock</th>
            <th className="text-right px-4 py-3 text-xs text-gray-500 uppercase">Mín</th>
            <th className="px-4 py-3"></th>
          </tr></thead>
          <tbody className="divide-y divide-[#30363d]">
            {filtradas.map((f) => (
              <tr key={f.variant_id} className="hover:bg-[#21262d] transition-colors">
                <td className="px-4 py-3"><p className="font-medium text-white">{f.variant?.product?.nombre}</p><p className="text-xs text-gray-500">{f.variant?.product?.sku}</p></td>
                <td className="px-4 py-3 text-gray-400">{[f.variant?.color, f.variant?.modelo && `${f.variant.modelo.marca} ${f.variant.modelo.modelo}`].filter(Boolean).join(' · ') || '—'}</td>
                <td className="px-4 py-3 text-right"><span className={`font-bold ${f.cantidad <= f.stock_minimo ? 'text-orange-400' : 'text-white'}`}>{f.cantidad}</span></td>
                <td className="px-4 py-3 text-right text-gray-500">{f.stock_minimo}</td>
                <td className="px-4 py-3">{f.cantidad <= f.stock_minimo && <span className="flex items-center gap-1 text-orange-400 text-xs font-semibold"><AlertTriangle size={12} /></span>}</td>
              </tr>
            ))}
            {filtradas.length === 0 && <tr><td colSpan={5} className="px-4 py-10 text-center text-gray-500">Sin resultados</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
