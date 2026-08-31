# Sysbox Host Setup — SessionEnv sysbox adapter prerequisite

Per-session dev environments (dev server, PTY host, port mapping) run behind
the `SessionEnv` boundary with two backends: the **host adapter** (direct host
processes; local dev / Mac) and the **sysbox adapter** (per-session rootless
system container via [sysbox-runc](https://github.com/nestybox/sysbox) — no
`--privileged`, no host docker socket). Sysbox is the default isolation
boundary on a self-hosted Linux server, and it needs a one-time host install.
This doc is that install, plus the decision record and capacity guidance.

## Decision: source-build on Amazon Linux 2023 (no second node)

**Chosen path: install sysbox from source on the existing AL2023 host.**

- The reference host (`agenthub-sandbox`, m7i.2xlarge, Nitro non-metal,
  AL2023, kernel 6.1, x86_64) clears every sysbox kernel gate: unprivileged
  user namespaces plus idmapped mounts (kernel >= 5.12 required, >= 5.19
  recommended — 6.1 needs no shiftfs and no distro patches). No nested
  virtualization is required; sysbox is a container runtime, not a VM.
- Sysbox's official
  [distro-compat matrix](https://github.com/nestybox/sysbox/blob/master/docs/distro-compat.md)
  lists **Amazon Linux 2023 as a supported build-from-source target
  (kernel 6.1+)**. Only Ubuntu/Debian get prebuilt `.deb` packages; there is
  no rpm. The source build runs inside a container (`make sysbox-static`), so
  it does not pollute the host toolchain.
- A dedicated Ubuntu 24.04 sysbox node (the finalize-runner-fleet pattern)
  stays as the **documented fallback** if the AL2023 source build proves
  unmaintainable across sysbox upgrades — the Hub side needs no change, since
  adapter selection is a boot-time capability probe, not a config assumption.
- **Firecracker is out on current infra**: m7i.2xlarge is non-metal, no
  `/dev/kvm`. The hardened microVM tier stays deferred behind a real
  multi-tenant trigger and would need a `.metal` (or nested-virt) instance.

## Host requirements

| Requirement                                                   | Gate           | AL2023 host          |
| ------------------------------------------------------------- | -------------- | -------------------- |
| Linux                                                         | hard           | yes                  |
| Kernel >= 5.12 (idmapped mounts; >= 5.19 recommended)         | hard           | 6.1 ✅               |
| Unprivileged user namespaces (`user.max_user_namespaces > 0`) | hard           | on by default ✅     |
| Docker installed natively (snap Docker is incompatible)       | hard           | ECS-optimized AMI ✅ |
| Nested virtualization / KVM                                   | **not needed** | n/a                  |

## Install

Run the idempotent setup script as root on the host:

```bash
sudo ops/scripts/setup-sysbox-host.sh --verify-run
```

What it does:

1. Verifies kernel version, user-namespace sysctl, and native Docker.
2. Installs `sysbox-runc`:
   - Ubuntu/Debian: official `sysbox-ce` `.deb` (registers the runtime and
     systemd units itself).
   - AL2023 / other kernel >= 5.12 distros: clones the pinned release tag,
     builds via `make sysbox-static` (containerized build), `make install`,
     and installs `sysbox-mgr.service` + `sysbox-fs.service` units.
3. Merges the `sysbox-runc` runtime (and, when opted in, a widened
   `default-address-pools`) into `/etc/docker/daemon.json` (backup kept beside
   it) and restarts dockerd **only if the merged config actually changed**.
   Pass `--skip-docker-restart` to defer the restart to a maintenance window —
   running containers with restart policies come back, but in-flight
   `docker exec`s die. Re-running purely to add or change pools works on an
   already-sysbox host.
4. `--verify-run` launches a throwaway `--runtime=sysbox-runc` container to
   prove the runtime end to end.

Pin a different release with `SYSBOX_VERSION=x.y.z`.

## Preview network capacity — widen `default-address-pools`

Each session compose preview allocates its own Docker network from the
daemon's `default-address-pools`. Stock dockerd only offers **~31 subnets**
(`172.17.0.0/16`–`172.31.0.0/16` as /16s, plus `192.168.0.0/20`–
`192.168.240.0/20`). On a busy shared preview host, concurrent and long-lived
session/test stacks consume every pool, and new previews fail the build with:

```
could not find an available, non-overlapping IPv4 address pool among the defaults
```

`docker network prune` does **not** help while those networks have live
containers attached (they belong to other active sessions, not leaks). The Hub
surfaces this exact case as a preview boot diagnostic, but the durable fix is
host capacity: widen the pool so thousands of small per-preview networks fit.

Opt in on the setup script (OFF by default — no behavior change unless set):

```bash
# Carve /24s out of 10.128.0.0/9 → 32768 preview networks, 256 addrs each.
sudo ops/scripts/setup-sysbox-host.sh --address-pool-base 10.128.0.0/9 --address-pool-size 24
# Env form (same effect):
sudo AGENT_HUB_DOCKER_ADDRESS_POOL_BASE=10.128.0.0/9 \
     AGENT_HUB_DOCKER_ADDRESS_POOL_SIZE=24 ops/scripts/setup-sysbox-host.sh
```

- `--address-pool-base <cidr>` — the supernet the daemon carves preview
  networks from. **It MUST NOT overlap this host's VPC/subnet CIDR.** Docker
  keeps `10.0.0.0/8` out of its stock defaults precisely because AWS VPCs
  commonly live there; a base that collides with the VPC silently breaks
  host↔container routing. Confirm your VPC/subnet ranges (e.g. `ip route`,
  the VPC CIDR in the console) and pick a supernet with no overlap. On the
  reference infra the VPC sits low in `10.0.0.0/16`, so `10.128.0.0/9`
  (i.e. `10.128.0.0`–`10.255.255.255`) is clear. The value must be a valid
  **canonical IPv4 network base with an explicit prefix** — host bits must be
  zero (`10.128.0.0/9`, not `10.128.5.3/9`). The setup script parses and
  rejects anything else _before_ it edits `daemon.json`, so a typo can never
  wedge the docker restart.
- `--address-pool-size <n>` — prefix length per preview network (default `24`
  = 256 addresses). Must be `>=` the base prefix and `<= 30`. Bigger `n` =
  more, smaller networks.

Applying this restarts dockerd (unless `--skip-docker-restart`), which bounces
running containers — do it in a maintenance window on a busy host. Enable
`live-restore` in `daemon.json` first if you want containers to survive the
restart.

## Hub adapter selection (boot capability probe)

At boot the Hub probes the host (`server/session-env/sysbox-capability.ts`):
platform, kernel >= 5.12, userns sysctl, `sysbox-runc --version`, and the
runtime being registered with the Docker daemon. It logs one line:

```
[session-env] adapter=sysbox (mode=auto) — sysbox available (auto)
```

Selection is controlled by `sessionEnvAdapter` in config.json or the
`AGENT_HUB_SESSION_ENV_ADAPTER` env var:

- `auto` (default) — sysbox when the probe passes, else host. MicroVM
  (`firecracker`) and privileged DinD (`container`) are **never** picked by
  `auto`. A Linux host degrading to the host adapter logs a **warning** (the
  server is running without the intended isolation boundary).
- `host` — force the host adapter (local dev, or debugging sysbox issues).
- `sysbox` — force sysbox; if the probe fails, the Hub **fails closed**
  (sessions error until sysbox is fixed or the mode is changed to `auto`).
- `container` — force privileged DinD; degrades to host with a warning when
  Docker is unavailable.
- `firecracker` — force microVM isolation (experimental; not auto-selected).
  Requires `/dev/kvm` and staged guest artifacts; fails closed when the probe
  fails. The VMM runs under the jailer by default. Agent CLI turns on the Hub
  host are refused while this mode is active (env-owned guest worktree).

Unknown values fall back to `auto` — a typo never forces a backend.

## Disk headroom & capacity

- **Budget ~0.5–1 GB per concurrent session** (session container rootfs +
  the project's own backing-service images pulled _inside_ the session
  container's inner dockerd). On the shared 32 GB m7i.2xlarge running the
  Hub + finalize runners, size the docker volume for peak concurrent
  sessions plus the finalize fleet; 100 GB+ gp3 is a sane floor.
- Session containers are removed at session end / idle reap, but their inner
  image caches live in per-session docker volumes — remove them with the
  container (`docker rm -v`, mirroring the finalize-runner teardown).
- The deploy template's daily docker GC
  (`agenthub-docker-gc.timer` in `ops/terraform/agent-hub-user-data.tftpl`:
  container/image/builder/volume prune, `until=24h`) also reaps leaked
  session containers and dangling session images. If sessions churn faster
  than daily, tighten the timer rather than adding a second prune path.
- Watch `df -h /var/lib/docker`; the GC script prints it on every run. The
  host has been lost to disk-full → `docker pull` failure → ALB 502 before
  (kanban post-mortems b2528863, 8b59c789) — headroom is not optional.

## Deploy-template note

Sysbox install is an **operator step, not cloud-init**: the source build
takes minutes and pulls from GitHub, both unacceptable in the boot path.
`ops/terraform/agent-hub-user-data.tftpl` carries a pointer to this doc; run
the setup script once per host (new AMI/instance = run it again). The Hub
needs no restart ordering guarantee — if it boots before sysbox is installed
it selects the host adapter, and the next restart after install picks up
sysbox automatically.

## Verifying an installed host

```bash
sysbox-runc --version
systemctl status sysbox-mgr sysbox-fs   # source-build installs (AL2023)
systemctl status sysbox                 # package installs (Ubuntu/Debian)
docker info --format '{{json .Runtimes}}' | jq 'keys'   # expect "sysbox-runc"
docker run --runtime=sysbox-runc --rm alpine:3 echo sysbox-ok
```
