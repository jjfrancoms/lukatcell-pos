import { useEffect, useState } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import { supabase } from '../lib/supabase'

export default function MFAGate({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [required, setRequired] = useState(false)
  const [factorId, setFactorId] = useState<string | null>(null)
  const [challengeId, setChallengeId] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [verifying, setVerifying] = useState(false)

  const check = async () => {
    setLoading(true)
    setError('')
    const aal = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aal.error) { setLoading(false); return }
    const needsMfa = aal.data.nextLevel === 'aal2' && aal.data.currentLevel !== 'aal2'
    if (!needsMfa) { setRequired(false); setLoading(false); return }

    const factors = await supabase.auth.mfa.listFactors()
    if (factors.error) { setError(factors.error.message); setLoading(false); return }
    const factor = factors.data.totp.find((f) => f.status === 'verified') || factors.data.phone.find((f) => f.status === 'verified')
    if (!factor) { setRequired(false); setLoading(false); return }

    const challenge = await supabase.auth.mfa.challenge({ factorId: factor.id })
    if (challenge.error) { setError(challenge.error.message); setLoading(false); return }
    setFactorId(factor.id)
    setChallengeId(challenge.data.id)
    setRequired(true)
    setLoading(false)
  }

  useEffect(() => { void check() }, [])

  const verify = async () => {
    if (!factorId || !challengeId || code.trim().length < 6) return
    setVerifying(true); setError('')
    const res = await supabase.auth.mfa.verify({ factorId, challengeId, code: code.trim() })
    setVerifying(false)
    if (res.error) { setError('Código inválido o vencido'); return }
    await supabase.auth.refreshSession()
    setRequired(false)
  }

  if (loading) return <div className="h-screen flex items-center justify-center bg-[#0d1117]"><Loader2 className="animate-spin text-cyan-500" size={28}/></div>
  if (!required) return <>{children}</>

  return <div className="min-h-screen bg-[#0d1117] flex items-center justify-center p-4">
    <div className="w-full max-w-sm rounded-2xl border border-[#30363d] bg-[#161b22] p-6 shadow-2xl">
      <div className="w-12 h-12 rounded-xl bg-cyan-500/15 text-cyan-400 flex items-center justify-center mb-4"><ShieldCheck size={26}/></div>
      <h1 className="text-xl font-bold text-white">Verificación en dos pasos</h1>
      <p className="text-sm text-gray-400 mt-2">Ingresa el código de 6 dígitos de tu aplicación autenticadora para continuar.</p>
      <input autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,'').slice(0,8))} onKeyDown={e=>e.key==='Enter'&&void verify()} placeholder="000000" className="mt-5 w-full rounded-xl border border-[#30363d] bg-[#0d1117] px-4 py-3 text-center text-xl tracking-[0.35em] text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"/>
      {error&&<p className="mt-3 text-xs text-red-400">{error}</p>}
      <button onClick={()=>void verify()} disabled={verifying||code.trim().length<6} className="mt-4 w-full rounded-xl bg-cyan-500 py-3 font-bold text-black disabled:opacity-50">{verifying?'Verificando...':'Verificar y continuar'}</button>
      <button onClick={()=>void check()} className="mt-3 w-full text-xs text-gray-500 hover:text-gray-300">Generar un nuevo desafío</button>
    </div>
  </div>
}
