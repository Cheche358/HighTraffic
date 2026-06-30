FROM node:22-alpine

# Docker CLI para discovery (docker service ls/inspect) y escalado (docker service scale)
RUN apk add --no-cache docker-cli

WORKDIR /app
COPY scaler.js engine.js server.js ./
COPY public/ ./public/

EXPOSE 9099

CMD ["node", "server.js"]
