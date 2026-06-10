import { getHistory, saveMessage, pauseChat, isPaused } from './memory.js'
import { generateReply } from './openai.js'
import { sendText } from './evolution.js'
import { config } from './config.js'

// Marca que el modelo añade a su respuesta cuando el paciente pide reevaluar
// sus resultados; el código la detecta para avisar al Dr. Maraví y la quita
// antes de enviar el mensaje al paciente.
const HANDOFF_TAG = '[DERIVAR]'

// Marca que el modelo añade cuando ya derivó al paciente a la encargada de
// citas (la cita está en proceso). Sirve para NO enviarle el recontacto.
const CITA_TAG = '[CITA]'

// Mensaje fijo que Andrea envía al paciente cuando comparte archivos o fotos.
const AVISO_ADJUNTO =
  'Gracias por compartir su información 🙏. Le haré llegar su mensaje y sus archivos al Dr. Maraví para que los revise personalmente. Cuando el Dr. me responda, se lo haré saber.'

// Mensaje que Andrea envía cuando el paciente pide tratamiento/receta/pastillas.
// Tras esto, Andrea queda en pausa y el personal del consultorio responde.
const AVISO_RECETA =
  'Con gusto. Para este tema le atenderá directamente el personal del consultorio del Dr. Maraví. En un momento se comunicarán con usted. 🙏'

// Mensaje de seguimiento que se envía 30 min después de terminar la conversación,
// invitando al paciente a seguir las redes sociales del Dr. Maraví.
const MENSAJE_REDES =
  '¡Gracias por escribirnos! 😊 Si desea conocer más sobre el Dr. Julio Maraví y sus consejos de salud digestiva, puede seguirlo en sus redes sociales:\n\n' +
  '📸 Instagram: https://www.instagram.com/dr.juliomaravi.gastro/\n' +
  '🎵 TikTok: https://www.tiktok.com/@dr.juliomaravi.gastro\n' +
  '👍 Facebook: https://www.facebook.com/Dr.JulioMaraviCoronado/\n\n' +
  '¡Que tenga un excelente día! 🙌'

// Mensaje de recontacto que se envía 25 min después, si el paciente quedó sin
// responder y aún NO concretó su cita.
const MENSAJE_RECONTACTO =
  'Hola 😊, ¿sigue interesado/a en agendar su cita con el Dr. Maraví? Con gusto le ayudo a reservar su horario o a resolver cualquier duda que tenga. Quedo atenta. 🙌'

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

// Temporizadores de seguimiento (mensaje de redes) por contacto. Se reinician
// con cada interacción y disparan `followUpMs` después de la última.
const followUps = new Map() // remoteJid -> Timeout

// Temporizadores de recontacto (si no concretó la cita) por contacto.
const recontacts = new Map() // remoteJid -> Timeout

// Conversaciones donde el paciente ya concretó/derivó su cita; no se les
// envía el mensaje de recontacto.
const citasConcertadas = new Set() // remoteJid

// Programa (o reinicia) el mensaje de seguimiento (redes) para un contacto.
function programarSeguimiento(remoteJid, number) {
  const prev = followUps.get(remoteJid)
  if (prev) clearTimeout(prev)
  const t = setTimeout(() => {
    followUps.delete(remoteJid)
    enviarSeguimiento(remoteJid, number).catch((err) =>
      console.error('❌ Error enviando seguimiento:', err.message),
    )
  }, config.followUpMs)
  followUps.set(remoteJid, t)
}

// Programa (o reinicia) el mensaje de recontacto para un contacto.
function programarRecontacto(remoteJid, number) {
  const prev = recontacts.get(remoteJid)
  if (prev) clearTimeout(prev)
  const t = setTimeout(() => {
    recontacts.delete(remoteJid)
    enviarRecontacto(remoteJid, number).catch((err) =>
      console.error('❌ Error enviando recontacto:', err.message),
    )
  }, config.recontactMs)
  recontacts.set(remoteJid, t)
}

// Cancela los temporizadores pendientes de un contacto (la conversación se
// reactivó o la tomó un humano).
function cancelarTemporizadores(remoteJid) {
  const f = followUps.get(remoteJid)
  if (f) clearTimeout(f)
  followUps.delete(remoteJid)
  const r = recontacts.get(remoteJid)
  if (r) clearTimeout(r)
  recontacts.delete(remoteJid)
}

// Envía el mensaje de redes sociales, salvo que la conversación esté en pausa.
async function enviarSeguimiento(remoteJid, number) {
  if (await isPaused(remoteJid)) return // un humano la está atendiendo
  await enviar(number, MENSAJE_REDES)
  await saveMessage(remoteJid, 'assistant', MENSAJE_REDES)
  console.log(`📣 Seguimiento (redes) enviado a ${number}`)
}

// Envía el mensaje de recontacto si no hay cita concertada ni pausa activa.
async function enviarRecontacto(remoteJid, number) {
  if (citasConcertadas.has(remoteJid)) return // ya concretó la cita
  if (await isPaused(remoteJid)) return // un humano la está atendiendo
  await enviar(number, MENSAJE_RECONTACTO)
  await saveMessage(remoteJid, 'assistant', MENSAJE_RECONTACTO)
  console.log(`📨 Recontacto enviado a ${number}`)
}

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

// Avisa por WhatsApp a la ENCARGADA DE CITAS cuando Andrea deriva a un paciente
// para agendar, para que una persona termine de coordinar la cita.
async function notificarEncargadaCitas(pushName, number) {
  const destino = config.citasNumber
  if (!destino) return
  const aviso =
    `🗓️ *Andrea — nueva cita por agendar*\n\n` +
    `Un paciente fue derivado para coordinar su cita. Por favor, comuníquese con él para terminar de agendarla.\n\n` +
    `Paciente: ${pushName || 'Sin nombre'}\n` +
    `WhatsApp: +${number}`
  try {
    await enviar(destino, aviso)
    console.log(`🗓️ Encargada de citas notificada para ${pushName || number}`)
  } catch (err) {
    console.error('⚠️  No se pudo notificar a la encargada de citas:', err.message)
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
    if (number === config.citasNumber) return // notificación a la encargada de citas
    // Lo escribió un humano -> Andrea se pausa en esa conversación 12 h.
    const pend = buffers.get(remoteJid)
    if (pend?.timer) clearTimeout(pend.timer)
    buffers.delete(remoteJid)
    cancelarTemporizadores(remoteJid)
    const hasta = new Date(Date.now() + config.humanPauseMs).toISOString()
    await pauseChat(remoteJid, hasta, 'un humano respondió manualmente')
    console.log(`👤 Humano respondió a ${number} -> Andrea en pausa ${config.humanPauseMs / 3600000} h`)
    return
  }

  // No responder al propio número de derivación (Dr. Maraví) ni al de la encargada.
  if (number === config.handoffNumber) return
  if (number === config.citasNumber) return

  const adjunto = detectarAdjunto(data.message)
  const text = adjunto ? null : extractText(data.message)
  if (!adjunto && !text) return // mensajes sin texto ni adjunto (audios, stickers, etc.)

  // Hay actividad nueva del paciente: cancelar temporizadores pendientes
  // (se reprogramarán cuando Andrea responda).
  cancelarTemporizadores(remoteJid)

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

    // Si el modelo marcó que la cita ya está en proceso ([CITA]), la quitamos,
    // registramos el contacto para no enviarle el recontacto y, tras responder
    // al paciente, avisamos a la encargada de citas para que agende la cita.
    let citaDerivada = false
    if (reply.includes(CITA_TAG)) {
      citaDerivada = true
      citasConcertadas.add(remoteJid)
      reply = reply.split(CITA_TAG).join('').trim()
    }

    await enviar(number, reply)
    await saveMessage(remoteJid, 'user', combinado, pushName)
    await saveMessage(remoteJid, 'assistant', reply)

    console.log(`🤖 Andrea → ${pushName || number}: ${reply}`)

    // Tras enviar el mensaje de derivación, avisar SIEMPRE a la encargada de citas.
    if (citaDerivada) {
      await notificarEncargadaCitas(pushName, number)
    }

    if (derivar) {
      await notificarHumano(pushName, number, `pidió reevaluación de resultados: "${combinado}"`)
      console.log(`🔔 Derivado al Dr. Maraví: ${pushName || number}`)
    } else {
      // Programar el seguimiento (redes) 30 min después de esta respuesta.
      programarSeguimiento(remoteJid, number)
      // Y el recontacto a los 25 min, salvo que ya haya concretado la cita.
      if (!citasConcertadas.has(remoteJid)) programarRecontacto(remoteJid, number)
    }
  } catch (err) {
    console.error('❌ Error procesando el mensaje:', err.message)
  }
}
