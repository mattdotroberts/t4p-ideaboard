FROM node:22-alpine
WORKDIR /app

COPY server.js index.html seed-notes.json ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
