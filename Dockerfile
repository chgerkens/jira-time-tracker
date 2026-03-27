FROM node:22-alpine

WORKDIR /app

COPY server.js ./
COPY public/ ./public/

EXPOSE 3001

ENTRYPOINT ["node", "server.js"]
