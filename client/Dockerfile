FROM node:20-slim AS build

WORKDIR /app

# Copy shared utilities first
COPY shared/ ./shared/

# Install client dependencies
COPY client/package.json client/package-lock.json ./client/
WORKDIR /app/client
RUN npm ci

# Copy client source and build
COPY client/ ./
# Vite reads repo-root package.json for VITE_APP_VERSION (see vite.config.js).
COPY package.json /app/package.json
# Vendor control-plane endpoints are build-time configurable and DISABLED by
# default (empty) so a self-hosted build never phones home. Point them at your
# own hub via docker-compose build args / .env (see .env.example).
# VITE_REPLAY_INGEST_ENDPOINT derives from the bug-report origin when unset.
ARG VITE_BUG_REPORT_ENDPOINT=""
ARG VITE_REPLAY_INGEST_ENDPOINT=""
ARG VITE_RELEASE_BUCKET_BASE=""
RUN VITE_API_PORT="" \
    VITE_BUG_REPORT_ENDPOINT="${VITE_BUG_REPORT_ENDPOINT}" \
    VITE_REPLAY_INGEST_ENDPOINT="${VITE_REPLAY_INGEST_ENDPOINT}" \
    VITE_RELEASE_BUCKET_BASE="${VITE_RELEASE_BUCKET_BASE}" \
    npm run build

FROM nginx:alpine

COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html

EXPOSE 80
