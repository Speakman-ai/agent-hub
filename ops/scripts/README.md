# ops/scripts

Operator tooling. Most scripts here are run by hand against a specific host.
Exceptions that CI invokes automatically are called out in the table.

Anything that belongs in the normal dev loop lives in the repo-root `scripts/`
directory instead and is wired to an npm script.

| Script | When to run it |
| --- | --- |
| `prune-session-events.cjs` | One-time backfill to delete orphan `session_events` rows and `VACUUM` the SQLite file so the on-disk size actually drops. The ongoing sweep already runs daily via `pruneOrphanSessionEvents` in `server/session-events-store.ts`; you only need this to reclaim space accumulated *before* that landed. |
| `recover-orphan-designs.cjs` | Incident recovery: re-inserts `designs` rows for artifact directories that exist on disk under `<dataDir>/designs/<uuid>/` but lost their DB row. |
| `bake-finalize-runner-ami.sh` | Bake a custom AMI for the Finalize runner fleet with the runner image pre-pulled (cuts cold provision from ~3–4 min toward ~1 min). **CI:** `Release` rebakes prod for `:vX.Y.Z`. DEV fleet bake is parked (DEV Hub decommissioned). Manual: `FLEET=prod RUNNER_IMAGE=… ./ops/scripts/bake-finalize-runner-ami.sh`, then pin. |
| `pin-finalize-runner-ami.sh` | Point the fleet launch template at a baked AMI and write SSM `/agenthub/<fleet>/finalize-runner-ami-id` — **no instance refresh** (in-flight hosts keep working; only new scale-outs use the AMI). Used by `.github/workflows/bake-finalize-runner-ami.yml`. |
| `prune-finalize-runner-amis.sh` | Keep the newest `KEEP` (default 3) bake AMIs per fleet; deregister older ones and delete their snapshots. Skips the SSM-pinned AMI and any AMI still on an instance. Runs automatically after each successful CI bake. |
| `setup-sysbox-host.sh` | Install `sysbox-runc` on an Agent Hub host and register it as a Docker runtime, so the SessionEnv sysbox adapter can run per-session dev environments without `--privileged` or a host docker socket. |

## Finalize runner AMI cadence

| Trigger | Fleet | Image tag | Disruptive to in-flight Finalize? |
| --- | --- | --- | --- |
| Release (`release-all.yml`) | prod | `:vX.Y.Z` | **No** — pin LT only; no instance refresh |
| Actions → “Bake finalize runner AMI” | chosen | chosen | **No** — same |

DEV Hub (dev.agenthub.*) was decommissioned 2026-08-17 — merges to `main` no longer bake a DEV fleet AMI. Busy prod runner hosts keep their current AMI and jobs. Only **new** scale-outs boot the baked image. Prune never deletes an AMI still on an instance, the SSM pin, or the launch-template `$Default`.

Digest skip: CI stores `/agenthub/<fleet>/finalize-runner-image-digest` and skips bake when unchanged (`force: true` overrides). Prod Terraform apply injects `TF_VAR_finalize_runner_ami_id` from the bake/SSM pin so a stale `FINALIZE_RUNNER_AMI_ID` GitHub Variable cannot revert a fresher pin. After each bake, CI keeps the newest **3** AMIs per fleet and deletes the rest (snapshots included).

OIDC role: `vars.AWS_TERRAFORM_ROLE_ARN` (needs EC2 run/create-image, SSM send-command, launch-template update, SSM PutParameter).

## Conventions

- **Dry run by default.** The two `.cjs` database tools print a plan and change
  nothing unless you pass `--apply`. Run them without the flag first and read
  the output.
- **Back up the database first.** Always snapshot `agent-hub.db` before an
  `--apply` on a host you cannot easily restore.
- **Target a specific host** with `AGENT_HUB_DATA_DIR=/path`, which both `.cjs`
  tools honour (default: `~/.agent-hub/data`).
- **Safe to re-run.** Both database tools are idempotent — the prune's orphan
  `SELECT`s have no side effects and `VACUUM` no-ops with nothing to reclaim;
  the design recovery uses `INSERT OR IGNORE`.

Each script's own header docblock is the detailed reference; read it before
running.
