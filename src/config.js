import 'dotenv/config'

function required(name) {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    console.error(`❌ Falta la variable de entorno ${name}. Revisa tu archivo .env`)
    process.exit(1)
  }
  return value.trim()
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  webhookToken: (process.env.WEBHOOK_TOKEN || '').trim(),

  // Número (con código de país, SIN el +) al que se avisa cuando se requiere
  // atención humana: el paciente envía archivos/fotos o pide reevaluar resultados.
  handoffNumber: (process.env.HANDOFF_NUMBER || '51978317597').trim(),

  // Número (con código de país, SIN el +) de la ENCARGADA DE CITAS. Cuando Andrea
  // deriva a un paciente para agendar, se le envía un WhatsApp aquí para que una
  // persona termine de coordinar la cita. Por defecto +51 941 697 769.
  citasNumber: (process.env.CITAS_NUMBER || '51941697769').trim(),

  // Tiempo (ms) que Andrea espera tras el ÚLTIMO mensaje del paciente para
  // agrupar todos sus mensajes y responder una sola vez. Por defecto 60 s.
  batchWindowMs: parseInt(process.env.BATCH_WINDOW_MS || '60000', 10),

  // Horas que Andrea queda en pausa (sin responder) cuando un paciente pide
  // tratamiento/receta y la conversación pasa a atención humana. Por defecto 24 h.
  pauseMs: parseInt(process.env.PAUSE_HOURS || '24', 10) * 60 * 60 * 1000,

  // Horas que Andrea queda en pausa cuando un HUMANO responde manualmente desde
  // el mismo WhatsApp del consultorio. Por defecto 12 h.
  humanPauseMs: parseInt(process.env.HUMAN_PAUSE_HOURS || '12', 10) * 60 * 60 * 1000,

  // Horas que Andrea queda en pausa cuando el paciente envía una foto, imagen,
  // audio, video, archivo o un enlace: esos casos los atiende SOLO un humano.
  // Durante la pausa Andrea tampoco responde los mensajes siguientes de ese
  // paciente. Por defecto 24 h.
  mediaPauseMs: parseInt(process.env.MEDIA_PAUSE_HOURS || '24', 10) * 60 * 60 * 1000,

  // Horario NOCTURNO en el que Andrea no responde nada al paciente (hora de
  // Piura). Por defecto de 23:00 (11 p. m.) a 07:00 (7 a. m.). A partir de la
  // hora de fin vuelve a responder sola.
  quietStartHour: parseInt(process.env.QUIET_START_HOUR || '23', 10),
  quietEndHour: parseInt(process.env.QUIET_END_HOUR || '7', 10),

  // Minutos de inactividad tras los cuales Andrea envía el mensaje de
  // seguimiento invitando a seguir las redes del Dr. Por defecto 30 min.
  followUpMs: parseInt(process.env.FOLLOWUP_MINUTES || '30', 10) * 60 * 1000,

  // Minutos de inactividad tras los cuales Andrea envía un mensaje de recontacto
  // si el paciente NO concretó la cita. Por defecto 25 min.
  recontactMs: parseInt(process.env.RECONTACT_MINUTES || '25', 10) * 60 * 1000,

  evolution: {
    url: required('EVOLUTION_API_URL').replace(/\/+$/, ''),
    apiKey: required('EVOLUTION_API_KEY'),
    instance: required('EVOLUTION_INSTANCE'),
  },

  openai: {
    apiKey: required('OPENAI_API_KEY'),
    model: (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim(),
  },

  supabase: {
    url: required('SUPABASE_URL'),
    key: required('SUPABASE_SERVICE_KEY'),
  },

  historyLimit: parseInt(process.env.HISTORY_LIMIT || '12', 10),
}
