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
    <div className="flex h-screen bg-ink-100">
      <aside className="w-20 md:w-56 bg-ink-900 text-white flex flex-col shrink-0">
        <div className="flex items-center gap-2 px-3 md:px-5 py-5 border-b border-white/10">
          <div className="w-9 h-9 rounded-full bg-cyan-500 flex items-center justify-center shrink-0">
            <Smartphone size={18} className="text-ink-900" />
          </div>
          <div className="hidden md:block leading-tight">
            <p className="font-display font-bold text-sm tracking-wide">LUKATCELL</p>
            <p className="text-[10px] text-cyan-500 uppercase tracking-wider">Punto de venta</p>
          </div>
        </div>
        <nav className="flex-1 py-4">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 md:px-5 py-3 mx-2 rounded-lg mb-1 transition-colors ${
                  isActive
                    ? 'bg-cyan-500 text-ink-900 font-semibold'
                    : 'text-white/70 hover:bg-white/10 hover:text-white'
                }`
              }
            >
              <Icon size={20} />
              <span className="hidden md:inline text-sm">{label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  )
}
