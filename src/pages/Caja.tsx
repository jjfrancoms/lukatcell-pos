import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Clock, TrendingUp, AlertTriangle, ArrowDownCircle, ArrowUpCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import { sumarMontos, restarMontos } from '../lib/money'
import type { CashSession, CashMovement, CashMovementTipo } from '../types'

const TIPOS_BASICOS: { value: CashMovementTipo; label: string }[] = [
  { value: 'ingreso', label: 'Ingreso' },
  { value: 'retiro', label: 'Retiro' },
]
const TIPOS_ELEVADOS: { value: CashMovementTipo; label: string }[] = [
  { value: 'gasto', label: 'Gasto' },
  { value: 'deposito_banco', label: 'Depósito a banco' },
  { value: 'retiro_banco', label: 'Retiro de banco' },
]
const ETIQUETAS_MOVIMIENTO: Record<CashMovementTipo, string> = {
  venta_efectivo: 'Venta en efectivo',
  devolucion_efectivo: 'Reembolso',
  ingreso: 'Ingreso',
  retiro: 'Retiro',
  deposito_banco: 'Depósito a banco',
  retiro_banco: 'Retiro de banco',
  gasto: 'Gasto',
  pago_proveedor: 'Pago a proveedor',
  ajuste: 'Ajuste',
}

export default function Caja() {
  const { staff, refreshCashSession } = useAuth()
  const { showToast } = useToast()
  const navigate = useNavigate()
  const [sesionActiva, setSesionActiva] = useState<CashSession | null>(null)
  const [historial, setHistorial] = useState<CashSession[]>([])
  const [montoInicial, setMontoInicial] = useState('')
  const [montoContado, setMontoContado] = useState('')
  const [movimientos, setMovimientos] = useState<CashMovement[]>([])
  const [cargando, setCargando] = useState(false)
  const [confirmandoCierre, setConfirmandoCierre] = useState(false)

  const puedeElevado = staff?.rol === 'administrador' || staff?.puesto === 'jefa' || staff?.puesto === 'encargado'
  const [movTipo, setMovTipo] = useState<CashMovementTipo>('ingreso')
  const [movMonto, setMovMonto] = useState('')
  const [movMotivo, setMovMotivo] = useState('')
  const [registrandoMov, setRegistrandoMov] = useState(false)

  const cargarSesion = async () => {
    if (!staff) return
    const { data } = await supabase.from('cash_sessions').select('*').eq('cajero_id', staff.id).is('cierre', null).order('apertura', { ascending: false }).limit(1).maybeSingle()
    setSesionActiva(data)
  }
  const cargarHistorial = async () => {
    if (!staff) return
    const { data } = await supabase.from('cash_sessions').select('*').eq('cajero_id', staff.id).not('cierre', 'is', null).order('cierre', { ascending: false }).limit(20)
    setHistorial(data || [])
  }
  const cargarMovimientos = async (sesionId: string) => {
    const { data } = await supabase.from('cash_movements').select('*').eq('cash_session_id', sesionId).order('created_at', { ascending: false })
    setMovimientos(data || [])
  }
  useEffect(() => { cargarSesion(); cargarHistorial() }, [staff])
  useEffect(() => {
    if (!sesionActiva) { setMovimientos([]); return }
    cargarMovimientos(sesionActiva.id)
  }, [sesionActiva?.id])

  const ventasEfectivo = sumarMontos(movimientos.filter((m) => m.tipo === 'venta_efectivo').map((m) => m.monto))
  const otrosMovimientos = sumarMontos(movimientos.filter((m) => m.tipo !== 'venta_efectivo').map((m) => m.monto))
  const montoEsperado = sesionActiva ? sumarMontos([sesionActiva.monto_inicial, ventasEfectivo, otrosMovimientos]) : 0
  const diferenciaPreview = montoContado ? restarMontos(Number(montoContado), montoEsperado) : null

  const abrirTurno = async () => {
    if (!staff) return
    setCargando(true)
    const { error } = await supabase.from('cash_sessions').insert({ monto_inicial: Number(montoInicial) || 0, cajero_id: staff.id, location_id: staff.location_id })
    setCargando(false)
    if (error) { showToast(error.message || 'No se pudo abrir la caja', 'error'); return }
    setMontoInicial('')
    await cargarSesion(); await refreshCashSession()
    showToast('Caja abierta', 'success')
    navigate('/')
  }
  const cerrarTurno = async () => {
    if (!sesionActiva) return
    setCargando(true)
    const { error } = await supabase.from('cash_sessions').update({ cierre: new Date().toISOString(), monto_final_contado: Number(montoContado) || 0 }).eq('id', sesionActiva.id)
    setCargando(false)
    if (error) { showToast(error.message || 'No se pudo cerrar la caja', 'error'); return }
    setMontoContado(''); setSesionActiva(null); setConfirmandoCierre(false)
    await cargarSesion(); await cargarHistorial(); await refreshCashSession()
    showToast('Caja cerrada. Registra tu salida cuando termines.', 'success')
    navigate('/jornada')
  }

  const registrarMovimiento = async () => {
    if (!sesionActiva) return
    const monto = Number(movMonto)
    if (!monto || monto <= 0) { showToast('Ingresa un monto válido', 'error'); return }
    if (!movMotivo.trim()) { showToast('Indica el motivo del movimiento', 'error'); return }
    setRegistrandoMov(true)
    const { error } = await supabase.rpc('registrar_movimiento_caja', {
      p_cash_session_id: sesionActiva.id,
      p_tipo: movTipo,
      p_monto: monto,
      p_motivo: movMotivo.trim(),
    })
    setRegistrandoMov(false)
    if (error) { showToast(error.message || 'No se pudo registrar el movimiento', 'error'); return }
    setMovMonto(''); setMovMotivo('')
    await cargarMovimientos(sesionActiva.id)
    showToast('Movimiento registrado', 'success')
  }

  return (
    <div className="p-3 md:p-5 max-w-3xl">
      <h1 className="font-display font-bold text-xl text-white mb-5">Control de caja</h1>
      {!sesionActiva ? (
        <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-cyan-500/15 flex items-center justify-center"><Clock size={20} className="text-cyan-400" /></div>
            <div><h2 className="font-semibold text-white">Abrir caja</h2><p className="text-xs text-gray-500">Tu entrada ya fue registrada. Ingresa el monto inicial.</p></div>
          </div>
          <label className="text-xs text-gray-500 font-semibold">Monto inicial en efectivo (S/)</label>
          <input type="number" value={montoInicial} onChange={(e) => setMontoInicial(e.target.value)} className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mt-1.5 mb-4 text-white text-lg focus:outline-none focus:ring-2 focus:ring-cyan-500" placeholder="100.00" />
          <button onClick={abrirTurno} disabled={cargando} className="bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-bold px-6 py-3 rounded-xl hover:shadow-lg hover:shadow-cyan-500/30 transition-all disabled:opacity-40">{cargando ? 'Abriendo...' : 'Abrir caja'}</button>
        </div>
      ) : (
        <div className="bg-[#161b22] rounded-2xl border border-[#30363d] p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-green-500/15 flex items-center justify-center"><TrendingUp size={20} className="text-green-400" /></div>
            <div><h2 className="font-semibold text-white">Caja activa</h2><p className="text-xs text-gray-500">Desde {new Date(sesionActiva.apertura).toLocaleString('es-PE')}</p></div>
          </div>
          <div className="grid grid-cols-3 gap-3 mb-5">
            <div className="bg-[#0d1117] rounded-xl p-4 border border-[#30363d]">
              <p className="text-xs text-gray-500 mb-1">Monto inicial</p>
              <p className="text-xl font-bold text-white">S/ {sesionActiva.monto_inicial.toFixed(2)}</p>
            </div>
            <div className="bg-[#0d1117] rounded-xl p-4 border border-[#30363d]">
              <p className="text-xs text-gray-500 mb-1">Ventas en efectivo</p>
              <p className="text-xl font-bold text-cyan-400">S/ {ventasEfectivo.toFixed(2)}</p>
            </div>
            <div className="bg-[#0d1117] rounded-xl p-4 border border-[#30363d]">
              <p className="text-xs text-gray-500 mb-1">Esperado ahora</p>
              <p className="text-xl font-bold text-white">S/ {montoEsperado.toFixed(2)}</p>
            </div>
          </div>

          <div className="bg-[#0d1117] rounded-xl p-4 border border-[#30363d] mb-5">
            <p className="text-xs text-gray-500 font-semibold mb-3">Registrar movimiento de caja</p>
            <div className="flex flex-wrap gap-2 mb-3">
              {TIPOS_BASICOS.map((t) => (
                <button key={t.value} onClick={() => setMovTipo(t.value)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${movTipo === t.value ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300' : 'border-[#30363d] text-gray-400'}`}>{t.label}</button>
              ))}
              {puedeElevado && TIPOS_ELEVADOS.map((t) => (
                <button key={t.value} onClick={() => setMovTipo(t.value)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${movTipo === t.value ? 'bg-orange-500/20 border-orange-500 text-orange-300' : 'border-[#30363d] text-gray-400'}`}>{t.label}</button>
              ))}
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <input type="number" value={movMonto} onChange={(e) => setMovMonto(e.target.value)} placeholder="Monto (S/)" className="flex-1 bg-[#161b22] border border-[#30363d] rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
              <input type="text" value={movMotivo} onChange={(e) => setMovMotivo(e.target.value)} placeholder="Motivo (obligatorio)" className="flex-[2] bg-[#161b22] border border-[#30363d] rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
              <button onClick={registrarMovimiento} disabled={registrandoMov} className="bg-[#21262d] hover:bg-[#282e37] text-white font-semibold px-4 py-2 rounded-xl text-sm disabled:opacity-40 whitespace-nowrap">{registrandoMov ? 'Registrando...' : 'Registrar'}</button>
            </div>
          </div>

          {movimientos.length > 0 && (
            <div className="mb-5">
              <p className="text-xs text-gray-500 font-semibold mb-2">Movimientos de esta caja</p>
              <div className="bg-[#0d1117] rounded-xl border border-[#30363d] divide-y divide-[#30363d] max-h-56 overflow-y-auto">
                {movimientos.map((m) => (
                  <div key={m.id} className="p-3 flex justify-between items-center text-sm">
                    <div className="flex items-center gap-2">
                      {m.monto >= 0 ? <ArrowUpCircle size={14} className="text-green-400 shrink-0" /> : <ArrowDownCircle size={14} className="text-red-400 shrink-0" />}
                      <div>
                        <p className="text-white font-medium">{ETIQUETAS_MOVIMIENTO[m.tipo]}</p>
                        {m.motivo && <p className="text-xs text-gray-500">{m.motivo}</p>}
                      </div>
                    </div>
                    <span className={`font-bold ${m.monto >= 0 ? 'text-green-400' : 'text-red-400'}`}>{m.monto >= 0 ? '+' : ''}S/ {m.monto.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <label className="text-xs text-gray-500 font-semibold">Monto contado al cierre (S/)</label>
          <input type="number" value={montoContado} onChange={(e) => { setMontoContado(e.target.value); setConfirmandoCierre(false) }}
            className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 mt-1.5 mb-2 text-white text-lg focus:outline-none focus:ring-2 focus:ring-orange-500" placeholder="0.00" />
          {diferenciaPreview !== null && (
            <p className={`text-xs mb-4 font-semibold ${diferenciaPreview === 0 ? 'text-gray-500' : diferenciaPreview > 0 ? 'text-green-400' : 'text-red-400'}`}>
              {diferenciaPreview === 0 ? 'Cuadra exacto' : `Diferencia: ${diferenciaPreview >= 0 ? '+' : ''}S/ ${diferenciaPreview.toFixed(2)}`}
            </p>
          )}
          {!confirmandoCierre ? (
            <button onClick={() => setConfirmandoCierre(true)} className="bg-gradient-to-r from-orange-500 to-orange-600 text-white font-bold px-6 py-3 rounded-xl hover:shadow-lg hover:shadow-orange-500/30 transition-all">Cerrar caja</button>
          ) : (
            <div className="bg-orange-500/10 border border-orange-500/30 rounded-xl p-4">
              <p className="text-sm text-orange-300 mb-3 flex items-center gap-2"><AlertTriangle size={15} className="shrink-0" /> Esta acción cierra tu caja y no se puede deshacer. ¿Confirmas?</p>
              <div className="flex gap-2">
                <button onClick={() => setConfirmandoCierre(false)} className="flex-1 bg-[#21262d] text-gray-300 font-semibold py-2.5 rounded-xl text-sm">Cancelar</button>
                <button onClick={cerrarTurno} disabled={cargando} className="flex-1 bg-gradient-to-r from-orange-500 to-orange-600 text-white font-bold py-2.5 rounded-xl text-sm disabled:opacity-40">{cargando ? 'Cerrando...' : 'Sí, cerrar caja'}</button>
              </div>
            </div>
          )}
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
