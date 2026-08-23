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
  const { data: callerStaff } = await admin
    .from('staff').select('rol, activo').eq('user_id', userData.user.id).maybeSingle()
  if (!callerStaff || callerStaff.rol !== 'administrador' || !callerStaff.activo) {
    return json({ error: 'Solo un administrador puede vincular accesos' }, 403)
  }

  let body: { staff_id?: string; correo?: string; password?: string }
  try { body = await req.json() } catch { return json({ error: 'Cuerpo inválido' }, 400) }

  const staffId = (body.staff_id || '').trim()
  const correo = (body.correo || '').trim()
  const password = body.password || ''
  if (!staffId || !EMAIL_RE.test(correo) || password.length < 6) {
    return json({ error: 'Perfil, correo válido y contraseña de al menos 6 caracteres son obligatorios' }, 400)
  }

  const { data: target, error: targetErr } = await admin
    .from('staff').select('id, user_id, activo').eq('id', staffId).maybeSingle()
  if (targetErr || !target) return json({ error: 'Perfil de personal no encontrado' }, 404)
  if (target.user_id) return json({ error: 'Este perfil ya tiene un acceso vinculado' }, 409)
  if (!target.activo) return json({ error: 'No se puede vincular acceso a un perfil inactivo' }, 400)

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: correo,
    password,
    email_confirm: true,
  })
  if (createErr || !created.user) return json({ error: createErr?.message || 'No se pudo crear el acceso' }, 400)

  const { data: updated, error: updateErr } = await admin
    .from('staff').update({ user_id: created.user.id }).eq('id', staffId).is('user_id', null).select().single()

  if (updateErr || !updated) {
    await admin.auth.admin.deleteUser(created.user.id)
    return json({ error: updateErr?.message || 'No se pudo vincular el acceso' }, 400)
  }

  return json({ staff: updated })
})
