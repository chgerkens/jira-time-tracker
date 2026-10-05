FROM node:24-alpine

WORKDIR /app

COPY server.js ./
COPY public/ ./public/

ENV HOST=0.0.0.0
USER node

EXPOSE 3001

ENTRYPOINT ["node", "server.js"]
