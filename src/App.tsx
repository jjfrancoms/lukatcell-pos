import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { AuthProvider, useAuth } from './lib/auth'
import { ToastProvider } from './lib/toast'
import { ConfigProvider } from './lib/config'
import Layout from './components/Layout'
import MFAGate from './components/MFAGate'
import Login from './pages/Login'
import Venta from './pages/Venta'
import Caja from './pages/Caja'
import Inventario from './pages/Inventario'
import Reportes from './pages/Reportes'
import ReportesAvanzados from './pages/ReportesAvanzados'
import OrdenesServicio from './pages/OrdenesServicio'
import Taller from './pages/Taller'
import Clientes from './pages/Clientes'
import CRM from './pages/CRM'
import Notificaciones from './pages/Notificaciones'
import Personal from './pages/Personal'
import PermisosPersonal from './pages/PermisosPersonal'
import CambiosTurno from './pages/CambiosTurno'
import MisSolicitudes from './pages/MisSolicitudes'
import SolicitudesPersonalAdmin from './pages/SolicitudesPersonalAdmin'
import WhatsAppAdmin from './pages/WhatsAppAdmin'
import OfflineAdmin from './pages/OfflineAdmin'
import HardwareAdmin from './pages/HardwareAdmin'
import MiJornada from './pages/MiJornada'
import DashboardAdmin from './pages/DashboardAdmin'
import Anulaciones from './pages/Anulaciones'
import Devoluciones from './pages/Devoluciones'
import NotasCredito from './pages/NotasCredito'
import Autorizaciones from './pages/Autorizaciones'
import CierreDiario from './pages/CierreDiario'
import Proveedores from './pages/Proveedores'
import Compras from './pages/Compras'
import Transferencias from './pages/Transferencias'
import ConteoInventario from './pages/ConteoInventario'
import Seriales from './pages/Seriales'
import ValorizacionInventario from './pages/ValorizacionInventario'
import CuentasPorPagar from './pages/CuentasPorPagar'
import ConciliacionPagos from './pages/ConciliacionPagos'
import ComparadorProveedores from './pages/ComparadorProveedores'
import Sucursales from './pages/Sucursales'
import Promociones from './pages/Promociones'
import SeguridadMFA from './pages/SeguridadMFA'
import Auditoria from './pages/Auditoria'
import Configuracion from './pages/Configuracion'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { session, staff, loading } = useAuth()
  if (loading) return <div className="h-screen flex items-center justify-center bg-[#0d1117]"><Loader2 className="animate-spin text-cyan-500" size={28} /></div>
  if (!session || !staff) return <Navigate to="/login" replace />
  return <MFAGate>{children}</MFAGate>
}
function AdminRoute({ children }: { children: React.ReactNode }) { const { isAdmin } = useAuth(); return isAdmin ? <>{children}</> : <Navigate to="/" replace /> }
function JornadaRoute({ children }: { children: React.ReactNode }) { const { jornadaActiva } = useAuth(); return jornadaActiva ? <>{children}</> : <Navigate to="/jornada" replace /> }
function OperationalRoute({ children }: { children: React.ReactNode }) { const { jornadaActiva, isAdmin } = useAuth(); return (isAdmin || jornadaActiva) ? <>{children}</> : <Navigate to="/jornada" replace /> }
function InventoryOpsRoute({ children }: { children: React.ReactNode }) { const { jornadaActiva,isAdmin,staff }=useAuth(); const habilitado=isAdmin||['tecnico','encargado','jefa'].includes(staff?.puesto||''); if(!habilitado)return <Navigate to="/" replace/>; if(!isAdmin&&!jornadaActiva)return <Navigate to="/jornada" replace/>; return <>{children}</> }
function VentaRoute() { const { jornadaActiva, cashSessionId } = useAuth(); if (!jornadaActiva) return <Navigate to="/jornada" replace />; if (!cashSessionId) return <Navigate to="/caja" replace />; return <Venta /> }

export default function App() {
  return <AuthProvider><ConfigProvider><ToastProvider><BrowserRouter><Routes>
    <Route path="/login" element={<Login />} />
    <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
      <Route index element={<VentaRoute />} />
      <Route path="jornada" element={<MiJornada />} />
      <Route path="mis-solicitudes" element={<MisSolicitudes />} />
      <Route path="seguridad" element={<SeguridadMFA />} />
      <Route path="notificaciones" element={<Notificaciones />} />
      <Route path="caja" element={<JornadaRoute><Caja /></JornadaRoute>} />
      <Route path="inventario" element={<OperationalRoute><Inventario /></OperationalRoute>} />
      <Route path="ordenes" element={<OperationalRoute><OrdenesServicio /></OperationalRoute>} />
      <Route path="taller" element={<InventoryOpsRoute><Taller /></InventoryOpsRoute>} />
      <Route path="clientes" element={<OperationalRoute><Clientes /></OperationalRoute>} />
      <Route path="seriales" element={<OperationalRoute><Seriales /></OperationalRoute>} />
      <Route path="autorizaciones" element={<Autorizaciones />} />
      <Route path="compras" element={<InventoryOpsRoute><Compras /></InventoryOpsRoute>} />
      <Route path="transferencias" element={<InventoryOpsRoute><Transferencias /></InventoryOpsRoute>} />
      <Route path="conteo-inventario" element={<InventoryOpsRoute><ConteoInventario /></InventoryOpsRoute>} />
      <Route path="dashboard" element={<AdminRoute><DashboardAdmin /></AdminRoute>} />
      <Route path="crm" element={<AdminRoute><CRM /></AdminRoute>} />
      <Route path="whatsapp" element={<AdminRoute><WhatsAppAdmin /></AdminRoute>} />
      <Route path="solicitudes-personal" element={<AdminRoute><SolicitudesPersonalAdmin /></AdminRoute>} />
      <Route path="offline" element={<AdminRoute><OfflineAdmin /></AdminRoute>} />
      <Route path="hardware" element={<AdminRoute><HardwareAdmin /></AdminRoute>} />
      <Route path="reportes" element={<AdminRoute><Reportes /></AdminRoute>} />
      <Route path="reportes-avanzados" element={<AdminRoute><ReportesAvanzados /></AdminRoute>} />
      <Route path="promociones" element={<AdminRoute><Promociones /></AdminRoute>} />
      <Route path="sucursales" element={<AdminRoute><Sucursales /></AdminRoute>} />
      <Route path="anulaciones" element={<AdminRoute><Anulaciones /></AdminRoute>} />
      <Route path="devoluciones" element={<AdminRoute><Devoluciones /></AdminRoute>} />
      <Route path="notas-credito" element={<AdminRoute><NotasCredito /></AdminRoute>} />
      <Route path="cierre-diario" element={<AdminRoute><CierreDiario /></AdminRoute>} />
      <Route path="conciliacion-pagos" element={<AdminRoute><ConciliacionPagos /></AdminRoute>} />
      <Route path="cuentas-por-pagar" element={<AdminRoute><CuentasPorPagar /></AdminRoute>} />
      <Route path="valorizacion-inventario" element={<AdminRoute><ValorizacionInventario /></AdminRoute>} />
      <Route path="comparador-proveedores" element={<AdminRoute><ComparadorProveedores /></AdminRoute>} />
      <Route path="proveedores" element={<AdminRoute><Proveedores /></AdminRoute>} />
      <Route path="personal" element={<AdminRoute><Personal /></AdminRoute>} />
      <Route path="permisos" element={<AdminRoute><PermisosPersonal /></AdminRoute>} />
      <Route path="cambios-turno" element={<AdminRoute><CambiosTurno /></AdminRoute>} />
      <Route path="auditoria" element={<AdminRoute><Auditoria /></AdminRoute>} />
      <Route path="configuracion" element={<AdminRoute><Configuracion /></AdminRoute>} />
    </Route>
  </Routes></BrowserRouter></ToastProvider></ConfigProvider></AuthProvider>
}
