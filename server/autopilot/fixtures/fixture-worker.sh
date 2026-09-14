#!/usr/bin/env bash
# Deterministic Autopilot fixture worker. Not a real agent CLI: drains Hub
# stdin, optionally commits the complete-todo change, and emits Gemini
# stream-json so createChatHandler can persist an assistant message.
set -euo pipefail
cat >/dev/null 2>&1 || true
exec node "$(dirname "$0")/fixture-worker.mjs" "$@"
