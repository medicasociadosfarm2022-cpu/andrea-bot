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

// Buffer de mensajes por contacto. Andrea junta todos los mensajes que el
// paciente envía y espera `batchWindowMs` desde el último para responder una
// sola vez, leyendo todo en conjunto.
const buffers = new Map() // remoteJid -> { number, pushName, texts, adjuntos, timer }

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

// Procesa un evento entrante de Evolution API: lo agrega al buffer del contacto
// y reinicia el temporizador. La respuesta se genera al vaciar el buffer.
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

  // No responder al propio número de derivación (Dr. Maraví).
  if (number === config.handoffNumber) return

  const adjunto = detectarAdjunto(data.message)
  const text = adjunto ? null : extractText(data.message)
  if (!adjunto && !text) return // mensajes sin texto ni adjunto (audios, stickers, etc.)

  // Agregar al buffer del contacto.
  let buf = buffers.get(remoteJid)
  if (!buf) {
    buf = { number, pushName, texts: [], adjuntos: [], timer: null }
    buffers.set(remoteJid, buf)
  }
  buf.pushName = pushName || buf.pushName
  if (adjunto) {
    buf.adjuntos.push(adjunto)
    console.log(`📎 (agrupando) ${pushName || number}: ${adjunto}`)
  } else {
    buf.texts.push(text)
    console.log(`📩 (agrupando) ${pushName || number}: ${text}`)
  }

  // Reiniciar el temporizador: respondemos 60 s después del ÚLTIMO mensaje.
  if (buf.timer) clearTimeout(buf.timer)
  buf.timer = setTimeout(() => {
    buffers.delete(remoteJid)
    flushBuffer(remoteJid, buf).catch((err) =>
      console.error('❌ Error procesando el lote de mensajes:', err.message),
    )
  }, config.batchWindowMs)
}

// Procesa todos los mensajes agrupados de un contacto y responde una sola vez.
async function flushBuffer(remoteJid, buf) {
  const { number, pushName, texts, adjuntos } = buf

  // 1) Si envió algún adjunto (foto/PDF) -> derivar al Dr. Maraví (un solo aviso).
  if (adjuntos.length) {
    const tipos = [...new Set(adjuntos)].join(' y ')
    const textoExtra = texts.length ? ` y escribió: "${texts.join(' ')}"` : ''
    try {
      await sendText(number, AVISO_ADJUNTO)
      await notificarHumano(pushName, number, `envió ${tipos}${textoExtra}`)
      await saveMessage(remoteJid, 'user', `[Paciente envió ${tipos}]${texts.length ? ' ' + texts.join(' ') : ''}`, pushName)
      await saveMessage(remoteJid, 'assistant', AVISO_ADJUNTO)
      console.log(`📎 ${pushName || number}: ${tipos} -> derivado al Dr. Maraví`)
    } catch (err) {
      console.error('❌ Error derivando adjunto:', err.message)
    }
    return
  }

  // 2) Solo texto -> juntar todo y responder una vez.
  const combinado = texts.join('\n')
  if (!combinado) return

  console.log(`📩 ${pushName || number} (${texts.length} msj): ${combinado.replace(/\n/g, ' / ')}`)

  try {
    const history = await getHistory(remoteJid)
    let reply = await generateReply(history, combinado)
    if (!reply) return

    // Si el modelo marcó derivación (reevaluación de resultados),
    // quitamos la marca y avisamos al Dr. Maraví.
    let derivar = false
    if (reply.includes(HANDOFF_TAG)) {
      derivar = true
      reply = reply.split(HANDOFF_TAG).join('').trim()
    }

    await sendText(number, reply)
    await saveMessage(remoteJid, 'user', combinado, pushName)
    await saveMessage(remoteJid, 'assistant', reply)

    console.log(`🤖 Andrea → ${pushName || number}: ${reply}`)

    if (derivar) {
      await notificarHumano(pushName, number, `pidió reevaluación de resultados: "${combinado}"`)
      console.log(`🔔 Derivado al Dr. Maraví: ${pushName || number}`)
    }
  } catch (err) {
    console.error('❌ Error procesando el mensaje:', err.message)
  }
}
