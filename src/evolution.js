import { config } from './config.js'

const base = config.evolution.url
const headers = {
  'Content-Type': 'application/json',
  apikey: config.evolution.apiKey,
}

// Envía un mensaje de texto por WhatsApp a través de Evolution API.
export async function sendText(number, text) {
  const url = `${base}/message/sendText/${config.evolution.instance}`
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ number, text, delay: 1200 }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Evolution API respondió ${res.status}: ${body}`)
  }
  return res.json()
}
