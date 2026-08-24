import { useEffect, useMemo, useState } from 'react'
import { FileMinus2, RefreshCw, Save, Send } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useToast } from '../lib/toast'

interface Devolucion {
  id: string
  sale_id: string
  tipo: string
  motivo: string
  monto: number
  created_at: string
  venta: { numero: number; tipo_comprobante: string } | null
}
interface Nota {
  id: string
  devolucion_id: string | null
  sale_id: string
  tipo_nota: number
  sustento: string
  serie: string
  numero: number
  monto: number
  estado: string
  enlace_pdf: string | null
  respuesta_error: string | null
  intentos: number
  created_at: string
}

const soles=(v:number)=>new Intl.NumberFormat('es-PE',{style:'currency',currency:'PEN'}).format(Number(v||0))
const fecha=(v:string)=>new Date(v).toLocaleString('es-PE',{dateStyle:'short',timeStyle:'short'})

export default function NotasCredito(){
  const {showToast}=useToast()
  const [serieBoleta,setSerieBoleta]=useState('')
  const [serieFactura,setSerieFactura]=useState('')
  const [devoluciones,setDevoluciones]=useState<Devolucion[]>([])
  const [notas,setNotas]=useState<Nota[]>([])
  const [loading,setLoading]=useState(true)
  const [saving,setSaving]=useState(false)
  const [procesando,setProcesando]=useState<string|null>(null)

  const cargar=async()=>{
    setLoading(true)
    const [c,d,n]=await Promise.all([
      supabase.from('configuracion').select('nubefact_serie_nc_boleta,nubefact_serie_nc_factura').eq('id',1).single(),
      supabase.from('devoluciones').select('id,sale_id,tipo,motivo,monto,created_at,venta:sales(numero,tipo_comprobante)').eq('estado','completada').order('created_at',{ascending:false}).limit(200),
      supabase.from('notas_credito').select('id,devolucion_id,sale_id,tipo_nota,sustento,serie,numero,monto,estado,enlace_pdf,respuesta_error,intentos,created_at').order('created_at',{ascending:false}).limit(200),
    ])
    if(c.error||d.error||n.error) showToast('No se pudo cargar Notas de crédito','error')
    setSerieBoleta(c.data?.nubefact_serie_nc_boleta||'')
    setSerieFactura(c.data?.nubefact_serie_nc_factura||'')
    setDevoluciones((d.data as unknown as Devolucion[])||[])
    setNotas((n.data as Nota[])||[])
    setLoading(false)
  }
  useEffect(()=>{cargar()},[])

  const porDev=useMemo(()=>new Map(notas.filter(n=>n.devolucion_id).map(n=>[n.devolucion_id!,n])),[notas])
  const pendientes=devoluciones.filter(d=>!porDev.has(d.id))

  const guardarSeries=async()=>{
    const b=serieBoleta.trim().toUpperCase(),f=serieFactura.trim().toUpperCase()
    if((b&&(!b.startsWith('B')||b.length!==4))||(f&&(!f.startsWith('F')||f.length!==4))){showToast('Boleta debe usar serie Bxxx y factura Fxxx','error');return}
    setSaving(true)
    const {error}=await supabase.from('configuracion').update({nubefact_serie_nc_boleta:b||null,nubefact_serie_nc_factura:f||null,updated_at:new Date().toISOString()}).eq('id',1)
    setSaving(false)
    if(error){showToast('No se pudieron guardar las series','error');return}
    showToast('Series de Nota de crédito guardadas','success')
  }

  const crear=async(d:Devolucion)=>{
    setProcesando(d.id)
    const {data,error}=await supabase.rpc('crear_nota_credito_devolucion',{p_devolucion_id:d.id})
    setProcesando(null)
    if(error){showToast(error.message,'error');return}
    showToast(`Nota ${data?.serie||''}-${data?.numero||''} creada`,'success');await cargar()
  }

  const reintentar=async(n:Nota)=>{
    setProcesando(n.id)
    const {error}=await supabase.functions.invoke('emitir-nota-credito',{body:{nota_credito_id:n.id}})
    setProcesando(null)
    if(error){showToast('No se pudo reintentar la emisión','error');return}
    await cargar()
  }

  return <div className="p-3 md:p-5 max-w-6xl mx-auto">
    <div className="flex items-center justify-between gap-3 mb-5"><div><div className="flex items-center gap-2"><FileMinus2 size={20} className="text-cyan-400"/><h1 className="font-display font-bold text-xl text-white">Notas de crédito</h1></div><p className="text-xs text-gray-500 mt-1">Emisión asociada a una sola devolución y un solo comprobante electrónico original.</p></div><button onClick={cargar} className="rounded-xl border border-[#30363d] bg-[#161b22] p-2.5 text-gray-400"><RefreshCw size={16}/></button></div>

    <section className="rounded-2xl border border-[#30363d] bg-[#161b22] p-4 mb-4"><h2 className="text-sm font-bold text-white">Series fiscales</h2><p className="text-[11px] text-gray-500 mt-1">No se asignan automáticamente: usa las series habilitadas en tu cuenta NubeFact.</p><div className="grid md:grid-cols-2 gap-3 mt-3"><div><label className="text-xs text-gray-500">NC de boleta</label><input value={serieBoleta} onChange={e=>setSerieBoleta(e.target.value.toUpperCase().slice(0,4))} placeholder="Bxxx" className="mt-1 w-full rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2 text-sm text-white"/></div><div><label className="text-xs text-gray-500">NC de factura</label><input value={serieFactura} onChange={e=>setSerieFactura(e.target.value.toUpperCase().slice(0,4))} placeholder="Fxxx" className="mt-1 w-full rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2 text-sm text-white"/></div></div><button onClick={guardarSeries} disabled={saving} className="mt-3 inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-4 py-2 text-sm font-bold text-black disabled:opacity-50"><Save size={14}/>{saving?'Guardando...':'Guardar series'}</button></section>

    <div className="grid xl:grid-cols-2 gap-4">
      <section className="rounded-2xl border border-[#30363d] bg-[#161b22] overflow-hidden"><div className="p-4 border-b border-[#30363d]"><h2 className="text-sm font-bold text-white">Devoluciones sin NC</h2><p className="text-[11px] text-gray-500 mt-1">Solo se podrá crear si la venta tiene comprobante electrónico emitido.</p></div>{loading?<p className="p-8 text-center text-xs text-gray-500">Cargando...</p>:<div className="divide-y divide-[#21262d]">{pendientes.map(d=><div key={d.id} className="p-4 flex items-center justify-between gap-3"><div><p className="text-sm font-bold text-white">Venta #{d.venta?.numero??'—'}</p><p className="text-[11px] text-gray-500">{fecha(d.created_at)} · devolución {d.tipo}</p><p className="text-sm font-bold text-cyan-300 mt-1">{soles(d.monto)}</p><p className="text-xs text-gray-400 mt-1">{d.motivo}</p></div><button onClick={()=>crear(d)} disabled={procesando===d.id} className="rounded-lg border border-cyan-500/25 bg-cyan-500/10 px-3 py-2 text-[11px] font-bold text-cyan-300 disabled:opacity-50">{procesando===d.id?'Creando...':'Crear NC'}</button></div>)}{!pendientes.length&&<p className="p-8 text-center text-xs text-gray-600">No hay devoluciones pendientes de Nota de crédito.</p>}</div>}</section>

      <section className="rounded-2xl border border-[#30363d] bg-[#161b22] overflow-hidden"><div className="p-4 border-b border-[#30363d]"><h2 className="text-sm font-bold text-white">Notas registradas</h2></div><div className="divide-y divide-[#21262d]">{notas.map(n=><div key={n.id} className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-3"><div><div className="flex gap-2 items-center"><p className="text-sm font-bold text-white">{n.serie}-{n.numero}</p><span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${n.estado==='emitido'?'border-green-500/20 bg-green-500/10 text-green-300':n.estado==='error'?'border-red-500/20 bg-red-500/10 text-red-300':'border-amber-500/20 bg-amber-500/10 text-amber-300'}`}>{n.estado}</span></div><p className="text-[11px] text-gray-500 mt-1">Tipo {n.tipo_nota} · {fecha(n.created_at)} · intento {n.intentos}</p><p className="text-sm font-bold text-white mt-1">{soles(n.monto)}</p>{n.respuesta_error&&<p className="text-[10px] text-red-300/70 mt-1 max-w-md">{n.respuesta_error}</p>}</div><div className="flex gap-2">{n.enlace_pdf&&<a href={n.enlace_pdf} target="_blank" rel="noreferrer" className="rounded-lg border border-green-500/20 bg-green-500/10 px-3 py-2 text-[11px] font-bold text-green-300">PDF</a>}{n.estado==='error'&&<button onClick={()=>reintentar(n)} disabled={procesando===n.id} className="inline-flex items-center gap-1 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] font-bold text-amber-300"><Send size={12}/>Reintentar</button>}</div></div>)}{!notas.length&&<p className="p-8 text-center text-xs text-gray-600">Aún no hay notas registradas.</p>}</div></section>
    </div>
  </div>
}
