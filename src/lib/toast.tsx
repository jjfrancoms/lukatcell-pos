import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { CheckCircle2, XCircle, Info, X } from 'lucide-react'

type ToastType = 'success' | 'error' | 'info'
interface ToastAction { label: string; onClick: () => void }
interface ToastItem { id: number; message: string; type: ToastType; action?: ToastAction }

interface ToastContextValue {
  showToast: (message: string, type?: ToastType, action?: ToastAction) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const icons: Record<ToastType, typeof CheckCircle2> = { success: CheckCircle2, error: XCircle, info: Info }
const colors: Record<ToastType, string> = {
  success: 'border-green-500/30 text-green-400',
  error: 'border-red-500/30 text-red-400',
  info: 'border-cyan-500/30 text-cyan-400',
}

let nextId = 1

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])

  const showToast = useCallback((message: string, type: ToastType = 'success', action?: ToastAction) => {
    const id = nextId++
    setToasts((t) => [...t, { id, message, type, action }])
    setTimeout(() => dismiss(id), action ? 5000 : 3200)
  }, [dismiss])

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 md:left-auto md:right-4 md:translate-x-0 z-[100] flex flex-col gap-2 w-[calc(100%-2rem)] max-w-sm no-print">
        {toasts.map((t) => {
          const Icon = icons[t.type]
          return (
            <div key={t.id} role="status"
              className={`flex items-center gap-2.5 bg-[#161b22] border ${colors[t.type]} rounded-xl px-4 py-3 shadow-2xl animate-[fadeIn_.15s_ease-out]`}>
              <Icon size={18} className="shrink-0" />
              <p className="text-sm text-white flex-1">{t.message}</p>
              {t.action && (
                <button onClick={() => { t.action!.onClick(); dismiss(t.id) }} className="text-xs font-bold text-cyan-400 hover:text-cyan-300 shrink-0">
                  {t.action.label}
                </button>
              )}
              <button onClick={() => dismiss(t.id)} className="text-gray-500 hover:text-white shrink-0" aria-label="Cerrar notificación"><X size={14} /></button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast debe usarse dentro de ToastProvider')
  return ctx
}
