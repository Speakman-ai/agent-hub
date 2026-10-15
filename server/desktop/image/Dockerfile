# Agent desktop image (SPEC-5 container backend): Debian slim + Xvfb (1280x800)
# + openbox + Chromium + xdotool + scrot, driven by the control daemon in
# server/desktop/control-daemon.ts.
#
# Runs unprivileged: the final USER is `desktop` (uid 1000), nothing needs
# extra capabilities, and no docker socket is mounted or installed. Start it
# with `--cap-drop ALL --security-opt no-new-privileges`; smoke-test.sh does.
#
#   docker build -f server/desktop/image/Dockerfile -t agent-hub/desktop:dev .
#   server/desktop/image/smoke-test.sh agent-hub/desktop:dev
#
# Build context is the repo root, same as the server and runner images.

# Node is copied in rather than installed from apt: Debian's nodejs lags, and
# the daemon runs its .ts source directly with Node's built-in type stripping
# (Node >= 22.18), so no build step or node_modules is needed.
FROM node:22-bookworm-slim AS node

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    DESKTOP_WIDTH=1280 \
    DESKTOP_HEIGHT=800 \
    DESKTOP_CONTROL_PORT=7300 \
    LANG=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb openbox xdotool scrot x11-utils \
      chromium fonts-dejavu-core fonts-liberation \
      tini bash ca-certificates curl procps xdg-utils \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node

# Chromium's own sandbox needs user namespaces, which Docker's default seccomp
# profile refuses to an unprivileged container. The container is the sandbox
# here, so Chromium runs without its inner one. /dev/shm is 64 MB by default.
RUN printf '%s\n' \
      'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check --password-store=basic"' \
      > /etc/chromium.d/agent-hub

# uid 1000 so a host-side persistent home volume gets a stable owner.
RUN groupadd --gid 1000 desktop \
 && useradd --uid 1000 --gid 1000 --create-home --home-dir /home/desktop --shell /bin/bash desktop \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

COPY server/desktop/control-daemon.ts /opt/agent-hub-desktop/control-daemon.ts
COPY server/desktop/image/entrypoint.sh /opt/agent-hub-desktop/entrypoint.sh
RUN chmod 0755 /opt/agent-hub-desktop/entrypoint.sh

USER desktop
WORKDIR /home/desktop
VOLUME ["/home/desktop"]
EXPOSE 7300

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${DESKTOP_CONTROL_PORT}/healthz" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/opt/agent-hub-desktop/entrypoint.sh"]
