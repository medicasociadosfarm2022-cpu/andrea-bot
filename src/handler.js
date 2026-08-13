import {
  getHistory,
  saveMessage,
  pauseChat,
  isPaused,
  getConversacionesSinResponder,
} from './memory.js'
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

// Mensaje fijo que Andrea envía al paciente cuando comparte fotos, audios,
// videos, archivos o enlaces. Tras esto Andrea queda en pausa y solo un humano
// del consultorio continúa la conversación.
const AVISO_ADJUNTO =
  'Gracias por compartir su información 🙏. Le haré llegar su mensaje al Dr. Maraví, cuando responda se lo haré saber.'

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

// Hora actual (0-23) en Piura, Perú. Se calcula con la zona horaria America/Lima
// para no depender de la hora del servidor, que corre en UTC.
export function horaLima(ahora = new Date()) {
  try {
    const h = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Lima',
      hour: '2-digit',
      hour12: false,
    }).format(ahora)
    return parseInt(h, 10) % 24
  } catch {
    return ahora.getUTCHours()
  }
}

// ¿Estamos en horario nocturno? De 23:00 a 07:00 (hora de Piura) Andrea no
// responde nada al paciente; a las 07:00 se reactiva sola. El rango cruza la
// medianoche, por eso la comparación va con "o" en lugar de "y".
export function esHorarioSilencio(ahora = new Date()) {
  const h = horaLima(ahora)
  const inicio = config.quietStartHour
  const fin = config.quietEndHour
  if (inicio === fin) return false // rango vacío: silencio desactivado
  return inicio > fin ? h >= inicio || h < fin : h >= inicio && h < fin
}

// Fecha de hoy (YYYY-MM-DD) en Piura, Perú, con la zona America/Lima, para no
// depender de la hora del servidor (corre en UTC).
export function fechaHoyLima(ahora = new Date()) {
  try {
    // 'en-CA' entrega el formato ISO YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Lima',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(ahora)
  } catch {
    return ahora.toISOString().slice(0, 10)
  }
}

// ¿Hoy es día feriado (el Dr. está de viaje y no atiende)? Compara la fecha de
// Piura contra la lista `config.feriadoDates`.
export function esDiaFeriado(ahora = new Date()) {
  return config.feriadoDates.includes(fechaHoyLima(ahora))
}

// Convierte una fecha 'YYYY-MM-DD' en un texto legible en español: "28 de julio".
const MESES_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]
function fechaLegible(iso) {
  const [, mes, dia] = iso.split('-').map((n) => parseInt(n, 10))
  return `${dia} de ${MESES_ES[mes - 1] || ''}`.trim()
}

// Lista de fechas legible en español. Si todas caen en el mismo mes, no lo
// repite: "28 y 29 de julio". Si no, escribe el mes en cada una.
function listaFechasLegible(fechas) {
  if (!fechas.length) return ''
  const meses = new Set(fechas.map((f) => f.split('-')[1]))
  const partes =
    meses.size === 1
      ? fechas.map((f) => parseInt(f.split('-')[2], 10)).map(String) // solo el día
      : fechas.map(fechaLegible) // día y mes en cada una
  let texto =
    partes.length > 1
      ? `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1]}`
      : partes[0]
  if (meses.size === 1) {
    const mes = parseInt([...meses][0], 10)
    texto += ` de ${MESES_ES[mes - 1] || ''}`
  }
  return texto.trim()
}

// Aviso que Andrea envía durante los días feriados. Menciona los días sin
// atención y la fecha de reinicio a partir de `config`.
function mensajeFeriado() {
  const listaDias = listaFechasLegible(config.feriadoDates)
  const reinicio = fechaLegible(config.feriadoReinicio)
  return (
    'Hola 😊, gracias por escribir al consultorio del Dr. Julio Maraví. ' +
    `Le informo que por feriados el Dr. no atenderá el ${listaDias}, ya que se encuentra de viaje. 🙏\n\n` +
    'Con gusto puede dejarme su mensaje y se lo haré llegar para que el Dr. le responda ' +
    `el ${reinicio}, cuando reinicia sus actividades. ¡Gracias por su comprensión! 🙌`
  )
}

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
  if (esHorarioSilencio()) return // horario nocturno: no molestar
  await enviar(number, MENSAJE_REDES)
  await saveMessage(remoteJid, 'assistant', MENSAJE_REDES)
  console.log(`📣 Seguimiento (redes) enviado a ${number}`)
}

// Envía el mensaje de recontacto si no hay cita concertada ni pausa activa.
async function enviarRecontacto(remoteJid, number) {
  if (citasConcertadas.has(remoteJid)) return // ya concretó la cita
  if (await isPaused(remoteJid)) return // un humano la está atendiendo
  if (esHorarioSilencio()) return // horario nocturno: no molestar
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

// Detecta si el paciente envió contenido multimedia (foto, audio, video, archivo).
// Estos casos NO los responde Andrea: los atiende solo un humano.
function detectarAdjunto(message) {
  if (!message) return null
  if (message.documentMessage || message.documentWithCaptionMessage) return 'un archivo/PDF'
  if (message.imageMessage) return 'una foto/imagen'
  if (message.audioMessage || message.pttMessage) return 'un audio/nota de voz'
  if (message.videoMessage) return 'un video'
  return null
}

// Detecta si el mensaje del paciente contiene un enlace (link). Cubre URLs con
// http(s)://, las que empiezan con www. y los dominios sueltos más comunes
// (ejemplo.com, ejemplo.pe...). Los enlaces también pasan a atención humana.
const REGEX_LINK =
  /(https?:\/\/\S+|www\.\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|pe|org|net|edu|gob|es|io|co|app|me|info|link|ly)\b(?:\/\S*)?)/i

function contieneLink(texto) {
  if (!texto) return false
  return REGEX_LINK.test(texto)
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

// --- Respuesta diferida de los mensajes nocturnos ---
// Al terminar el horario de silencio (07:00 en Piura), Andrea contesta sola las
// consultas que llegaron de madrugada y quedaron sin responder.

// Texto que se antepone al mensaje del paciente para que Andrea sepa que está
// respondiendo por la mañana algo que le escribieron de noche. Es una
// instrucción interna: no se le muestra al paciente ni se guarda en el historial.
const INSTRUCCION_NOCTURNA =
  '[NOTA INTERNA: el paciente escribió esto de madrugada, fuera del horario de atención, y recién le estás respondiendo ahora en la mañana. Salúdalo, discúlpate brevemente por la demora en una sola frase y responde su consulta con normalidad. No menciones esta nota.]\n\n'

async function responderPendientesNocturnos() {
  // En día feriado el Dr. no atiende: no se generan respuestas automáticas de la
  // madrugada. Cuando el paciente vuelva a escribir recibirá el aviso de feriado.
  if (esDiaFeriado()) {
    console.log('🏖️ Feriado: no se generan respuestas automáticas de la madrugada.')
    return
  }

  let chats = []
  try {
    // Buscamos desde el inicio del horario nocturno (con 1 h de margen).
    const desde = new Date(Date.now() - (horasDeSilencio() + 1) * 60 * 60 * 1000).toISOString()
    chats = await getConversacionesSinResponder(desde)
  } catch (err) {
    console.error('❌ Error buscando mensajes nocturnos pendientes:', err.message)
    return
  }

  if (!chats.length) {
    console.log('🌅 Fin del horario nocturno: no hay mensajes pendientes por responder')
    return
  }

  console.log(`🌅 Fin del horario nocturno: respondiendo ${chats.length} conversación(es) pendiente(s)`)
  for (const chat of chats) {
    const { remoteJid, pushName, textos } = chat
    const number = remoteJid.split('@')[0]
    try {
      if (await isPaused(remoteJid)) continue // la atiende un humano
      const combinado = textos.join('\n')
      const history = await getHistory(remoteJid)
      let reply = await generateReply(history, INSTRUCCION_NOCTURNA + combinado)
      if (!reply) continue

      let citaDerivada = false
      if (reply.includes(CITA_TAG)) {
        citaDerivada = true
        citasConcertadas.add(remoteJid)
        reply = reply.split(CITA_TAG).join('').trim()
      }
      let derivar = false
      if (reply.includes(HANDOFF_TAG)) {
        derivar = true
        reply = reply.split(HANDOFF_TAG).join('').trim()
      }

      await enviar(number, reply)
      await saveMessage(remoteJid, 'assistant', reply)
      console.log(`🌅 Andrea (pendiente nocturno) → ${pushName || number}: ${reply}`)

      if (citaDerivada) await notificarEncargadaCitas(pushName, number)
      if (derivar) await notificarHumano(pushName, number, `pidió reevaluación de resultados: "${combinado}"`)
    } catch (err) {
      console.error(`❌ Error respondiendo pendiente nocturno de ${number}:`, err.message)
    }
  }
}

// Cuántas horas dura el silencio nocturno (para saber desde cuándo buscar).
function horasDeSilencio() {
  const { quietStartHour: i, quietEndHour: f } = config
  if (i === f) return 0
  return i > f ? 24 - i + f : f - i
}

// Vigila el paso de "noche" a "día" y dispara las respuestas pendientes.
// Se revisa cada minuto: es más robusto que programar un temporizador a horas
// vista, que se desajusta si el servidor se suspende o reinicia.
let eraDeNoche = null
export function iniciarProgramadorNocturno() {
  const revisar = () => {
    const ahoraNoche = esHorarioSilencio()
    if (eraDeNoche === true && ahoraNoche === false) {
      responderPendientesNocturnos().catch((err) =>
        console.error('❌ Error en las respuestas pendientes:', err.message),
      )
    }
    eraDeNoche = ahoraNoche
  }
  revisar() // estado inicial, sin disparar nada

  // Si el bot arranca justo después del fin del silencio (por ejemplo, un
  // redeploy a las 7:05 a. m.), la transición noche->día no la vería nadie y
  // los mensajes de madrugada quedarían sin respuesta. En esa franja revisamos
  // los pendientes al arrancar. Fuera de ella no, para no revivir
  // conversaciones viejas de la tarde.
  const h = horaLima()
  const finVentana = (config.quietEndHour + 2) % 24
  const recienAmanecio =
    config.quietEndHour <= finVentana
      ? h >= config.quietEndHour && h < finVentana
      : h >= config.quietEndHour || h < finVentana
  if (!esHorarioSilencio() && recienAmanecio) {
    console.log('🌅 Arranque dentro de la franja posterior al horario nocturno: revisando pendientes')
    responderPendientesNocturnos().catch((err) =>
      console.error('❌ Error revisando pendientes al arrancar:', err.message),
    )
  }

  const t = setInterval(revisar, 60 * 1000)
  if (t.unref) t.unref()
  console.log(
    `🌙 Horario nocturno activo: de ${config.quietStartHour}:00 a ${config.quietEndHour}:00 (hora de Piura). ` +
      `Ahora son las ${horaLima()}:00 -> Andrea ${esHorarioSilencio() ? 'NO responde' : 'responde'}.`,
  )
  return t
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
  const text = extractText(data.message) // puede venir como pie de foto/video
  if (!adjunto && !text) return // mensajes sin contenido útil (stickers, etc.)

  // Hay actividad nueva del paciente: cancelar temporizadores pendientes
  // (se reprogramarán cuando Andrea responda).
  cancelarTemporizadores(remoteJid)

  // Si la conversación está en pausa (la atiende un humano), Andrea no responde.
  if (await isPaused(remoteJid)) {
    console.log(`🔕 (en pausa) ${pushName || number}: mensaje ignorado por Andrea`)
    return
  }

  // Días FERIADOS (el Dr. está de viaje): Andrea NO atiende ninguna consulta,
  // venga como texto, imagen o audio. Guarda el mensaje del paciente para que el
  // Dr. lo lea al reiniciar, y responde una sola vez con el aviso del feriado
  // (no lo repite en cada mensaje del mismo chat).
  if (esDiaFeriado()) {
    // Cancelar cualquier respuesta agrupada o seguimiento que estuviera pendiente.
    const pend = buffers.get(remoteJid)
    if (pend?.timer) clearTimeout(pend.timer)
    buffers.delete(remoteJid)
    cancelarTemporizadores(remoteJid)

    const aviso = mensajeFeriado()
    try {
      // ¿Ya le enviamos el aviso de feriado en este chat? Lo comprobamos en el
      // historial para no reenviarlo en cada mensaje.
      const history = await getHistory(remoteJid)
      const yaAvisado = history.some(
        (m) => m.role === 'assistant' && m.content === aviso,
      )

      // Guardar lo que envió el paciente (texto o descripción del adjunto) para
      // que el Dr. lo revise el día de reinicio.
      const contenido = adjunto
        ? `[Paciente envió ${adjunto}]${text ? ' ' + text : ''}`
        : text
      await saveMessage(remoteJid, 'user', contenido, pushName)

      // El aviso respeta el horario nocturno: de madrugada no se le escribe nada.
      if (!yaAvisado && !esHorarioSilencio()) {
        await enviar(number, aviso)
        await saveMessage(remoteJid, 'assistant', aviso)
        console.log(`🏖️ (feriado ${fechaHoyLima()}) aviso enviado a ${pushName || number}`)
      } else {
        console.log(
          `🏖️ (feriado ${fechaHoyLima()}) ${pushName || number}: mensaje guardado, ` +
            `${yaAvisado ? 'aviso ya enviado antes' : 'horario nocturno'}, sin reenviar`,
        )
      }
    } catch (err) {
      console.error('❌ Error en modo feriado:', err.message)
    }
    return
  }

  // Si el paciente envía multimedia (foto, audio, video, archivo) o un enlace,
  // Andrea DEJA de responder automáticamente: avisa al número humano y queda en
  // pausa, de modo que los mensajes que el paciente escriba después tampoco se
  // responden solos (los atrapa el control de pausa de arriba). Solo un humano
  // continúa esta conversación.
  const link = !adjunto && contieneLink(text)
  if (adjunto || link) {
    // Descartar cualquier respuesta automática que estuviera pendiente.
    const pend = buffers.get(remoteJid)
    if (pend?.timer) clearTimeout(pend.timer)
    buffers.delete(remoteJid)

    const tipo = adjunto || 'un enlace/link'
    const motivo = adjunto
      ? `envió ${tipo}${text ? ` con el mensaje: "${text}"` : ''}`
      : `envió un enlace/link: "${text}"`

    const hasta = new Date(Date.now() + config.mediaPauseMs).toISOString()
    await pauseChat(remoteJid, hasta, `envió ${tipo} (requiere atención humana)`)
    try {
      // De noche no se le escribe al paciente, pero el aviso al personal sí sale.
      const acusado = !esHorarioSilencio()
      if (acusado) await enviar(number, AVISO_ADJUNTO)
      await notificarHumano(
        pushName,
        number,
        `${motivo}. Andrea quedó en pausa: responda usted directamente al paciente.` +
          (acusado ? '' : ' (Llegó de madrugada: Andrea NO le respondió nada.)'),
      )
      await saveMessage(
        remoteJid,
        'user',
        `[Paciente envió ${tipo}]${text ? ' ' + text : ''}`,
        pushName,
      )
      if (acusado) await saveMessage(remoteJid, 'assistant', AVISO_ADJUNTO)
    } catch (err) {
      console.error('❌ Error derivando multimedia/enlace:', err.message)
    }
    console.log(
      `📎 ${pushName || number}: ${tipo} -> Andrea en pausa ${config.mediaPauseMs / 3600000} h, avisado +${config.handoffNumber}`,
    )
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
      // De noche no se le escribe al paciente, pero el aviso al personal sí sale.
      const acusado = !esHorarioSilencio()
      if (acusado) await enviar(number, AVISO_RECETA)
      await notificarHumano(
        pushName,
        number,
        `solicitó tratamiento/receta/pastillas: "${text}". Andrea quedó en pausa por atención humana.` +
          (acusado ? '' : ' (Llegó de madrugada: Andrea NO le respondió nada.)'),
      )
      await saveMessage(remoteJid, 'user', text, pushName)
      if (acusado) await saveMessage(remoteJid, 'assistant', AVISO_RECETA)
    } catch (err) {
      console.error('❌ Error derivando solicitud de receta:', err.message)
    }
    console.log(`💊 ${pushName || number} pidió receta -> Andrea en pausa, derivado al Dr. Maraví`)
    return
  }

  // Agregar al buffer del contacto.
  // Horario nocturno (23:00-07:00 en Piura): Andrea no responde. El mensaje se
  // guarda en el historial para que quede constancia, pero no se agrupa ni se
  // contesta. A las 07:00 vuelve a responder sola los mensajes nuevos.
  if (esHorarioSilencio()) {
    console.log(`🌙 (horario nocturno, ${horaLima()}:00 en Piura) ${pushName || number}: sin respuesta automática`)
    try {
      await saveMessage(remoteJid, 'user', text, pushName)
    } catch (err) {
      console.error('⚠️  No se pudo guardar el mensaje nocturno:', err.message)
    }
    return
  }

  // Llegados aquí solo queda texto sin enlaces: se agrupa y se responde una vez.
  let buf = buffers.get(remoteJid)
  if (!buf) {
    buf = { number, pushName, texts: [], timer: null }
    buffers.set(remoteJid, buf)
  }
  buf.pushName = pushName || buf.pushName
  buf.texts.push(text)
  console.log(`📩 (agrupando) ${pushName || number}: ${text}`)

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
  const { number, pushName, texts } = buf

  // Si la conversación se pausó mientras había mensajes pendientes (por ejemplo,
  // el paciente mandó una foto justo después de escribir), no responder.
  if (await isPaused(remoteJid)) return

  // Si entró el horario nocturno mientras se agrupaban los mensajes (escribió a
  // las 22:59 y el lote vencía a las 23:00), tampoco responder.
  if (esHorarioSilencio()) {
    console.log(`🌙 (entró horario nocturno) ${pushName || number}: lote descartado sin responder`)
    return
  }

  // Juntar todo el texto del lote y responder una sola vez.
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
