import { getHistory, saveMessage } from './memory.js'
import { generateReply } from './openai.js'
import { sendText } from './evolution.js'

// Extrae el texto de los distintos tipos de mensaje de WhatsApp.
function extractText(message) {
  if (!message) return null
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    null
  )
}

// Procesa un evento entrante de Evolution API.
export async function handleIncoming(payload) {
  // Evolution puede mandar el evento como "messages.upsert" o "messages-upsert".
  const event = (payload?.event || '').replace('-', '.')
  if (event && event !== 'messages.upsert') return

  const data = payload?.data
  if (!data?.key) return

  const { remoteJid, fromMe } = data.key
  if (fromMe) return // ignorar lo que el propio número envía
  if (!remoteJid) return
  if (remoteJid.endsWith('@g.us')) return // ignorar grupos
  if (remoteJid === 'status@broadcast') return // ignorar estados

  const text = extractText(data.message)
  if (!text) return // mensajes sin texto (audios, stickers, etc.)

  const number = remoteJid.split('@')[0]
  const pushName = data.pushName || null

  console.log(`📩 ${pushName || number}: ${text}`)

  try {
    const history = await getHistory(remoteJid)
    const reply = await generateReply(history, text)
    if (!reply) return

    await sendText(number, reply)
    await saveMessage(remoteJid, 'user', text, pushName)
    await saveMessage(remoteJid, 'assistant', reply)

    console.log(`🤖 Andrea → ${pushName || number}: ${reply}`)
  } catch (err) {
    console.error('❌ Error procesando el mensaje:', err.message)
  }
}
