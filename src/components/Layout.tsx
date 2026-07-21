import { useState, useEffect } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { ShoppingCart, Wallet, Package, BarChart3, Smartphone, Menu, X, Wrench, Users, UserCog, ChevronsLeft, ChevronsRight, LogOut, WifiOff } from 'lucide-react'
import { useAuth } from '../lib/auth'
import { useOnlineStatus, sincronizarVentasPendientes, contarVentasPendientes } from '../lib/offline'

const baseNavItems = [
  { to: '/', label: 'Venta', icon: ShoppingCart },
  { to: '/caja', label: 'Caja', icon: Wallet },
  { to: '/inventario', label: 'Inventario', icon: Package },
  { to: '/ordenes', label: 'Órdenes', icon: Wrench },
  { to: '/clientes', label: 'Clientes', icon: Users },
  { to: '/reportes', label: 'Reportes', icon: BarChart3 },
]

export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('lukatcell_sidebar_collapsed') === '1')
  const { staff, isAdmin, cashSessionId, signOut } = useAuth()
  const online = useOnlineStatus()
  const [pendientes, setPendientes] = useState(0)

  const navItems = isAdmin ? [...baseNavItems, { to: '/personal', label: 'Personal', icon: UserCog }] : baseNavItems

  useEffect(() => { localStorage.setItem('lukatcell_sidebar_collapsed', collapsed ? '1' : '0') }, [collapsed])

  useEffect(() => { contarVentasPendientes().then(setPendientes) }, [])

  useEffect(() => {
    if (!online) return
    sincronizarVentasPendientes().then(({ ok }) => {
      if (ok > 0) contarVentasPendientes().then(setPendientes)
    })
  }, [online])

  const TurnoBadge = ({ compact }: { compact?: boolean }) => (
    <span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold ${cashSessionId ? 'text-green-400' : 'text-gray-500'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cashSessionId ? 'bg-green-400' : 'bg-gray-500'}`} />
      {compact ? (cashSessionId ? 'Turno abierto' : 'Turno cerrado') : (cashSessionId ? 'Turno abierto' : 'Sin turno abierto')}
    </span>
  )

  return (
    <div className="flex h-screen bg-[#0d1117]">
      {/* Mobile header */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-40 bg-[#010409] border-b border-[#30363d] flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-cyan-400 to-cyan-600 flex items-center justify-center">
            <Smartphone size={14} className="text-black" />
          </div>
          <div>
            <span className="font-display font-bold text-sm text-white block leading-none">LUKATCELL</span>
            <TurnoBadge compact />
          </div>
        </div>
        <div className="flex items-center gap-3">
          {!online && <WifiOff size={16} className="text-orange-400" aria-label="Sin conexión" />}
          <button onClick={() => setMenuOpen(!menuOpen)} className="text-gray-400" aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'}>
            {menuOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </div>
      {/* Mobile menu overlay */}
      {menuOpen && (
        <div className="md:hidden fixed inset-0 z-30 bg-black/60" onClick={() => setMenuOpen(false)}>
          <nav className="absolute top-14 left-0 right-0 bg-[#010409] border-b border-[#30363d] p-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
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
      {/* Desktop sidebar */}
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
          <div className="px-4 py-2 border-b border-[#30363d]"><TurnoBadge /></div>
        )}
        <nav className="flex-1 py-3 overflow-y-auto">
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
              <p className="text-[10px] text-gray-500 capitalize">{staff.rol}</p>
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
      <main className="flex-1 overflow-y-auto pt-14 md:pt-0 flex flex-col">
        {!online && (
          <div className="bg-orange-500/15 border-b border-orange-500/30 text-orange-400 text-xs font-semibold px-4 py-2 flex items-center gap-2 shrink-0">
            <WifiOff size={13} /> Sin conexión — las ventas se guardarán y sincronizarán al reconectar
          </div>
        )}
        {online && pendientes > 0 && (
          <div className="bg-cyan-500/15 border-b border-cyan-500/30 text-cyan-400 text-xs font-semibold px-4 py-2 flex items-center gap-2 shrink-0">
            Sincronizando {pendientes} venta{pendientes === 1 ? '' : 's'} pendiente{pendientes === 1 ? '' : 's'}...
          </div>
        )}
        <div className="flex-1 min-h-0">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
