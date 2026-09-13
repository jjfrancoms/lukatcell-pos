import { useState, useEffect, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Clock, TrendingUp, AlertTriangle, ArrowDownCircle, ArrowUpCircle, ShieldCheck } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import { sumarMontos, restarMontos } from '../lib/money'
import { getVentasPendientes } from '../lib/offline'
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
// Autorización operativa reutilizada para caja: el motor es el de siempre
// (tipo 'otro' + recurso_tipo 'movimiento_caja'), no hay uno nuevo.
type AutorizacionCaja = {
  id: string
  estado: string
  motivo: string
  payload: { tipo?: string; monto?: number } | null
}
const RECURSO_CAJA = 'movimiento_caja'
// Tipos que sacan efectivo del cajón. El ajuste va aparte: cuenta para el
// umbral en cualquier signo, porque un ajuste positivo grande es justo el
// mecanismo con el que se tapa un faltante.
const TIPOS_EGRESO: CashMovementTipo[] = ['retiro', 'gasto', 'deposito_banco']

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
  const [ventasSinSincronizar, setVentasSinSincronizar] = useState(0)
  // Umbral por encima del cual un egreso o ajuste exige autorización aprobada.
  // El servidor es quien manda: esto es sólo para no dejar al cajero a ciegas.
  const [umbral, setUmbral] = useState<number | null>(null)
  const [autorizacion, setAutorizacion] = useState<AutorizacionCaja | null>(null)
  const [solicitando, setSolicitando] = useState(false)
  // Se genera ANTES del envío y se reutiliza en cada reintento: el doble clic
  // manda el mismo id y el servidor devuelve el movimiento que ya registró en
  // vez de duplicarlo. Sólo se renueva cuando un movimiento se completa.
  const [txId, setTxId] = useState(() => crypto.randomUUID())

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
  const cargarAutorizacion = async (sesionId: string) => {
    const { data } = await supabase.from('autorizaciones_operativas').select('id,estado,motivo,payload')
      .eq('recurso_tipo', RECURSO_CAJA).eq('recurso_id', sesionId).in('estado', ['pendiente', 'aprobada'])
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    setAutorizacion((data as AutorizacionCaja | null) ?? null)
  }
  useEffect(() => { cargarSesion(); cargarHistorial() }, [staff])
  useEffect(() => {
    supabase.from('configuracion').select('caja_egreso_max_sin_autorizacion').eq('id', 1).maybeSingle()
      .then(({ data }) => setUmbral(data ? Number((data as { caja_egreso_max_sin_autorizacion: number }).caja_egreso_max_sin_autorizacion) : null))
  }, [])
  useEffect(() => {
    if (!sesionActiva) { setMovimientos([]); setVentasSinSincronizar(0); setAutorizacion(null); return }
    cargarMovimientos(sesionActiva.id)
    cargarAutorizacion(sesionActiva.id)
    const revisarPendientes = () => {
      getVentasPendientes().then((todas) => {
        setVentasSinSincronizar(todas.filter((v) => v.cashSessionId === sesionActiva.id).length)
      })
    }
    revisarPendientes()
    const intervalo = setInterval(revisarPendientes, 5000)
    return () => clearInterval(intervalo)
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
    const pendientes = (await getVentasPendientes()).filter((v) => v.cashSessionId === sesionActiva.id)
    if (pendientes.length > 0) {
      setVentasSinSincronizar(pendientes.length)
      showToast('No puedes cerrar: aún hay ventas de este dispositivo sin sincronizar', 'error')
      return
    }
    setCargando(true)
    const { error } = await supabase.from('cash_sessions').update({ cierre: new Date().toISOString(), monto_final_contado: Number(montoContado) || 0 }).eq('id', sesionActiva.id)
    setCargando(false)
    if (error) { showToast(error.message || 'No se pudo cerrar la caja', 'error'); return }
    setMontoContado(''); setSesionActiva(null); setConfirmandoCierre(false)
    await cargarSesion(); await cargarHistorial(); await refreshCashSession()
    showToast('Caja cerrada. Registra tu salida cuando termines.', 'success')
    navigate('/jornada')
  }

  const montoNum = Number(movMonto) || 0
  // El servidor trabaja con el valor absoluto: un ajuste lleva signo y cuenta
  // para el umbral en cualquier sentido.
  const montoAbs = Math.abs(montoNum)
  const esEgreso = TIPOS_EGRESO.includes(movTipo)
  // Espejo EXACTO de la regla de registrar_movimiento_caja:
  //   requiere autorización ⇔ (monto_firmado < 0 or tipo = 'ajuste') and abs(monto) > umbral
  // Es informativo —el servidor rechaza igual—, pero si el espejo omite un caso,
  // la UI no ofrece pedir la autorización que el servidor sí exige y el
  // movimiento queda sin salida. Hoy `ajuste` no se ofrece en el selector; se
  // refleja igualmente para que añadirlo no abra ese callejón.
  const requiereAutorizacion = umbral !== null && (esEgreso || movTipo === 'ajuste') && montoAbs > umbral
  const autorizacionAprobada = autorizacion?.estado === 'aprobada' ? autorizacion : null
  const autorizacionCubre = !!autorizacionAprobada
    && autorizacionAprobada.payload?.tipo === movTipo
    && montoAbs > 0 && montoAbs <= Number(autorizacionAprobada.payload?.monto ?? 0)

  // Una clave por INTENCIÓN, no por clic. Un reintento con el mismo contenido
  // conserva la clave y el servidor devuelve el movimiento ya registrado; si el
  // cajero cambia tipo, monto o motivo es otra operación y necesita otra clave.
  // Sin esto, tras un éxito cuya respuesta se perdió, editar el formulario
  // reutilizaría una clave ya consumida con un contenido distinto.
  useEffect(() => { setTxId(crypto.randomUUID()) }, [movTipo, movMonto, movMotivo])

  const solicitarAutorizacion = async () => {
    if (!sesionActiva) return
    if (montoAbs <= 0) { showToast('Ingresa el monto que necesitas autorizar', 'error'); return }
    const motivo = movMotivo.trim()
    if (motivo.length < 5) { showToast('Indica un motivo de al menos 5 caracteres', 'error'); return }
    setSolicitando(true)
    const { error } = await supabase.rpc('solicitar_autorizacion', {
      p_tipo: 'otro',
      p_recurso_tipo: RECURSO_CAJA,
      p_recurso_id: sesionActiva.id,
      p_motivo: `Caja · ${ETIQUETAS_MOVIMIENTO[movTipo]} de S/ ${montoAbs.toFixed(2)}: ${motivo}`,
      // El servidor exige un número JSON > 0 y lo compara con el valor absoluto:
      // un ajuste negativo enviado tal cual se rechazaría por "no indica el monto".
      p_payload: { tipo: movTipo, monto: montoAbs },
    })
    setSolicitando(false)
    if (error) { showToast(error.message || 'No se pudo solicitar la autorización', 'error'); return }
    await cargarAutorizacion(sesionActiva.id)
    showToast('Solicitud enviada. Un administrador debe aprobarla.', 'success')
  }

  // Guarda SÍNCRONA contra el doble envío. `registrandoMov` es estado de React y
  // no se actualiza hasta el siguiente render: dos clics en la misma tarea de JS
  // pasarían ambos. El ref se lee y se escribe en el acto.
  const enviandoMov = useRef(false)

  const registrarMovimiento = async () => {
    if (!sesionActiva || enviandoMov.current) return
    const monto = Number(movMonto)
    if (!monto || monto <= 0) { showToast('Ingresa un monto válido', 'error'); return }
    if (!movMotivo.trim()) { showToast('Indica el motivo del movimiento', 'error'); return }
    enviandoMov.current = true
    setRegistrandoMov(true)
    // El builder de PostgREST es thenable pero no expone .finally(): se libera
    // la guarda con try/finally para que ni un error de red la deje bloqueada.
    let error: { message?: string } | null = null
    try {
      ;({ error } = await supabase.rpc('registrar_movimiento_caja', {
        p_cash_session_id: sesionActiva.id,
        p_tipo: movTipo,
        p_monto: monto,
        p_motivo: movMotivo.trim(),
        p_client_transaction_id: txId,
        p_autorizacion_id: autorizacionCubre ? autorizacionAprobada!.id : null,
      }))
    } catch (e) {
      error = { message: e instanceof Error ? e.message : 'No se pudo registrar el movimiento' }
    } finally {
      enviandoMov.current = false
    }
    setRegistrandoMov(false)
    if (error) {
      // El id de transacción NO se renueva: el reintento del mismo movimiento
      // debe seguir siendo el mismo movimiento para el servidor.
      showToast(error.message || 'No se pudo registrar el movimiento', 'error')
      // Un timeout DESPUÉS del commit llega aquí como error. Recargar los
      // movimientos hace visible un movimiento que sí se registró, para que el
      // cajero no lo cargue otra vez a mano creyendo que falló.
      await cargarMovimientos(sesionActiva.id)
      await cargarAutorizacion(sesionActiva.id)
      return
    }
    setMovMonto(''); setMovMotivo(''); setTxId(crypto.randomUUID())
    await cargarMovimientos(sesionActiva.id)
    await cargarAutorizacion(sesionActiva.id)
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
              <button onClick={registrarMovimiento} disabled={registrandoMov || (requiereAutorizacion && !autorizacionCubre)} className="bg-[#21262d] hover:bg-[#282e37] text-white font-semibold px-4 py-2 rounded-xl text-sm disabled:opacity-40 whitespace-nowrap">{registrandoMov ? 'Registrando...' : 'Registrar'}</button>
            </div>
            {umbral !== null && esEgreso && (
              <p className="text-[11px] text-gray-600 mt-2">Por encima de S/ {umbral.toFixed(2)}, un egreso necesita autorización de un administrador.</p>
            )}
            {requiereAutorizacion && (
              <div className={`mt-3 rounded-xl border p-3 ${autorizacionCubre ? 'border-green-500/30 bg-green-500/10' : 'border-orange-500/30 bg-orange-500/10'}`}>
                {autorizacionCubre ? (
                  <p className="text-xs text-green-300 flex items-center gap-2"><ShieldCheck size={14} className="shrink-0" />
                    Autorización aprobada por hasta S/ {Number(autorizacionAprobada?.payload?.monto ?? 0).toFixed(2)}. Se consumirá al registrar este movimiento.
                  </p>
                ) : (
                  <>
                    <p className="text-xs text-orange-300 flex items-center gap-2 mb-2"><AlertTriangle size={14} className="shrink-0" />
                      {autorizacion?.estado === 'pendiente'
                        ? `Ya hay una solicitud pendiente para esta caja (${ETIQUETAS_MOVIMIENTO[(autorizacion.payload?.tipo ?? 'retiro') as CashMovementTipo]} de S/ ${Number(autorizacion.payload?.monto ?? 0).toFixed(2)}). Espera a que un administrador la resuelva.`
                        : autorizacionAprobada
                          ? `La autorización aprobada cubre ${ETIQUETAS_MOVIMIENTO[(autorizacionAprobada.payload?.tipo ?? 'retiro') as CashMovementTipo]} de hasta S/ ${Number(autorizacionAprobada.payload?.monto ?? 0).toFixed(2)}; no cubre este movimiento.`
                          : `Este ${ETIQUETAS_MOVIMIENTO[movTipo].toLowerCase()} de S/ ${montoNum.toFixed(2)} supera el umbral y necesita autorización aprobada.`}
                    </p>
                    {autorizacion?.estado !== 'pendiente' && (
                      <button onClick={solicitarAutorizacion} disabled={solicitando} className="rounded-lg bg-orange-500/20 border border-orange-500/40 px-3 py-1.5 text-xs font-semibold text-orange-200 disabled:opacity-40">{solicitando ? 'Enviando...' : 'Solicitar autorización'}</button>
                    )}
                  </>
                )}
              </div>
            )}
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
          {ventasSinSincronizar > 0 && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 mb-4">
              <p className="text-sm text-red-300 flex items-center gap-2"><AlertTriangle size={15} className="shrink-0" />
                Tienes {ventasSinSincronizar} venta{ventasSinSincronizar > 1 ? 's' : ''} de este dispositivo aún sin sincronizar. No puedes cerrar la caja hasta que se suban (conéctate a internet y espera, o revisa el <Link to="/offline" className="underline font-semibold">panel offline</Link>).
              </p>
            </div>
          )}
          {!confirmandoCierre ? (
            <button onClick={() => setConfirmandoCierre(true)} disabled={ventasSinSincronizar > 0} className="bg-gradient-to-r from-orange-500 to-orange-600 text-white font-bold px-6 py-3 rounded-xl hover:shadow-lg hover:shadow-orange-500/30 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:shadow-none">Cerrar caja</button>
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
              {s.recalculado_tras_cierre && (
                <p className="text-xs text-yellow-500 mt-0.5">Recalculada: llegó una venta offline después del cierre</p>
              )}
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
