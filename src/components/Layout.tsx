import { useState, useEffect } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { ShoppingCart, Wallet, Package, BarChart3, Smartphone, Menu, X, Wrench, Users, UserCog, ChevronsLeft, ChevronsRight, ChevronDown, ChevronRight, LogOut, WifiOff, Settings, Clock3, LayoutDashboard, ShieldCheck, CalendarOff, CalendarClock, Ban, RotateCcw, FileMinus2, KeyRound, CalendarCheck2, ShoppingBasket, Building2, ArrowRightLeft, ClipboardCheck, Barcode, BadgePercent, Bell, ClipboardList, MessageCircle, Database, PlugZap, Activity } from 'lucide-react'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import { useOnlineStatus, contarVentasPendientes } from '../lib/offline'
import { sincronizarVentasCoordinadas } from '../lib/offlineAdvanced'

type SucursalAcceso={location_id:string;nombre:string;direccion:string|null;activa:boolean}
type NavItem={to:string;label:string;icon:React.ComponentType<{size?:number;className?:string}>}
type NavSection={id:string;label:string;icon:React.ComponentType<{size?:number;className?:string}>;items:NavItem[]}

const baseNavItems:NavItem[] = [
  { to: '/jornada', label: 'Mi jornada', icon: Clock3 },
  { to: '/mis-solicitudes', label: 'Mis solicitudes', icon: ClipboardList },
  { to: '/', label: 'Venta', icon: ShoppingCart },
  { to: '/caja', label: 'Caja', icon: Wallet },
  { to: '/inventario', label: 'Inventario', icon: Package },
  { to: '/seriales', label: 'IMEI / Seriales', icon: Barcode },
  { to: '/ordenes', label: 'Órdenes', icon: Wrench },
  { to: '/clientes', label: 'Clientes', icon: Users },
  { to: '/autorizaciones', label: 'Autorizaciones', icon: KeyRound },
  { to: '/notificaciones', label: 'Notificaciones', icon: Bell },
  { to: '/seguridad', label: 'Seguridad', icon: ShieldCheck },
]

export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => { const stored=localStorage.getItem('lukatcell_sidebar_collapsed'); return stored!==null?stored==='1':window.innerWidth<1024 })
  const [openSections,setOpenSections]=useState<Record<string,boolean>>(()=>{
    try { return JSON.parse(localStorage.getItem('lukatcell_sidebar_sections')||'{}') } catch { return {} }
  })
  const location=useLocation()
  const { staff, isAdmin, cashSessionId, jornadaActiva, signOut } = useAuth()
  const { online } = useOnlineStatus()
  const [pendientes,setPendientes]=useState(0), [fallidas,setFallidas]=useState(0), [agotadas,setAgotadas]=useState(0), [reintentandoManual,setReintentandoManual]=useState(false)
  const [sucursales,setSucursales]=useState<SucursalAcceso[]>([])
  const puedeInventarioAvanzado=isAdmin||['tecnico','encargado','jefa'].includes(staff?.puesto||'')

  const operacional:NavItem[]=[...baseNavItems,...(puedeInventarioAvanzado?[
    {to:'/taller',label:'Taller',icon:Wrench},
    {to:'/compras',label:'Compras',icon:ShoppingBasket},
    {to:'/transferencias',label:'Transferencias',icon:ArrowRightLeft},
    {to:'/conteo-inventario',label:'Conteo físico',icon:ClipboardCheck}
  ]:[])]

  const adminSections:NavSection[]=[
    {id:'operacion',label:'Operación diaria',icon:ShoppingCart,items:operacional},
    {id:'clientes',label:'Clientes y ventas',icon:Users,items:[
      {to:'/crm',label:'CRM',icon:Users},{to:'/whatsapp',label:'WhatsApp',icon:MessageCircle},{to:'/promociones',label:'Promociones',icon:BadgePercent},
      {to:'/anulaciones',label:'Anulaciones',icon:Ban},{to:'/devoluciones',label:'Devoluciones',icon:RotateCcw},{to:'/notas-credito',label:'Notas de crédito',icon:FileMinus2},
    ]},
    {id:'inventario',label:'Inventario y compras',icon:Package,items:[
      {to:'/valorizacion-inventario',label:'Valorización',icon:Package},{to:'/proveedores',label:'Proveedores',icon:Building2},
      {to:'/comparador-proveedores',label:'Comparador proveedores',icon:BarChart3},{to:'/cuentas-por-pagar',label:'Cuentas por pagar',icon:ShoppingBasket},
    ]},
    {id:'finanzas',label:'Caja y finanzas',icon:Wallet,items:[
      {to:'/conciliacion-pagos',label:'Conciliación',icon:Wallet},{to:'/cierre-diario',label:'Cierre diario',icon:CalendarCheck2},
      {to:'/reportes',label:'Reportes',icon:BarChart3},{to:'/reportes-avanzados',label:'Reportes avanzados',icon:BarChart3},
    ]},
    {id:'personal',label:'Personal',icon:UserCog,items:[
      {to:'/personal',label:'Personal',icon:UserCog},{to:'/solicitudes-personal',label:'Solicitudes',icon:ClipboardList},
      {to:'/permisos',label:'Permisos',icon:CalendarOff},{to:'/cambios-turno',label:'Cambios de turno',icon:CalendarClock},
    ]},
    {id:'administracion',label:'Administración',icon:Settings,items:[
      {to:'/dashboard',label:'Dashboard',icon:LayoutDashboard},{to:'/sucursales',label:'Sucursales',icon:Building2},
      {to:'/auditoria',label:'Auditoría',icon:ShieldCheck},{to:'/configuracion',label:'Configuración',icon:Settings},
    ]},
    {id:'sistema',label:'Sistema y dispositivos',icon:Activity,items:[
      {to:'/offline',label:'Offline y backup',icon:Database},{to:'/hardware',label:'Hardware POS',icon:PlugZap},{to:'/estado-sistema',label:'Estado del sistema',icon:Activity},
    ]},
  ]

  const staffSections:NavSection[]=[
    {id:'operacion',label:'Operación',icon:ShoppingCart,items:operacional.filter(i=>['/','/caja','/inventario','/seriales','/ordenes','/clientes','/taller','/compras','/transferencias','/conteo-inventario'].includes(i.to))},
    {id:'personal',label:'Mi cuenta',icon:UserCog,items:operacional.filter(i=>['/jornada','/mis-solicitudes','/notificaciones','/seguridad','/autorizaciones'].includes(i.to))},
  ]
  const sections=isAdmin?adminSections:staffSections

  useEffect(()=>{localStorage.setItem('lukatcell_sidebar_collapsed',collapsed?'1':'0')},[collapsed])
  useEffect(()=>{localStorage.setItem('lukatcell_sidebar_sections',JSON.stringify(openSections))},[openSections])
  useEffect(()=>{
    const active=sections.find(s=>s.items.some(i=>i.to==='/'?location.pathname==='/':location.pathname.startsWith(i.to)))
    if(active&&!openSections[active.id])setOpenSections(prev=>({...prev,[active.id]:true}))
  },[location.pathname,isAdmin,puedeInventarioAvanzado])
  useEffect(()=>{supabase.rpc('mis_sucursales').then(({data})=>setSucursales((data as SucursalAcceso[])||[]))},[staff?.id])
  const cambiarSucursal=async(locationId:string)=>{if(!locationId||locationId===staff?.location_id)return;const {error}=await supabase.rpc('cambiar_sucursal_activa',{p_location_id:locationId});if(!error)window.location.reload()}
  const actualizar=()=>contarVentasPendientes().then(v=>{setPendientes(v.pendientes);setFallidas(v.fallidas);setAgotadas(v.agotadas)})
  useEffect(()=>{actualizar()},[])
  useEffect(()=>{if(!online)return;sincronizarVentasCoordinadas().then(actualizar);const i=setInterval(()=>sincronizarVentasCoordinadas().then(actualizar),45000);return()=>clearInterval(i)},[online])
  const reintentar=()=>{setReintentandoManual(true);sincronizarVentasCoordinadas(true).then(()=>{actualizar();setReintentandoManual(false)})}
  const EstadoBadge=({compact}:{compact?:boolean})=><div className="flex items-center gap-2 flex-wrap"><span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold ${jornadaActiva?'text-green-400':'text-gray-500'}`}><span className={`w-1.5 h-1.5 rounded-full ${jornadaActiva?'bg-green-400':'bg-gray-500'}`}/>{compact?(jornadaActiva?'En jornada':'Fuera de jornada'):(jornadaActiva?'Jornada activa':'Sin jornada activa')}</span>{!compact&&<span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold ${cashSessionId?'text-cyan-400':'text-gray-600'}`}><span className={`w-1.5 h-1.5 rounded-full ${cashSessionId?'bg-cyan-400':'bg-gray-600'}`}/>{cashSessionId?'Caja abierta':'Caja cerrada'}</span>}</div>
  const SelectorSucursal=({mobile=false}:{mobile?:boolean})=>sucursales.length>1?<div className={mobile?'px-4 py-2':'px-3 py-2 border-b border-[#30363d]'}><p className="text-[9px] uppercase tracking-wider text-gray-600 mb-1">Sucursal activa</p><select value={staff?.location_id||''} onChange={e=>cambiarSucursal(e.target.value)} className="w-full rounded-lg border border-[#30363d] bg-[#0d1117] px-2 py-1.5 text-[11px] text-gray-300">{sucursales.map(s=><option key={s.location_id} value={s.location_id}>{s.nombre}</option>)}</select></div>:null
  const roleClass=isAdmin?'role-administrador':`role-${staff?.puesto||'sin-puesto'}`
  const toggleSection=(id:string)=>setOpenSections(prev=>({...prev,[id]:!prev[id]}))
  const link=(item:NavItem,mobile=false,indented=false)=>{const Icon=item.icon;return <NavLink key={item.to} to={item.to} end={item.to==='/'} onClick={()=>mobile&&setMenuOpen(false)} title={!mobile&&collapsed?item.label:undefined} className={({isActive})=>`flex items-center gap-3 rounded-lg transition-all ${mobile?'px-4 py-2.5 mb-1':`py-2.5 mx-2 mb-0.5 ${collapsed?'justify-center px-0':'px-4'}`} ${indented&&!collapsed&&!mobile?'ml-5':''} ${isActive?'bg-cyan-500/15 text-cyan-400 font-semibold border border-cyan-500/30':'text-gray-500 hover:bg-[#161b22] hover:text-gray-300 border border-transparent'}`}><Icon size={18}/>{(mobile||!collapsed)&&<span className="text-sm">{item.label}</span>}</NavLink>}
  const links=(mobile=false)=>{
    if(!mobile&&collapsed)return sections.flatMap(s=>s.items).map(i=>link(i,false,false))
    return sections.map(section=>{
      const SectionIcon=section.icon
      const open=openSections[section.id]??section.id==='operacion'
      const hasActive=section.items.some(i=>i.to==='/'?location.pathname==='/':location.pathname.startsWith(i.to))
      return <div key={section.id} className="mb-1">
        <button onClick={()=>toggleSection(section.id)} className={`w-full flex items-center justify-between rounded-lg transition-all ${mobile?'px-4 py-3':'px-4 py-2.5 mx-2 w-[calc(100%-1rem)]'} ${hasActive?'text-gray-200':'text-gray-500 hover:text-gray-300 hover:bg-[#161b22]'}`}>
          <span className="flex items-center gap-3"><SectionIcon size={17}/><span className="text-xs font-semibold uppercase tracking-wide">{section.label}</span></span>
          {open?<ChevronDown size={15}/>:<ChevronRight size={15}/>} 
        </button>
        {open&&<div className={`${mobile?'pl-2':'pl-1'} mt-1 border-l border-[#21262d] ${mobile?'ml-5':'ml-4'}`}>{section.items.map(i=>link(i,mobile,true))}</div>}
      </div>
    })
  }
  return <div className={`flex h-screen bg-[#0d1117] ${roleClass}`}>
    <div className="md:hidden fixed top-0 left-0 right-0 z-40 bg-[#010409] border-b border-[#30363d] flex items-center justify-between px-4 pb-3" style={{paddingTop:'calc(0.75rem + env(safe-area-inset-top))'}}><div className="flex items-center gap-2"><div className="w-7 h-7 rounded-lg bg-gradient-to-br from-cyan-400 to-cyan-600 flex items-center justify-center"><Smartphone size={14} className="text-black"/></div><div><span className="font-display font-bold text-sm text-white block leading-none">LUKATCELL</span><EstadoBadge compact/></div></div><div className="flex items-center gap-3">{!online&&<WifiOff size={16} className="text-orange-400"/>}<button onClick={()=>setMenuOpen(!menuOpen)} className="text-gray-400">{menuOpen?<X size={22}/>:<Menu size={22}/>}</button></div></div>
    {menuOpen&&<div className="md:hidden fixed inset-0 z-30 bg-black/60" onClick={()=>setMenuOpen(false)}><nav className="absolute mobile-header-offset left-0 right-0 bg-[#010409] border-b border-[#30363d] p-3 max-h-[85vh] overflow-y-auto" onClick={e=>e.stopPropagation()}><SelectorSucursal mobile/>{links(true)}<button onClick={()=>{setMenuOpen(false);signOut()}} className="w-full flex items-center gap-3 px-4 py-3 mt-2 border-t border-[#30363d] text-gray-500 hover:text-red-400"><LogOut size={18}/>Cerrar sesión</button></nav></div>}
    <aside className={`hidden md:flex flex-col shrink-0 border-r border-[#30363d] bg-[#010409] transition-all ${collapsed?'w-16':'w-60'}`}><div className={`flex items-center gap-2 py-4 border-b border-[#30363d] ${collapsed?'justify-center px-2':'px-4'}`}><div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-400 to-cyan-600 flex items-center justify-center"><Smartphone size={16} className="text-black"/></div>{!collapsed&&<div><p className="font-display font-bold text-sm text-white">LUKATCELL</p><p className="text-[10px] text-cyan-500 uppercase tracking-widest">Punto de venta</p></div>}</div>{!collapsed&&<><SelectorSucursal/><div className="px-4 py-2 border-b border-[#30363d]"><EstadoBadge/></div></>}<nav className="flex-1 py-3 overflow-y-auto">{links()}</nav><div className="border-t border-[#30363d] p-2">{!collapsed&&staff&&<div className="px-2 py-2"><p className="text-xs font-semibold text-white truncate">{staff.nombre}</p><p className="text-[10px] text-gray-500 capitalize">{staff.puesto||staff.rol}</p></div>}<button onClick={signOut} className={`w-full flex items-center gap-3 py-2 rounded-lg text-gray-500 hover:text-red-400 ${collapsed?'justify-center':'px-2'}`}><LogOut size={16}/>{!collapsed&&<span className="text-xs">Cerrar sesión</span>}</button><button onClick={()=>setCollapsed(!collapsed)} className={`w-full flex items-center gap-3 py-2 rounded-lg text-gray-500 hover:text-white ${collapsed?'justify-center':'px-2'}`}>{collapsed?<ChevronsRight size={16}/>:<ChevronsLeft size={16}/>} {!collapsed&&<span className="text-xs">Colapsar</span>}</button></div></aside>
    <main className="flex-1 min-w-0 overflow-y-auto mobile-header-pad flex flex-col">{!online&&<div className="bg-orange-500/15 border-b border-orange-500/30 text-orange-400 text-xs font-semibold px-4 py-2"><WifiOff size={13} className="inline mr-2"/>OFFLINE — ventas guardadas para sincronización {pendientes>0&&`(${pendientes})`}</div>}{online&&pendientes>0&&<div className="bg-cyan-500/15 border-b border-cyan-500/30 text-cyan-400 text-xs font-semibold px-4 py-2">Sincronizando {pendientes} venta(s)...</div>}{online&&fallidas>0&&pendientes===0&&<div className="bg-red-500/15 border-b border-red-500/30 text-red-400 text-xs font-semibold px-4 py-2">{fallidas} venta(s) con error de sincronización</div>}{online&&agotadas>0&&<div className="bg-red-500/15 border-b border-red-500/30 text-red-400 text-xs font-semibold px-4 py-2 flex justify-between"><span>{agotadas} venta(s) requieren atención</span><button onClick={reintentar} disabled={reintentandoManual} className="underline">{reintentandoManual?'Reintentando...':'Reintentar'}</button></div>}<div className="flex-1 min-w-0 min-h-0"><Outlet/></div></main>
  </div>
}
