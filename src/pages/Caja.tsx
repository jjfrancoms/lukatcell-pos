import { useState, useEffect } from 'react'
import { Clock, DollarSign, TrendingUp } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { CashSession } from '../types'

export default function Caja() {
  const [sesionActiva, setSesionActiva] = useState<CashSession | null>(null)
  const [historial, setHistorial] = useState<CashSession[]>([])
  const [montoInicial, setMontoInicial] = useState('')
  const [montoContado, setMontoContado] = useState('')
  const [ventasEfectivo, setVentasEfectivo] = useState(0)
  const [cargando, setCargando] = useState(false)

  const cargarSesion = async () => {
    const { data } = await supabase.from('cash_sessions').select('*').is('cierre', null).order('apertura', { ascending: false }).limit(1).maybeSingle()
    setSesionActiva(data)
  }
  const cargarHistorial = async () => {
    const { data } = await supabase.from('cash_sessions').select('*').not('cierre', 'is', null).order('cierre', { ascending: false }).limit(20)
    setHistorial(data || [])
  }
  useEffect(() => { cargarSesion(); cargarHistorial() }, [])
  useEffect(() => {
    if (!sesionActiva) return
    supabase.from('payments').select('monto, sale:sales!inner(cash_session_id)').eq('metodo', 'efectivo').eq('sale.cash_session_id', sesionActiva.id)
      .then(({ data }) => setVentasEfectivo((data || []).reduce((s: number, p: any) => s + Number(p.monto), 0)))
  }, [sesionActiva])

  const abrirTurno = async () => { setCargando(true); await supabase.from('cash_sessions').insert({ monto_inicial: Number(montoInicial) || 0 }); setMontoInicial(''); await cargarSesion(); setCargando(false) }
  const cerrarTurno = async () => {
    if (!sesionActiva) return; setCargando(true)
    await supabase.from('cash_sessions').update({ cierre: new Date().toISOString(), monto_final_esperado: sesionActiva.monto_inicial + ventasEfectivo, monto_final_contado: Number(montoContado) || 0 }).eq('id', sesionActiva.id)
    setMontoContado(''); setSesionActiva(null); await cargarSesion(); await cargarHistorial(); setCargando(false)
  }

  return (
    <div className="p-5 max-w-3xl">
      <h1 className="font-display font-bold text-xl text-white mb-5">Control de caja</h1>
      {!sesionActiva ? (
        <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-cyan-500/15 flex items-center justify-center"><Clock size={20} className="text-cyan-400" /></div>
            <div><h2 className="font-semibold text-white">Abrir turno</h2><p className="text-xs text-gray-500">Ingresa el monto inicial en caja</p></div>
          </div>
          <label className="text-xs text-gray-500 font-semibold">Monto inicial en efectivo (S/)</label>
          <input type="number" value={montoInicial} onChange={(e) => setMontoInicial(e.target.value)} className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mt-1.5 mb-4 text-white text-lg focus:outline-none focus:ring-2 focus:ring-cyan-500" placeholder="100.00" />
          <button onClick={abrirTurno} disabled={cargando} className="bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-bold px-6 py-3 rounded-xl hover:shadow-lg hover:shadow-cyan-500/30 transition-all">Abrir turno</button>
        </div>
      ) : (
        <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-green-500/15 flex items-center justify-center"><TrendingUp size={20} className="text-green-400" /></div>
            <div><h2 className="font-semibold text-white">Turno activo</h2><p className="text-xs text-gray-500">Desde {new Date(sesionActiva.apertura).toLocaleString('es-PE')}</p></div>
          </div>
          <div className="grid grid-cols-2 gap-3 mb-5">
            <div className="bg-[#0d1117] rounded-xl p-4 border border-[#30363d]">
              <p className="text-xs text-gray-500 mb-1">Monto inicial</p>
              <p className="text-xl font-bold text-white">S/ {sesionActiva.monto_inicial.toFixed(2)}</p>
            </div>
            <div className="bg-[#0d1117] rounded-xl p-4 border border-[#30363d]">
              <p className="text-xs text-gray-500 mb-1">Ventas en efectivo</p>
              <p className="text-xl font-bold text-cyan-400">S/ {ventasEfectivo.toFixed(2)}</p>
            </div>
          </div>
          <label className="text-xs text-gray-500 font-semibold">Monto contado al cierre (S/)</label>
          <input type="number" value={montoContado} onChange={(e) => setMontoContado(e.target.value)} className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mt-1.5 mb-4 text-white text-lg focus:outline-none focus:ring-2 focus:ring-orange-500" placeholder="0.00" />
          <button onClick={cerrarTurno} disabled={cargando} className="bg-gradient-to-r from-orange-500 to-orange-600 text-white font-bold px-6 py-3 rounded-xl hover:shadow-lg hover:shadow-orange-500/30 transition-all">Cerrar turno</button>
        </div>
      )}
      <h2 className="font-display font-bold text-white mt-8 mb-3">Historial</h2>
      <div className="bg-[#161b22] rounded-2xl border border-[#30363d] divide-y divide-[#30363d]">
        {historial.map((s) => (
          <div key={s.id} className="p-4 flex justify-between items-center">
            <div>
              <p className="font-medium text-white text-sm">{new Date(s.apertura).toLocaleDateString('es-PE')}</p>
              <p className="text-xs text-gray-500">Inicial S/ {s.monto_inicial.toFixed(2)} · Contado S/ {(s.monto_final_contado ?? 0).toFixed(2)}</p>
            </div>
            <span className={`font-bold text-sm ${(s.diferencia ?? 0) === 0 ? 'text-gray-500' : (s.diferencia ?? 0) > 0 ? 'text-green-400' : 'text-red-400'}`}>
              {(s.diferencia ?? 0) >= 0 ? '+' : ''}S/ {(s.diferencia ?? 0).toFixed(2)}
            </span>
          </div>
        ))}
        {historial.length === 0 && <p className="p-5 text-sm text-gray-500 text-center">Sin sesiones cerradas aún</p>}
      </div>
    </div>
  )
}
