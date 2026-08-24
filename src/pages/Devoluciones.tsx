import { useEffect, useMemo, useState } from 'react'
import { RotateCcw, RefreshCw, Search, X, WalletCards } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useToast } from '../lib/toast'

interface Venta { id: string; numero: number; fecha: string; total: number; estado: string; cajero: { nombre: string } | null }
interface ItemVenta { id: string; variant_id: string; cantidad: number; subtotal: number; producto_nombre_snapshot: string | null }
interface DevItem { sale_item_id: string; cantidad: number }
interface Devolucion { id: string; sale_id: string; tipo: string; motivo: string; monto: number; estado: string; reembolso_estado: string; reembolso_metodo: string | null; reembolso_referencia: string | null; created_at: string; venta: { numero: number } | null; creador: { nombre: string } | null }
interface Caja { id: string; cajero: { nombre: string } | null; monto_inicial: number }

const soles = (v: number) => new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' }).format(Number(v || 0))
const fecha = (v: string) => new Date(v).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' })

export default function Devoluciones() {
  const { showToast } = useToast()
  const [ventas, setVentas] = useState<Venta[]>([])
  const [devoluciones, setDevoluciones] = useState<Devolucion[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [ventaSeleccionada, setVentaSeleccionada] = useState<Venta | null>(null)
  const [reembolso, setReembolso] = useState<Devolucion | null>(null)

  const cargar = async (manual = false) => {
    manual ? setRefreshing(true) : setLoading(true)
    const [v, d] = await Promise.all([
      supabase.from('sales').select('id,numero,fecha,total,estado,cajero:staff!sales_cajero_id_fkey(nombre)').eq('estado', 'completada').order('fecha', { ascending: false }).limit(200),
      supabase.from('devoluciones').select('id,sale_id,tipo,motivo,monto,estado,reembolso_estado,reembolso_metodo,reembolso_referencia,created_at,venta:sales(numero),creador:staff!devoluciones_creado_por_fkey(nombre)').order('created_at', { ascending: false }).limit(200),
    ])
    if (v.error || d.error) showToast('No se pudo cargar devoluciones', 'error')
    setVentas((v.data as unknown as Venta[]) || [])
    setDevoluciones((d.data as unknown as Devolucion[]) || [])
    setLoading(false); setRefreshing(false)
  }

  useEffect(() => { cargar() }, [])

  const filtradas = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return ventas
    return ventas.filter((v) => String(v.numero).includes(q) || (v.cajero?.nombre || '').toLowerCase().includes(q))
  }, [ventas, query])

  return <div className="p-3 md:p-5 max-w-6xl mx-auto">
    <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-5">
      <div><div className="flex items-center gap-2"><RotateCcw size={20} className="text-cyan-400" /><h1 className="font-display font-bold text-xl text-white">Devoluciones</h1></div><p className="text-xs text-gray-500 mt-1">Devolución parcial o total con reposición automática de stock y seguimiento del reembolso.</p></div>
      <button onClick={() => cargar(true)} disabled={refreshing} className="inline-flex items-center gap-2 rounded-xl border border-[#30363d] bg-[#161b22] px-3 py-2 text-sm text-gray-300 disabled:opacity-50"><RefreshCw size={15} className={refreshing ? 'animate-spin' : ''}/>Actualizar</button>
    </div>

    <div className="grid xl:grid-cols-[1fr_1fr] gap-4">
      <section className="rounded-2xl border border-[#30363d] bg-[#161b22] overflow-hidden">
        <div className="p-4 border-b border-[#30363d]"><h2 className="text-sm font-bold text-white">Ventas completadas</h2><div className="relative mt-3"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600"/><input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Venta o cajero..." className="w-full rounded-xl border border-[#30363d] bg-[#0d1117] py-2 pl-8 pr-3 text-xs text-white placeholder:text-gray-700"/></div></div>
        {loading ? <div className="p-8 text-center text-sm text-gray-500">Cargando...</div> : <div className="divide-y divide-[#21262d] max-h-[620px] overflow-y-auto">{filtradas.map((v)=><div key={v.id} className="p-4 flex items-center justify-between gap-3"><div><p className="text-sm font-bold text-white">Venta #{v.numero}</p><p className="text-[11px] text-gray-500">{fecha(v.fecha)} · {v.cajero?.nombre || 'Sin cajero'}</p><p className="text-sm font-bold text-cyan-300 mt-1">{soles(v.total)}</p></div><button onClick={()=>setVentaSeleccionada(v)} className="rounded-lg border border-cyan-500/25 bg-cyan-500/10 px-3 py-2 text-[11px] font-bold text-cyan-300">Devolver</button></div>)}{!filtradas.length&&<p className="p-8 text-center text-xs text-gray-600">Sin ventas disponibles</p>}</div>}
      </section>

      <section className="rounded-2xl border border-[#30363d] bg-[#161b22] overflow-hidden">
        <div className="p-4 border-b border-[#30363d]"><h2 className="text-sm font-bold text-white">Historial de devoluciones</h2><p className="text-[11px] text-gray-500 mt-1">Los reembolsos pendientes requieren confirmación administrativa.</p></div>
        <div className="divide-y divide-[#21262d] max-h-[620px] overflow-y-auto">{devoluciones.map((d)=><div key={d.id} className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-3"><div><div className="flex flex-wrap gap-2 items-center"><p className="text-sm font-bold text-white">Venta #{d.venta?.numero ?? '—'}</p><span className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-bold text-cyan-300 capitalize">{d.tipo}</span><span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${d.reembolso_estado==='completado'?'border-green-500/20 bg-green-500/10 text-green-300':'border-amber-500/20 bg-amber-500/10 text-amber-300'}`}>Reembolso {d.reembolso_estado}</span></div><p className="text-[11px] text-gray-500 mt-1">{fecha(d.created_at)} · {d.creador?.nombre || 'Administración'}</p><p className="text-base font-bold text-white mt-1">{soles(d.monto)}</p><p className="text-xs text-gray-400 mt-1">{d.motivo}</p>{d.reembolso_metodo&&<p className="text-[10px] text-gray-600 mt-1">{d.reembolso_metodo}{d.reembolso_referencia?` · ${d.reembolso_referencia}`:''}</p>}</div>{d.reembolso_estado==='pendiente'&&<button onClick={()=>setReembolso(d)} className="self-start md:self-auto rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] font-bold text-amber-300">Confirmar reembolso</button>}</div>)}{!devoluciones.length&&<p className="p-8 text-center text-xs text-gray-600">No hay devoluciones registradas.</p>}</div>
      </section>
    </div>

    {ventaSeleccionada&&<ModalDevolucion venta={ventaSeleccionada} onClose={()=>setVentaSeleccionada(null)} onSaved={async()=>{setVentaSeleccionada(null);await cargar(true);showToast('Devolución registrada y stock repuesto','success')}}/>}
    {reembolso&&<ModalReembolso devolucion={reembolso} onClose={()=>setReembolso(null)} onSaved={async()=>{setReembolso(null);await cargar(true);showToast('Reembolso confirmado','success')}}/>}
  </div>
}

function ModalDevolucion({venta,onClose,onSaved}:{venta:Venta;onClose:()=>void;onSaved:()=>void}){
  const [items,setItems]=useState<ItemVenta[]>([])
  const [previas,setPrevias]=useState<Record<string,number>>({})
  const [cantidades,setCantidades]=useState<Record<string,number>>({})
  const [motivo,setMotivo]=useState('')
  const [loading,setLoading]=useState(true)
  const [guardando,setGuardando]=useState(false)
  const [error,setError]=useState('')

  useEffect(()=>{Promise.all([
    supabase.from('sale_items').select('id,variant_id,cantidad,subtotal,producto_nombre_snapshot').eq('sale_id',venta.id),
    supabase.from('devolucion_items').select('sale_item_id,cantidad,devolucion:devoluciones!inner(sale_id,estado)').eq('devolucion.sale_id',venta.id).eq('devolucion.estado','completada'),
  ]).then(([i,d])=>{setItems((i.data as ItemVenta[])||[]);const p:Record<string,number>={};((d.data as unknown as DevItem[])||[]).forEach(x=>p[x.sale_item_id]=(p[x.sale_item_id]||0)+x.cantidad);setPrevias(p);setLoading(false)})},[venta.id])

  const payload=items.map(i=>({sale_item_id:i.id,cantidad:Math.max(0,Number(cantidades[i.id]||0))})).filter(i=>i.cantidad>0)
  const guardar=async()=>{setError('');if(!payload.length||motivo.trim().length<5){setError('Selecciona al menos una unidad e ingresa un motivo');return}setGuardando(true);const{error:e}=await supabase.rpc('registrar_devolucion',{p_sale_id:venta.id,p_items:payload,p_motivo:motivo.trim()});setGuardando(false);if(e){setError(e.message);return}onSaved()}

  return <div className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-end md:items-center justify-center"><div className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-t-2xl md:rounded-2xl border border-[#30363d] bg-[#161b22] p-5"><button onClick={onClose} className="absolute right-4 top-4 text-gray-500"><X size={19}/></button><h3 className="font-bold text-white">Devolver venta #{venta.numero}</h3><p className="text-xs text-gray-500 mb-4">Selecciona únicamente las unidades que físicamente regresan a inventario.</p>{loading?<p className="py-6 text-center text-xs text-gray-500">Cargando líneas...</p>:<div className="space-y-2">{items.map(i=>{const disponible=Math.max(0,i.cantidad-(previas[i.id]||0));return <div key={i.id} className="rounded-xl border border-[#30363d] bg-[#0d1117] p-3 flex items-center justify-between gap-3"><div><p className="text-sm font-semibold text-white">{i.producto_nombre_snapshot||'Producto'}</p><p className="text-[10px] text-gray-600">Vendido {i.cantidad} · devuelto {previas[i.id]||0} · disponible {disponible}</p></div><input type="number" min={0} max={disponible} value={cantidades[i.id]||0} onChange={e=>setCantidades(c=>({...c,[i.id]:Math.min(disponible,Math.max(0,Number(e.target.value)||0))}))} className="w-20 rounded-lg border border-[#30363d] bg-[#161b22] px-2 py-1.5 text-sm text-white"/></div>})}</div>}<label className="block text-xs font-semibold text-gray-500 mt-4">Motivo</label><textarea value={motivo} onChange={e=>setMotivo(e.target.value)} rows={3} className="mt-1 w-full resize-none rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2 text-sm text-white" placeholder="Producto defectuoso, cambio solicitado..."/>{error&&<p className="mt-3 rounded-lg bg-red-500/10 p-2 text-xs text-red-400">{error}</p>}<div className="flex gap-2 mt-5"><button onClick={onClose} className="flex-1 rounded-xl border border-[#30363d] py-2.5 text-sm text-gray-300">Cancelar</button><button onClick={guardar} disabled={guardando||!payload.length||motivo.trim().length<5} className="flex-1 rounded-xl bg-cyan-500 py-2.5 text-sm font-bold text-black disabled:opacity-40">{guardando?'Registrando...':'Registrar devolución'}</button></div></div></div>
}

function ModalReembolso({devolucion,onClose,onSaved}:{devolucion:Devolucion;onClose:()=>void;onSaved:()=>void}){
  const [metodo,setMetodo]=useState('efectivo')
  const [referencia,setReferencia]=useState('')
  const [cajas,setCajas]=useState<Caja[]>([])
  const [cajaId,setCajaId]=useState('')
  const [guardando,setGuardando]=useState(false)
  const [error,setError]=useState('')
  useEffect(()=>{supabase.from('cash_sessions').select('id,monto_inicial,cajero:staff!cash_sessions_cajero_id_fkey(nombre)').is('cierre',null).order('apertura',{ascending:false}).then(({data})=>{setCajas((data as unknown as Caja[])||[]);setCajaId(data?.[0]?.id||'')})},[])
  const guardar=async()=>{setError('');if(metodo==='efectivo'&&!cajaId){setError('No hay una caja abierta para devolver efectivo');return}setGuardando(true);const{error:e}=await supabase.rpc('confirmar_reembolso_devolucion',{p_devolucion_id:devolucion.id,p_metodo:metodo,p_referencia:referencia.trim()||null,p_cash_session_id:metodo==='efectivo'?cajaId:null});setGuardando(false);if(e){setError(e.message);return}onSaved()}
  return <div className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-end md:items-center justify-center"><div className="relative w-full max-w-md rounded-t-2xl md:rounded-2xl border border-[#30363d] bg-[#161b22] p-5"><button onClick={onClose} className="absolute right-4 top-4 text-gray-500"><X size={19}/></button><div className="flex items-center gap-2 mb-1"><WalletCards size={18} className="text-amber-400"/><h3 className="font-bold text-white">Confirmar reembolso</h3></div><p className="text-xs text-gray-500 mb-4">Monto: {soles(devolucion.monto)}</p><label className="text-xs text-gray-500">Método</label><select value={metodo} onChange={e=>setMetodo(e.target.value)} className="mt-1 w-full rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2.5 text-sm text-white"><option value="efectivo">Efectivo</option><option value="yape">Yape</option><option value="plin">Plin</option><option value="tarjeta">Tarjeta</option><option value="transferencia">Transferencia</option></select>{metodo==='efectivo'&&<><label className="block text-xs text-gray-500 mt-4">Caja que entrega el efectivo</label><select value={cajaId} onChange={e=>setCajaId(e.target.value)} className="mt-1 w-full rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2.5 text-sm text-white"><option value="">Selecciona caja abierta</option>{cajas.map(c=><option key={c.id} value={c.id}>{c.cajero?.nombre||'Caja'} · inicial {soles(c.monto_inicial)}</option>)}</select></>}<label className="block text-xs text-gray-500 mt-4">Referencia / constancia</label><input value={referencia} onChange={e=>setReferencia(e.target.value)} className="mt-1 w-full rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2.5 text-sm text-white" placeholder="Opcional"/>{metodo!=='efectivo'&&<p className="text-[10px] text-amber-300/70 mt-2">Esta confirmación registra la devolución como realizada manualmente; la automatización directa con el proveedor se conecta en Integraciones.</p>}{error&&<p className="mt-3 rounded-lg bg-red-500/10 p-2 text-xs text-red-400">{error}</p>}<div className="flex gap-2 mt-5"><button onClick={onClose} className="flex-1 rounded-xl border border-[#30363d] py-2.5 text-sm text-gray-300">Cancelar</button><button onClick={guardar} disabled={guardando||(metodo==='efectivo'&&!cajaId)} className="flex-1 rounded-xl bg-amber-500 py-2.5 text-sm font-bold text-black disabled:opacity-40">{guardando?'Confirmando...':'Confirmar reembolso'}</button></div></div></div>
}
