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

export interface Staff {
  id: string
  user_id: string
  nombre: string
  rol: 'cajero' | 'administrador'
  location_id: string
  activo: boolean
  username: string
}

export type MetodoPago = 'efectivo' | 'tarjeta' | 'yape' | 'plin'

export interface PagoDetalle {
  metodo: MetodoPago
  monto: number
  referencia?: string
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

export interface OrdenServicio {
  id: string
  numero: number
  cliente_id: string | null
  cliente_nombre: string
  cliente_telefono: string | null
  equipo_marca: string | null
  equipo_modelo: string | null
  problema: string
  diagnostico: string | null
  estado: EstadoOrden
  costo_estimado: number | null
  costo_final: number | null
  fecha_recepcion: string
  fecha_entrega: string | null
  notas: string | null
  location_id: string | null
}
