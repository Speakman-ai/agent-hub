# ── Build stage ──────────────────────────────────────────────────
FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Clear VITE_API_PORT so the client uses same-origin WebSocket via /ws
# (nginx proxies the upgrade to the server container)
ENV VITE_API_PORT=""
RUN npm run build

# ── Production stage ─────────────────────────────────────────────
FROM nginx:alpine

# Copy built assets
COPY --from=build /app/dist /usr/share/nginx/html

# Copy nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
