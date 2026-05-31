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
