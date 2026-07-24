import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase } from './supabase'
import type { Configuracion } from '../types'

const DEFAULT_CONFIG: Configuracion = {
  id: 1, igv_activo: true, igv_porcentaje: 18, negocio_nombre: 'LUKATCELL',
  negocio_ruc: null, negocio_direccion: null, stock_minimo_default: 5, updated_at: '',
}

interface ConfigContextValue {
  config: Configuracion
  loading: boolean
  refreshConfig: () => Promise<void>
}

const ConfigContext = createContext<ConfigContextValue | null>(null)

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<Configuracion>(DEFAULT_CONFIG)
  const [loading, setLoading] = useState(true)

  const cargar = async () => {
    const { data } = await supabase.from('configuracion').select('*').eq('id', 1).maybeSingle()
    if (data) setConfig(data)
    setLoading(false)
  }

  useEffect(() => { cargar() }, [])

  return (
    <ConfigContext.Provider value={{ config, loading, refreshConfig: cargar }}>
      {children}
    </ConfigContext.Provider>
  )
}

export function useConfig() {
  const ctx = useContext(ConfigContext)
  if (!ctx) throw new Error('useConfig debe usarse dentro de ConfigProvider')
  return ctx
}
