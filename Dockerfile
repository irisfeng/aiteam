# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22.14.0-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
COPY desktop/package.json desktop/package.json
RUN npm ci --no-audit --workspace server --workspace web --include-workspace-root

COPY server server
COPY web web
RUN npm run build

FROM ${NODE_IMAGE} AS production-dependencies
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
COPY desktop/package.json desktop/package.json
RUN npm ci --no-audit --omit=dev --workspace server --include-workspace-root=false \
  && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime

ARG AITEAM_RELEASE_SHA=unknown
LABEL org.opencontainers.image.title="AITeam" \
  org.opencontainers.image.revision="${AITEAM_RELEASE_SHA}"

ENV NODE_ENV=production \
  PORT=8787 \
  AITEAM_HOST=0.0.0.0 \
  AITEAM_DATA_DIR=/data \
  AITEAM_RELEASE_SHA=${AITEAM_RELEASE_SHA}

WORKDIR /app
RUN groupadd --gid 10001 aiteam \
  && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/aiteam aiteam \
  && install -d -o 10001 -g 10001 -m 0700 /data \
  && printf '%s\n' "${AITEAM_RELEASE_SHA}" > /app/RELEASE_SHA \
  && chmod 0444 /app/RELEASE_SHA

COPY --from=production-dependencies --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/server/dist ./server/dist
COPY --from=build --chown=10001:10001 /app/web/dist ./web/dist
COPY --chown=10001:10001 scripts/container-entrypoint.mjs scripts/container-healthcheck.mjs scripts/gray-data-audit.mjs ./scripts/

USER 10001:10001
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD ["node", "scripts/container-healthcheck.mjs"]

CMD ["node", "scripts/container-entrypoint.mjs"]
