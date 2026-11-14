FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --legacy-peer-deps --no-audit --no-fund

COPY . .

EXPOSE 3000
CMD ["npm", "start"]
