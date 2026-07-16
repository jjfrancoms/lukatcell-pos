import { useState, useEffect } from 'react'
import { AlertTriangle, Search } from 'lucide-react'
import { supabase } from '../lib/supabase'

interface FilaInventario {
  variant_id: string
  cantidad: number
  stock_minimo: number
  variant: {
    id: string
    color: string | null
    codigo_barras: string | null
    product: { nombre: string; sku: string | null }
    modelo: { marca: string; modelo: string } | null
  }
}

export default function Inventario() {
  const [filas, setFilas] = useState<FilaInventario[]>([])
  const [busqueda, setBusqueda] = useState('')
  const [soloStockBajo, setSoloStockBajo] = useState(false)

  const cargar = async () => {
    const { data } = await supabase
      .from('inventory')
      .select('variant_id, cantidad, stock_minimo, variant:product_variants(id, color, codigo_barras, product:products(nombre, sku), modelo:modelos_celular(marca, modelo))')
      .order('cantidad', { ascending: true })
    setFilas((data as unknown as FilaInventario[]) || [])
  }

  useEffect(() => { cargar() }, [])

  const filtradas = filas.filter((f) => {
    const texto = `${f.variant?.product?.nombre} ${f.variant?.product?.sku} ${f.variant?.color}`.toLowerCase()
    const coincide = texto.includes(busqueda.toLowerCase())
    const bajo = !soloStockBajo || f.cantidad <= f.stock_minimo
    return coincide && bajo
  })

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display font-bold text-xl text-ink-900">Inventario</h1>
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input type="checkbox" checked={soloStockBajo} onChange={(e) => setSoloStockBajo(e.target.checked)} />
          Solo stock bajo
        </label>
      </div>

      <div className="relative mb-4 max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" size={16} />
        <input
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar producto o SKU"
          className="w-full pl-9 pr-3 py-2 rounded-lg border border-ink-100 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
        />
      </div>

      <div className="bg-white rounded-2xl border border-ink-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ink-100/60 text-ink-400 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-3">Producto</th>
              <th className="text-left px-4 py-3">Variante</th>
              <th className="text-right px-4 py-3">Stock</th>
              <th className="text-right px-4 py-3">Mínimo</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {filtradas.map((f) => (
              <tr key={f.variant_id}>
                <td className="px-4 py-3">
                  <p className="font-medium">{f.variant?.product?.nombre}</p>
                  <p className="text-xs text-ink-400">{f.variant?.product?.sku}</p>
                </td>
                <td className="px-4 py-3 text-ink-700">
                  {[f.variant?.color, f.variant?.modelo && `${f.variant.modelo.marca} ${f.variant.modelo.modelo}`]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </td>
                <td className="px-4 py-3 text-right font-bold">{f.cantidad}</td>
                <td className="px-4 py-3 text-right text-ink-400">{f.stock_minimo}</td>
                <td className="px-4 py-3">
                  {f.cantidad <= f.stock_minimo && (
                    <span className="flex items-center gap-1 text-orange-600 text-xs font-semibold">
                      <AlertTriangle size={14} /> Bajo
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {filtradas.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-ink-400">Sin resultados</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
