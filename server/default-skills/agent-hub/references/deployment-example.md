# Deployment — Example Template (unlinked)

> **Stub.** This is an example scaffold for self-hosting Agent Hub. Replace every
> angle-bracket placeholder (`<your-host>`, `<your-bucket>`, `<your-role>`, etc.)
> with values from your own infrastructure. Agent Hub does **not** ship with a
> reference deployment and encodes no hostnames, bucket names, or IAM roles.
>
> This file is intentionally **not linked from SKILL.md** — it's reserved as a
> placeholder for operator-facing docs so the no-prod-infra guard has something
> to assert against. For the agent-facing surfaces, start at
> [SKILL.md](../SKILL.md).

## Topology

A typical Agent Hub server deployment:

```
Browser / Mobile / Desktop
           │
           ▼
    <your-host>:443            ← TLS-terminating reverse proxy
           │
           ▼
  localhost:3051 (Node.js)     ← Express + WebSocket, managed by PM2 / systemd
           │
           ▼
   SQLite (local, WAL mode)
```

## Environment Variables

| Variable           | Example                                     | Purpose                                          |
| ------------------ | ------------------------------------------- | ------------------------------------------------ |
| `PORT`             | `3051`                                      | HTTP/WebSocket port bound by the Node process.   |
| `ALLOWED_ORIGINS`  | `https://<your-host>`                       | Comma-separated browser origin allowlist (CORS). |
| `DATA_DIR`         | `/var/lib/agent-hub`                        | Where SQLite, configs, and workspaces live.      |
| `PUBLIC_URL`       | `https://<your-host>`                       | External URL used for webhook and PR callbacks.  |

> **Security:** `ALLOWED_ORIGINS` should list only the hosts your real web
> clients use. Unknown origins get no CORS header and the browser's SOP blocks
> them. Non-browser clients (Electron, mobile, server-to-server) bypass CORS
> because they don't send an Origin header.

## Reverse Proxy

Any TLS-terminating proxy works (Nginx, Caddy, Traefik, an ALB). Forward HTTP
and WebSocket traffic to `localhost:3051`:

```nginx
server {
  listen 443 ssl http2;
  server_name <your-host>;

  location / {
    proxy_pass http://localhost:3051;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

If you sit behind a non-loopback proxy (ALB, Cloudflare, etc.), revisit the
`trust proxy` value in `server/index.ts` so per-IP rate limits still see the
real client address.

## Process Manager

PM2 is one option; systemd, Docker, or Nomad are equally fine. A PM2 example:

```bash
# Start (one-time)
pm2 start ecosystem.config.cjs

# Update on deploy
git pull
npm install
npm run build
(cd server && npm install)
pm2 restart <your-pm2-app-name>
```

`ecosystem.config.cjs` lives in the repo root — set `name`, `cwd`, and env
values to match your environment.

## Artifact Storage (optional)

If you publish desktop builds via the Electron auto-updater, point it at your
own bucket:

| Placeholder         | Example                  | Notes                                |
| ------------------- | ------------------------ | ------------------------------------ |
| `<your-bucket>`     | `my-org-hub-releases`    | S3/GCS/R2 bucket for DMG/exe/deb.    |
| `<your-role>`       | `hub-deploy-role`        | IAM role assumed by CI for uploads.  |
| `<your-region>`     | `us-east-2`              | Region for the bucket & role.        |

## CI / Deploy

The specifics depend on your CI system. A typical flow:

1. CI checks out the tag, runs `npm install && npm run build`.
2. CI packages/signs the Electron build (if releasing desktop).
3. CI uploads artifacts to `<your-bucket>` using `<your-role>`.
4. CI SSHs / invokes a remote command on `<your-host>` to `git pull` and
   restart the process manager.

This file is intentionally a stub. Fill in your own values; do **not** commit
real hostnames, bucket names, or IAM role ARNs back into this template.
