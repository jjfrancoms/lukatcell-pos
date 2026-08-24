import { useEffect, useState } from 'react'
import { CalendarCheck2, RefreshCw } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useToast } from '../lib/toast'

interface Preview {
  fecha: string
  total_ventas: number
  cantidad_ventas: number
  efectivo: number
  digital: number
  otros_pagos: number
  total_reembolsos: number
  cajas_abiertas: number
  cajas_cerradas: number
  diferencia_cajas: number
  ordenes_abiertas: number
  stock_critico: number
}
interface Cierre {
  id: string
  fecha: string
  total_ventas: number
  cantidad_ventas: number
  efectivo: number
  digital: number
  otros_pagos: number
  total_reembolsos: number
  diferencia_cajas: number
  cajas_cerradas: number
  ordenes_abiertas: number
  stock_critico: number
  observacion: string | null
  closed_at: string
  cerrador: { nombre: string } | null
}
const soles=(v:number)=>new Intl.NumberFormat('es-PE',{style:'currency',currency:'PEN'}).format(Number(v||0))

export default function CierreDiario(){
  const {showToast}=useToast()
  const hoy=new Date().toISOString().slice(0,10)
  const [fecha,setFecha]=useState(hoy)
  const [preview,setPreview]=useState<Preview|null>(null)
  const [cierres,setCierres]=useState<Cierre[]>([])
  const [observacion,setObservacion]=useState('')
  const [loading,setLoading]=useState(true)
  const [cerrando,setCerrando]=useState(false)

  const cargar=async()=>{
    setLoading(true)
    const [p,c]=await Promise.all([
      supabase.rpc('previsualizar_cierre_diario',{p_fecha:fecha}),
      supabase.from('cierres_diarios').select('id,fecha,total_ventas,cantidad_ventas,efectivo,digital,otros_pagos,total_reembolsos,diferencia_cajas,cajas_cerradas,ordenes_abiertas,stock_critico,observacion,closed_at,cerrador:staff!cierres_diarios_cerrado_por_fkey(nombre)').order('fecha',{ascending:false}).limit(60),
    ])
    if(p.error||c.error) showToast('No se pudo cargar el cierre diario','error')
    setPreview((p.data as Preview|null)||null)
    setCierres((c.data as unknown as Cierre[])||[])
    setLoading(false)
  }
  useEffect(()=>{cargar()},[fecha])

  const cerrar=async()=>{
    if(!preview)return
    if(preview.cajas_abiertas>0){showToast('Cierra todas las cajas antes del cierre diario','error');return}
    if(!window.confirm(`¿Cerrar definitivamente la operación del ${fecha}?`))return
    setCerrando(true)
    const {error}=await supabase.rpc('cerrar_dia',{p_fecha:fecha,p_observacion:observacion.trim()||null})
    setCerrando(false)
    if(error){showToast(error.message,'error');return}
    showToast('Cierre diario registrado','success');setObservacion('');await cargar()
  }

  const yaCerrado=cierres.some(c=>c.fecha===fecha)
  return <div className="p-3 md:p-5 max-w-6xl mx-auto">
    <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-5"><div><div className="flex items-center gap-2"><CalendarCheck2 size={20} className="text-cyan-400"/><h1 className="font-display font-bold text-xl text-white">Cierre diario</h1></div><p className="text-xs text-gray-500 mt-1">Consolida la operación de la sucursal y conserva un snapshot histórico inmutable.</p></div><button onClick={cargar} className="rounded-xl border border-[#30363d] bg-[#161b22] p-2.5 text-gray-400"><RefreshCw size={16}/></button></div>

    <section className="rounded-2xl border border-[#30363d] bg-[#161b22] p-4 mb-4"><div className="flex flex-col sm:flex-row gap-3 sm:items-end justify-between"><div><label className="text-xs text-gray-500">Fecha operativa</label><input type="date" max={hoy} value={fecha} onChange={e=>setFecha(e.target.value)} className="mt-1 block rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2 text-sm text-white"/></div>{yaCerrado&&<span className="rounded-full border border-green-500/20 bg-green-500/10 px-3 py-1.5 text-xs font-bold text-green-300">Día cerrado</span>}</div></section>

    {loading?<div className="p-10 text-center text-sm text-gray-500">Calculando...</div>:preview&&<><div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4"><Metric label="Ventas" value={soles(preview.total_ventas)} sub={`${preview.cantidad_ventas} transacciones`}/><Metric label="Efectivo" value={soles(preview.efectivo)}/><Metric label="Digital" value={soles(preview.digital)}/><Metric label="Otros pagos" value={soles(preview.otros_pagos)}/><Metric label="Reembolsos" value={soles(preview.total_reembolsos)}/><Metric label="Diferencia cajas" value={soles(preview.diferencia_cajas)}/><Metric label="Cajas" value={`${preview.cajas_cerradas} cerradas`} sub={`${preview.cajas_abiertas} abiertas`}/><Metric label="Alertas" value={`${preview.ordenes_abiertas} órdenes`} sub={`${preview.stock_critico} stock crítico`}/></div>
    {!yaCerrado&&<section className="rounded-2xl border border-[#30363d] bg-[#161b22] p-4 mb-5"><label className="text-xs text-gray-500">Observación del cierre</label><textarea value={observacion} onChange={e=>setObservacion(e.target.value)} rows={3} className="mt-1 w-full resize-none rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2 text-sm text-white" placeholder="Incidencias, diferencias o notas de la jefa..."/><div className="flex items-center justify-between gap-3 mt-3"><p className={`text-xs ${preview.cajas_abiertas?'text-red-300':'text-green-300'}`}>{preview.cajas_abiertas?`Hay ${preview.cajas_abiertas} caja(s) abierta(s).`:'Todas las cajas están cerradas.'}</p><button onClick={cerrar} disabled={cerrando||preview.cajas_abiertas>0} className="rounded-xl bg-cyan-500 px-4 py-2.5 text-sm font-bold text-black disabled:opacity-40">{cerrando?'Cerrando...':'Cerrar día'}</button></div></section>}</>}

    <section className="rounded-2xl border border-[#30363d] bg-[#161b22] overflow-hidden"><div className="p-4 border-b border-[#30363d]"><h2 className="text-sm font-bold text-white">Historial de cierres</h2></div><div className="divide-y divide-[#21262d]">{cierres.map(c=><div key={c.id} className="p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-bold text-white">{new Date(`${c.fecha}T12:00:00`).toLocaleDateString('es-PE',{dateStyle:'medium'})}</p><p className="text-[11px] text-gray-500">{c.cerrador?.nombre||'Administración'} · {new Date(c.closed_at).toLocaleString('es-PE')}</p></div><p className="text-base font-bold text-cyan-300">{soles(c.total_ventas)}</p></div><p className="text-[11px] text-gray-500 mt-2">{c.cantidad_ventas} ventas · reembolsos {soles(c.total_reembolsos)} · diferencia cajas {soles(c.diferencia_cajas)} · {c.cajas_cerradas} cajas</p>{c.observacion&&<p className="text-xs text-gray-300 mt-1.5">{c.observacion}</p>}</div>)}{!cierres.length&&<p className="p-8 text-center text-xs text-gray-600">Aún no existen cierres diarios.</p>}</div></section>
  </div>
}

function Metric({label,value,sub}:{label:string;value:string;sub?:string}){return <div className="rounded-2xl border border-[#30363d] bg-[#161b22] p-4"><p className="text-[11px] text-gray-500">{label}</p><p className="text-lg font-bold text-white mt-1">{value}</p>{sub&&<p className="text-[10px] text-gray-600 mt-1">{sub}</p>}</div>}
