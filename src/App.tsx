import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { AuthProvider, useAuth } from './lib/auth'
import { ToastProvider } from './lib/toast'
import { ConfigProvider } from './lib/config'
import Layout from './components/Layout'
import Login from './pages/Login'
import Venta from './pages/Venta'
import Caja from './pages/Caja'
import Inventario from './pages/Inventario'
import Reportes from './pages/Reportes'
import OrdenesServicio from './pages/OrdenesServicio'
import Clientes from './pages/Clientes'
import Personal from './pages/Personal'
import MiJornada from './pages/MiJornada'
import DashboardAdmin from './pages/DashboardAdmin'
import Configuracion from './pages/Configuracion'

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

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { isAdmin } = useAuth()
  if (!isAdmin) return <Navigate to="/" replace />
  return <>{children}</>
}

function JornadaRoute({ children }: { children: React.ReactNode }) {
  const { jornadaActiva } = useAuth()
  if (!jornadaActiva) return <Navigate to="/jornada" replace />
  return <>{children}</>
}

function OperationalRoute({ children }: { children: React.ReactNode }) {
  const { jornadaActiva, isAdmin } = useAuth()
  if (!isAdmin && !jornadaActiva) return <Navigate to="/jornada" replace />
  return <>{children}</>
}

function VentaRoute() {
  const { jornadaActiva, cashSessionId } = useAuth()
  if (!jornadaActiva) return <Navigate to="/jornada" replace />
  if (!cashSessionId) return <Navigate to="/caja" replace />
  return <Venta />
}

export default function App() {
  return (
    <AuthProvider>
      <ConfigProvider>
        <ToastProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
                <Route index element={<VentaRoute />} />
                <Route path="jornada" element={<MiJornada />} />
                <Route path="caja" element={<JornadaRoute><Caja /></JornadaRoute>} />
                <Route path="inventario" element={<OperationalRoute><Inventario /></OperationalRoute>} />
                <Route path="ordenes" element={<OperationalRoute><OrdenesServicio /></OperationalRoute>} />
                <Route path="clientes" element={<OperationalRoute><Clientes /></OperationalRoute>} />
                <Route path="dashboard" element={<AdminRoute><DashboardAdmin /></AdminRoute>} />
                <Route path="reportes" element={<AdminRoute><Reportes /></AdminRoute>} />
                <Route path="personal" element={<AdminRoute><Personal /></AdminRoute>} />
                <Route path="configuracion" element={<AdminRoute><Configuracion /></AdminRoute>} />
              </Route>
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </ConfigProvider>
    </AuthProvider>
  )
}
