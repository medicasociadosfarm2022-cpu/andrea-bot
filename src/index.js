import express from 'express'
import { config } from './config.js'
import { handleIncoming } from './handler.js'

const app = express()
app.use(express.json({ limit: '4mb' }))

// Endpoints de salud / comprobación rápida desde el navegador.
app.get('/', (req, res) => res.send('Andrea bot activo ✅'))
app.get('/health', (req, res) => res.json({ status: 'ok' }))

// Webhook que recibe los mensajes de Evolution API.
// Acepta /webhook y también /webhook/messages-upsert (modo "webhook by events").
app.post(['/webhook', '/webhook/*'], (req, res) => {
  if (config.webhookToken) {
    const token = req.query.token || req.headers['x-webhook-token']
    if (token !== config.webhookToken) {
      return res.status(401).send('unauthorized')
    }
  }

  // Respondemos rápido para no bloquear a Evolution; procesamos en segundo plano.
  res.sendStatus(200)
  handleIncoming(req.body).catch((err) =>
    console.error('❌ Error no controlado:', err.message),
  )
})

app.listen(config.port, () => {
  console.log(`🚀 Andrea bot escuchando en el puerto ${config.port}`)
  console.log(`   Instancia Evolution: ${config.evolution.instance}`)
  console.log(`   Modelo OpenAI: ${config.openai.model}`)
})
