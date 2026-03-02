FROM node:20-alpine

RUN apk add --no-cache curl ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
