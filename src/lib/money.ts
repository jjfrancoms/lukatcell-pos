// Aritmética de dinero: toda suma/resta/multiplicación se hace en centavos (enteros)
// para evitar el error de acumulación de floats (0.1 + 0.2 !== 0.3 en JS).
// Los valores en soles (float) solo existen en los bordes: al leer de/escribir a Supabase
// y al mostrarlos en pantalla.

export function aCentavos(soles: number): number {
  return Math.round(soles * 100)
}

export function aSoles(centavos: number): number {
  return centavos / 100
}

export function formatearSoles(soles: number): string {
  return `S/ ${soles.toFixed(2)}`
}

export function sumarMontos(montos: number[]): number {
  return aSoles(montos.reduce((s, m) => s + aCentavos(m), 0))
}

export function restarMontos(a: number, b: number): number {
  return aSoles(aCentavos(a) - aCentavos(b))
}

interface LineaCarrito {
  precio_unitario: number
  descuento: number
  cantidad: number
}

export function calcularTotalesCarrito(cart: LineaCarrito[], igvTasa: number) {
  const subtotalC = cart.reduce(
    (s, i) => s + (aCentavos(i.precio_unitario) - aCentavos(i.descuento)) * i.cantidad,
    0,
  )
  const totalDescuentoC = cart.reduce((s, i) => s + aCentavos(i.descuento) * i.cantidad, 0)
  const impuestoC = Math.round(subtotalC * igvTasa)
  const totalC = subtotalC + impuestoC
  return {
    subtotal: aSoles(subtotalC),
    totalDescuento: aSoles(totalDescuentoC),
    impuesto: aSoles(impuestoC),
    total: aSoles(totalC),
  }
}

export function calcularSubtotalLinea(precioUnitario: number, descuento: number, cantidad: number): number {
  const c = (aCentavos(precioUnitario) - aCentavos(descuento)) * cantidad
  return aSoles(c)
}

export function calcularDescuentoLinea(precioUnitario: number, valor: number, tipo: 'pct' | 'fijo'): number {
  const precioC = aCentavos(precioUnitario)
  const descuentoC = tipo === 'pct' ? Math.round((precioC * valor) / 100) : aCentavos(valor)
  return aSoles(Math.min(Math.max(0, descuentoC), precioC))
}

export function calcularVuelto(recibido: number, total: number): number {
  const c = aCentavos(recibido) - aCentavos(total)
  return aSoles(Math.max(0, c))
}
