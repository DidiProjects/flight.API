FROM node:22-alpine3.21 AS builder
WORKDIR /app

LABEL app=flight-api
LABEL project=flight
LABEL maintainer=diego

COPY package*.json ./
RUN npm ci --silent

COPY . .
RUN npm run build && npm prune --production

FROM node:22-alpine3.21
WORKDIR /app

RUN apk add --no-cache curl

COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs

EXPOSE 3011

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3011/health || exit 1

CMD ["node", "build/index.js"]
