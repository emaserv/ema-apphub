# EMA AppHub · backend (contexto de build: raíz del repositorio)
FROM node:24-alpine AS build
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
# Docker CLI + Compose + Buildx para builds/deploys, git/ssh para repositorios, tar para backups
RUN apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git openssh-client tar tini ca-certificates tzdata wget
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000 \
    MIGRATIONS_DIR=/app/database \
    TZ=America/Argentina/Buenos_Aires
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY backend/package.json ./
COPY database ./database
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/api/health >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
