# The AutoDev backend in one image. The service it runs is chosen at start by AUTODEV_SERVICE
# (api | worker | gateway | migrate), so every host can use the same build:
#   docker build -t autodev .
#   docker run -e AUTODEV_SERVICE=worker ... autodev
# Named targets exist for local convenience (--target api|worker|gateway|migrate|web).
# The web app is built separately (Vercel builds it itself; --target web is for self-hosting).
# See docs/deploy-backend.md.

FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

FROM base AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @autodev/api --filter @autodev/worker --filter @autodev/builder-gateway build

FROM build AS web-build
# The web app proxies /api/* to the API; the address is fixed at build time.
ARG API_URL=http://api:4000
ENV API_URL=$API_URL
RUN pnpm --filter @autodev/web build

FROM base AS web
ENV NODE_ENV=production
COPY --from=web-build /app /app
USER node
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-p", "3000"]

FROM base AS backend
ENV NODE_ENV=production
# The code index downloads its embedding model (about 160 MB) here on first use; mount a volume to keep it.
ENV EMBEDDINGS_CACHE_DIR=/var/cache/autodev/embeddings
COPY --from=build /app /app
COPY docker/entrypoint.sh /usr/local/bin/autodev
RUN mkdir -p /var/cache/autodev/embeddings && chown -R node:node /var/cache/autodev
USER node
EXPOSE 4000 4100
# Health for the HTTP services (api, gateway); the worker and migrate have no port and report healthy.
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "const s=process.env.AUTODEV_SERVICE||'api';if(s!=='api'&&s!=='gateway')process.exit(0);const p=process.env.PORT||(s==='api'?4000:process.env.GATEWAY_PORT||4100);fetch('http://127.0.0.1:'+p+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/autodev"]

FROM backend AS api
ENV AUTODEV_SERVICE=api
FROM backend AS worker
ENV AUTODEV_SERVICE=worker
FROM backend AS gateway
ENV AUTODEV_SERVICE=gateway
FROM backend AS migrate
ENV AUTODEV_SERVICE=migrate

# Default (no --target): the backend image, service chosen by AUTODEV_SERVICE.
FROM backend
