# ops/scripts

Operator tooling. Nothing here runs automatically — no `package.json` script, no
workflow, and no CI job invokes these. They are run by hand, against a specific
host, when the situation below applies.

Anything that belongs in the normal dev loop lives in the repo-root `scripts/`
directory instead and is wired to an npm script.

| Script | When to run it |
| --- | --- |
| `prune-session-events.cjs` | One-time backfill to delete orphan `session_events` rows and `VACUUM` the SQLite file so the on-disk size actually drops. The ongoing sweep already runs daily via `pruneOrphanSessionEvents` in `server/session-events-store.ts`; you only need this to reclaim space accumulated *before* that landed. |
| `recover-orphan-designs.cjs` | Incident recovery: re-inserts `designs` rows for artifact directories that exist on disk under `<dataDir>/designs/<uuid>/` but lost their DB row. |
| `bake-finalize-runner-ami.sh` | Bake a custom AMI for the Finalize runner fleet with the runner image pre-pulled, cutting instance provisioning from ~3-4 min to ~1 min. Outputs an AMI id to set as `finalize_runner_ami_id` in the env tfvars, then `terraform apply`. |
| `setup-sysbox-host.sh` | Install `sysbox-runc` on an Agent Hub host and register it as a Docker runtime, so the SessionEnv sysbox adapter can run per-session dev environments without `--privileged` or a host docker socket. |

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
