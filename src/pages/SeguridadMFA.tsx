import { useEffect, useState } from 'react'
import { KeyRound, Loader2, ShieldCheck, ShieldOff } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useToast } from '../lib/toast'

type Factor={id:string;friendly_name?:string|null;status:string;factor_type:string}

export default function SeguridadMFA(){
  const {showToast}=useToast()
  const [factors,setFactors]=useState<Factor[]>([])
  const [loading,setLoading]=useState(true)
  const [factorId,setFactorId]=useState<string|null>(null)
  const [challengeId,setChallengeId]=useState<string|null>(null)
  const [qr,setQr]=useState<string|null>(null)
  const [secret,setSecret]=useState<string|null>(null)
  const [code,setCode]=useState('')
  const [busy,setBusy]=useState(false)

  const cargar=async()=>{
    setLoading(true)
    const {data,error}=await supabase.auth.mfa.listFactors()
    if(error){showToast('No se pudieron cargar los factores MFA','error');setLoading(false);return}
    setFactors([...(data.totp as Factor[]),...(data.phone as Factor[])])
    setLoading(false)
  }
  useEffect(()=>{void cargar()},[])

  const iniciarTotp=async()=>{
    setBusy(true)
    const {data,error}=await supabase.auth.mfa.enroll({factorType:'totp',friendlyName:'LUKATCELL'})
    if(error){showToast(error.message,'error');setBusy(false);return}
    const challenge=await supabase.auth.mfa.challenge({factorId:data.id})
    if(challenge.error){await supabase.auth.mfa.unenroll({factorId:data.id});showToast(challenge.error.message,'error');setBusy(false);return}
    setFactorId(data.id);setChallengeId(challenge.data.id);setQr(data.totp.qr_code);setSecret(data.totp.secret);setBusy(false)
  }

  const verificar=async()=>{
    if(!factorId||!challengeId||code.trim().length<6)return
    setBusy(true)
    const {error}=await supabase.auth.mfa.verify({factorId,challengeId,code:code.trim()})
    if(error){showToast('Código inválido o vencido','error');setBusy(false);return}
    await supabase.auth.refreshSession()
    setFactorId(null);setChallengeId(null);setQr(null);setSecret(null);setCode('');setBusy(false)
    showToast('Autenticación en dos pasos activada','success');await cargar()
  }

  const eliminar=async(id:string)=>{
    if(!confirm('¿Desactivar este factor de autenticación?'))return
    setBusy(true)
    const {error}=await supabase.auth.mfa.unenroll({factorId:id})
    setBusy(false)
    showToast(error?error.message:'Factor eliminado',error?'error':'success')
    if(!error)await cargar()
  }

  const verified=factors.filter(f=>f.status==='verified')
  return <div className="p-4 md:p-6 max-w-3xl mx-auto">
    <div className="flex items-center gap-3 mb-6"><div className="w-10 h-10 rounded-xl bg-cyan-500/15 text-cyan-400 flex items-center justify-center"><ShieldCheck size={22}/></div><div><h1 className="text-xl font-bold text-white">Seguridad de la cuenta</h1><p className="text-xs text-gray-500">Autenticación en dos pasos (MFA/TOTP)</p></div></div>

    <div className="rounded-xl border border-[#30363d] bg-[#161b22] p-5">
      <div className="flex items-start justify-between gap-4"><div><h2 className="font-semibold text-white">Aplicación autenticadora</h2><p className="mt-1 text-sm text-gray-400">Protege tu cuenta con códigos temporales desde Google Authenticator, Microsoft Authenticator, 1Password u otra app compatible.</p></div><span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${verified.length?'bg-green-500/15 text-green-400':'bg-gray-500/15 text-gray-400'}`}>{verified.length?'Activo':'No configurado'}</span></div>

      {loading?<div className="py-8 flex justify-center"><Loader2 className="animate-spin text-cyan-500"/></div>:<>
        {verified.map(f=><div key={f.id} className="mt-4 flex items-center justify-between rounded-lg border border-[#30363d] bg-[#0d1117] p-3"><div className="flex items-center gap-3"><KeyRound size={17} className="text-green-400"/><div><p className="text-sm text-white">{f.friendly_name||'Autenticador'}</p><p className="text-[11px] text-gray-500">Factor verificado</p></div></div><button onClick={()=>void eliminar(f.id)} disabled={busy} className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50">Desactivar</button></div>)}
        {!factorId&&<button onClick={()=>void iniciarTotp()} disabled={busy} className="mt-5 rounded-lg bg-cyan-500 px-4 py-2.5 text-sm font-bold text-black disabled:opacity-50">{busy?'Preparando...':verified.length?'Añadir otro autenticador':'Activar MFA'}</button>}
      </>}
    </div>

    {factorId&&<div className="mt-5 rounded-xl border border-cyan-500/30 bg-cyan-500/5 p-5"><h2 className="font-semibold text-white">Escanea el código QR</h2><p className="mt-1 text-sm text-gray-400">Escanéalo con tu aplicación autenticadora y escribe el código generado para finalizar.</p>{qr&&<div className="mt-4 inline-block rounded-xl bg-white p-3"><img src={qr} alt="Código QR para configurar MFA" className="w-44 h-44"/></div>}{secret&&<div className="mt-3"><p className="text-[11px] text-gray-500">Clave manual</p><code className="mt-1 block break-all rounded-lg bg-[#0d1117] p-2 text-xs text-gray-300">{secret}</code></div>}<div className="mt-4 flex gap-2"><input value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,'').slice(0,8))} onKeyDown={e=>e.key==='Enter'&&void verificar()} inputMode="numeric" placeholder="000000" className="flex-1 rounded-lg border border-[#30363d] bg-[#0d1117] px-3 py-2 text-center tracking-[0.25em] text-white"/><button onClick={()=>void verificar()} disabled={busy||code.length<6} className="rounded-lg bg-green-500 px-4 py-2 text-sm font-bold text-black disabled:opacity-50">Verificar</button></div></div>}

    <div className="mt-5 flex gap-3 rounded-xl border border-[#30363d] bg-[#161b22] p-4"><ShieldOff size={18} className="mt-0.5 shrink-0 text-orange-400"/><p className="text-xs leading-relaxed text-gray-400">Si activas MFA, una nueva sesión no podrá acceder a las áreas sensibles hasta verificar el segundo factor. Mantén acceso a tu aplicación autenticadora antes de cerrar sesión.</p></div>
  </div>
}
