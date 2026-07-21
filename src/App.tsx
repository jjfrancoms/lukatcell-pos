import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { AuthProvider, useAuth } from './lib/auth'
import Layout from './components/Layout'
import Login from './pages/Login'
import Venta from './pages/Venta'
import Caja from './pages/Caja'
import Inventario from './pages/Inventario'
import Reportes from './pages/Reportes'
import OrdenesServicio from './pages/OrdenesServicio'
import Clientes from './pages/Clientes'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { session, staff, loading } = useAuth()
  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#0d1117]">
        <Loader2 className="animate-spin text-cyan-500" size={28} />
      </div>
    )
  }
  if (!session || !staff) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
            <Route index element={<Venta />} />
            <Route path="caja" element={<Caja />} />
            <Route path="inventario" element={<Inventario />} />
            <Route path="ordenes" element={<OrdenesServicio />} />
            <Route path="clientes" element={<Clientes />} />
            <Route path="reportes" element={<Reportes />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
