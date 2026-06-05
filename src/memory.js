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
