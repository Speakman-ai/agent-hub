#!/usr/bin/env bash
# Smoke-test the agent desktop image: boot, screenshot, click, exec.
#
#   server/desktop/image/smoke-test.sh [image]          # default agent-hub/desktop:dev
#   server/desktop/image/smoke-test.sh --build [image]  # build from this checkout first
#
# Starts the container the way the host will (unprivileged, every capability
# dropped, no docker socket), drives it through the control daemon's HTTP API,
# and removes it on exit. Needs docker, curl and node on the host.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$ROOT/../../.." && pwd)"

build=0
if [[ "${1:-}" == "--build" ]]; then
  build=1
  shift
fi
IMAGE="${1:-${DESKTOP_IMAGE:-agent-hub/desktop:dev}}"

if (( build )); then
  docker build -f "$ROOT/Dockerfile" -t "$IMAGE" "$REPO_ROOT"
fi

TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')"
NAME="agent-hub-desktop-smoke-$$"

cleanup() {
  local rc=$?
  if (( rc != 0 )); then
    echo "--- container logs ---" >&2
    docker logs "$NAME" 2>&1 | tail -50 >&2 || true
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "ok   $*"; }

docker run -d --name "$NAME" \
  --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1::7300 \
  -e DESKTOP_CONTROL_TOKEN="$TOKEN" \
  "$IMAGE" >/dev/null

PORT="$(docker port "$NAME" 7300/tcp | head -1 | sed 's/.*://')"
[[ -n "$PORT" ]] || fail "control port was not published"
# The published loopback port is what the Hub uses on a docker host. When this
# script itself runs inside a container (an Agent Hub session, a DinD runner)
# that loopback is the wrong one, so fall back to the bridge IP.
CANDIDATES=("http://127.0.0.1:$PORT")
IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$NAME" | awk '{print $1}')"
[[ -n "$IP" ]] && CANDIDATES+=("http://$IP:7300")

# ── boot ─────────────────────────────────────────────────────────────────────
BASE=""
for _ in $(seq 1 60); do
  for c in "${CANDIDATES[@]}"; do
    if curl -fsS --max-time 2 "$c/healthz" >/dev/null 2>&1; then
      BASE="$c"
      break 2
    fi
  done
  if [[ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]]; then
    fail "container exited during boot"
  fi
  sleep 0.5
done
[[ -n "$BASE" ]] || fail "control daemon never answered /healthz on ${CANDIDATES[*]}"
health="$(curl -fsS "$BASE/healthz")" || fail "control daemon never answered /healthz"
node -e '
  const h = JSON.parse(process.argv[1]);
  if (!h.ok || h.width !== 1280 || h.height !== 800) throw new Error("bad healthz: " + process.argv[1]);
' "$health" || fail "healthz did not report a 1280x800 display"
pass "boot ($health)"

[[ "$(docker inspect -f '{{.Config.User}}' "$NAME")" == "desktop" ]] || fail "image does not run as the desktop user"
if docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$NAME" | grep -q docker.sock; then
  fail "docker socket is mounted"
fi
pass "unprivileged, no docker socket mount"

op() {
  curl -sS -X POST "$BASE/v1/op" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    --data "$1"
}
# Assert a reply is ok and optionally evaluate a JS expression against it (`r`).
expect_ok() {
  node -e '
    const r = JSON.parse(process.argv[1]);
    if (!r.ok) throw new Error(r.error || "not ok");
    if (!new Function("r", "return (" + process.argv[2] + ");")(r)) {
      throw new Error("check failed: " + process.argv[2] + " reply=" + JSON.stringify(r).slice(0, 500));
    }
  ' "$1" "${2:-true}"
}

code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/op" --data '{"op":"screenshot"}')"
[[ "$code" == "401" ]] || fail "unauthenticated op returned $code, want 401"
pass "unauthenticated op refused"

# ── exec ─────────────────────────────────────────────────────────────────────
r="$(op '{"op":"exec","command":"echo hello-desktop; id -u"}')"
expect_ok "$r" 'r.exitCode === 0 && r.stdout === "hello-desktop\n1000\n"' || fail "exec: $r"
pass "exec runs as uid 1000"

r="$(op '{"op":"exec","command":"test ! -e /var/run/docker.sock && ! command -v docker && ! printenv DESKTOP_CONTROL_TOKEN"}')"
expect_ok "$r" 'r.exitCode === 0' || fail "exec sees a docker socket, docker CLI or the control token: $r"
pass "exec has no docker access and cannot read the control token"

r="$(op '{"op":"exec","command":"sleep 5","timeoutMs":300}')"
expect_ok "$r" 'r.timedOut === true' || fail "exec timeout: $r"
pass "exec timeout kills the command"

# ── screenshot ───────────────────────────────────────────────────────────────
r="$(op '{"op":"screenshot"}')"
expect_ok "$r" '(() => {
  const png = Buffer.from(r.png, "base64");
  return png.subarray(1, 4).toString() === "PNG" && png.readUInt32BE(16) === 1280 && png.readUInt32BE(20) === 800;
})()' || fail "screenshot is not a 1280x800 PNG"
pass "screenshot is a 1280x800 PNG"

# ── chromium + click ─────────────────────────────────────────────────────────
r="$(op '{"op":"exec","command":"chromium about:blank >/tmp/chromium.log 2>&1 &"}')"
expect_ok "$r" 'r.exitCode === 0' || fail "launching chromium: $r"
r="$(op '{"op":"exec","command":"for i in $(seq 1 60); do xdotool search --onlyvisible --class chromium >/dev/null 2>&1 && exit 0; sleep 0.5; done; cat /tmp/chromium.log; exit 1","timeoutMs":40000}')"
expect_ok "$r" 'r.exitCode === 0' || fail "chromium window never appeared: $r"
pass "chromium window is up"

r="$(op '{"op":"exec","command":"for i in $(seq 1 20); do curl -fsS --max-time 2 http://127.0.0.1:9222/json/list | grep -q about:blank && exit 0; sleep 0.5; done; exit 1","timeoutMs":20000}')"
expect_ok "$r" 'r.exitCode === 0' || fail "chromium DevTools tab list (approval gate site lookup) unavailable: $r"
pass "chromium lists its tabs on the loopback DevTools port"

r="$(op '{"op":"click","x":640,"y":400}')"
expect_ok "$r" || fail "click: $r"
r="$(op '{"op":"cursor_position"}')"
expect_ok "$r" 'r.x === 640 && r.y === 400' || fail "cursor did not move to the click point: $r"
pass "click lands at (640,400)"

for body in \
  '{"op":"double_click","x":100,"y":100}' \
  '{"op":"key","combo":"ctrl+l"}' \
  '{"op":"type","text":"about:blank"}' \
  '{"op":"key","combo":"Return"}' \
  '{"op":"scroll","x":640,"y":400,"direction":"down","amount":2}' \
  '{"op":"drag","x":200,"y":200,"toX":300,"toY":300}' \
  '{"op":"wait","ms":100}'; do
  r="$(op "$body")"
  expect_ok "$r" || fail "$body: $r"
done
pass "double_click, key, type, scroll, drag, wait"

# 1,500 chars at 12 ms each is ~18 s, past a fixed 15 s input deadline.
long_text="$(printf 'a%.0s' $(seq 1 1500))"
r="$(op "{\"op\":\"type\",\"text\":\"$long_text\"}")"
expect_ok "$r" || fail "long type was cut off: $r"
pass "long type completes"

r="$(op '{"op":"click","x":1280,"y":0}')"
node -e 'const r = JSON.parse(process.argv[1]); if (r.ok) process.exit(1)' "$r" || fail "off-screen click was accepted"
pass "off-screen coordinates refused"

echo "desktop smoke test passed: $IMAGE"
