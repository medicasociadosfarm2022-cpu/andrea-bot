FROM node:22-alpine

WORKDIR /app

# Instalar dependencias primero (mejor cacheo)
COPY package*.json ./
RUN npm install --omit=dev

# Copiar el resto del código
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/index.js"]
