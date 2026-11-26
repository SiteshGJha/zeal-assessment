FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json nest-cli.json ./
COPY prisma ./prisma
COPY src ./src
COPY mcp ./mcp

RUN npx prisma generate && npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY prisma ./prisma
COPY fixtures ./fixtures
COPY openapi.yaml ./openapi.yaml

EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/prisma/seed.js && node dist/src/main.js"]
