# Finalize remote runner — Phase 2a smoke (no AWS)

Validates the whole pull-based remote-runner protocol end-to-end on **one host**:
the Hub enqueues jobs, a locally-run `runner-agent` claims them, runs each in a
fresh privileged DinD container, and streams logs back to the live checks panel —
exactly what the ECS fleet will do later, minus AWS.

Everything is gated behind `FINALIZE_RUNNER_BACKEND=remote`; with it unset the Hub
uses the local DinD backend (unchanged).

## Prereqs
- Docker available to the Hub process (privileged `docker run` allowed).
- The finalize runner image present (`agent-hub/finalize-runner:ubuntu-24.04`) —
  build via `server/finalize/runner/build.sh` or set
  `FINALIZE_RUNNER_IMAGE_UBUNTU_24_04` to a pulled tag.
- A project/session whose worktree has `.agent-hub/ci.yaml` (start small — a
  one-job ci.yaml — to keep local memory sane; this is the box's job at scale).
- A shared bundle dir readable by BOTH the Hub and the agent (same host):
  `mkdir -p /tmp/finalize-bundles`

## 1. Start the Hub with the remote backend enabled
```
FINALIZE_RUNNER_BACKEND=remote \
FINALIZE_RUNNER_FLEET_TOKEN=dev-fleet-secret \
FINALIZE_RUNNER_TOKEN_SECRET=dev-token-secret \
FINALIZE_RUNNER_BUNDLE_DIR=/tmp/finalize-bundles \
npm run dev:server
```

## 2. Start a runner-agent (separate terminal, same host)
```
FINALIZE_RUNNER_FLEET_TOKEN=dev-fleet-secret \
FINALIZE_RUNNER_TOKEN_SECRET=dev-token-secret \
FINALIZE_RUNNER_HUB_URL=http://127.0.0.1:3051 \
FINALIZE_RUNNER_BUNDLE_DIR=/tmp/finalize-bundles \
FINALIZE_RUNNER_WORKSPACE_DIR=/tmp/finalize-agent-ws \
npx tsx server/finalize/runner-agent.ts
```
Expect: `[runner-agent] registered; polling http://127.0.0.1:3051 (scope=shared)`.

## 3. Trigger a Finalize run from the UI (or the normal flow)
Expected, in order:
- agent logs `claimed job <id> (<jobId>)`,
- a privileged DinD runner container starts on the host (`docker ps` shows
  `finalize-<run>-<job>-…`),
- the checks panel streams the job's step logs live (same path as local DinD),
- on completion the agent tears the container down and goes back to polling;
  pass/fail/`infra_error` propagate to the run exactly as before.

## What this proves before any AWS spend
- The HTTP control-plane protocol (register → claim → poll → logs → result →
  410-teardown), the channel→`RemoteSpawnedStep` bridge, worktree-bundle
  delivery (no GitHub push), and DinD parity via the shared `runner-exec-args`.

## Next (Increment 9, AWS)
- Terraform `modules/finalize-runners` (ECS-on-EC2 privileged fleet, queue-depth
  autoscaler, S3/ECR warm cache), the S3 `BundleStore`, and per-tenant STS
  credential minting — then the same agent runs in the runner image on the fleet.
```
