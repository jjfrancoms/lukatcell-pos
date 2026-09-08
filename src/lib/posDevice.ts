import { supabase } from './supabase'

// Identidad persistente de ESTA terminal. El cierre diario necesita saber si
// alguna terminal de la sucursal tiene ventas offline sin sincronizar — algo
// que vive en el IndexedDB de cada navegador y que ningún otro dispositivo
// puede ver. El heartbeat publica ese conteo server-side (pos_devices) para
// que aprobar_cierre_diario pueda bloquear el cierre en vez de congelar el
// día y dejar la venta atrapada para siempre.
//
// El device_id NO da permisos: la sucursal y el staff se resuelven en el
// backend desde auth.uid(). Es solo un identificador estable de terminal.
const DEVICE_ID_KEY = 'lukatcell_pos_device_id'

function nombreTerminalPorDefecto(): string | null {
  if (typeof navigator === 'undefined') return null
  const ua = navigator.userAgent
  const navegador = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Navegador'
  const so = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : null
  return so ? `${navegador} · ${so}` : navegador
}

/** Id estable de esta terminal; se genera una vez y se guarda localmente. */
export function getDeviceId(): string {
  try {
    const guardado = localStorage.getItem(DEVICE_ID_KEY)
    if (guardado) return guardado
    const nuevo = crypto.randomUUID()
    localStorage.setItem(DEVICE_ID_KEY, nuevo)
    return nuevo
  } catch {
    // Modo privado / storage bloqueado: se usa un id efímero. El heartbeat
    // sigue funcionando, solo que esta terminal se ve como una nueva en cada
    // sesión — preferible a romper el POS por no poder escribir localStorage.
    return crypto.randomUUID()
  }
}

/**
 * Reporta el estado de esta terminal. Se llama al sincronizar y
 * periódicamente mientras haya conexión. Nunca lanza: un heartbeat fallido
 * no debe romper el flujo de venta.
 */
export async function enviarHeartbeatPos(pendientes: number, fallidas: number): Promise<void> {
  try {
    await supabase.rpc('registrar_heartbeat_pos', {
      p_device_id: getDeviceId(),
      p_pending_sales: pendientes,
      p_failed_sales: fallidas,
      p_app_version: null,
      p_nombre: nombreTerminalPorDefecto(),
    })
  } catch {
    // silencioso a propósito
  }
}
