#!/usr/bin/env bash
# Dump decrypted project secrets for local Finalize DinD runs (Hub parity).
#
# Usage: ./scripts/load-finalize-project-secrets.sh <project-id> [out-file]
#        PROJECT_ID=<id> ./scripts/load-finalize-project-secrets.sh
#
# Requires Agent Hub docker compose server running.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_ID="${1:-${PROJECT_ID:-}}"
if [[ -z "$PROJECT_ID" ]]; then
  echo "Usage: $0 <project-id> [out-file]  (or set PROJECT_ID)" >&2
  exit 1
fi
OUT="${2:-/tmp/finalize-project-env.${PROJECT_ID}}"

if ! docker compose -f "$ROOT/docker-compose.yml" ps --status running --services 2>/dev/null | grep -qx server; then
  echo "Agent Hub server container is not running — start with: docker compose up -d" >&2
  exit 1
fi

docker compose -f "$ROOT/docker-compose.yml" exec -T server npx tsx -e "
import { loadProjectEnvForSpawn } from './preview/preview-secrets-store.ts';
const env = loadProjectEnvForSpawn('${PROJECT_ID}', { sessionId: null });
for (const [k, v] of Object.entries(env)) process.stdout.write(k + '=' + v + '\n');
" > "$OUT"

chmod 600 "$OUT"
echo "Wrote $(wc -l < "$OUT" | tr -d ' ') secret(s) to $OUT"
