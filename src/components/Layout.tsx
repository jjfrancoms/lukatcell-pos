import { useState, useEffect } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { ShoppingCart, Wallet, Package, BarChart3, Smartphone, Menu, X, Wrench, Users, UserCog, ChevronsLeft, ChevronsRight, LogOut, WifiOff, Settings, Clock3 } from 'lucide-react'
import { useAuth } from '../lib/auth'
import { useOnlineStatus, sincronizarVentasPendientes, contarVentasPendientes } from '../lib/offline'

const baseNavItems = [
  { to: '/jornada', label: 'Mi jornada', icon: Clock3 },
  { to: '/', label: 'Venta', icon: ShoppingCart },
  { to: '/caja', label: 'Caja', icon: Wallet },
  { to: '/inventario', label: 'Inventario', icon: Package },
  { to: '/ordenes', label: 'Órdenes', icon: Wrench },
  { to: '/clientes', label: 'Clientes', icon: Users },
]

export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => {
    const stored = localStorage.getItem('lukatcell_sidebar_collapsed')
    if (stored !== null) return stored === '1'
    return window.innerWidth < 1024
  })
  const { staff, isAdmin, cashSessionId, jornadaActiva, signOut } = useAuth()
  const { online } = useOnlineStatus()
  const [pendientes, setPendientes] = useState(0)
  const [fallidas, setFallidas] = useState(0)
  const [agotadas, setAgotadas] = useState(0)
  const [reintentandoManual, setReintentandoManual] = useState(false)

  const navItems = isAdmin
    ? [
        ...baseNavItems,
        { to: '/reportes', label: 'Reportes', icon: BarChart3 },
        { to: '/personal', label: 'Personal', icon: UserCog },
        { to: '/configuracion', label: 'Configuración', icon: Settings },
      ]
    : baseNavItems

  useEffect(() => { localStorage.setItem('lukatcell_sidebar_collapsed', collapsed ? '1' : '0') }, [collapsed])

  const actualizarContador = () => contarVentasPendientes().then(({ pendientes, fallidas, agotadas }) => { setPendientes(pendientes); setFallidas(fallidas); setAgotadas(agotadas) })

  useEffect(() => { actualizarContador() }, [])

  useEffect(() => {
    if (!online) return
    sincronizarVentasPendientes().then(() => actualizarContador())
    const interval = setInterval(() => { sincronizarVentasPendientes().then(() => actualizarContador()) }, 45000)
    return () => clearInterval(interval)
  }, [online])

  const reintentarAgotadas = () => {
    setReintentandoManual(true)
    sincronizarVentasPendientes(true).then(() => { actualizarContador(); setReintentandoManual(false) })
  }

  const EstadoBadge = ({ compact }: { compact?: boolean }) => (
    <div className="flex items-center gap-2 flex-wrap">
      <span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold ${jornadaActiva ? 'text-green-400' : 'text-gray-500'}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${jornadaActiva ? 'bg-green-400' : 'bg-gray-500'}`} />
        {compact ? (jornadaActiva ? 'En jornada' : 'Fuera de jornada') : (jornadaActiva ? 'Jornada activa' : 'Sin jornada activa')}
      </span>
      {!compact && (
        <span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold ${cashSessionId ? 'text-cyan-400' : 'text-gray-600'}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${cashSessionId ? 'bg-cyan-400' : 'bg-gray-600'}`} />
          {cashSessionId ? 'Caja abierta' : 'Caja cerrada'}
        </span>
      )}
    </div>
  )

  return (
    <div className="flex h-screen bg-[#0d1117]">
      <div className="md:hidden fixed top-0 left-0 right-0 z-40 bg-[#010409] border-b border-[#30363d] flex items-center justify-between px-4 pb-3"
        style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}>
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-cyan-400 to-cyan-600 flex items-center justify-center">
            <Smartphone size={14} className="text-black" />
          </div>
          <div>
            <span className="font-display font-bold text-sm text-white block leading-none">LUKATCELL</span>
            <EstadoBadge compact />
          </div>
        </div>
        <div className="flex items-center gap-3">
          {!online && <WifiOff size={16} className="text-orange-400" aria-label="Sin conexión" />}
          <button onClick={() => setMenuOpen(!menuOpen)} className="text-gray-400" aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'}>
            {menuOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="md:hidden fixed inset-0 z-30 bg-black/60" onClick={() => setMenuOpen(false)}>
          <nav className="absolute mobile-header-offset left-0 right-0 bg-[#010409] border-b border-[#30363d] p-3 max-h-[85vh] overflow-y-auto overflow-x-hidden"
            onClick={(e) => e.stopPropagation()}>
            {navItems.map(({ to, label, icon: Icon }) => (
              <NavLink key={to} to={to} end={to === '/'} onClick={() => setMenuOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-4 py-3 rounded-lg mb-1 transition-all ${
                    isActive ? 'bg-cyan-500/15 text-cyan-400 font-semibold' : 'text-gray-400 hover:text-white'}`}>
                <Icon size={18} /><span className="text-sm">{label}</span>
              </NavLink>
            ))}
            <button onClick={() => { setMenuOpen(false); signOut() }}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-lg mt-2 pt-3 border-t border-[#30363d] text-gray-500 hover:text-red-400">
              <LogOut size={18} /><span className="text-sm">Cerrar sesión</span>
            </button>
          </nav>
        </div>
      )}

      <aside className={`hidden md:flex flex-col shrink-0 border-r border-[#30363d] bg-[#010409] transition-all duration-200 ${collapsed ? 'w-16' : 'w-52'}`}>
        <div className={`flex items-center gap-2 py-4 border-b border-[#30363d] ${collapsed ? 'justify-center px-2' : 'px-4'}`}>
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-400 to-cyan-600 flex items-center justify-center shrink-0 shadow-lg shadow-cyan-500/20">
            <Smartphone size={16} className="text-black" />
          </div>
          {!collapsed && (
            <div className="leading-tight min-w-0">
              <p className="font-display font-bold text-sm text-white tracking-wide truncate">LUKATCELL</p>
              <p className="text-[10px] text-cyan-500 uppercase tracking-widest">Punto de venta</p>
            </div>
          )}
        </div>
        {!collapsed && (
          <div className="px-4 py-2 border-b border-[#30363d]"><EstadoBadge /></div>
        )}
        <nav className="flex-1 py-3 overflow-y-auto overflow-x-hidden">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === '/'} title={collapsed ? label : undefined}
              className={({ isActive }) =>
                `flex items-center gap-3 py-2.5 mx-2 rounded-lg mb-0.5 transition-all ${collapsed ? 'justify-center px-0' : 'px-4'} ${
                  isActive ? 'bg-cyan-500/15 text-cyan-400 font-semibold border border-cyan-500/30' : 'text-gray-500 hover:bg-[#161b22] hover:text-gray-300 border border-transparent'}`}>
              <Icon size={18} />{!collapsed && <span className="text-sm">{label}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-[#30363d] p-2">
          {!collapsed && staff && (
            <div className="px-2 py-2 mb-1">
              <p className="text-xs font-semibold text-white truncate">{staff.nombre}</p>
              <p className="text-[10px] text-gray-500 capitalize">{staff.puesto || staff.rol}</p>
            </div>
          )}
          <button onClick={() => signOut()} title="Cerrar sesión" aria-label="Cerrar sesión"
            className={`w-full flex items-center gap-3 py-2 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-all ${collapsed ? 'justify-center px-0' : 'px-2'}`}>
            <LogOut size={16} />{!collapsed && <span className="text-xs">Cerrar sesión</span>}
          </button>
          <button onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expandir menú' : 'Colapsar menú'}
            className={`w-full flex items-center gap-3 py-2 rounded-lg text-gray-500 hover:text-white hover:bg-[#161b22] transition-all mt-0.5 ${collapsed ? 'justify-center px-0' : 'px-2'}`}>
            {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
            {!collapsed && <span className="text-xs">Colapsar</span>}
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden mobile-header-pad flex flex-col">
        {!online && (
          <div className="bg-orange-500/15 border-b border-orange-500/30 text-orange-400 text-xs font-semibold px-4 py-2 flex items-center gap-2 shrink-0">
            <WifiOff size={13} /> ● OFFLINE — las ventas se guardarán y sincronizarán al reconectar
            {pendientes > 0 && <span className="ml-1">({pendientes} venta{pendientes === 1 ? '' : 's'} pendiente{pendientes === 1 ? '' : 's'})</span>}
          </div>
        )}
        {online && pendientes > 0 && (
          <div className="bg-cyan-500/15 border-b border-cyan-500/30 text-cyan-400 text-xs font-semibold px-4 py-2 flex items-center gap-2 shrink-0">
            ● ONLINE — sincronizando {pendientes} venta{pendientes === 1 ? '' : 's'} pendiente{pendientes === 1 ? '' : 's'}...
          </div>
        )}
        {online && pendientes === 0 && fallidas > 0 && (
          <div className="bg-red-500/15 border-b border-red-500/30 text-red-400 text-xs font-semibold px-4 py-2 flex items-center gap-2 shrink-0">
            {fallidas} venta{fallidas === 1 ? '' : 's'} no se pudo{fallidas === 1 ? '' : 'ieron'} sincronizar — se reintentará automáticamente
          </div>
        )}
        {online && agotadas > 0 && (
          <div className="bg-red-500/15 border-b border-red-500/30 text-red-400 text-xs font-semibold px-4 py-2 flex items-center justify-between gap-2 shrink-0">
            <span>{agotadas} venta{agotadas === 1 ? '' : 's'} requiere{agotadas === 1 ? '' : 'n'} atención — no se pudo{agotadas === 1 ? '' : 'ieron'} sincronizar tras varios intentos</span>
            <button onClick={reintentarAgotadas} disabled={reintentandoManual} className="underline shrink-0 disabled:opacity-50">
              {reintentandoManual ? 'Reintentando...' : 'Reintentar ahora'}
            </button>
          </div>
        )}
        <div className="flex-1 min-w-0 min-h-0">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
