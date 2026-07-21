import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { ShoppingCart, Wallet, Package, BarChart3, Smartphone, Menu, X } from 'lucide-react'

const navItems = [
  { to: '/', label: 'Venta', icon: ShoppingCart },
  { to: '/caja', label: 'Caja', icon: Wallet },
  { to: '/inventario', label: 'Inventario', icon: Package },
  { to: '/reportes', label: 'Reportes', icon: BarChart3 },
]

export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <div className="flex h-screen bg-[#0d1117]">
      {/* Mobile header */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-40 bg-[#010409] border-b border-[#30363d] flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-cyan-400 to-cyan-600 flex items-center justify-center">
            <Smartphone size={14} className="text-black" />
          </div>
          <span className="font-display font-bold text-sm text-white">LUKATCELL</span>
        </div>
        <button onClick={() => setMenuOpen(!menuOpen)} className="text-gray-400">
          {menuOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>
      {/* Mobile menu overlay */}
      {menuOpen && (
        <div className="md:hidden fixed inset-0 z-30 bg-black/60" onClick={() => setMenuOpen(false)}>
          <nav className="absolute top-14 left-0 right-0 bg-[#010409] border-b border-[#30363d] p-3" onClick={(e) => e.stopPropagation()}>
            {navItems.map(({ to, label, icon: Icon }) => (
              <NavLink key={to} to={to} end={to === '/'} onClick={() => setMenuOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-4 py-3 rounded-lg mb-1 transition-all ${
                    isActive ? 'bg-cyan-500/15 text-cyan-400 font-semibold' : 'text-gray-400 hover:text-white'}`}>
                <Icon size={18} /><span className="text-sm">{label}</span>
              </NavLink>
            ))}
          </nav>
        </div>
      )}
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-52 bg-[#010409] flex-col shrink-0 border-r border-[#30363d]">
        <div className="flex items-center gap-2 px-4 py-4 border-b border-[#30363d]">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-400 to-cyan-600 flex items-center justify-center shrink-0 shadow-lg shadow-cyan-500/20">
            <Smartphone size={16} className="text-black" />
          </div>
          <div className="leading-tight">
            <p className="font-display font-bold text-sm text-white tracking-wide">LUKATCELL</p>
            <p className="text-[10px] text-cyan-500 uppercase tracking-widest">Punto de venta</p>
          </div>
        </div>
        <nav className="flex-1 py-3">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-2.5 mx-2 rounded-lg mb-0.5 transition-all ${
                  isActive ? 'bg-cyan-500/15 text-cyan-400 font-semibold border border-cyan-500/30' : 'text-gray-500 hover:bg-[#161b22] hover:text-gray-300 border border-transparent'}`}>
              <Icon size={18} /><span className="text-sm">{label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-y-auto pt-14 md:pt-0">
        <Outlet />
      </main>
    </div>
  )
}
