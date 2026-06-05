import { getHistory, saveMessage, pauseChat, isPaused } from './memory.js'
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

// Mensaje que Andrea envía cuando el paciente pide tratamiento/receta/pastillas.
// Tras esto, Andrea queda en pausa y el personal del consultorio responde.
const AVISO_RECETA =
  'Con gusto. Para este tema le atenderá directamente el personal del consultorio del Dr. Maraví. En un momento se comunicarán con usted. 🙏'

// Frases que activan la atención humana (el paciente pide medicación/receta).
// Se comparan sin tildes y en minúsculas, como subcadena del mensaje.
const TRIGGERS_RECETA = [
  'envieme tratamiento', 'enviame tratamiento', 'envieme un tratamiento', 'enviame un tratamiento',
  'envieme una receta', 'enviame una receta', 'envieme receta', 'enviame receta', 'envieme la receta',
  'deme pastillas', 'dame pastillas', 'deme unas pastillas', 'dame unas pastillas',
  'deme pastilla', 'dame pastilla',
]

// Normaliza un texto: minúsculas y sin tildes/acentos, para comparar frases.
function normalizar(texto) {
  return texto
    .toLowerCase()
    .replace(/[áàä]/g, 'a')
    .replace(/[éèë]/g, 'e')
    .replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o')
    .replace(/[úùü]/g, 'u')
}

// ¿El paciente está pidiendo tratamiento, receta o pastillas?
function pideReceta(texto) {
  const t = normalizar(texto)
  return TRIGGERS_RECETA.some((frase) => t.includes(frase))
}

// Buffer de mensajes por contacto. Andrea junta todos los mensajes que el
// paciente envía y espera `batchWindowMs` desde el último para responder una
// sola vez, leyendo todo en conjunto.
const buffers = new Map() // remoteJid -> { number, pushName, texts, adjuntos, timer }

// Registro de los mensajes que envía el PROPIO bot (vía API), para distinguirlos
// de los que escribe un humano a mano desde el mismo WhatsApp. Ambos llegan como
// "fromMe", pero solo los del bot quedan aquí. Se limpia por antigüedad y tamaño.
const botSent = [] // { id, number, text, at }
const BOT_SENT_MAX = 1000
const BOT_SENT_TTL_MS = 2 * 60 * 1000

// Recuerda el contenido de un mensaje saliente del bot (antes de enviarlo).
function recordarTextoBot(number, text) {
  botSent.push({ id: null, number, text, at: Date.now() })
  const corte = Date.now() - BOT_SENT_TTL_MS
  while (botSent.length && botSent[0].at < corte) botSent.shift()
  while (botSent.length > BOT_SENT_MAX) botSent.shift()
}

// ¿Este mensaje saliente ("fromMe") lo generó el propio bot?
function esMensajeDelBot(number, text, id) {
  return botSent.some(
    (m) => (id && m.id === id) || (m.number === number && m.text === text),
  )
}

// Envía un texto y lo registra como mensaje del bot (para no confundirlo con
// una respuesta humana). Úsalo en lugar de sendText para todo lo que envía Andrea.
async function enviar(number, text) {
  recordarTextoBot(number, text)
  const res = await sendText(number, text)
  const id = res?.key?.id
  if (id) {
    const ultimo = botSent[botSent.length - 1]
    if (ultimo) ultimo.id = id
  }
  return res
}

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
    await enviar(destino, aviso)
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

  const { remoteJid, fromMe, id: msgId } = data.key
  if (!remoteJid) return
  if (remoteJid.endsWith('@g.us')) return // ignorar grupos
  if (remoteJid === 'status@broadcast') return // ignorar estados

  const number = remoteJid.split('@')[0]
  const pushName = data.pushName || null

  // Mensaje saliente (fromMe): puede ser del propio bot o de un humano del
  // consultorio respondiendo a mano desde el mismo WhatsApp.
  if (fromMe) {
    const text = extractText(data.message)
    if (esMensajeDelBot(number, text, msgId)) return // lo envió Andrea (API)
    if (number === config.handoffNumber) return // notificación interna al Dr.
    // Lo escribió un humano -> Andrea se pausa en esa conversación 12 h.
    const pend = buffers.get(remoteJid)
    if (pend?.timer) clearTimeout(pend.timer)
    buffers.delete(remoteJid)
    const hasta = new Date(Date.now() + config.humanPauseMs).toISOString()
    await pauseChat(remoteJid, hasta, 'un humano respondió manualmente')
    console.log(`👤 Humano respondió a ${number} -> Andrea en pausa ${config.humanPauseMs / 3600000} h`)
    return
  }

  // No responder al propio número de derivación (Dr. Maraví).
  if (number === config.handoffNumber) return

  const adjunto = detectarAdjunto(data.message)
  const text = adjunto ? null : extractText(data.message)
  if (!adjunto && !text) return // mensajes sin texto ni adjunto (audios, stickers, etc.)

  // Si la conversación está en pausa (la atiende un humano), Andrea no responde.
  if (await isPaused(remoteJid)) {
    console.log(`🔕 (en pausa) ${pushName || number}: mensaje ignorado por Andrea`)
    return
  }

  // Si el paciente pide tratamiento/receta/pastillas, Andrea deja de responder
  // y deriva a atención humana (pausa de 24 h + aviso al Dr. Maraví).
  if (text && pideReceta(text)) {
    // Cancelar cualquier respuesta automática que estuviera pendiente.
    const pend = buffers.get(remoteJid)
    if (pend?.timer) clearTimeout(pend.timer)
    buffers.delete(remoteJid)

    const hasta = new Date(Date.now() + config.pauseMs).toISOString()
    await pauseChat(remoteJid, hasta, 'pidió tratamiento/receta/pastillas')
    try {
      await enviar(number, AVISO_RECETA)
      await notificarHumano(
        pushName,
        number,
        `solicitó tratamiento/receta/pastillas: "${text}". Andrea quedó en pausa por atención humana.`,
      )
      await saveMessage(remoteJid, 'user', text, pushName)
      await saveMessage(remoteJid, 'assistant', AVISO_RECETA)
    } catch (err) {
      console.error('❌ Error derivando solicitud de receta:', err.message)
    }
    console.log(`💊 ${pushName || number} pidió receta -> Andrea en pausa, derivado al Dr. Maraví`)
    return
  }

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

  // Si la conversación se pausó mientras había mensajes pendientes, no responder.
  if (await isPaused(remoteJid)) return

  // 1) Si envió algún adjunto (foto/PDF) -> derivar al Dr. Maraví (un solo aviso).
  if (adjuntos.length) {
    const tipos = [...new Set(adjuntos)].join(' y ')
    const textoExtra = texts.length ? ` y escribió: "${texts.join(' ')}"` : ''
    try {
      await enviar(number, AVISO_ADJUNTO)
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

    await enviar(number, reply)
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
