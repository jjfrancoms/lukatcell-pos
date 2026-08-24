import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { JornadaActual, Staff } from '../types'

interface AuthContextValue {
  session: Session | null
  staff: Staff | null
  loading: boolean
  isAdmin: boolean
  cashSessionId: string | null
  jornada: JornadaActual | null
  jornadaActiva: boolean
  signIn: (email: string, password: string) => Promise<string | null>
  signOut: () => Promise<void>
  refreshStaff: () => Promise<void>
  refreshCashSession: () => Promise<void>
  refreshJornada: () => Promise<void>
  registrarEntrada: () => Promise<string | null>
  registrarSalida: () => Promise<string | null>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [staff, setStaff] = useState<Staff | null>(null)
  const [loading, setLoading] = useState(true)
  const [cashSessionId, setCashSessionId] = useState<string | null>(null)
  const [jornada, setJornada] = useState<JornadaActual | null>(null)

  const cargarJornada = async () => {
    const { data, error } = await supabase.rpc('mi_estado_jornada')
    if (error) { setJornada(null); return }
    const fila = Array.isArray(data) ? data[0] : data
    setJornada(fila ?? null)
  }

  const cargarStaff = async (userId: string) => {
    const { data } = await supabase.from('staff').select('*').eq('user_id', userId).maybeSingle()
    if (data && !data.activo) {
      setStaff(null); setCashSessionId(null); setJornada(null)
      await supabase.auth.signOut()
      return
    }
    const efectivo = data ? ({ ...data, location_id: data.active_location_id ?? data.location_id } as Staff) : null
    setStaff(efectivo)
    if (efectivo) await Promise.all([cargarCajaActiva(efectivo.id), cargarJornada()])
    else { setCashSessionId(null); setJornada(null) }
  }

  const cargarCajaActiva = async (staffId: string) => {
    const { data } = await supabase.from('cash_sessions').select('id').eq('cajero_id', staffId).is('cierre', null).order('apertura', { ascending: false }).limit(1).maybeSingle()
    setCashSessionId(data?.id ?? null)
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session)
      if (data.session) await cargarStaff(data.session.user.id)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      setSession(newSession)
      if (newSession) await cargarStaff(newSession.user.id)
      else { setStaff(null); setCashSessionId(null); setJornada(null) }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return error ? error.message : null
  }

  const signOut = async () => { await supabase.auth.signOut() }
  const refreshStaff = async () => { if (session) await cargarStaff(session.user.id) }
  const refreshCashSession = async () => { if (staff) await cargarCajaActiva(staff.id) }
  const refreshJornada = async () => { if (staff) await cargarJornada() }

  const registrarEntrada = async () => {
    const { error } = await supabase.rpc('registrar_mi_entrada')
    if (!error) await cargarJornada()
    return error?.message ?? null
  }

  const registrarSalida = async () => {
    const { error } = await supabase.rpc('registrar_mi_salida')
    if (!error) await cargarJornada()
    return error?.message ?? null
  }

  const jornadaActiva = Boolean(jornada?.entrada && !jornada?.salida)

  return (
    <AuthContext.Provider value={{ session, staff, loading, isAdmin: staff?.rol === 'administrador', cashSessionId, jornada, jornadaActiva, signIn, signOut, refreshStaff, refreshCashSession, refreshJornada, registrarEntrada, registrarSalida }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth debe usarse dentro de AuthProvider')
  return ctx
}
