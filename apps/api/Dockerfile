# NEXORA API — multi-stage build (ADR-005).
# Bundle: esbuild single-file output; @prisma/client + generated engine stay external.
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/contracts/package.json packages/contracts/
COPY packages/config/package.json packages/config/
COPY packages/logging/package.json packages/logging/
COPY packages/events/package.json packages/events/
COPY packages/auth/package.json packages/auth/
COPY packages/db/package.json packages/db/
COPY packages/router-sdk/package.json packages/router-sdk/
COPY packages/payment-sdk/package.json packages/payment-sdk/
COPY apps/api/package.json apps/api/

RUN npm ci --workspace @nexora/api --include-workspace-root

COPY . .
RUN npm run db:generate && npm run build --workspace @nexora/api

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S nexora && adduser -S nexora -G nexora

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/packages/db/prisma ./prisma

USER nexora
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.cjs"]
