#!/usr/bin/env node
// Container pool — lean PR env fallback HTTP server (W3).
//
// This runs inside `ghcr.io/.../agent-hub/pr-env-base:*` when a PR repo
// comes in "bare" (no Dockerfile of its own). Its only job is to answer
// the compose healthcheck probe (wget -qO- http://localhost:3000/) with
// a 200 so the dispatcher moves the slot to `running` instead of
// reaping it as `failed`.
//
// Why keep this tiny:
//   - It ships in the base layer of every PR env. Extra deps = extra
//     compressed bytes on every image pull for every PR on every host.
//   - It must NOT require npm install at container start — the dispatcher
//     is on a 60 s healthcheck budget (compose template `start_period`).
//
// Intentionally:
//   - No dependencies beyond Node 20 stdlib.
//   - No filesystem writes (would collide with read_only-friendly bases).
//   - Responds on `$PORT || 3000` with a tiny JSON body; any path works.

import { createServer } from 'node:http';

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const BODY = JSON.stringify({
  ok: true,
  service: 'agent-hub/pr-env-base',
  note: 'Fallback healthcheck. Override CMD in your PR repo to run your app.',
});

const server = createServer((_req, res) => {
  res.writeHead(200, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(BODY);
});

// Accept SIGTERM so `docker compose down --timeout 30` drains cleanly.
// tini (ENTRYPOINT) forwards the signal; we just need to stop accepting
// new connections and let in-flight ones finish.
const shutdown = (signal) => {
  console.log(`[pr-env-base] received ${signal}, closing server`);
  server.close(() => process.exit(0));
  // Belt-and-braces: if `close` hangs past the compose drain window,
  // exit anyway so the slot is released for the next PR.
  setTimeout(() => process.exit(0), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, () => {
  console.log(`[pr-env-base] fallback healthcheck listening on :${PORT}`);
});
