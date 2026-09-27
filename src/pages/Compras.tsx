import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { History, PackagePlus, Plus, RefreshCw, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'

type Prov={id:string;nombre:string}
type Variant={id:string;product:{nombre:string;control_serial?:boolean}|null;color:string|null}
type Orden={id:string;numero:number;estado:string;total:number;fecha_orden:string;fecha_esperada:string|null;proveedor:{nombre:string}|null;location_id:string}
type Item={id:string;variant_id:string;cantidad_pedida:number;cantidad_recibida:number;costo_unitario:number;variant:{product:{nombre:string;control_serial?:boolean}|null;color:string|null}|null}
type LineaNueva={variant_id:string;cantidad:number;costo_unitario:number}

// Filas del historial. Se leen con select('*') para tolerar el esquema antes y
// después de _p1_b: las columnas de incidencia y de idempotencia son opcionales.
type Recepcion={id:string;orden_id:string;recibido_por:string|null;fecha:string|null;created_at:string;observacion:string|null;client_transaction_id?:string|null;payload_hash?:string|null;corrige_recepcion_id?:string|null}
type RecItem={id:string;recepcion_id:string;orden_item_id:string;cantidad:number;cantidad_danada?:number;cantidad_faltante?:number;cantidad_sobrante?:number;cantidad_producto_equivocado?:number;variant_id_recibido?:string|null;observacion?:string|null}
type SerialRec={id:string;serial_number:string;imei2:string|null;estado:string;recepcion_item_id:string|null}
type Resultado={recepcion_id:string;corrige_recepcion_id:string|null;reintento?:boolean}

type Captura={buenas:string;danadas:string;faltante:string;equivocado:string;variantEq:string;aceptaSobrante:boolean;observacion:string;imeiBuenos:string;imeiDanados:string;revertir:string}
const CAPTURA_VACIA:Captura={buenas:'',danadas:'',faltante:'',equivocado:'',variantEq:'',aceptaSobrante:false,observacion:'',imeiBuenos:'',imeiDanados:'',revertir:''}

// Un envío que no responde en este plazo se aborta; el reintento reutiliza la MISMA clave.
const TIMEOUT_MS=30000
// Espejo exacto de la guarda del servidor: sólo 'recibida' y 'cancelada' rechazan.
const ESTADOS_CERRADOS=['recibida','cancelada']
const ESTADO_SERIAL:Record<string,string>={disponible:'text-green-400',cuarentena:'text-amber-300',vendido:'text-gray-400'}

const entero=(s:string)=>{const n=Number(s);return s.trim()===''||!Number.isFinite(n)?0:Math.trunc(n)}
const nombreVariante=(v:{product:{nombre:string}|null;color:string|null}|null|undefined)=>`${v?.product?.nombre||'Producto'}${v?.color?` · ${v.color}`:''}`
const fechaHora=(s:string|null|undefined)=>s?new Date(s).toLocaleString('es-PE'):'—'
// Una unidad por línea (o separadas por coma). IMEI2 opcional: IMEI1|IMEI2.
const parseSeriales=(text:string,danado:boolean)=>text.split(/\n|,/).map(x=>x.trim()).filter(Boolean).map(x=>{const [serial_number,imei2]=x.split('|').map(v=>v.trim());return danado?{serial_number,imei2:imei2||null,danado:true}:{serial_number,imei2:imei2||null}})

export default function Compras(){
 const {isAdmin,puede}=useAuth(); const puedeRecibir=puede('operar_inventario'); const {showToast}=useToast(); const [ordenes,setOrdenes]=useState<Orden[]>([]); const [proveedores,setProveedores]=useState<Prov[]>([]); const [variants,setVariants]=useState<Variant[]>([]); const [openNew,setOpenNew]=useState(false); const [detalle,setDetalle]=useState<Orden|null>(null); const [loading,setLoading]=useState(true)
 // El selector de variantes usa products!inner + is_test=false: sin !inner PostgREST anula el embed pero conserva la variante, y el catálogo QA seguiría apareciendo como "Producto" sin nombre.
 const load=useCallback(async()=>{setLoading(true);const [o,p,v]=await Promise.all([supabase.from('ordenes_compra').select('id,numero,estado,total,fecha_orden,fecha_esperada,location_id,proveedor:proveedores(nombre)').order('fecha_orden',{ascending:false}),isAdmin?supabase.from('proveedores').select('id,nombre').eq('activo',true).order('nombre'):Promise.resolve({data:[] as Prov[],error:null}),supabase.from('product_variants').select('id,color,product:products!inner(nombre,control_serial)').eq('product.is_test',false).order('created_at',{ascending:false}).limit(500)]); if(o.error||v.error)showToast('No se pudieron cargar compras','error');setOrdenes((o.data as unknown as Orden[])||[]);setProveedores((p.data as Prov[])||[]);setVariants((v.data as unknown as Variant[])||[]);setLoading(false)},[isAdmin,showToast])
 useEffect(()=>{load()},[load])
 return <div className="p-3 md:p-5 max-w-7xl mx-auto"><div className="flex flex-wrap items-center justify-between gap-3 mb-5"><div><div className="flex items-center gap-2"><PackagePlus size={20} className="text-cyan-400"/><h1 className="font-display font-bold text-xl text-white">Compras</h1></div><p className="text-xs text-gray-500 mt-1">Órdenes de compra y recepción de mercadería.</p></div><div className="flex gap-2"><button onClick={load} className="rounded-xl border border-[#30363d] px-3 py-2 text-sm text-gray-300 inline-flex gap-2 items-center"><RefreshCw size={14}/>Actualizar</button>{isAdmin&&<button onClick={()=>setOpenNew(true)} className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-bold text-black inline-flex gap-2 items-center"><Plus size={14}/>Nueva orden</button>}</div></div><div className="rounded-2xl border border-[#30363d] bg-[#161b22] overflow-hidden">{loading?<div className="p-10 text-center text-sm text-gray-500">Cargando...</div>:<div className="divide-y divide-[#21262d]">{ordenes.map(o=><button key={o.id} onClick={()=>setDetalle(o)} className="w-full text-left p-4 hover:bg-[#1c2128] flex items-center justify-between gap-3"><div><p className="text-sm font-semibold text-white">OC #{o.numero} · {o.proveedor?.nombre||'Proveedor'}</p><p className="text-xs text-gray-500">{new Date(o.fecha_orden).toLocaleString('es-PE')}{o.fecha_esperada?` · esperada ${o.fecha_esperada}`:''}</p></div><div className="text-right"><p className="text-sm font-bold text-cyan-400">S/ {Number(o.total).toFixed(2)}</p><span className="text-[10px] uppercase text-gray-500">{o.estado}</span></div></button>)}{ordenes.length===0&&<div className="p-10 text-center text-sm text-gray-600">No hay órdenes de compra.</div>}</div>}</div>{openNew&&<NuevaOrden proveedores={proveedores} variants={variants} onClose={()=>setOpenNew(false)} onSaved={async()=>{setOpenNew(false);await load()}}/>}{detalle&&<Detalle orden={detalle} variants={variants} puedeRecibir={puedeRecibir} onClose={()=>setDetalle(null)} onChanged={load}/>}</div>
}

function NuevaOrden({proveedores,variants,onClose,onSaved}:{proveedores:Prov[];variants:Variant[];onClose:()=>void;onSaved:()=>void}){const {showToast}=useToast();const [proveedorId,setProveedorId]=useState(proveedores[0]?.id||'');const [fechaEsperada,setFechaEsperada]=useState('');const [obs,setObs]=useState('');const [lineas,setLineas]=useState<LineaNueva[]>([{variant_id:variants[0]?.id||'',cantidad:1,costo_unitario:0}]);const [saving,setSaving]=useState(false);const total=useMemo(()=>lineas.reduce((a,l)=>a+l.cantidad*l.costo_unitario,0),[lineas]);const save=async()=>{if(!proveedorId||lineas.some(l=>!l.variant_id||l.cantidad<=0||l.costo_unitario<0))return;setSaving(true);const {error}=await supabase.rpc('crear_orden_compra',{p_proveedor_id:proveedorId,p_items:lineas,p_fecha_esperada:fechaEsperada||null,p_observacion:obs||null});setSaving(false);if(error){showToast(error.message,'error');return}showToast('Orden creada','success');onSaved()};return <Modal title="Nueva orden de compra" onClose={onClose}><label className="text-xs text-gray-500">Proveedor</label><select value={proveedorId} onChange={e=>setProveedorId(e.target.value)} className="input-personal mt-1 w-full">{proveedores.map(p=><option key={p.id} value={p.id}>{p.nombre}</option>)}</select><label className="block text-xs text-gray-500 mt-3">Fecha esperada</label><input type="date" value={fechaEsperada} onChange={e=>setFechaEsperada(e.target.value)} className="input-personal mt-1 w-full"/><div className="mt-4 space-y-2">{lineas.map((l,i)=><div key={i} className="grid grid-cols-[1fr_80px_100px_32px] gap-2"><select value={l.variant_id} onChange={e=>setLineas(x=>x.map((q,j)=>j===i?{...q,variant_id:e.target.value}:q))} className="input-personal"><option value="">Producto...</option>{variants.map(v=><option key={v.id} value={v.id}>{v.product?.nombre||'Producto'}{v.color?` · ${v.color}`:''}{v.product?.control_serial?' · IMEI':''}</option>)}</select><input type="number" min={1} value={l.cantidad} onChange={e=>setLineas(x=>x.map((q,j)=>j===i?{...q,cantidad:Number(e.target.value)}:q))} className="input-personal"/><input type="number" min={0} step="0.01" value={l.costo_unitario} onChange={e=>setLineas(x=>x.map((q,j)=>j===i?{...q,costo_unitario:Number(e.target.value)}:q))} className="input-personal"/><button onClick={()=>setLineas(x=>x.filter((_,j)=>j!==i))} className="text-red-400">×</button></div>)}</div><button onClick={()=>setLineas(x=>[...x,{variant_id:'',cantidad:1,costo_unitario:0}])} className="mt-2 text-xs text-cyan-400">+ Agregar línea</button><textarea value={obs} onChange={e=>setObs(e.target.value)} placeholder="Observación" className="input-personal mt-3 w-full"/><div className="flex justify-between mt-4"><span className="text-sm text-gray-400">Total: <b className="text-white">S/ {total.toFixed(2)}</b></span><button onClick={save} disabled={saving} className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-bold text-black disabled:opacity-40">{saving?'Guardando...':'Crear orden'}</button></div></Modal>}

// ---------------------------------------------------------------------------
// RECEPCIÓN — public.recibir_orden_compra de 5 argumentos (P1.B).
//
// IDEMPOTENCIA. La clave pertenece a una INTENCIÓN, no a un intento:
//   · se genera una vez al abrir la orden;
//   · se liga a la huella del contenido en el primer envío;
//   · un reintento con el mismo contenido (tras error o timeout) reutiliza la clave;
//   · si cambia cualquier cantidad, incidencia, serial, observación o la recepción
//     corregida, la huella difiere y se genera otra antes de enviar;
//   · tras un éxito confirmado (nuevo o reintento reconocido) se genera una nueva.
// El servidor rechaza la misma clave con otro contenido ("contenido distinto"), pero
// su hash NO cubre observaciones, IMEI2, acepta_sobrante ni p_corrige_recepcion_id:
// con esos cambios y la clave vieja devolvería la recepción anterior como reintento.
// Por eso la huella local incluye TODO lo que se envía.
//
// Las reglas de negocio (sobrante, faltante, dañado, producto equivocado, IMEI
// exactos, estado de la orden, permisos, sucursal) las decide el servidor; aquí
// sólo se orienta y se muestra su mensaje tal cual.
// ---------------------------------------------------------------------------

function Detalle({orden,variants,puedeRecibir,onClose,onChanged}:{orden:Orden;variants:Variant[];puedeRecibir:boolean;onClose:()=>void;onChanged:()=>Promise<void>}){
  const {showToast}=useToast()
  const {isAdmin}=useAuth()
  const [ordenActual,setOrdenActual]=useState<Orden>(orden)
  const [items,setItems]=useState<Item[]>([])
  const [recepciones,setRecepciones]=useState<Recepcion[]>([])
  const [recItems,setRecItems]=useState<RecItem[]>([])
  const [seriales,setSeriales]=useState<SerialRec[]>([])
  const [variantesRecibidas,setVariantesRecibidas]=useState<Record<string,Variant>>({})
  const [nombresStaff,setNombresStaff]=useState<Record<string,string>>({})
  const [cargando,setCargando]=useState(true)
  const [errorCarga,setErrorCarga]=useState<string|null>(null)
  const [captura,setCaptura]=useState<Record<string,Captura>>({})
  const [observacion,setObservacion]=useState('')
  const [corrige,setCorrige]=useState<string|null>(null)
  const [enviando,setEnviando]=useState(false)
  const [ultimoError,setUltimoError]=useState<string|null>(null)
  const [aviso,setAviso]=useState<{tipo:'nueva'|'reintento';texto:string}|null>(null)
  const enCurso=useRef(false)
  const clave=useRef<string>(crypto.randomUUID())
  const huellaLigada=useRef<string|null>(null)
  const formRef=useRef<HTMLDivElement>(null)

  const cargar=useCallback(async()=>{
    setCargando(true)
    const [o,it,rc]=await Promise.all([
      supabase.from('ordenes_compra').select('id,numero,estado,total,fecha_orden,fecha_esperada,location_id,proveedor:proveedores(nombre)').eq('id',orden.id).maybeSingle(),
      supabase.from('orden_compra_items').select('id,variant_id,cantidad_pedida,cantidad_recibida,costo_unitario,variant:product_variants(color,product:products(nombre,control_serial))').eq('orden_id',orden.id),
      supabase.from('recepciones_compra').select('*').eq('orden_id',orden.id).order('created_at',{ascending:true}),
    ])
    const err=o.error||it.error||rc.error
    if(err){setErrorCarga(err.message);setCargando(false);return}
    if(o.data)setOrdenActual(o.data as unknown as Orden)
    setItems((it.data as unknown as Item[])||[])
    const recs=(rc.data as Recepcion[])||[]
    setRecepciones(recs)
    let ris:RecItem[]=[]
    if(recs.length){
      const r=await supabase.from('recepcion_compra_items').select('*').in('recepcion_id',recs.map(x=>x.id))
      if(r.error){setErrorCarga(r.error.message);setCargando(false);return}
      ris=(r.data as RecItem[])||[]
    }
    setRecItems(ris)
    const extras:Promise<void>[]=[]
    if(ris.length)extras.push((async()=>{const s=await supabase.from('product_serials').select('id,serial_number,imei2,estado,recepcion_item_id').in('recepcion_item_id',ris.map(x=>x.id));setSeriales(s.error?[]:(s.data as SerialRec[])||[])})())
    else setSeriales([])
    const eqIds=[...new Set(ris.map(x=>x.variant_id_recibido).filter((x):x is string=>!!x))]
    if(eqIds.length)extras.push((async()=>{const v=await supabase.from('product_variants').select('id,color,product:products(nombre,control_serial)').in('id',eqIds);setVariantesRecibidas(Object.fromEntries(((v.data as unknown as Variant[])||[]).map(x=>[x.id,x])))})())
    // staff sólo es legible para administradores (RLS staff_propio); el resto ve "Personal".
    const staffIds=[...new Set(recs.map(x=>x.recibido_por).filter((x):x is string=>!!x))]
    if(isAdmin&&staffIds.length)extras.push((async()=>{const s=await supabase.from('staff').select('id,nombre').in('id',staffIds);setNombresStaff(Object.fromEntries(((s.data as {id:string;nombre:string}[])||[]).map(x=>[x.id,x.nombre])))})())
    await Promise.all(extras)
    setErrorCarga(null)
    setCargando(false)
  },[orden.id,isAdmin])

  useEffect(()=>{cargar()},[cargar])

  const abierta=!ESTADOS_CERRADOS.includes(ordenActual.estado)
  const editable=puedeRecibir&&abierta
  const itemPorId=useMemo(()=>Object.fromEntries(items.map(i=>[i.id,i])),[items])
  const numeroRecepcion=useMemo(()=>Object.fromEntries(recepciones.map((r,i)=>[r.id,i+1])),[recepciones])

  const cap=(id:string):Captura=>captura[id]||CAPTURA_VACIA
  const setCap=(id:string,cambio:Partial<Captura>)=>setCaptura(c=>({...c,[id]:{...(c[id]||CAPTURA_VACIA),...cambio}}))
  const pendiente=(i:Item)=>Math.max(i.cantidad_pedida-i.cantidad_recibida,0)
  const sobranteEstimado=(i:Item,c:Captura)=>Math.max(entero(c.buenas)+entero(c.danadas)-pendiente(i),0)

  // Payload con la forma exacta del contrato. Una línea entra si el operador tocó
  // cualquier campo; si no declara ninguna cantidad, el servidor lo rechaza y se
  // muestra su mensaje.
  const construirItems=()=>{
    const out:Record<string,unknown>[]=[]
    for(const i of items){
      const c=captura[i.id]
      if(!c)continue
      const tocada=c.buenas!==''||c.danadas!==''||c.faltante!==''||c.equivocado!==''||c.variantEq!==''||c.observacion.trim()!==''||c.imeiBuenos.trim()!==''||c.imeiDanados.trim()!==''||c.revertir!==''
      if(!tocada)continue
      const linea:Record<string,unknown>={
        orden_item_id:i.id,
        cantidad:entero(c.buenas),
        cantidad_danada:entero(c.danadas),
        cantidad_faltante:entero(c.faltante),
        cantidad_producto_equivocado:entero(c.equivocado),
        variant_id_recibido:c.variantEq||null,
        // Una casilla marcada y luego olvidada no puede aceptar un dedazo posterior:
        // sólo viaja en true si, con lo capturado ahora, hay exceso sobre lo pendiente.
        acepta_sobrante:c.aceptaSobrante&&sobranteEstimado(i,c)>0,
        observacion:c.observacion.trim()||null,
      }
      if(i.variant?.product?.control_serial)linea.seriales=[...parseSeriales(c.imeiBuenos,false),...parseSeriales(c.imeiDanados,true)]
      // _p3_c: una corrección ya puede RESTAR lo que se registró de más. Sólo viaja si se declara,
      // y el servidor la rechaza salvo que el envío vaya enlazado a la recepción que corrige.
      if(entero(c.revertir)>0)linea.cantidad_revertida=entero(c.revertir)
      out.push(linea)
    }
    return out
  }

  const enviar=async()=>{
    if(enCurso.current)return
    const payload=construirItems()
    if(payload.length===0){showToast('No hay ninguna línea con datos para registrar','info');return}
    const obs=observacion.trim()||null
    const huella=JSON.stringify({orden:orden.id,payload,obs,corrige})
    if(huellaLigada.current!==null&&huellaLigada.current!==huella)clave.current=crypto.randomUUID()
    huellaLigada.current=huella
    enCurso.current=true
    setEnviando(true)
    setUltimoError(null)
    setAviso(null)
    try{
      let data:unknown=null
      let mensajeError:string|null=null
      try{
        const res=await supabase.rpc('recibir_orden_compra',{p_orden_id:orden.id,p_client_transaction_id:clave.current,p_items:payload,p_observacion:obs,p_corrige_recepcion_id:corrige}).abortSignal(AbortSignal.timeout(TIMEOUT_MS))
        if(res.error)mensajeError=res.error.message
        else data=res.data
      }catch(e){mensajeError=e instanceof Error?e.message:String(e)}

      if(mensajeError!==null){
        // Se conserva la clave y su huella: reintentar lo mismo no puede duplicar.
        setUltimoError(mensajeError)
        showToast(mensajeError,'error')
        // Si fue un timeout que sí llegó a aplicarse, el historial y el estado lo muestran.
        await Promise.all([cargar(),onChanged()])
        return
      }

      const r=data as Resultado|null
      clave.current=crypto.randomUUID()
      huellaLigada.current=null
      setCaptura({})
      setObservacion('')
      setCorrige(null)
      if(r?.reintento){
        const texto='Esta recepción ya estaba registrada: el servidor reconoció el reenvío y no aplicó nada nuevo.'
        setAviso({tipo:'reintento',texto})
        showToast(texto,'info')
      }else{
        const texto=r?.corrige_recepcion_id?'Corrección registrada como recepción nueva enlazada.':'Recepción registrada.'
        setAviso({tipo:'nueva',texto})
        showToast(texto,'success')
      }
      await Promise.all([cargar(),onChanged()])
    }finally{
      enCurso.current=false
      setEnviando(false)
    }
  }

  // _p3_c · B4: lo que el proveedor no va a mandar se cierra con motivo, en vez de dejar la orden
  // en 'parcial' para siempre. Clave propia: reintentar tras un error de red no cierra dos veces.
  const claveCierre=useRef(crypto.randomUUID())
  const [cerrando,setCerrando]=useState(false)
  const cerrarConFaltantes=async()=>{
    const motivo=window.prompt('Cerrar la orden con faltantes. Explica por qué lo que falta ya no va a llegar (queda registrado con tu nombre):')
    if(motivo===null)return
    if(motivo.trim()===''){showToast('El servidor exige un motivo para cerrar con faltantes','error');return}
    setCerrando(true)
    try{
      const {error}=await supabase.rpc('cerrar_orden_compra_con_faltantes',{p_orden_id:ordenActual.id,p_client_transaction_id:claveCierre.current,p_motivo:motivo.trim()})
      if(error){showToast(error.message,'error');return}
      showToast('Orden cerrada con faltantes','success')
      await Promise.all([cargar(),onChanged()])
    }finally{setCerrando(false)}
  }

  const iniciarCorreccion=(id:string)=>{setCorrige(id);formRef.current?.scrollIntoView({behavior:'smooth',block:'start'})}
  const irARecepcion=(id:string)=>document.getElementById(`rec-${id}`)?.scrollIntoView({behavior:'smooth',block:'center'})

  const campo=(i:Item,k:'buenas'|'danadas'|'faltante'|'equivocado',label:string,tono:string)=><label className="block"><span className={`text-[10px] ${tono}`}>{label}</span><input type="number" min={0} step={1} inputMode="numeric" disabled={enviando} value={cap(i.id)[k]} onChange={e=>setCap(i.id,{[k]:e.target.value})} className="input-personal mt-0.5 w-full" placeholder="0"/></label>

  return <Modal title={`OC #${ordenActual.numero} · ${ordenActual.proveedor?.nombre||'Proveedor'}`} onClose={onClose}>
    <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
      <p className="text-xs text-gray-500">Estado: <span className="uppercase font-semibold text-cyan-300">{ordenActual.estado}</span> · S/ {Number(ordenActual.total).toFixed(2)}</p>
      <button onClick={()=>cargar()} disabled={cargando} className="rounded-lg border border-[#30363d] px-2 py-1 text-xs text-gray-300 inline-flex gap-1 items-center disabled:opacity-40"><RefreshCw size={12}/>{cargando?'Cargando...':'Recargar'}</button>
    </div>
    {errorCarga&&<div className="mb-3 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">{errorCarga}</div>}

    <div ref={formRef}/>
    {editable&&corrige&&<div className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200 flex flex-wrap justify-between gap-2"><span>Corrección de la <b>recepción #{numeroRecepcion[corrige]??'?'}</b>. Se guarda como una recepción NUEVA enlazada; la anterior no se modifica. Lo que declares se suma; y si se registró de más, indícalo en <b>Revertir</b> de la línea y el servidor lo resta con su propio rastro.</span><button onClick={()=>setCorrige(null)} disabled={enviando} className="underline">Quitar enlace</button></div>}

    <div className="space-y-2">{items.map(i=>{
      const pend=pendiente(i)
      const serial=!!i.variant?.product?.control_serial
      const c=cap(i.id)
      const sobrante=sobranteEstimado(i,c)
      const acumulado=recItems.filter(x=>x.orden_item_id===i.id).reduce((a,x)=>({danadas:a.danadas+(x.cantidad_danada||0),faltantes:a.faltantes+(x.cantidad_faltante||0),sobrantes:a.sobrantes+(x.cantidad_sobrante||0),equivocados:a.equivocados+(x.cantidad_producto_equivocado||0)}),{danadas:0,faltantes:0,sobrantes:0,equivocados:0})
      const nBuenos=parseSeriales(c.imeiBuenos,false).length
      const nDanados=parseSeriales(c.imeiDanados,true).length
      return <div key={i.id} className="rounded-xl border border-[#30363d] p-3">
        <div className="flex flex-wrap justify-between gap-2">
          <p className="text-sm text-white">{nombreVariante(i.variant)}{serial&&<span className="ml-2 text-[10px] text-orange-400">IMEI obligatorio</span>}</p>
          <p className="text-[11px] text-gray-500">S/ {Number(i.costo_unitario).toFixed(2)}</p>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
          <span className="text-gray-400">Pedido <b className="text-white">{i.cantidad_pedida}</b></span>
          <span className="text-gray-400">Ya recibido <b className="text-green-400">{i.cantidad_recibida}</b></span>
          <span className="text-gray-400">Pendiente <b className={pend>0?'text-amber-300':'text-gray-300'}>{pend}</b></span>
          {(acumulado.danadas+acumulado.faltantes+acumulado.sobrantes+acumulado.equivocados)>0&&<span className="text-red-300">Incidencias previas: {acumulado.danadas} dañadas · {acumulado.faltantes} faltantes · {acumulado.sobrantes} sobrantes · {acumulado.equivocados} equivocadas</span>}
        </div>
        {editable&&<div className="mt-3 space-y-2">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {campo(i,'buenas','Recibido bien','text-green-400')}
            {campo(i,'danadas','Dañado (no vendible)','text-amber-300')}
            {campo(i,'faltante','Faltante (no llegó)','text-red-300')}
            {campo(i,'equivocado','Producto equivocado','text-purple-300')}
          </div>
          {(c.equivocado!==''||c.variantEq!=='')&&<label className="block"><span className="text-[10px] text-purple-300">Variante que llegó en su lugar</span><select disabled={enviando} value={c.variantEq} onChange={e=>setCap(i.id,{variantEq:e.target.value})} className="input-personal mt-0.5 w-full"><option value="">Selecciona la variante recibida...</option>{variants.filter(v=>v.id!==i.variant_id).map(v=><option key={v.id} value={v.id}>{nombreVariante(v)}{v.product?.control_serial?' · IMEI':''}</option>)}</select></label>}
          {corrige&&!serial&&<label className="block"><span className="text-[10px] text-cyan-300">Revertir de lo ya registrado (corrección)</span><input type="number" min={0} step={1} inputMode="numeric" disabled={enviando} value={c.revertir} onChange={e=>setCap(i.id,{revertir:e.target.value})} className="input-personal mt-0.5 w-full" placeholder="0"/></label>}
          {corrige&&serial&&<p className="text-[10px] text-gray-500">Para revertir unidades con IMEI hay que identificar cuáles: resuélvelas por cuarentena o baja desde Seriales.</p>}
          {sobrante>0&&<label className="flex items-start gap-2 rounded-lg border border-orange-500/40 bg-orange-500/10 p-2 text-[11px] text-orange-200"><input type="checkbox" disabled={enviando} checked={c.aceptaSobrante} onChange={e=>setCap(i.id,{aceptaSobrante:e.target.checked})} className="mt-0.5"/><span>Llegan físicamente {entero(c.buenas)+entero(c.danadas)} y quedan {pend} pendientes: sobrante de {sobrante}. Confirmo que el sobrante es real (acepta_sobrante). Sin esta confirmación el servidor rechaza la línea.</span></label>}
          {serial&&<div className="grid md:grid-cols-2 gap-2">
            <label className="block"><span className="text-[10px] text-gray-400">IMEI/serie de las unidades buenas ({nBuenos} de {entero(c.buenas)}) · <code>IMEI1|IMEI2</code></span><textarea disabled={enviando} value={c.imeiBuenos} onChange={e=>setCap(i.id,{imeiBuenos:e.target.value})} rows={Math.min(6,Math.max(2,entero(c.buenas)))} className="input-personal mt-0.5 w-full font-mono text-xs" placeholder={'IMEI-001\nIMEI-002|IMEI2-002'}/></label>
            <label className="block"><span className="text-[10px] text-amber-300">IMEI/serie de las unidades dañadas ({nDanados} de {entero(c.danadas)}) · quedan en cuarentena</span><textarea disabled={enviando} value={c.imeiDanados} onChange={e=>setCap(i.id,{imeiDanados:e.target.value})} rows={Math.min(6,Math.max(2,entero(c.danadas)))} className="input-personal mt-0.5 w-full font-mono text-xs" placeholder="IMEI-003"/></label>
          </div>}
          <input disabled={enviando} value={c.observacion} onChange={e=>setCap(i.id,{observacion:e.target.value})} placeholder="Observación de la línea (opcional)" className="input-personal w-full text-xs"/>
        </div>}
      </div>})}
      {!cargando&&items.length===0&&!errorCarga&&<p className="text-xs text-gray-600">La orden no tiene líneas visibles.</p>}
    </div>

    {editable&&<div className="mt-3">
      <textarea disabled={enviando} value={observacion} onChange={e=>setObservacion(e.target.value)} placeholder="Observación general de la recepción (opcional)" rows={2} className="input-personal w-full text-sm"/>
      {ultimoError&&<div className="mt-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300"><p className="font-semibold">El servidor rechazó el envío o no respondió:</p><p className="mt-1 whitespace-pre-wrap">{ultimoError}</p><p className="mt-2 text-red-200/80">El estado de la orden y el historial ya se recargaron por si el envío llegó a aplicarse. Reintentar sin cambiar nada es seguro: se reutiliza la misma clave. Si cambias algo, se enviará como una recepción distinta.</p></div>}
      {aviso&&<div className={`mt-2 rounded-xl border p-3 text-xs ${aviso.tipo==='reintento'?'border-cyan-500/40 bg-cyan-500/10 text-cyan-200':'border-green-500/40 bg-green-500/10 text-green-300'}`}>{aviso.texto}</div>}
      <button onClick={enviar} disabled={enviando||cargando} className="mt-3 w-full rounded-xl bg-green-500 px-4 py-2 text-sm font-bold text-black disabled:opacity-40">{enviando?'Registrando...':ultimoError?'Reintentar envío':corrige?'Registrar corrección':'Registrar recepción'}</button>
      {items.some(i=>pendiente(i)>0)&&<button onClick={cerrarConFaltantes} disabled={cerrando||enviando||cargando} className="mt-2 w-full rounded-xl border border-amber-500/40 py-2 text-xs text-amber-200 disabled:opacity-40">{cerrando?'Cerrando...':'Cerrar orden con faltantes'}</button>}
    </div>}
    {!editable&&!cargando&&<p className="mt-3 text-xs text-gray-500">{!abierta?`La orden está ${ordenActual.estado}: el servidor no admite más recepciones ni correcciones.`:'Tu puesto no figura entre los que el servidor autoriza a recibir compras.'}</p>}
    {!editable&&aviso&&<div className={`mt-2 rounded-xl border p-3 text-xs ${aviso.tipo==='reintento'?'border-cyan-500/40 bg-cyan-500/10 text-cyan-200':'border-green-500/40 bg-green-500/10 text-green-300'}`}>{aviso.texto}</div>}

    <div className="mt-6">
      <div className="flex items-center gap-2 mb-2"><History size={14} className="text-cyan-400"/><h4 className="text-sm font-semibold text-white">Historial de recepciones</h4><span className="text-[10px] text-gray-500">append-only: nada se edita ni se borra</span></div>
      {recepciones.length===0&&!cargando&&<p className="text-xs text-gray-600">Aún no hay recepciones registradas.</p>}
      <div className="space-y-2">{recepciones.map(r=>{
        const lineas=recItems.filter(x=>x.recepcion_id===r.id)
        const correcciones=recepciones.filter(x=>x.corrige_recepcion_id===r.id)
        const historica=!r.client_transaction_id||(r.payload_hash||'').startsWith('legacy:')
        return <div key={r.id} id={`rec-${r.id}`} className={`rounded-xl border p-3 ${corrige===r.id?'border-amber-500/60':'border-[#30363d]'} ${r.corrige_recepcion_id?'ml-4 border-l-4 border-l-amber-500/60':''}`}>
          <div className="flex flex-wrap justify-between gap-2">
            <p className="text-xs text-white font-semibold">Recepción #{numeroRecepcion[r.id]} · {fechaHora(r.fecha||r.created_at)}</p>
            <p className="text-[11px] text-gray-500">Recibido por {r.recibido_por?(nombresStaff[r.recibido_por]||'Personal'):'—'}</p>
          </div>
          <div className="mt-1 flex flex-wrap gap-2 text-[10px]">
            {r.corrige_recepcion_id&&<button onClick={()=>irARecepcion(r.corrige_recepcion_id as string)} className="rounded border border-amber-500/40 px-1.5 py-0.5 text-amber-300">Corrige la recepción #{numeroRecepcion[r.corrige_recepcion_id]??'?'}</button>}
            {correcciones.map(x=><button key={x.id} onClick={()=>irARecepcion(x.id)} className="rounded border border-amber-500/40 px-1.5 py-0.5 text-amber-200">Corregida por la recepción #{numeroRecepcion[x.id]}</button>)}
            {historica&&<span className="rounded border border-gray-500/40 px-1.5 py-0.5 text-gray-400">histórica (sin clave de idempotencia)</span>}
          </div>
          {r.observacion&&<p className="mt-1 text-[11px] text-gray-400">“{r.observacion}”</p>}
          <div className="mt-2 space-y-1">{lineas.map(li=>{
            const it=itemPorId[li.orden_item_id]
            const ser=seriales.filter(s=>s.recepcion_item_id===li.id)
            const eq=li.variant_id_recibido?variantesRecibidas[li.variant_id_recibido]:null
            return <div key={li.id} className="rounded-lg bg-[#0d1117] px-2 py-1.5 text-[11px]">
              <p className="text-gray-300">{it?nombreVariante(it.variant):'Línea'}</p>
              <p className="flex flex-wrap gap-x-3 text-gray-500">
                <span>bien <b className="text-green-400">{li.cantidad}</b></span>
                {!!li.cantidad_danada&&<span>dañadas <b className="text-amber-300">{li.cantidad_danada}</b></span>}
                {!!li.cantidad_faltante&&<span>faltantes <b className="text-red-300">{li.cantidad_faltante}</b></span>}
                {!!li.cantidad_sobrante&&<span>sobrante <b className="text-orange-300">{li.cantidad_sobrante}</b></span>}
                {!!li.cantidad_producto_equivocado&&<span>equivocadas <b className="text-purple-300">{li.cantidad_producto_equivocado}</b>{li.variant_id_recibido&&<> · llegó {eq?nombreVariante(eq):'otra variante'}</>}</span>}
              </p>
              {li.observacion&&<p className="text-gray-500">“{li.observacion}”</p>}
              {ser.length>0&&<p className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-[10px]">{ser.map(s=><span key={s.id} className={ESTADO_SERIAL[s.estado]||'text-gray-400'}>{s.serial_number}{s.imei2?`|${s.imei2}`:''} ({s.estado})</span>)}</p>}
            </div>})}
            {lineas.length===0&&<p className="text-[11px] text-gray-600">Sin líneas visibles.</p>}
          </div>
          {editable&&<button onClick={()=>iniciarCorreccion(r.id)} disabled={enviando} className="mt-2 text-[11px] text-amber-300 underline disabled:opacity-40">Registrar corrección de esta recepción</button>}
        </div>})}
      </div>
    </div>
  </Modal>
}

function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:React.ReactNode}){return <div className="fixed inset-0 z-[70] bg-black/65 flex items-end md:items-center justify-center"><div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-t-2xl md:rounded-2xl border border-[#30363d] bg-[#161b22] p-5 relative"><button onClick={onClose} className="absolute right-4 top-4 text-gray-500"><X size={18}/></button><h3 className="font-bold text-white mb-4 pr-6">{title}</h3>{children}</div></div>}
