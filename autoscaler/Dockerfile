FROM node:22-alpine

# Instalar Docker CLI para ejecutar 'docker service scale'
RUN apk add --no-cache docker-cli

WORKDIR /app
COPY server.js .
COPY public/ ./public/

EXPOSE 9099

CMD ["node", "server.js"]
