import { getHistory, saveMessage } from './memory.js'
import { generateReply } from './openai.js'
import { sendText } from './evolution.js'
import { config } from './config.js'

// Marca que el modelo añade a su respuesta cuando el paciente pide reevaluar
// sus resultados; el código la detecta para avisar al Dr. Maraví y la quita
// antes de enviar el mensaje al paciente.
const HANDOFF_TAG = '[DERIVAR]'

// Mensaje fijo que Andrea envía al paciente cuando comparte archivos o fotos.
const AVISO_ADJUNTO =
  'Gracias por compartir su información 🙏. Le haré llegar su mensaje y sus archivos al Dr. Maraví para que los revise personalmente. Cuando el Dr. me responda, se lo haré saber.'

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

// Detecta si el paciente envió un archivo o una foto (PDF, imagen, documento).
function detectarAdjunto(message) {
  if (!message) return null
  if (message.documentMessage || message.documentWithCaptionMessage) return 'un archivo/PDF'
  if (message.imageMessage) return 'una foto/imagen'
  return null
}

// Avisa al número humano (Dr. Maraví) para que una persona atienda al paciente.
async function notificarHumano(pushName, number, motivo) {
  const destino = config.handoffNumber
  if (!destino) return
  const aviso =
    `🔔 *Andrea — requiere atención del Dr. Maraví*\n\n` +
    `Paciente: ${pushName || 'Sin nombre'}\n` +
    `WhatsApp: +${number}\n` +
    `Motivo: ${motivo}\n\n` +
    `Por favor, comuníquese con el paciente.`
  try {
    await sendText(destino, aviso)
  } catch (err) {
    console.error('⚠️  No se pudo notificar al Dr. Maraví:', err.message)
  }
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

  const number = remoteJid.split('@')[0]
  const pushName = data.pushName || null

  // No responder al propio número de derivación (Dr. Maraví), para no
  // generar conversaciones automáticas con él.
  if (number === config.handoffNumber) return

  // 1) Adjuntos (PDF, fotos, documentos) -> derivar al Dr. Maraví.
  const adjunto = detectarAdjunto(data.message)
  if (adjunto) {
    console.log(`📎 ${pushName || number} envió ${adjunto} -> derivando al Dr. Maraví`)
    try {
      await sendText(number, AVISO_ADJUNTO)
      await notificarHumano(pushName, number, `envió ${adjunto}`)
      await saveMessage(remoteJid, 'user', `[Paciente envió ${adjunto}]`, pushName)
      await saveMessage(remoteJid, 'assistant', AVISO_ADJUNTO)
    } catch (err) {
      console.error('❌ Error derivando adjunto:', err.message)
    }
    return
  }

  const text = extractText(data.message)
  if (!text) return // mensajes sin texto (audios, stickers, etc.)

  console.log(`📩 ${pushName || number}: ${text}`)

  try {
    const history = await getHistory(remoteJid)
    let reply = await generateReply(history, text)
    if (!reply) return

    // 2) Si el modelo marcó derivación (reevaluación de resultados),
    //    quitamos la marca y avisamos al Dr. Maraví.
    let derivar = false
    if (reply.includes(HANDOFF_TAG)) {
      derivar = true
      reply = reply.split(HANDOFF_TAG).join('').trim()
    }

    await sendText(number, reply)
    await saveMessage(remoteJid, 'user', text, pushName)
    await saveMessage(remoteJid, 'assistant', reply)

    console.log(`🤖 Andrea → ${pushName || number}: ${reply}`)

    if (derivar) {
      await notificarHumano(pushName, number, `pidió reevaluación de resultados: "${text}"`)
      console.log(`🔔 Derivado al Dr. Maraví: ${pushName || number}`)
    }
  } catch (err) {
    console.error('❌ Error procesando el mensaje:', err.message)
  }
}
