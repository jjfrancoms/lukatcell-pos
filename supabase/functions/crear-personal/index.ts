import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PUESTOS = new Set(['jefa', 'vendedor', 'tecnico', 'encargado'])

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const authHeader = req.headers.get('Authorization') ?? ''
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })

  const { data: userData, error: userErr } = await callerClient.auth.getUser()
  if (userErr || !userData.user) return json({ error: 'No autenticado' }, 401)

  const admin = createClient(supabaseUrl, serviceKey)
  const { data: callerStaff, error: callerStaffErr } = await admin.from('staff').select('rol, activo, location_id').eq('user_id', userData.user.id).maybeSingle()
  if (callerStaffErr || !callerStaff || callerStaff.rol !== 'administrador' || !callerStaff.activo) return json({ error: 'Solo un administrador puede crear personal' }, 403)

  let body: { nombre?: string; username?: string; correo?: string; password?: string; rol?: string; puesto?: string }
  try { body = await req.json() } catch { return json({ error: 'Cuerpo inválido' }, 400) }

  const nombre = (body.nombre || '').trim()
  const username = (body.username || '').trim().toLowerCase()
  const correo = (body.correo || '').trim()
  const password = body.password || ''
  const rol = body.rol === 'administrador' ? 'administrador' : 'cajero'
  const puesto = PUESTOS.has(body.puesto || '') ? body.puesto : 'vendedor'

  if (!nombre || !username || !correo || password.length < 6) return json({ error: 'Nombre, usuario, correo y una contraseña de al menos 6 caracteres son obligatorios' }, 400)
  if (!EMAIL_RE.test(correo)) return json({ error: 'El correo no es válido (ej: nombre@correo.com)' }, 400)
  if (!/^[a-z0-9._-]{3,}$/.test(username)) return json({ error: 'El usuario debe tener al menos 3 caracteres (letras, números, puntos o guiones)' }, 400)

  const { data: existente } = await admin.from('staff').select('id').ilike('username', username).maybeSingle()
  if (existente) return json({ error: 'Ese nombre de usuario ya está en uso' }, 400)

  const { data: created, error: createErr } = await admin.auth.admin.createUser({ email: correo, password, email_confirm: true })
  if (createErr || !created.user) return json({ error: createErr?.message || 'No se pudo crear el usuario' }, 400)

  const { data: staffRow, error: staffErr } = await admin.from('staff').insert({ user_id: created.user.id, nombre, username, rol, puesto, location_id: callerStaff.location_id, activo: true }).select().single()
  if (staffErr) {
    await admin.auth.admin.deleteUser(created.user.id)
    return json({ error: staffErr.message }, 400)
  }

  return json({ staff: staffRow })
})
