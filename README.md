# 🤖 Andrea — Bot de WhatsApp del Dr. Julio Maraví

Chatbot que atiende WhatsApp con la personalidad de **Andrea**, usando:

- **Evolution API** → conexión con WhatsApp
- **OpenAI** → genera las respuestas (guion del consultorio)
- **Supabase** → memoria de cada conversación

---

## 📁 Qué hace

Cuando un paciente escribe al WhatsApp del consultorio, Evolution API le avisa al bot
(por un *webhook*). El bot:

1. Lee los últimos mensajes de esa persona en Supabase (memoria).
2. Le pide a OpenAI una respuesta como "Andrea" siguiendo el guion.
3. Responde por WhatsApp a través de Evolution API.
4. Guarda la conversación en Supabase.

---

## 🚀 Puesta en marcha

### 1. Configura las credenciales

Copia `.env.example` a `.env` y rellena tus datos:

```
EVOLUTION_API_URL=...      # URL de tu Evolution en EasyPanel (sin barra final)
EVOLUTION_API_KEY=...      # apikey de Evolution
EVOLUTION_INSTANCE=...      # nombre de tu instancia conectada a WhatsApp
OPENAI_API_KEY=sk-...
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...    # clave service_role
WEBHOOK_TOKEN=...           # opcional, un texto secreto para proteger el webhook
```

### 2. Crea la tabla en Supabase

En Supabase → **SQL Editor** → pega el contenido de `supabase/schema.sql` → **Run**.

### 3. Instala y arranca (local, para probar)

```powershell
npm install
npm start
```

Deberías ver: `🚀 Andrea bot escuchando en el puerto 3000`.

### 4. Conecta el webhook en Evolution API

El bot necesita una **URL pública**. Dos opciones:

- **Recomendado: desplegar en EasyPanel** (ver abajo). La URL será algo como
  `https://andrea-bot.tudominio.com/webhook`.
- **Para probar desde tu PC:** usa un túnel como
  [ngrok](https://ngrok.com) → `ngrok http 3000` y usa la URL `https://....ngrok-free.app/webhook`.

Luego, en Evolution API, configura el webhook de tu instancia apuntando a esa URL
y activa el evento **MESSAGES_UPSERT**. (Por API: `POST /webhook/set/{instancia}`.)

Si pusiste `WEBHOOK_TOKEN`, añade `?token=TU_TOKEN` al final de la URL del webhook.

---

## ☁️ Desplegar en EasyPanel (recomendado)

1. Sube esta carpeta a un repositorio de GitHub (o usa el despliegue por código de EasyPanel).
2. En EasyPanel: **Create → App**, fuente = tu repo.
3. EasyPanel detecta el `Dockerfile` automáticamente.
4. En **Environment**, pega las mismas variables del `.env`.
5. Expón el puerto **3000** y asígnale un dominio.
6. La URL del webhook será: `https://TU-DOMINIO/webhook`.

Ventaja: el bot queda encendido 24/7 sin depender de tu PC, y al estar junto a
Evolution en EasyPanel la comunicación es directa y rápida.

---

## 🧪 Probar sin WhatsApp

Puedes simular un mensaje entrante con curl/PowerShell:

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/webhook" -Method Post -ContentType "application/json" -Body '{
  "event": "messages.upsert",
  "data": {
    "key": { "remoteJid": "51999999999@s.whatsapp.net", "fromMe": false, "id": "x" },
    "pushName": "Paciente de prueba",
    "message": { "conversation": "Hola, cuanto cuesta la consulta?" }
  }
}'
```

(El número de prueba debe ser real para que Evolution lo entregue; si no, solo verás
la respuesta generada en los logs.)

---

## 🔧 Estructura

```
andrea-bot/
├── src/
│   ├── index.js      # servidor web + webhook
│   ├── handler.js    # lógica al recibir un mensaje
│   ├── openai.js     # llamada a OpenAI
│   ├── evolution.js  # envío de mensajes por WhatsApp
│   ├── memory.js     # memoria en Supabase
│   ├── prompt.js     # personalidad y guion de Andrea
│   └── config.js     # carga de variables de entorno
├── supabase/schema.sql
├── Dockerfile
├── .env.example
└── README.md
```
