# Autopilot disposable todo fixture

A tiny in-memory todo list used as the isolated local application for
Experimental Project Autopilot's plan -> implement -> finalize cycle.

Vitest never launches this app or a real agent CLI. Drive the cycle with:

    npx tsx server/autopilot/fixtures/run-baseline-cycle.ts

Default (`npm run test:autopilot-fixture`) runs the real planning,
implementation, and Finalize paths through a stub worker
(`fixture-worker.sh`). The fixture has no ci.yaml, so Finalize is
checks-free: in-session review, native push/merge on a Hub-hosted repo,
then Autopilot reconciles the merged SHA onto the cycle. Vitest keeps
the canned driver (`--deterministic`) so the suite never spawns a CLI.
