import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Venta from './pages/Venta'
import Caja from './pages/Caja'
import Inventario from './pages/Inventario'
import Reportes from './pages/Reportes'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Venta />} />
          <Route path="caja" element={<Caja />} />
          <Route path="inventario" element={<Inventario />} />
          <Route path="reportes" element={<Reportes />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
