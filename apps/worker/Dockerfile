# NEXORA worker — multi-stage build (ADR-005).
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/contracts/package.json packages/contracts/
COPY packages/config/package.json packages/config/
COPY packages/logging/package.json packages/logging/
COPY packages/events/package.json packages/events/
COPY packages/auth/package.json packages/auth/
COPY packages/engines/package.json packages/engines/
COPY packages/db/package.json packages/db/
COPY packages/router-sdk/package.json packages/router-sdk/
COPY packages/payment-sdk/package.json packages/payment-sdk/
COPY apps/worker/package.json apps/worker/

RUN npm ci --workspace @nexora/worker --include-workspace-root

COPY . .
RUN npm run db:generate && npm run build --workspace @nexora/worker

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S nexora && adduser -S nexora -G nexora

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/worker/dist ./dist
COPY --from=build /app/packages/db/prisma ./prisma

USER nexora
CMD ["node", "dist/index.cjs"]
