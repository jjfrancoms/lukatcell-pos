export interface Product {
  id: string
  sku: string | null
  nombre: string
  categoria_id: string | null
  precio_base: number
  activo: boolean
  imagen_url: string | null
  favorito: boolean
  costo: number
  control_serial?: boolean
}

export interface ModeloCelular {
  id: string
  marca: string
  modelo: string
}

export interface ProductVariant {
  id: string
  product_id: string
  color: string | null
  modelo_celular_id: string | null
  precio_override: number | null
  codigo_barras: string | null
  product?: Product
  modelo?: ModeloCelular | null
  stock?: number
}

export interface CartItem {
  variant: ProductVariant
  cantidad: number
  precio_unitario: number
  descuento: number
  serialIds?: string[]
}

export interface ReciboLineaItem {
  variant: { id: string; product?: { nombre?: string | null } | null }
  cantidad: number
  precio_unitario: number
  descuento: number
}

export interface CashSession {
  id: string
  cajero_id: string
  location_id: string
  apertura: string
  cierre: string | null
  monto_inicial: number
  monto_final_esperado: number | null
  monto_final_contado: number | null
  diferencia: number | null
}

export type StaffRol = 'cajero' | 'administrador'
export type StaffPuesto = 'jefa' | 'vendedor' | 'tecnico' | 'encargado'

export interface Staff {
  id: string
  user_id: string
  nombre: string
  rol: StaffRol
  puesto: StaffPuesto | null
  location_id: string
  activo: boolean
  username: string
}

export interface Turno {
  id: string
  nombre: string
  hora_inicio: string
  hora_fin: string
  cruza_medianoche: boolean
  tolerancia_minutos: number
  activo: boolean
  created_at?: string
  updated_at?: string
}

export interface StaffTurno {
  id: string
  staff_id: string
  turno_id: string
  dia_semana: number
  fecha_desde: string | null
  fecha_hasta: string | null
  activo: boolean
  created_at?: string
  turno?: Turno | null
}

export type EstadoAsistencia = 'pendiente' | 'presente' | 'tarde' | 'ausente' | 'justificado'

export interface Asistencia {
  id: string
  staff_id: string
  turno_id: string | null
  fecha: string
  entrada: string | null
  salida: string | null
  estado: EstadoAsistencia
  minutos_tarde: number
  observacion: string | null
  registrado_por: string | null
  created_at: string
  updated_at: string
}

export interface JornadaActual {
  asistencia_id: string | null
  fecha: string | null
  entrada: string | null
  salida: string | null
  estado: EstadoAsistencia | null
  minutos_tarde: number
  turno_id: string | null
  turno_nombre: string | null
  hora_inicio: string | null
  hora_fin: string | null
  tolerancia_minutos: number | null
}

export type MetodoPago = 'efectivo' | 'tarjeta' | 'yape' | 'plin'

export interface PagoDetalle {
  metodo: MetodoPago
  monto: number
  referencia?: string
  pagoDigitalId?: string
}

export interface Cliente {
  id: string
  nombre: string
  telefono: string | null
  email: string | null
  notas: string | null
  created_at: string
}

export type EstadoOrden = 'recibido' | 'diagnosticado' | 'en_reparacion' | 'listo' | 'entregado' | 'cancelado'
export type TamanoPapel = '58mm' | '80mm'

export interface Configuracion {
  id: number
  igv_activo: boolean
  igv_porcentaje: number
  negocio_nombre: string
  negocio_ruc: string | null
  negocio_direccion: string | null
  stock_minimo_default: number
  permitir_stock_negativo: boolean
  auto_imprimir_ticket: boolean
  tamano_papel: TamanoPapel
  nubefact_activo: boolean
  nubefact_serie_boleta: string
  nubefact_serie_factura: string
  culqi_activo: boolean
  updated_at: string
}

export type EstadoPagoDigital = 'pendiente' | 'pagado' | 'expirado' | 'fallido'

export interface PagoDigital {
  id: string
  culqi_order_id: string | null
  monto: number
  metodo: 'yape' | 'plin'
  estado: EstadoPagoDigital
  sale_id: string | null
  created_at: string
  updated_at: string
}

export interface Sale {
  id: string
  numero: number
  fecha: string
  subtotal: number
  impuesto: number
  total: number
  estado: string
}

export type TipoComprobante = 'boleta' | 'factura'
export type TipoDocumentoCliente = 'dni' | 'ruc' | null
export interface DatosComprobante {
  tipoComprobante: TipoComprobante
  clienteTipoDoc: TipoDocumentoCliente
  clienteNumDoc: string | null
  clienteDenominacion: string | null
  clienteDireccion: string | null
}
export type SyncEstado = 'PENDING' | 'SYNCING' | 'FAILED'
export interface OrdenServicio { id:string; numero:number; cliente_nombre:string; cliente_telefono:string|null; equipo_marca:string|null; equipo_modelo:string|null; estado:EstadoOrden; venta_id?:string|null }
export type EstadoComprobante = 'pendiente'|'emitido'|'error'
