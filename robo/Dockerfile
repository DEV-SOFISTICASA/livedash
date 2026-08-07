# LiveDash · robô no Render (Background Worker)
# node:20-slim + Chromium do Playwright instalado no build (--with-deps roda o apt
# como root aqui, e a versão do navegador casa sozinha com a do npm).
FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev
RUN npx playwright install --with-deps chromium

COPY . .

ENV NODE_ENV=production
CMD ["node", "robo-loop.js"]
