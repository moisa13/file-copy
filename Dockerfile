FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY src/ src/
COPY public/ public/

RUN mkdir -p data logs && chown -R node:node /app

USER node

EXPOSE 3020

CMD ["node", "src/index.js"]
