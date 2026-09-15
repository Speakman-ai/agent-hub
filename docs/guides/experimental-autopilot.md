# Experimental Project Autopilot: operator setup and recovery

Experimental Project Autopilot runs one bounded implement, review, merge,
deploy, verify, document cycle at a time against a **disposable local** web app
or API, then selects one evidence-backed improvement and repeats. It is disabled
by default, opt-in per project, and additionally gated by a server operator
setting. This guide is the operator runbook: how to turn it on, what Autopilot
does without a human in the loop, how it recovers from a bad deployment, and the
two limits every operator must understand before trusting a run: **what an
evaluator score does and does not prove**, and **why recovery is a code-only
rollback**.

Manage everything from **Settings > Experimental Autopilot** for a project (web,
Electron, and mobile). No shell is required to set up, watch, pause, resume, or
stop a run. The REST shapes behind these controls are in the generated OpenAPI
reference: [`docs/api/openapi.yaml`](../api/openapi.yaml) (tag **Autopilot**).

## What is in scope

- Disposable web applications and APIs with a browser-testable main flow.
- A dedicated **local** deployment target (loopback origin, same-origin
  readiness probe). Session preview is not proof of deployment.
- One active run per project; one implementation/deployment cycle at a time.

Out of scope: native mobile builds, cloud provisioning, production deployment,
and anything that would modify the running Hub, another project, the controller
policy, or the human-authored brief and limits.

## 1. Enable the server setting

Autopilot cannot start until an authorized operator turns on the server-side
feature flag **`experimentalAutopilotEnabled`** (default `false`). This gate is
independent of local-mode authentication bypass: enabling local mode does
**not** enable Autopilot. Until the flag is on, the project settings module lets
you prepare a configuration but shows a "turned off by the server operator"
banner (`autopilot-server-disabled`) and blocks Start.

There are three supported ways to set it. The API path applies live; the file
and env paths are read at startup and need a restart:

- **`PATCH /api/config`** (recommended; requires an Owner/Admin session):
  send `{ "experimentalAutopilotEnabled": true }`. The server applies it to the
  running config immediately (no restart) and persists it to
  `~/.agent-hub/data/config.json`. The Autopilot start/config gate reads the
  live value, so the "server disabled" banner clears on the next load. Set it
  back to `false` to turn the gate off. This field is documented in the OpenAPI
  reference under **Config**.
- **`config.json`**: set `"experimentalAutopilotEnabled": true` in
  `~/.agent-hub/data/config.json` (or the legacy `server/config.json` fallback).
  This file is read at boot, so **restart the server** (`pm2 restart agent-hub`,
  or your process manager) for the change to take effect.
- **Environment variable**: set `AGENT_HUB_EXPERIMENTAL_AUTOPILOT=true` on the
  server process. It is read once at startup, so it also requires a
  **restart**; when set, it overrides the config-file value.

The setting is process-wide, not per project: it authorizes any opted-in
project to start a run. Leaving it off keeps every project's Autopilot disabled
regardless of per-project configuration.

## 2. Opt the project in and configure the run

In **Settings > Experimental Autopilot**, provide:

- **Brief**: a loose product brief. The planner expands it into a small baseline
  with explicit acceptance journeys, non-goals, and a versioned quality rubric.
  It may choose architecture and lock spec decisions before implementation; any
  attempt to expand scope or permissions pauses the run.
- **Local target**: the dedicated deployment target, a declared `deploy.yaml`
  environment with a loopback origin, a same-origin readiness probe, and a
  reported deployed revision. Public origins and cross-origin probes are
  rejected.
- **Limits**: finite per-stage timeouts and a per-run envelope (wall-time,
  optional cost cap, retries per stage capped at 2). Choose **continuous**
  (no fixed cycle count, pauses when the envelope is exhausted) or **finite**
  (a fixed cycle count).
- **Credential owner**: the user whose project-scoped worker credentials the run
  uses. The broadly privileged Hub break-glass key is never the boundary for an
  unattended worker.

## 3. Readiness and Start

The **Readiness** checklist validates, before any run starts: repo and agent
credentials, Finalize review-and-merge automation, local-target isolation,
deployment revision reporting, test access, and recoverability. Every failed
check explains itself without a shell. **Start** is available only when the
checklist passes and the server flag is on. Starting authorizes routine
automated implementation, review, merge, local deployment, and testing for that
project's experiment target, with no per-cycle human approval.

## 4. Watch a run

The run view shows the current stage and cycle, the deployment link, the last
verified revision, the selected improvement, verification evidence, the cycle
documentation, measured usage, and any pause or failure reason. Every cycle,
including rejected proposals and failures, is documented and linked to its
evidence.

## Controls: Pause, Resume, Stop, disable

- **Pause** drains the active cycle without starting another. **Resume**
  rechecks ownership, limits, and the actually deployed revision before
  continuing; it refuses if the deployed revision no longer matches the last
  verified SHA or if the declared environment now points elsewhere.
- **Stop** persists cancellation immediately, prevents new side effects, and
  cancels in-flight sessions, Finalize runs, deployments, and tests through
  their owner APIs. The run stays **Stopping** until cancellation and
  reconciliation finish. Stopping cannot undo a merge or a deployment that has
  already completed. A stopped run is never resurrected by a restart.
- **Disable** invokes Stop and turns the project capability back off.

## Recovery runbook

Autopilot persists intent before every side effect and reconciles in-flight
operations after a crash or restart before retrying. Ambiguous outcomes pause
rather than guess.

- **Bad deploy / failed verification**: a candidate that fails verification
  never becomes last-known-good. Autopilot redeploys the prior verified
  artifact, verifies the restoration, and continues only if it comes back clean.
- **Failed recovery**: if redeploying the prior verified artifact does not
  restore it, the run **pauses** with evidence for an operator.
- **Wrong live revision**: verification checks the SHA actually running at the
  target, not an HTTP health check and not the session preview. A mismatch is a
  failure, not a pass.
- **Restart mid-cycle**: on Hub restart, in-flight work is reconciled against the
  durable operation record. A late callback cannot advance a stopped or
  superseded run.
- **Budget exhaustion**: when the wall-time or cost envelope is spent, the run
  pauses instead of opening another cycle. Cost is reported honestly; when a
  provider gives no reliable cost, wall-time and resource limits still apply.
- **No-improvement plateau**: three consecutive rejected or no-benefit proposals
  pause the run instead of churning.
- **Retries**: a failed stage retries at most twice, then pauses with evidence.

## Limit 1: what an evaluator score does and does not prove

Verification runs in a **separate evaluator session with no implementation write
authority**, driving a dedicated local-target browser/test worker over stable
baseline regression journeys plus cycle-specific checks. Independent evaluation
reduces self-grading bias, and every promotion requires Hub-recorded evidence
(screenshots, traces, recorded API responses) captured at the exact deployed
SHA. Fabricated or stale evidence is rejected.

But an evaluator score is **evidence, not proof of product value**. It does not
guarantee the change is genuinely better for a user, and it does **not**
guarantee monotonic improvement from cycle to cycle. Read the pass/fail result
alongside the recorded evidence and the cycle documentation; treat a green
evaluation as "the pinned journeys passed at this revision," not as "this is a
better product." Autopilot prioritizes regressions over new features precisely
because independent evaluation cannot, on its own, establish forward progress.

## Limit 2: recovery is a code-only rollback

Rollback restores the last verified **code artifact** and redeploys it. **A code
rollback is not a database rollback.** Autopilot targets disposable test data and
backward-compatible storage changes only. Before a deploy, it assesses storage
recoverability from the spec: an explicit disposable or backward-compatible
recovery contract is required. Mixed prose, an unknown contract, or an
unsupported data migration/recovery requirement **pauses before deploying**. It
does not attempt a data migration or a data rollback. Do not point a run at any
target whose data you are not willing to lose.

## Automated-test guarantees

The validation suite for this feature is fully deterministic: it mocks every
model CLI and external call, uses fake agent and Finalize outputs, and drives a
disposable local integration fixture. No test spawns a real agent CLI or touches
a live deployment (enforced by the CLI-spawn and network guards in
`server/test/setup.ts`).

The card-level proof lives in the `server/autopilot/acceptance-*.test.ts` suite,
one file per criterion over a shared `server/autopilot/acceptance-harness.ts`:
`acceptance-ac1-cycles.test.ts` (unattended cycles), `acceptance-ac2-failure.test.ts`
(failure and recovery), `acceptance-ac2-restart.test.ts` (restart around each side
effect), and `acceptance-ac3-authz-docs.test.ts` (authorization and durable
documentation). Driving the production controller and orchestrator with fake
ports, they execute and assert:

- a baseline plus two improvement cycles against a **disposable browser app
  fixture** (`server/autopilot/fixtures/observable-app.ts`): a real
  browser-facing todo app (`index.html` + a DOM-rendering `app.js`). The
  deployment revision is the fixture's real commit SHA, and verification is a
  **browser journey** — the deployed app is loaded into an isolated DOM (jsdom)
  and driven like a user (type into the input, submit the form, click Done /
  Edit), asserting on the rendered DOM. Two companion tests prove the check is
  rendered-flow-sensitive: an improvement whose control is absent, and one whose
  handler updates the store but never re-renders (a broken rendered flow despite
  shipping), both fail to verify green even though the underlying store is
  correct;
- wrong-SHA detection, a failed deployment recovering the last-known-good
  artifact, a failed recovery that pauses, duplicate finalize delivery,
  cancellation of an in-flight deployment on Stop, wall-time budget exhaustion,
  and the three-proposal no-improvement pause;
- **restart around each side effect**: each test reconstructs a fresh controller
  and orchestrator over the preserved SQLite state (a real Hub restart) and runs
  production `reconcileAfterRestart` at the implementation, finalize, deploy,
  evaluate, recovery, and documentation boundaries — asserting the run pauses
  ambiguous, no side effect is re-invoked, a stale (fenced) completion cannot
  advance, and a mid-documenting restart finishes documentation exactly once;
- cross-project denial, protected brief/policy/limits/target denial, no run
  resurrection after Stop, and durable documentation with linked evidence and
  correct cycle/revision association for verified successes, a rejected
  candidate (failed verification), and a failed deployment — all through the
  production documentation path (`afterFailedOperation`), not hand-built records.

Broader per-module coverage (planner, board, deploy ownership, containment,
worker authority, evaluation captures, documentation) lives across the other
`server/autopilot/*.test.ts` files, and the web/mobile run controls (Start,
Pause, Resume, Stop, disable, pending and failed actions) are covered in
`client/src/components/AutopilotSettingsSection.test.tsx` and
`mobile/src/screens/ExperimentalAutopilotScreen.test.tsx`.
