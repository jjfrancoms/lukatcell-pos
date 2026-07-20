import { NavLink, Outlet } from 'react-router-dom'
import { ShoppingCart, Wallet, Package, BarChart3, Smartphone } from 'lucide-react'

const navItems = [
  { to: '/', label: 'Venta', icon: ShoppingCart },
  { to: '/caja', label: 'Caja', icon: Wallet },
  { to: '/inventario', label: 'Inventario', icon: Package },
  { to: '/reportes', label: 'Reportes', icon: BarChart3 },
]

export default function Layout() {
  return (
    <div className="flex h-screen bg-[#0d1117]">
      <aside className="w-16 md:w-52 bg-[#010409] flex flex-col shrink-0 border-r border-[#30363d]">
        <div className="flex items-center gap-2 px-3 md:px-4 py-4 border-b border-[#30363d]">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-400 to-cyan-600 flex items-center justify-center shrink-0 shadow-lg shadow-cyan-500/20">
            <Smartphone size={16} className="text-black" />
          </div>
          <div className="hidden md:block leading-tight">
            <p className="font-display font-bold text-sm text-white tracking-wide">LUKATCELL</p>
            <p className="text-[10px] text-cyan-500 uppercase tracking-widest">Punto de venta</p>
          </div>
        </div>
        <nav className="flex-1 py-3">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 md:px-4 py-2.5 mx-2 rounded-lg mb-0.5 transition-all ${
                  isActive
                    ? 'bg-cyan-500/15 text-cyan-400 font-semibold border border-cyan-500/30'
                    : 'text-gray-500 hover:bg-[#161b22] hover:text-gray-300 border border-transparent'
                }`}>
              <Icon size={18} />
              <span className="hidden md:inline text-sm">{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="hidden md:block px-4 py-3 border-t border-[#30363d]">
          <p className="text-[10px] text-gray-600">v1.0 · SJL, Lima</p>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  )
}
