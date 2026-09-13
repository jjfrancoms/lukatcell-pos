export type HardwareHealth={ok:boolean;printer?:boolean;drawer?:boolean;version?:string;message?:string}
const DEFAULT_BRIDGE='http://127.0.0.1:17171'

// El bridge recibe el HTML de los recibos y la orden de abrir el cajón: sólo puede ser local.
// Se valida al guardar Y al leer, porque localStorage se puede escribir por fuera de setBridgeUrl.
function origenLocal(url:string){
  const u=new URL(url)
  // URL.hostname devuelve IPv6 entre corchetes ("[::1]"): sin normalizar, '::1' nunca coincidía.
  const host=u.hostname.replace(/^\[|\]$/g,'')
  if(!['127.0.0.1','localhost','::1'].includes(host))throw new Error('El bridge debe ejecutarse localmente')
  if(!['http:','https:'].includes(u.protocol))throw new Error('Protocolo no permitido')
  return u.origin
}
export function getBridgeUrl(){
  const guardado=localStorage.getItem('lukatcell_hardware_bridge')
  if(!guardado)return DEFAULT_BRIDGE
  try{return origenLocal(guardado)}catch{return DEFAULT_BRIDGE}
}
export function setBridgeUrl(url:string){
  localStorage.setItem('lukatcell_hardware_bridge',origenLocal(url))
}

async function call(path:string,body?:unknown,timeoutMs=1800){
  const controller=new AbortController();const t=setTimeout(()=>controller.abort(),timeoutMs)
  try{
    const r=await fetch(`${getBridgeUrl()}${path}`,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:controller.signal,cache:'no-store'})
    const data=await r.json().catch(()=>({}))
    if(!r.ok)throw new Error(String(data?.error||`Hardware HTTP ${r.status}`))
    return data
  }finally{clearTimeout(t)}
}

export async function verificarHardware():Promise<HardwareHealth>{
  try{return {...await call('/health'),ok:true} as HardwareHealth}catch(e){return {ok:false,message:e instanceof Error?e.message:'Bridge no disponible'}}
}

export async function imprimirHtmlHardware(html:string,paper:'58mm'|'80mm'){
  try{await call('/print',{format:'html',paper,html},5000);return true}catch{return false}
}

export async function abrirCajonHardware(){await call('/drawer/open',{},2500)}

export async function imprimirPruebaHardware(paper:'58mm'|'80mm'){
  const html=`<div style="font-family:monospace;width:${paper};padding:4mm"><b>LUKATCELL</b><br/>PRUEBA DE IMPRESIÓN<br/>${new Date().toLocaleString('es-PE')}<br/>----------------<br/>Hardware POS OK</div>`
  await call('/print',{format:'html',paper,html},5000)
}
