# Build para Railway (contexto = raíz del repo).
# Para desarrollo local usá docker-compose, que usa backend/Dockerfile.
FROM node:20-alpine

WORKDIR /app

COPY backend/package*.json ./
RUN npm install --omit=dev

COPY backend/src ./src

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "src/index.js"]
