import { useEffect, useState } from 'react'
import { Check, KeyRound, Plus, RefreshCw, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'

interface Autorizacion {
  id: string
  tipo: string
  solicitado_por: string
  solicitante_nombre?: string
  recurso_tipo: string | null
  recurso_id: string | null
  motivo: string
  payload: Record<string, unknown>
  estado: string
  resolutor_nombre?: string | null
  resolucion_motivo?: string | null
  created_at: string
  resolved_at?: string | null
  consumed_at?: string | null
}

const fecha=(v:string)=>new Date(v).toLocaleString('es-PE',{dateStyle:'short',timeStyle:'short'})
const estadoCls=(e:string)=>e==='aprobada'?'text-green-300 border-green-500/20 bg-green-500/10':e==='rechazada'?'text-red-300 border-red-500/20 bg-red-500/10':e==='consumida'?'text-cyan-300 border-cyan-500/20 bg-cyan-500/10':'text-amber-300 border-amber-500/20 bg-amber-500/10'

export default function Autorizaciones(){
  const {isAdmin}=useAuth()
  const {showToast}=useToast()
  const [rows,setRows]=useState<Autorizacion[]>([])
  const [loading,setLoading]=useState(true)
  const [open,setOpen]=useState(false)
  const [resolviendo,setResolviendo]=useState<string|null>(null)

  const cargar=async()=>{
    setLoading(true)
    const res=isAdmin
      ? await supabase.rpc('autorizaciones_admin',{p_estado:null,p_limite:200})
      : await supabase.rpc('mis_autorizaciones',{p_limite:100})
    if(res.error){showToast('No se pudieron cargar las autorizaciones','error');setRows([])} else setRows((res.data as Autorizacion[])||[])
    setLoading(false)
  }
  useEffect(()=>{cargar()},[isAdmin])

  const resolver=async(row:Autorizacion,aprobar:boolean)=>{
    const motivo=window.prompt(aprobar?'Observación de aprobación (opcional)':'Motivo del rechazo', '')
    if(!aprobar&&motivo===null)return
    setResolviendo(row.id)
    const {error}=await supabase.rpc('resolver_autorizacion',{p_autorizacion_id:row.id,p_aprobar:aprobar,p_motivo:motivo||null})
    setResolviendo(null)
    if(error){showToast(error.message,'error');return}
    showToast(aprobar?'Autorización aprobada':'Solicitud rechazada','success');await cargar()
  }

  return <div className="p-3 md:p-5 max-w-6xl mx-auto">
    <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-5"><div><div className="flex items-center gap-2"><KeyRound size={20} className="text-cyan-400"/><h1 className="font-display font-bold text-xl text-white">Autorizaciones</h1></div><p className="text-xs text-gray-500 mt-1">{isAdmin?'Aprueba acciones sensibles sin entregar permisos administrativos permanentes.':'Solicita una aprobación puntual para una acción sensible.'}</p></div><div className="flex gap-2"><button onClick={cargar} className="rounded-xl border border-[#30363d] bg-[#161b22] p-2.5 text-gray-400"><RefreshCw size={16}/></button>{!isAdmin&&<button onClick={()=>setOpen(true)} className="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-4 py-2 text-sm font-bold text-black"><Plus size={15}/>Nueva solicitud</button>}</div></div>

    <div className="rounded-2xl border border-[#30363d] bg-[#161b22] overflow-hidden">{loading?<p className="p-10 text-center text-sm text-gray-500">Cargando...</p>:<div className="divide-y divide-[#21262d]">{rows.map(r=><div key={r.id} className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-bold text-white capitalize">{r.tipo.replace('_',' ')}</p><span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold capitalize ${estadoCls(r.estado)}`}>{r.estado}</span></div>{isAdmin&&<p className="text-[11px] text-cyan-300 mt-1">{r.solicitante_nombre||'Personal'}</p>}<p className="text-[11px] text-gray-500 mt-1">{fecha(r.created_at)}{r.recurso_tipo?` · ${r.recurso_tipo}${r.recurso_id?` ${r.recurso_id}`:''}`:''}</p><p className="text-xs text-gray-300 mt-1.5">{r.motivo}</p>{r.resolucion_motivo&&<p className="text-[10px] text-gray-600 mt-1">Resolución: {r.resolucion_motivo}</p>}</div>{isAdmin&&r.estado==='pendiente'&&<div className="flex gap-2"><button onClick={()=>resolver(r,false)} disabled={resolviendo===r.id} className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] font-bold text-red-300">Rechazar</button><button onClick={()=>resolver(r,true)} disabled={resolviendo===r.id} className="inline-flex items-center gap-1 rounded-lg border border-green-500/20 bg-green-500/10 px-3 py-2 text-[11px] font-bold text-green-300"><Check size={12}/>Aprobar</button></div>}</div>)}{!rows.length&&<p className="p-10 text-center text-xs text-gray-600">No hay autorizaciones registradas.</p>}</div>}</div>
    {open&&<ModalSolicitud onClose={()=>setOpen(false)} onSaved={async()=>{setOpen(false);await cargar();showToast('Solicitud enviada a administración','success')}}/>}
  </div>
}

function ModalSolicitud({onClose,onSaved}:{onClose:()=>void;onSaved:()=>void}){
  const [tipo,setTipo]=useState('anulacion')
  const [recursoId,setRecursoId]=useState('')
  const [motivo,setMotivo]=useState('')
  const [guardando,setGuardando]=useState(false)
  const [error,setError]=useState('')
  const guardar=async()=>{setError('');if(motivo.trim().length<5){setError('Ingresa un motivo de al menos 5 caracteres');return}const requiereVenta=tipo==='anulacion'||tipo==='devolucion';if(requiereVenta&&!recursoId.trim()){setError('Indica el ID de la venta');return}setGuardando(true);const {error:e}=await supabase.rpc('solicitar_autorizacion',{p_tipo:tipo,p_motivo:motivo.trim(),p_recurso_tipo:requiereVenta?'venta':null,p_recurso_id:requiereVenta?recursoId.trim():null,p_payload:{}});setGuardando(false);if(e){setError(e.message);return}onSaved()}
  return <div className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-end md:items-center justify-center"><div className="relative w-full max-w-md rounded-t-2xl md:rounded-2xl border border-[#30363d] bg-[#161b22] p-5"><button onClick={onClose} className="absolute right-4 top-4 text-gray-500"><X size={19}/></button><h3 className="font-bold text-white mb-1">Solicitar autorización</h3><p className="text-xs text-gray-500 mb-4">La aprobación queda limitada a esta solicitud y no cambia tu rol.</p><label className="text-xs text-gray-500">Acción</label><select value={tipo} onChange={e=>setTipo(e.target.value)} className="mt-1 w-full rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2.5 text-sm text-white"><option value="anulacion">Anulación de venta</option><option value="devolucion">Devolución</option><option value="descuento">Descuento excepcional</option><option value="ajuste_stock">Ajuste de stock</option><option value="otro">Otra acción</option></select>{(tipo==='anulacion'||tipo==='devolucion')&&<><label className="block text-xs text-gray-500 mt-4">ID de la venta</label><input value={recursoId} onChange={e=>setRecursoId(e.target.value)} className="mt-1 w-full rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2.5 text-sm text-white" placeholder="UUID de la venta"/></>}<label className="block text-xs text-gray-500 mt-4">Motivo</label><textarea value={motivo} onChange={e=>setMotivo(e.target.value)} rows={3} className="mt-1 w-full resize-none rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2.5 text-sm text-white" placeholder="Explica por qué necesitas esta autorización"/>{error&&<p className="mt-3 rounded-lg bg-red-500/10 p-2 text-xs text-red-400">{error}</p>}<div className="flex gap-2 mt-5"><button onClick={onClose} className="flex-1 rounded-xl border border-[#30363d] py-2.5 text-sm text-gray-300">Cancelar</button><button onClick={guardar} disabled={guardando||motivo.trim().length<5} className="flex-1 rounded-xl bg-cyan-500 py-2.5 text-sm font-bold text-black disabled:opacity-40">{guardando?'Enviando...':'Enviar solicitud'}</button></div></div></div>
}
