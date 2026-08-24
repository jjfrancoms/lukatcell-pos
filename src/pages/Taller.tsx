import { useEffect, useMemo, useState } from 'react'
import { Wrench, PackagePlus, Camera, Clock3, ShieldCheck, Printer, RefreshCw } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import ReciboOrden from '../components/ReciboOrden'
import type { OrdenServicio } from '../types'

type OrdenTecnica = OrdenServicio & {
  tecnico_id: string | null
  equipo_serial: string | null
  equipo_imei: string | null
  mano_obra: number
  fecha_prometida: string | null
  garantia_dias: number
  garantia_hasta: string | null
  updated_at: string
}
type Tecnico = { id: string; nombre: string }
type Variant = { id: string; color: string | null; product: { nombre: string } | null }
type Repuesto = { id: string; variant_id: string; cantidad: number; precio_unitario: number; costo_unitario: number; variant: { color: string | null; product: { nombre: string } | null } | null }
type Hist = { id: string; tipo: string; descripcion: string | null; estado_anterior: string | null; estado_nuevo: string | null; created_at: string; actor: { nombre: string } | null }
type Foto = { id: string; tipo: string; storage_path: string; descripcion: string | null; created_at: string; signedUrl?: string }

const ESTADOS = ['recibido','diagnosticado','en_reparacion','listo','entregado','cancelado'] as const

export default function Taller() {
  const { staff, isAdmin } = useAuth()
  const { showToast } = useToast()
  const [ordenes, setOrdenes] = useState<OrdenTecnica[]>([])
  const [tecnicos, setTecnicos] = useState<Tecnico[]>([])
  const [variants, setVariants] = useState<Variant[]>([])
  const [selected, setSelected] = useState<OrdenTecnica | null>(null)
  const [repuestos, setRepuestos] = useState<Repuesto[]>([])
  const [historial, setHistorial] = useState<Hist[]>([])
  const [fotos, setFotos] = useState<Foto[]>([])
  const [loading, setLoading] = useState(true)
  const [imprimir, setImprimir] = useState<OrdenTecnica | null>(null)

  const load = async () => {
    setLoading(true)
    const [o, t, v] = await Promise.all([
      supabase.from('ordenes_servicio').select('*').order('numero', { ascending: false }),
      supabase.from('staff').select('id,nombre').eq('activo', true).eq('puesto', 'tecnico').order('nombre'),
      supabase.from('product_variants').select('id,color,product:products(nombre)').limit(500),
    ])
    if (o.error || t.error || v.error) showToast('No se pudo cargar Taller', 'error')
    setOrdenes((o.data as OrdenTecnica[]) || [])
    setTecnicos((t.data as Tecnico[]) || [])
    setVariants((v.data as unknown as Variant[]) || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const abrir = async (o: OrdenTecnica) => {
    setSelected(o)
    const [r,h,f] = await Promise.all([
      supabase.from('orden_servicio_repuestos').select('id,variant_id,cantidad,precio_unitario,costo_unitario,variant:product_variants(color,product:products(nombre))').eq('orden_id', o.id).order('created_at'),
      supabase.from('orden_servicio_historial').select('id,tipo,descripcion,estado_anterior,estado_nuevo,created_at,actor:staff(nombre)').eq('orden_id', o.id).order('created_at', { ascending: false }),
      supabase.from('orden_servicio_fotos').select('id,tipo,storage_path,descripcion,created_at').eq('orden_id', o.id).order('created_at', { ascending: false }),
    ])
    setRepuestos((r.data as unknown as Repuesto[]) || [])
    setHistorial((h.data as unknown as Hist[]) || [])
    const photoRows = (f.data as Foto[]) || []
    const signed = await Promise.all(photoRows.map(async p => {
      const { data } = await supabase.storage.from('ordenes-servicio').createSignedUrl(p.storage_path, 3600)
      return { ...p, signedUrl: data?.signedUrl }
    }))
    setFotos(signed)
  }

  const refrescarSeleccion = async () => {
    if (!selected) return
    const { data } = await supabase.from('ordenes_servicio').select('*').eq('id', selected.id).single()
    if (data) {
      const next = data as OrdenTecnica
      setSelected(next)
      setOrdenes(xs => xs.map(x => x.id === next.id ? next : x))
      await abrir(next)
    }
  }

  const puedeAsignar = isAdmin || ['jefa','encargado'].includes(staff?.puesto || '')
  const abiertas = useMemo(() => ordenes.filter(o => !['entregado','cancelado'].includes(o.estado)), [ordenes])

  return <div className="p-3 md:p-5 max-w-7xl mx-auto">
    <div className="flex items-center justify-between gap-3 mb-5">
      <div><div className="flex gap-2 items-center"><Wrench className="text-cyan-400" size={20}/><h1 className="text-xl font-bold text-white">Taller</h1></div><p className="text-xs text-gray-500 mt-1">Diagnóstico, técnico, repuestos, SLA, garantía y evidencias.</p></div>
      <button onClick={load} className="rounded-xl border border-[#30363d] px-3 py-2 text-sm text-gray-300 inline-flex gap-2 items-center"><RefreshCw size={14}/>Actualizar</button>
    </div>
    <div className="grid lg:grid-cols-[320px_1fr] gap-4">
      <div className="rounded-2xl border border-[#30363d] bg-[#161b22] overflow-hidden h-fit">
        {loading ? <div className="p-8 text-sm text-gray-500 text-center">Cargando...</div> : <div className="divide-y divide-[#21262d]">{abiertas.map(o => {
          const overdue = o.fecha_prometida && new Date(o.fecha_prometida).getTime() < Date.now() && !['listo','entregado','cancelado'].includes(o.estado)
          return <button key={o.id} onClick={() => abrir(o)} className={`w-full text-left p-3 hover:bg-[#1c2128] ${selected?.id === o.id ? 'bg-cyan-500/10' : ''}`}>
            <div className="flex justify-between gap-2"><p className="text-sm font-semibold text-white">#{o.numero} · {o.cliente_nombre}</p><span className={`text-[10px] uppercase ${overdue ? 'text-red-400' : 'text-cyan-400'}`}>{overdue ? 'SLA vencido' : o.estado}</span></div>
            <p className="text-xs text-gray-500 mt-1">{[o.equipo_marca,o.equipo_modelo].filter(Boolean).join(' ') || 'Equipo'}{o.equipo_imei ? ` · ${o.equipo_imei}` : ''}</p>
          </button>
        })}{abiertas.length === 0 && <div className="p-8 text-center text-sm text-gray-600">Sin órdenes abiertas.</div>}</div>}
      </div>
      {selected ? <Detalle orden={selected} tecnicos={tecnicos} variants={variants} repuestos={repuestos} historial={historial} fotos={fotos} puedeAsignar={puedeAsignar} locationId={staff?.location_id || ''} onSaved={refrescarSeleccion} onPrint={() => setImprimir(selected)} /> : <div className="rounded-2xl border border-[#30363d] bg-[#161b22] p-10 text-center text-gray-600 text-sm">Selecciona una orden.</div>}
    </div>
    {imprimir && <ReciboOrden orden={imprimir} onClose={() => setImprimir(null)} />}
  </div>
}

function Detalle({orden,tecnicos,variants,repuestos,historial,fotos,puedeAsignar,locationId,onSaved,onPrint}:{orden:OrdenTecnica;tecnicos:Tecnico[];variants:Variant[];repuestos:Repuesto[];historial:Hist[];fotos:Foto[];puedeAsignar:boolean;locationId:string;onSaved:()=>void;onPrint:()=>void}) {
  const { showToast } = useToast()
  const [f,setF] = useState({tecnico_id:orden.tecnico_id||'',diagnostico:orden.diagnostico||'',estado:orden.estado,mano_obra:String(orden.mano_obra||0),fecha_prometida:orden.fecha_prometida?orden.fecha_prometida.slice(0,16):'',garantia_dias:String(orden.garantia_dias||0),equipo_serial:orden.equipo_serial||'',equipo_imei:orden.equipo_imei||'',notas:orden.notas||''})
  const [variantId,setVariantId] = useState('')
  const [qty,setQty] = useState(1)
  const [photoType,setPhotoType] = useState<'antes'|'despues'|'diagnostico'|'otro'>('antes')
  useEffect(()=>setF({tecnico_id:orden.tecnico_id||'',diagnostico:orden.diagnostico||'',estado:orden.estado,mano_obra:String(orden.mano_obra||0),fecha_prometida:orden.fecha_prometida?orden.fecha_prometida.slice(0,16):'',garantia_dias:String(orden.garantia_dias||0),equipo_serial:orden.equipo_serial||'',equipo_imei:orden.equipo_imei||'',notas:orden.notas||''}),[orden.id,orden.updated_at])
  const save = async () => {
    const patch:any={diagnostico:f.diagnostico||null,estado:f.estado,mano_obra:Number(f.mano_obra)||0,fecha_prometida:f.fecha_prometida?new Date(f.fecha_prometida).toISOString():null,garantia_dias:Number(f.garantia_dias)||0,equipo_serial:f.equipo_serial||null,equipo_imei:f.equipo_imei||null,notas:f.notas||null}
    if(puedeAsignar) patch.tecnico_id=f.tecnico_id||null
    const {error}=await supabase.rpc('actualizar_orden_servicio_tecnica',{p_orden_id:orden.id,p_patch:patch})
    if(error){showToast(error.message,'error');return} showToast('Orden técnica actualizada','success'); await onSaved()
  }
  const addPart = async()=>{if(!variantId||qty<=0)return;const {error}=await supabase.rpc('agregar_repuesto_orden',{p_orden_id:orden.id,p_variant_id:variantId,p_cantidad:qty});if(error){showToast(error.message,'error');return}showToast('Repuesto agregado','success');setVariantId('');setQty(1);await onSaved()}
  const removePart = async(r:Repuesto)=>{const {error}=await supabase.rpc('retirar_repuesto_orden',{p_repuesto_id:r.id,p_cantidad:1});if(error){showToast(error.message,'error');return}showToast('Unidad devuelta a inventario','success');await onSaved()}
  const upload = async(file:File)=>{const ext=(file.name.split('.').pop()||'jpg').toLowerCase();const path=`${locationId}/${orden.id}/${photoType}/${crypto.randomUUID()}.${ext}`;const {error}=await supabase.storage.from('ordenes-servicio').upload(path,file,{upsert:false});if(error){showToast(error.message,'error');return}const {error:e2}=await supabase.rpc('registrar_foto_orden',{p_orden_id:orden.id,p_tipo:photoType,p_storage_path:path,p_descripcion:null});if(e2){showToast(e2.message,'error');return}showToast('Foto agregada','success');await onSaved()}
  const totalParts = repuestos.reduce((a,r)=>a+Number(r.precio_unitario)*r.cantidad,0)
  return <div className="space-y-4">
    <div className="rounded-2xl border border-[#30363d] bg-[#161b22] p-4">
      <div className="flex flex-wrap justify-between gap-3 mb-4"><div><h2 className="text-lg font-bold text-white">Orden #{orden.numero}</h2><p className="text-xs text-gray-500">{orden.cliente_nombre} · {orden.cliente_telefono||'sin teléfono'}</p></div><button onClick={onPrint} className="rounded-lg border border-[#30363d] px-3 py-2 text-xs text-gray-300 inline-flex gap-2 items-center"><Printer size={14}/>Ticket</button></div>
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
        {puedeAsignar && <Field label="Técnico"><select value={f.tecnico_id} onChange={e=>setF({...f,tecnico_id:e.target.value})} className="input-personal w-full"><option value="">Sin asignar</option>{tecnicos.map(t=><option key={t.id} value={t.id}>{t.nombre}</option>)}</select></Field>}
        <Field label="Estado"><select value={f.estado} onChange={e=>setF({...f,estado:e.target.value})} className="input-personal w-full">{ESTADOS.map(x=><option key={x} value={x}>{x}</option>)}</select></Field>
        <Field label="Mano de obra"><input type="number" min={0} step="0.01" value={f.mano_obra} onChange={e=>setF({...f,mano_obra:e.target.value})} className="input-personal w-full"/></Field>
        <Field label="Fecha prometida"><input type="datetime-local" value={f.fecha_prometida} onChange={e=>setF({...f,fecha_prometida:e.target.value})} className="input-personal w-full"/></Field>
        <Field label="Garantía (días)"><input type="number" min={0} value={f.garantia_dias} onChange={e=>setF({...f,garantia_dias:e.target.value})} className="input-personal w-full"/></Field>
        <Field label="Garantía hasta"><div className="input-personal text-gray-400">{orden.garantia_hasta||'Se calcula al entregar'}</div></Field>
        <Field label="IMEI"><input value={f.equipo_imei} onChange={e=>setF({...f,equipo_imei:e.target.value})} className="input-personal w-full"/></Field>
        <Field label="Serie"><input value={f.equipo_serial} onChange={e=>setF({...f,equipo_serial:e.target.value})} className="input-personal w-full"/></Field>
      </div>
      <Field label="Diagnóstico"><textarea rows={4} value={f.diagnostico} onChange={e=>setF({...f,diagnostico:e.target.value})} className="input-personal w-full"/></Field>
      <Field label="Notas"><textarea rows={2} value={f.notas} onChange={e=>setF({...f,notas:e.target.value})} className="input-personal w-full"/></Field>
      <button onClick={save} className="mt-3 w-full rounded-xl bg-cyan-500 py-2.5 text-sm font-bold text-black">Guardar cambios técnicos</button>
    </div>

    <div className="grid xl:grid-cols-2 gap-4">
      <div className="rounded-2xl border border-[#30363d] bg-[#161b22] p-4">
        <div className="flex items-center gap-2 mb-3"><PackagePlus size={16} className="text-cyan-400"/><h3 className="text-sm font-bold text-white">Repuestos</h3></div>
        <div className="flex gap-2"><select value={variantId} onChange={e=>setVariantId(e.target.value)} className="input-personal flex-1"><option value="">Producto...</option>{variants.map(v=><option key={v.id} value={v.id}>{v.product?.nombre||'Producto'}{v.color?` · ${v.color}`:''}</option>)}</select><input type="number" min={1} value={qty} onChange={e=>setQty(Math.max(1,Number(e.target.value)))} className="input-personal w-20"/><button onClick={addPart} className="rounded-lg bg-cyan-500 px-3 text-xs font-bold text-black">Agregar</button></div>
        <div className="mt-3 divide-y divide-[#21262d]">{repuestos.map(r=><div key={r.id} className="py-2 flex justify-between gap-3"><div><p className="text-xs text-white">{r.variant?.product?.nombre||'Producto'}{r.variant?.color?` · ${r.variant.color}`:''}</p><p className="text-[10px] text-gray-500">{r.cantidad} × S/ {Number(r.precio_unitario).toFixed(2)}</p></div><button onClick={()=>removePart(r)} className="text-[10px] text-red-400">Retirar 1</button></div>)}</div>
        <div className="mt-3 border-t border-[#30363d] pt-3 text-xs text-gray-400">Repuestos: <b className="text-white">S/ {totalParts.toFixed(2)}</b> · Mano de obra: <b className="text-white">S/ {Number(orden.mano_obra||0).toFixed(2)}</b> · Total: <b className="text-cyan-400">S/ {Number(orden.costo_final||0).toFixed(2)}</b></div>
      </div>
      <div className="rounded-2xl border border-[#30363d] bg-[#161b22] p-4">
        <div className="flex items-center gap-2 mb-3"><Camera size={16} className="text-cyan-400"/><h3 className="text-sm font-bold text-white">Fotos</h3></div>
        <div className="flex gap-2 mb-3"><select value={photoType} onChange={e=>setPhotoType(e.target.value as any)} className="input-personal"><option value="antes">Antes</option><option value="diagnostico">Diagnóstico</option><option value="despues">Después</option><option value="otro">Otro</option></select><label className="rounded-lg bg-[#21262d] border border-[#30363d] px-3 py-2 text-xs text-gray-300 cursor-pointer">Subir foto<input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={e=>e.target.files?.[0]&&upload(e.target.files[0])}/></label></div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">{fotos.map(p=><a key={p.id} href={p.signedUrl} target="_blank" rel="noreferrer" className="rounded-xl border border-[#30363d] overflow-hidden bg-[#0d1117]"><div className="aspect-square bg-[#0d1117]">{p.signedUrl&&<img src={p.signedUrl} className="w-full h-full object-cover"/>}</div><p className="p-2 text-[10px] uppercase text-gray-500">{p.tipo}</p></a>)}</div>
      </div>
    </div>

    <div className="rounded-2xl border border-[#30363d] bg-[#161b22] p-4">
      <div className="flex items-center gap-2 mb-3"><Clock3 size={16} className="text-cyan-400"/><h3 className="text-sm font-bold text-white">Historial</h3>{orden.garantia_hasta&&<span className="ml-auto inline-flex items-center gap-1 text-[10px] text-green-400"><ShieldCheck size={12}/>Garantía hasta {orden.garantia_hasta}</span>}</div>
      <div className="space-y-2">{historial.map(h=><div key={h.id} className="rounded-lg bg-[#0d1117] border border-[#21262d] px-3 py-2"><div className="flex justify-between gap-2"><span className="text-[10px] uppercase text-cyan-400">{h.tipo}</span><span className="text-[10px] text-gray-600">{new Date(h.created_at).toLocaleString('es-PE')}</span></div><p className="text-xs text-gray-300 mt-1">{h.descripcion||`${h.estado_anterior||''} → ${h.estado_nuevo||''}`}</p>{h.actor?.nombre&&<p className="text-[10px] text-gray-600">{h.actor.nombre}</p>}</div>)}</div>
    </div>
  </div>
}

function Field({label,children}:{label:string;children:React.ReactNode}){return <label className="block mt-3"><span className="text-xs text-gray-500">{label}</span><div className="mt-1">{children}</div></label>}
