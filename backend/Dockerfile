FROM node:20-alpine

# Install ffmpeg (required for restreaming)
RUN apk add --no-cache ffmpeg curl

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p logs

EXPOSE 3000

CMD ["node", "server.js"]
