import { openDB } from 'idb'
import { sincronizarVentasPendientes } from './offline'

const DB_NAME='lukatcell-pos'
const DB_VERSION=2
const LOCK_NAME='lukatcell-sync-ventas'
const STORES=['productos_cache','categorias','ventas_pendientes','movimientos_pendientes','sync_metadata','carrito_activo'] as const

async function db(){return openDB(DB_NAME,DB_VERSION)}

export async function sincronizarVentasCoordinadas(forzarAgotadas=false):Promise<{ok:number;fallidas:number;ocupado?:boolean}>{
  if('locks' in navigator && navigator.locks){
    const result=await navigator.locks.request(LOCK_NAME,{mode:'exclusive',ifAvailable:true},async(lock)=>{
      if(!lock)return {ok:0,fallidas:0,ocupado:true}
      return sincronizarVentasPendientes(forzarAgotadas)
    })
    return result
  }
  return sincronizarVentasPendientes(forzarAgotadas)
}

export interface BackupLocal{
  version:1
  exportedAt:string
  dbVersion:number
  stores:Record<string,unknown[]>
}

export async function crearBackupLocal():Promise<BackupLocal>{
  const database=await db()
  const stores:Record<string,unknown[]>={}
  for(const name of STORES){
    if(database.objectStoreNames.contains(name)) stores[name]=await database.getAll(name)
  }
  return {version:1,exportedAt:new Date().toISOString(),dbVersion:DB_VERSION,stores}
}

export async function descargarBackupLocal(){
  const backup=await crearBackupLocal()
  const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'})
  const url=URL.createObjectURL(blob)
  const a=document.createElement('a')
  a.href=url
  a.download=`lukatcell-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`
  a.click()
  setTimeout(()=>URL.revokeObjectURL(url),1000)
}

function esBackup(v:unknown):v is BackupLocal{
  if(!v||typeof v!=='object')return false
  const b=v as Partial<BackupLocal>
  return b.version===1&&!!b.stores&&typeof b.stores==='object'
}

export async function restaurarBackupLocal(file:File):Promise<{restaurados:number;omitidos:number}>{
  const parsed=JSON.parse(await file.text()) as unknown
  if(!esBackup(parsed))throw new Error('Archivo de backup inválido')
  const database=await db()
  let restaurados=0,omitidos=0
  for(const name of STORES){
    if(!database.objectStoreNames.contains(name))continue
    const rows=Array.isArray(parsed.stores[name])?parsed.stores[name]:[]
    if(!rows.length)continue
    const tx=database.transaction(name,'readwrite')
    if(name==='ventas_pendientes'){
      const actuales=await tx.store.getAll()
      const ids=new Set(actuales.map((x:any)=>x.clientTransactionId).filter(Boolean))
      for(const row of rows as any[]){
        if(row.clientTransactionId&&ids.has(row.clientTransactionId)){omitidos++;continue}
        const copy={...row};delete copy.id
        await tx.store.add(copy);restaurados++
        if(copy.clientTransactionId)ids.add(copy.clientTransactionId)
      }
    }else{
      for(const row of rows){try{await tx.store.put(row as never);restaurados++}catch{omitidos++}}
    }
    await tx.done
  }
  return {restaurados,omitidos}
}

export async function diagnosticoLocal(){
  const database=await db()
  const ventas=database.objectStoreNames.contains('ventas_pendientes')?await database.getAll('ventas_pendientes'):[]
  const catalogo=database.objectStoreNames.contains('productos_cache')?await database.count('productos_cache'):0
  const carritos=database.objectStoreNames.contains('carrito_activo')?await database.count('carrito_activo'):0
  return {
    catalogo,
    carritos,
    pendientes:ventas.filter((v:any)=>v.estado==='PENDING'||v.estado==='SYNCING').length,
    fallidas:ventas.filter((v:any)=>v.estado==='FAILED').length,
    ventas:ventas.sort((a:any,b:any)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,100),
  }
}
