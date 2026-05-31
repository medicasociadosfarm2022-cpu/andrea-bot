import OpenAI from 'openai'
import { config } from './config.js'
import { buildSystemPrompt } from './prompt.js'

const client = new OpenAI({ apiKey: config.openai.apiKey })

// Genera la respuesta de Andrea a partir del historial y el mensaje nuevo.
export async function generateReply(history, userMessage) {
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...history,
    { role: 'user', content: userMessage },
  ]

  const completion = await client.chat.completions.create({
    model: config.openai.model,
    messages,
    temperature: 0.5,
    max_tokens: 500,
  })

  return completion.choices[0]?.message?.content?.trim() || ''
}
