FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --legacy-peer-deps --no-audit --no-fund; else npm install --omit=dev --legacy-peer-deps --no-audit --no-fund; fi

COPY . .

EXPOSE 3000 8000
CMD ["node", "index.js"]
