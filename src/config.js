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
