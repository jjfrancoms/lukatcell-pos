// Único punto para "¿qué día comercial es esto en Perú?". El backend ya
// tiene su propia fuente de verdad (sales.business_date, calculado por
// trigger en America/Lima) — este helper es el equivalente del lado del
// cliente, para defaults de filtros/formularios que representan un día
// comercial (cierre diario, conciliación, reportes, solicitudes de
// personal, fecha de emisión de documentos, etc.), NO para instantes
// técnicos (created_at/updated_at/synced_at), que deben seguir siendo
// timestamptz normales.
//
// `new Date().toISOString().slice(0, 10)` usa UTC: en Lima (UTC-5, sin
// horario de verano) el día calendario cambia recién a las 19:00 hora
// local, así que ese patrón adelanta el "día" 5 horas antes de tiempo.
const LIMA_TZ = 'America/Lima'

/** Convierte cualquier instante a su fecha comercial en Lima, como YYYY-MM-DD. */
export function formatBusinessDateLima(d: Date = new Date()): string {
  // en-CA da directamente el orden YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: LIMA_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

/** Fecha comercial de HOY en Lima (YYYY-MM-DD). */
export function getBusinessDateLima(): string {
  return formatBusinessDateLima(new Date())
}

/** Fecha comercial en Lima, `dias` días antes/después de ahora (YYYY-MM-DD). */
export function addDaysBusinessDateLima(dias: number, from: Date = new Date()): string {
  return formatBusinessDateLima(new Date(from.getTime() + dias * 86400000))
}

/**
 * Instante UTC real del inicio (00:00:00) de un día comercial en Lima, para
 * comparar contra columnas timestamptz (ej. `sale.fecha >= inicioDelDiaLima()`).
 * Perú no tiene horario de verano: Lima es siempre UTC-5, así que esto es
 * exacto sin depender de la zona horaria configurada en el dispositivo —
 * a diferencia de `new Date(); d.setHours(0,0,0,0)`, que usa la hora LOCAL
 * del navegador/SO y puede quedar mal si ese reloj no está en hora de Lima.
 */
export function startOfBusinessDayLima(businessDate: string = getBusinessDateLima()): Date {
  return new Date(`${businessDate}T05:00:00.000Z`)
}

/**
 * "Ahora" en hora de Lima, formateado para el valor de un
 * `<input type="datetime-local">` (YYYY-MM-DDTHH:mm). Un datetime-local NO
 * lleva zona horaria: el navegador muestra esos dígitos tal cual, como hora
 * de pared. `new Date().toISOString().slice(0,16)` da la hora UTC con esos
 * mismos dígitos — en Lima eso se ve 5 horas ADELANTADO de la hora real
 * (ej. una promoción que el admin cree que "empieza ahora" en realidad
 * empieza 5 horas después). Se usa para valores por defecto de vigencia de
 * promociones/cupones — no para instantes técnicos.
 */
export function nowDatetimeLocalLima(d: Date = new Date()): string {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: LIMA_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d)
  const get = (t: string) => partes.find((p) => p.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

/**
 * Convierte el valor de un `<input type="datetime-local">` (YYYY-MM-DDTHH:mm,
 * sin zona horaria) a un instante ISO real, tratando esos dígitos como hora
 * de pared de Lima — NUNCA como hora local del navegador (`new Date(value)`
 * usaría la zona del dispositivo, que puede no ser Lima). Perú es siempre
 * UTC-5 (sin horario de verano), así que basta con anexar el offset fijo.
 */
export function limaDatetimeLocalToISO(value: string): string {
  return new Date(`${value}:00.000-05:00`).toISOString()
}
