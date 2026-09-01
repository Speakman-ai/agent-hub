# macOS Finalize Runner (native, for iOS build/test/deploy)

The Linux fleet runs jobs in privileged DinD containers. macOS/Xcode cannot run
in a Linux container, so a macOS Finalize job (`runs-on: macos-*`) runs on a
**native macOS runner-agent**: the same pull-based agent, but it executes each
step directly on the host in the materialized worktree instead of `docker exec`
into a container.

This lets a Linux-hosted Agent Hub build, test, and deploy iOS apps: the Hub
enqueues `macos-*` jobs to the `macos` runner class, and a Mac claims and runs
them.

## Trust model — native runners are SINGLE-TENANT (read first)

A native step runs job code **directly as the agent user, with no container or VM
sandbox**. That code can read the agent user's home dir and keychain, modify
login/startup files, daemonize outside the tracked process group, and thereby
observe a _later_ job on the same Mac. Env-scrubbing and file permissions cannot
prevent this — a same-UID process can read the runner's files and memory.

Therefore native execution is only safe under the **self-hosted-runner trust
model**: one org's own jobs on a Mac dedicated to that org. Agent Hub **enforces**
this — it will not run untrusted multi-tenant work on a native runner:

- A native runner must be **pinned to a dedicated org** (`FINALIZE_RUNNER_ORG_SCOPE`
  set to your org, never `shared`). The agent refuses to start otherwise, and the
  Hub refuses to register a `macos`-class agent for the shared pool.
- A native runner must authenticate with an **org-scoped registration token**
  (`FINALIZE_RUNNER_ORG_FLEET_TOKENS` on the Hub), never the global fleet token.
  An org-scoped token can only ever register agents **for its own org**, so even
  though job code on the Mac can read the token file (same UID), the blast radius
  is the single org the Mac already serves — it can never register an agent that
  claims another tenant's jobs.

Do **not** point a native runner at a repo you don't trust with that org's
resources, exactly as GitHub warns for self-hosted runners with public repos. For
untrusted / cross-tenant iOS work you need a per-job **ephemeral VM or throwaway
user** boundary, which this runner does not yet provide.

## Hub setup (one-time, per org)

On the Hub, mint a random per-org registration secret and add it to
`FINALIZE_RUNNER_ORG_FLEET_TOKENS` (JSON map of `orgId` → secret):

```sh
# Hub environment
FINALIZE_RUNNER_ORG_FLEET_TOKENS='{"acme":"<random-per-org-secret>"}'
```

Hand that secret to the org's Mac runner (below). Rotate it by replacing the map
entry; only that org's runners are affected.

## How it fits together

- **Hub side** (already on by default when `FINALIZE_RUNNER_BACKEND=remote`):
  - `runs-on: macos-*` → resolves to no container image (native host job).
  - The remote backend advertises `nativeHostPlatforms: ['darwin']` (override
    with `FINALIZE_FLEET_NATIVE_PLATFORMS`) and `runsNativeJobsRemotely: true`,
    so a Linux Hub accepts the job instead of rejecting it on its own platform.
  - The job is enqueued under the **`macos` runner class** so only a macOS agent
    claims it (a Linux DinD agent never will, and vice versa).
- **Runner side**: a macOS host runs the runner-agent with `FINALIZE_RUNNER_CLASS=macos`.
  It registers under that class (baked into its agent token), claims only `macos`
  jobs, and runs steps via the native executor (`bash -euo pipefail -c <step>`
  in the worktree, inheriting the Mac's toolchain env).

## Prerequisites on the Mac

- macOS with **Xcode** + command-line tools installed and licensed
  (`xcodebuild`, `xcrun simctl`). Add Fastlane / CocoaPods / Node as your CI
  needs them — steps inherit the runner user's `PATH`.
- **Node 22+** (to run the agent).
- Code signing set up as your pipeline requires (signing certs + provisioning
  profiles in the login keychain, or an App Store Connect API key delivered as a
  project secret and consumed by your `ci.yaml` / `deploy.yaml` steps).
- Network egress to the Hub URL.

## Launch the agent

```sh
export FINALIZE_RUNNER_HUB_URL="https://hub.example.com"
export FINALIZE_RUNNER_ORG_SCOPE="acme"                     # REQUIRED: dedicate this Mac to one org
export FINALIZE_RUNNER_CLASS="macos"                        # claim only that org's macOS jobs + native exec
export FINALIZE_RUNNER_WORKSPACE_DIR="$HOME/finalize-ws"    # per-agent scratch worktree root
# Org-scoped registration secret (matches this org's entry in the Hub's
# FINALIZE_RUNNER_ORG_FLEET_TOKENS). Prefer a FILE over an env var: an
# env-delivered secret is captured into the process's initial environment block
# and stays readable via `ps eww` / `/proc/<pid>/environ`. A file keeps it out of
# the env block. (Note: on a native runner, job code runs as the same user and
# CAN read this file — that's why the token is org-scoped, so reading it grants
# no access beyond this org, which the Mac already serves.)
printf '%s' "<org-scoped secret>" > "$HOME/.finalize-fleet-token"
chmod 600 "$HOME/.finalize-fleet-token"
export FINALIZE_RUNNER_FLEET_TOKEN_FILE="$HOME/.finalize-fleet-token"
# Cross-host worktree delivery is via the presigned bundle URL in the job spec;
# no AWS credentials are needed on the Mac.

node /path/to/runner-agent.mjs        # or: npx tsx server/finalize/runner-agent-cli.ts
```

`FINALIZE_RUNNER_FLEET_TOKEN` (the raw env var) still works for delivering the
secret, and the agent deletes it from its own environment at startup — but prefer
`FINALIZE_RUNNER_FLEET_TOKEN_FILE`. Either way the secret MUST be an org-scoped
token; the shared global token is rejected for the `macos` class.

Run it under `launchd` (recommended) or `tmux`/`screen` so it survives logout.
`FINALIZE_RUNNER_NATIVE=1` forces the native executor independently of the class
name if you use a custom class (it is still subject to the single-tenant guard).

## Notes / current limitations

- **No sandboxing / resource caps.** Native steps run as the agent user with the
  host toolchain env; there is no container isolation and no GitHub-parity
  CPU/memory cap (those are Docker flags). This is why native runners are
  single-tenant (see the trust-model section) — dedicate the Mac to one org.
- **Secret handling is defense-in-depth, NOT a multi-tenant boundary.** The fleet
  credential is org-scoped and enforced single-tenant (above) — that is the real
  isolation. On top of it: (1) at startup the agent deletes the fleet token and
  host credentials (`AWS_*`, `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`,
  `GOOGLE_APPLICATION_CREDENTIALS`, `FINALIZE_RUNNER_TOKEN_SECRET`) from its OWN
  `process.env`; (2) each step's child env is sanitized of runner-control
  (`FINALIZE_RUNNER_*`, `FINALIZE_FLEET_*`, `FINALIZE_WORKTREE_*`) and the same
  host creds. These reduce accidental leakage but do NOT stop determined same-UID
  job code — only the single-tenant model does. Anything a job legitimately needs
  (signing keys, an App Store Connect API key, deploy creds) must be delivered as
  a **project secret** so it arrives via the job's step env, never relied on from
  the Mac's ambient login environment.
- **One job at a time** per agent (same as the Linux agent).
- **Autoscaling is not wired for macOS.** The ECS/ASG scaler manages the Linux
  fleet only; run macOS agents as long-lived hosts (EC2 `mac2` dedicated hosts,
  a Mac mini, or a hosted Mac provider). Capacity is "how many Macs you keep
  registered" — if none are online, `macos-*` jobs queue until the acquire
  timeout, then fail as a normal "no runner available" infra error.
