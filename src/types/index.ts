export interface Product {
  id: string
  sku: string | null
  nombre: string
  categoria_id: string | null
  precio_base: number
  activo: boolean
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
  modelo?: ModeloCelular
  stock?: number
}

export interface CartItem {
  variant: ProductVariant
  cantidad: number
  precio_unitario: number
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
}

export type MetodoPago = 'efectivo' | 'tarjeta' | 'yape' | 'plin'
