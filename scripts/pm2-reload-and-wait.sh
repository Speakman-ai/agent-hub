#!/usr/bin/env bash
# After deploy (npm ci, npm run build), (re)start the API with PM2 using
# ecosystem.config.cjs in this repo so cwd + tsx path always match the
# current checkout, then wait for /api/health. Used by SSM deploy workflows.
# Run from the repository root (same as interactive deploys on EC2).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Plain `pm2 restart agent-hub` reuses the *saved* process metadata; if the
# app was first registered with a different cwd/entry, restarts can leave
# nothing listening. Reloading from the ecosystem file keeps config aligned.
if pm2 describe agent-hub >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --update-env
else
  pm2 start ecosystem.config.cjs
fi

sleep 2
set -x
for i in $(seq 1 12); do
  if curl -fsS http://localhost:3051/api/health >/dev/null; then
    echo "health ok on attempt $i"
    set +e
    exit 0
  fi
  sleep 5
done
echo "health check FAILED after 12 attempts" >&2
set +e
pm2 list || true
pm2 describe agent-hub || true
pm2 logs agent-hub --lines 60 --nostream 2>&1 || true
exit 1
