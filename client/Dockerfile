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
RUN VITE_API_PORT="" npm run build

FROM nginx:alpine

COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html

EXPOSE 80
