import { useState, useEffect } from 'react'
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
    const { data } = await supabase
      .from('cash_sessions')
      .select('*')
      .is('cierre', null)
      .order('apertura', { ascending: false })
      .limit(1)
      .maybeSingle()
    setSesionActiva(data)
  }

  const cargarHistorial = async () => {
    const { data } = await supabase
      .from('cash_sessions')
      .select('*')
      .not('cierre', 'is', null)
      .order('cierre', { ascending: false })
      .limit(20)
    setHistorial(data || [])
  }

  useEffect(() => {
    cargarSesion()
    cargarHistorial()
  }, [])

  useEffect(() => {
    if (!sesionActiva) return
    supabase
      .from('payments')
      .select('monto, sale:sales!inner(cash_session_id)')
      .eq('metodo', 'efectivo')
      .eq('sale.cash_session_id', sesionActiva.id)
      .then(({ data }) => {
        const total = (data || []).reduce((sum: number, p: any) => sum + Number(p.monto), 0)
        setVentasEfectivo(total)
      })
  }, [sesionActiva])

  const abrirTurno = async () => {
    setCargando(true)
    await supabase.from('cash_sessions').insert({ monto_inicial: Number(montoInicial) || 0 })
    setMontoInicial('')
    await cargarSesion()
    setCargando(false)
  }

  const cerrarTurno = async () => {
    if (!sesionActiva) return
    setCargando(true)
    const esperado = sesionActiva.monto_inicial + ventasEfectivo
    await supabase
      .from('cash_sessions')
      .update({
        cierre: new Date().toISOString(),
        monto_final_esperado: esperado,
        monto_final_contado: Number(montoContado) || 0,
      })
      .eq('id', sesionActiva.id)
    setMontoContado('')
    setSesionActiva(null)
    await cargarSesion()
    await cargarHistorial()
    setCargando(false)
  }

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="font-display font-bold text-xl text-ink-900 mb-6">Control de caja</h1>

      {!sesionActiva ? (
        <div className="bg-white rounded-2xl border border-ink-100 p-6">
          <h2 className="font-semibold mb-3">Abrir turno</h2>
          <label className="text-xs text-ink-400">Monto inicial en efectivo (S/)</label>
          <input
            type="number"
            value={montoInicial}
            onChange={(e) => setMontoInicial(e.target.value)}
            className="w-full border border-ink-100 rounded-lg px-3 py-2 mt-1 mb-4"
          />
          <button
            onClick={abrirTurno}
            disabled={cargando}
            className="bg-cyan-500 text-ink-900 font-bold px-5 py-2.5 rounded-xl hover:bg-cyan-600"
          >
            Abrir turno
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-ink-100 p-6">
          <h2 className="font-semibold mb-1">Turno activo</h2>
          <p className="text-xs text-ink-400 mb-4">
            Abierto: {new Date(sesionActiva.apertura).toLocaleString('es-PE')}
          </p>
          <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
            <div className="bg-ink-100/60 rounded-lg p-3">
              <p className="text-ink-400 text-xs">Monto inicial</p>
              <p className="font-bold">S/ {sesionActiva.monto_inicial.toFixed(2)}</p>
            </div>
            <div className="bg-ink-100/60 rounded-lg p-3">
              <p className="text-ink-400 text-xs">Ventas en efectivo</p>
              <p className="font-bold">S/ {ventasEfectivo.toFixed(2)}</p>
            </div>
          </div>
          <label className="text-xs text-ink-400">Monto contado al cierre (S/)</label>
          <input
            type="number"
            value={montoContado}
            onChange={(e) => setMontoContado(e.target.value)}
            className="w-full border border-ink-100 rounded-lg px-3 py-2 mt-1 mb-4"
          />
          <button
            onClick={cerrarTurno}
            disabled={cargando}
            className="bg-orange-500 text-white font-bold px-5 py-2.5 rounded-xl hover:bg-orange-600"
          >
            Cerrar turno
          </button>
        </div>
      )}

      <h2 className="font-display font-bold text-ink-900 mt-8 mb-3">Historial de sesiones</h2>
      <div className="bg-white rounded-2xl border border-ink-100 divide-y divide-ink-100">
        {historial.map((s) => (
          <div key={s.id} className="p-4 flex justify-between items-center text-sm">
            <div>
              <p className="font-medium">{new Date(s.apertura).toLocaleDateString('es-PE')}</p>
              <p className="text-xs text-ink-400">
                Inicial S/ {s.monto_inicial.toFixed(2)} · Contado S/ {(s.monto_final_contado ?? 0).toFixed(2)}
              </p>
            </div>
            <span
              className={`font-bold ${
                (s.diferencia ?? 0) === 0 ? 'text-ink-400' : (s.diferencia ?? 0) > 0 ? 'text-cyan-700' : 'text-red-500'
              }`}
            >
              {(s.diferencia ?? 0) >= 0 ? '+' : ''}S/ {(s.diferencia ?? 0).toFixed(2)}
            </span>
          </div>
        ))}
        {historial.length === 0 && <p className="p-4 text-sm text-ink-400">Sin sesiones cerradas aún</p>}
      </div>
    </div>
  )
}
