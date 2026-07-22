import { createClient } from '@supabase/supabase-js'
import { config } from './config.js'

const supabase = createClient(config.supabase.url, config.supabase.key, {
  auth: { persistSession: false },
})

// Trae los últimos mensajes de un contacto, en orden cronológico (viejo -> nuevo).
export async function getHistory(remoteJid, limit = config.historyLimit) {
  const { data, error } = await supabase
    .from('messages')
    .select('role, content')
    .eq('remote_jid', remoteJid)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('⚠️  Error leyendo historial de Supabase:', error.message)
    return []
  }
  return data.reverse().map((m) => ({ role: m.role, content: m.content }))
}

// Guarda un mensaje (del paciente o de Andrea) en la memoria.
export async function saveMessage(remoteJid, role, content, pushName = null) {
  const { error } = await supabase.from('messages').insert({
    remote_jid: remoteJid,
    role,
    content,
    push_name: pushName,
  })
  if (error) console.error('⚠️  Error guardando mensaje en Supabase:', error.message)
}

// Devuelve las conversaciones que quedaron con la ÚLTIMA palabra del paciente
// desde `desde` (ISO): es decir, escribió y Andrea nunca le respondió. Se usa al
// terminar el horario nocturno para contestar lo que llegó de madrugada.
// No necesita tablas nuevas: se deduce del propio historial de `messages`.
export async function getConversacionesSinResponder(desde) {
  const { data, error } = await supabase
    .from('messages')
    .select('remote_jid, role, content, push_name, created_at')
    .gte('created_at', desde)
    .order('created_at', { ascending: true })
    .limit(500)

  if (error) {
    console.error('⚠️  Error leyendo mensajes pendientes de Supabase:', error.message)
    return []
  }

  // Agrupar por conversación conservando el orden cronológico.
  const porChat = new Map()
  for (const m of data) {
    let c = porChat.get(m.remote_jid)
    if (!c) {
      c = { remoteJid: m.remote_jid, pushName: m.push_name || null, textos: [], ultimoRol: null }
      porChat.set(m.remote_jid, c)
    }
    if (m.push_name) c.pushName = m.push_name
    // Los textos pendientes son los del paciente posteriores a la última
    // respuesta de Andrea; si Andrea respondió, se descarta lo anterior.
    if (m.role === 'user') c.textos.push(m.content)
    else c.textos = []
    c.ultimoRol = m.role
  }

  // Solo interesan las conversaciones donde el último mensaje es del paciente.
  return [...porChat.values()].filter((c) => c.ultimoRol === 'user' && c.textos.length)
}

// Pausa una conversación (Andrea deja de responder) hasta la fecha/hora `until`
// (ISO). Lo usa cuando un paciente pide tratamiento/receta y un humano debe
// atenderlo. Se guarda en Supabase para que sobreviva a reinicios.
export async function pauseChat(remoteJid, until, reason = null) {
  const { error } = await supabase
    .from('paused_chats')
    .upsert({ remote_jid: remoteJid, paused_until: until, reason }, { onConflict: 'remote_jid' })
  if (error) console.error('⚠️  Error pausando conversación en Supabase:', error.message)
}

// Indica si la conversación está en pausa (un humano la está atendiendo).
export async function isPaused(remoteJid) {
  const { data, error } = await supabase
    .from('paused_chats')
    .select('paused_until')
    .eq('remote_jid', remoteJid)
    .maybeSingle()
  if (error) {
    console.error('⚠️  Error consultando pausa en Supabase:', error.message)
    return false
  }
  if (!data) return false
  return new Date(data.paused_until).getTime() > Date.now()
}
