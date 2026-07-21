import { useState, useEffect } from 'react'
import { Plus, X, Search, Phone, Mail, ShoppingBag, User } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { Cliente } from '../types'

interface CompraHistorial { id: string; fecha: string; total: number }

export default function Clientes() {
  const [clientes, setClientes] = useState<Cliente[]>([])
  const [busqueda, setBusqueda] = useState('')
  const [nuevoOpen, setNuevoOpen] = useState(false)
  const [detalle, setDetalle] = useState<Cliente | null>(null)
  const [loading, setLoading] = useState(true)

  const cargar = async () => {
    const { data } = await supabase.from('clientes').select('*').order('nombre')
    setClientes(data || [])
    setLoading(false)
  }
  useEffect(() => { cargar() }, [])

  const filtrados = clientes.filter((c) => `${c.nombre} ${c.telefono || ''} ${c.email || ''}`.toLowerCase().includes(busqueda.toLowerCase()))

  return (
    <div className="p-3 md:p-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <h1 className="font-display font-bold text-xl text-white">Clientes frecuentes</h1>
        <button onClick={() => setNuevoOpen(true)}
          className="flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-bold px-4 py-2.5 rounded-xl hover:shadow-lg hover:shadow-cyan-500/30 transition-all text-sm">
          <Plus size={16} /> Nuevo cliente
        </button>
      </div>

      <div className="relative mb-4">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" size={16} />
        <input value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="Buscar por nombre, teléfono o correo..."
          className="w-full pl-10 pr-3 py-2.5 rounded-xl bg-[#161b22] border border-[#30363d] text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {loading && <p className="text-gray-500 text-sm col-span-full py-10 text-center">Cargando...</p>}
        {!loading && filtrados.map((c) => (
          <button key={c.id} onClick={() => setDetalle(c)}
            className="text-left bg-[#161b22] rounded-2xl border border-[#30363d] p-4 hover:border-cyan-500/50 transition-all">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-cyan-500/15 flex items-center justify-center shrink-0"><User size={18} className="text-cyan-400" /></div>
              <div className="min-w-0">
                <p className="font-semibold text-white text-sm truncate">{c.nombre}</p>
                {c.telefono && <p className="text-xs text-gray-500 flex items-center gap-1"><Phone size={11} /> {c.telefono}</p>}
              </div>
            </div>
          </button>
        ))}
        {!loading && filtrados.length === 0 && (
          <div className="col-span-full py-16 text-center text-gray-500">
            <User size={32} className="mx-auto mb-2 text-gray-600" />
            <p className="text-sm">Sin clientes registrados</p>
          </div>
        )}
      </div>

      {nuevoOpen && <ModalCliente onClose={() => setNuevoOpen(false)} onSaved={() => { setNuevoOpen(false); cargar() }} />}
      {detalle && <ModalDetalleCliente cliente={detalle} onClose={() => setDetalle(null)} onSaved={() => { setDetalle(null); cargar() }} />}
    </div>
  )
}

function ModalCliente({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [nombre, setNombre] = useState('')
  const [telefono, setTelefono] = useState('')
  const [email, setEmail] = useState('')
  const [notas, setNotas] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')

  const guardar = async () => {
    if (!nombre.trim()) { setError('El nombre es obligatorio'); return }
    setGuardando(true); setError('')
    const { error: err } = await supabase.from('clientes').insert({ nombre: nombre.trim(), telefono: telefono.trim() || null, email: email.trim() || null, notas: notas.trim() || null })
    setGuardando(false)
    if (err) { setError(err.message); return }
    onSaved()
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end md:items-center justify-center z-50 p-0 md:p-4">
      <div className="bg-[#161b22] rounded-t-2xl md:rounded-2xl w-full max-w-sm p-5 border border-[#30363d] shadow-2xl relative">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-500 hover:text-white"><X size={20} /></button>
        <h3 className="font-display font-bold text-lg text-white mb-4">Nuevo cliente</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500 font-semibold">Nombre *</label>
            <input autoFocus value={nombre} onChange={(e) => setNombre(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
          <div>
            <label className="text-xs text-gray-500 font-semibold">Teléfono</label>
            <input value={telefono} onChange={(e) => setTelefono(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
          <div>
            <label className="text-xs text-gray-500 font-semibold">Correo</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
          <div>
            <label className="text-xs text-gray-500 font-semibold">Notas</label>
            <textarea value={notas} onChange={(e) => setNotas(e.target.value)} rows={2}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-none" />
          </div>
          {error && <p className="text-red-400 text-xs bg-red-500/10 rounded-lg p-2">{error}</p>}
          <button onClick={guardar} disabled={guardando}
            className="w-full bg-gradient-to-r from-cyan-500 to-cyan-600 disabled:opacity-40 text-black font-bold py-3 rounded-xl transition-all active:scale-[0.98] mt-1">
            {guardando ? 'Guardando...' : 'Guardar cliente'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ModalDetalleCliente({ cliente, onClose, onSaved }: { cliente: Cliente; onClose: () => void; onSaved: () => void }) {
  const [notas, setNotas] = useState(cliente.notas || '')
  const [historial, setHistorial] = useState<CompraHistorial[]>([])
  const [guardando, setGuardando] = useState(false)

  useEffect(() => {
    supabase.from('sales').select('id, fecha, total').eq('cliente_id', cliente.id).order('fecha', { ascending: false }).limit(15)
      .then(({ data }) => setHistorial(data || []))
  }, [cliente.id])

  const guardar = async () => {
    setGuardando(true)
    await supabase.from('clientes').update({ notas: notas.trim() || null }).eq('id', cliente.id)
    setGuardando(false)
    onSaved()
  }

  const totalGastado = historial.reduce((s, h) => s + Number(h.total), 0)

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end md:items-center justify-center z-50 p-0 md:p-4">
      <div className="bg-[#161b22] rounded-t-2xl md:rounded-2xl w-full max-w-md p-5 border border-[#30363d] shadow-2xl relative max-h-[90vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-500 hover:text-white"><X size={20} /></button>
        <h3 className="font-display font-bold text-lg text-white mb-1">{cliente.nombre}</h3>
        <div className="flex flex-wrap gap-3 text-xs text-gray-500 mb-4">
          {cliente.telefono && <span className="flex items-center gap-1"><Phone size={12} /> {cliente.telefono}</span>}
          {cliente.email && <span className="flex items-center gap-1"><Mail size={12} /> {cliente.email}</span>}
        </div>
        <div className="grid grid-cols-2 gap-2 mb-4">
          <div className="bg-[#0d1117] rounded-xl p-3 border border-[#30363d]">
            <p className="text-[10px] text-gray-500 uppercase">Compras</p><p className="text-lg font-bold text-white">{historial.length}</p>
          </div>
          <div className="bg-[#0d1117] rounded-xl p-3 border border-[#30363d]">
            <p className="text-[10px] text-gray-500 uppercase">Total gastado</p><p className="text-lg font-bold text-cyan-400">S/ {totalGastado.toFixed(2)}</p>
          </div>
        </div>
        <div className="mb-4">
          <label className="text-xs text-gray-500 font-semibold">Notas</label>
          <textarea value={notas} onChange={(e) => setNotas(e.target.value)} rows={2}
            className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 mt-1 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-none" />
        </div>
        <p className="text-xs text-gray-500 font-semibold mb-2 flex items-center gap-1.5"><ShoppingBag size={13} /> Historial de compras</p>
        <div className="space-y-1.5 mb-4 max-h-48 overflow-y-auto">
          {historial.map((h) => (
            <div key={h.id} className="flex justify-between items-center bg-[#0d1117] rounded-lg px-3 py-2 border border-[#30363d]">
              <span className="text-xs text-gray-400">{new Date(h.fecha).toLocaleDateString('es-PE')}</span>
              <span className="text-sm font-semibold text-white">S/ {Number(h.total).toFixed(2)}</span>
            </div>
          ))}
          {historial.length === 0 && <p className="text-xs text-gray-500 text-center py-4">Sin compras registradas</p>}
        </div>
        <button onClick={guardar} disabled={guardando}
          className="w-full bg-gradient-to-r from-cyan-500 to-cyan-600 disabled:opacity-40 text-black font-bold py-3 rounded-xl transition-all active:scale-[0.98]">
          {guardando ? 'Guardando...' : 'Guardar notas'}
        </button>
      </div>
    </div>
  )
}
