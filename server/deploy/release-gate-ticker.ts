/**
 * release-gate-ticker.ts — evaluation + firing for operator-configured RELEASE
 * GATES (multi-environment management — the release-gate phase). The store +
 * CRUD live in `deployment-release-gate-store.ts`; this module owns the running
 * side: a periodic sweep re-evaluates every armed gate and, when a gate's
 * sessions/epics are all complete, enqueues a one-shot deployment and flips the
 * gate to `fired`.
 *
 * Why a sweep instead of an event hook: "complete" is derived from four separate
 * writers (native-PR merge, finalize merge, kanban drag, auto-close) plus epic
 * state, and native merges bypass `recomputeSessionState` — so observing a
 * single event seam would miss cases. A once-a-minute sweep is the robust
 * primary; event seams call {@link requestReleaseGateSweep} for immediacy.
 *
 * Gating on each fire mirrors the schedule ticker so the automated enqueue paths
 * never drift:
 *   1. Re-read the row — a gate flipped off/deleted/already-fired between the
 *      sweep snapshot and this fire must not fire again.
 *   2. Re-evaluate — the completion condition must still hold.
 *   3. `deploy.yaml` must declare the environment AND the operator must not have
 *      paused it ({@link isEnvironmentDeployable}). Otherwise the gate stays
 *      armed and retries on a later sweep (a gate remains until deleted/fired).
 *   4. The per-environment concurrency lock inside {@link triggerDeployment}: a
 *      busy environment ({@link EnvironmentBusyError}) is a transient skip.
 *
 * Only a genuine enqueue error flips the gate to `failed` (decision: "mark it as
 * failed"). Busy env / missing deploy.yaml / non-deployable env are transient
 * skips that leave the gate armed. Every failure is logged and swallowed — a bad
 * gate must never take down the sweep.
 */
import path from 'path';
import { rm } from 'fs/promises';
import cron, { type ScheduledTask } from 'node-cron';
import type {
  AppConfig,
  BroadcastFn,
  DeploymentEnvironmentReleaseGateRow,
  Project,
} from '../types.js';
import { defaultTickOptions, wrapCronTick } from '../cron-tick.js';
import { getStmts } from '../db.js';
import {
  triggerDeployment as defaultTriggerDeployment,
  EnvironmentBusyError,
  type DeployOrchestratorDeps,
} from './deploy-orchestrator.js';
import { DeployConfigError, loadDeployConfig, type DeployConfig } from './deploy-config.js';
import { prepareDeploymentCheckout } from './deployment-checkout.js';
import { isEnvironmentDeployable as defaultIsEnvironmentDeployable } from './deployment-env-config-store.js';
import {
  getReleaseGate as defaultGetReleaseGate,
  listActiveReleaseGates as defaultListActiveReleaseGates,
  markReleaseGateFailed as defaultMarkReleaseGateFailed,
  markReleaseGateFired as defaultMarkReleaseGateFired,
} from './deployment-release-gate-store.js';
import {
  buildReleaseGateResolvers,
  evaluateReleaseGate,
  type ReleaseGateResolvers,
} from './release-gate-evaluator.js';
import { buildDeployOrchestratorDeps } from './deploy-trigger-hook.js';
import type { ReleaseDigestRunner } from '../release-digest.js';

type CheckoutResult = { worktreePath: string; resolvedRef: string };

/** node-cron expression for the sweep cadence (every minute). */
const SWEEP_CRON = '* * * * *';

export interface ReleaseGateTickerDeps {
  broadcast: BroadcastFn;
  config: AppConfig;
  findProject: (id: string) => Project | null | undefined;
  releaseDigestRunner?: ReleaseDigestRunner;
  /** Test seam — defaults to {@link prepareDeploymentCheckout}. */
  prepareCheckout?: (args: { project: Project; ref: string }) => Promise<CheckoutResult>;
  /** Test seam — defaults to {@link loadDeployConfig}. */
  loadConfig?: (deployYamlPath: string) => Promise<DeployConfig>;
  /** Test seam — defaults to {@link defaultTriggerDeployment}. */
  triggerDeployment?: typeof defaultTriggerDeployment;
  /** Test seam — defaults to {@link defaultIsEnvironmentDeployable}. */
  isEnvironmentDeployable?: typeof defaultIsEnvironmentDeployable;
  /** Test seam — defaults to {@link defaultGetReleaseGate}. */
  getReleaseGate?: typeof defaultGetReleaseGate;
  /** Test seam — defaults to {@link defaultListActiveReleaseGates}. */
  listActiveReleaseGates?: typeof defaultListActiveReleaseGates;
  /** Test seam — defaults to {@link defaultMarkReleaseGateFired}. */
  markReleaseGateFired?: typeof defaultMarkReleaseGateFired;
  /** Test seam — defaults to {@link defaultMarkReleaseGateFailed}. */
  markReleaseGateFailed?: typeof defaultMarkReleaseGateFailed;
  /** Test seam — completion resolvers. Defaults to DB-backed resolvers. */
  resolvers?: ReleaseGateResolvers;
  /** Test seam — the node-cron scheduler. Defaults to {@link cron.schedule}. */
  scheduleFn?: typeof cron.schedule;
  /** Orchestrator overrides (runner backend, clock, env, …) for tests. */
  orchestratorDeps?: Partial<DeployOrchestratorDeps>;
  /** Override for tests to capture log lines. */
  log?: (msg: string) => void;
}

// ─── Module-level state ────────────────────────────────────────────────────
/** The single sweep task (registered by {@link initReleaseGates}). */
let sweepTask: ScheduledTask | null = null;
/** Injected deps (set via {@link initReleaseGates}). */
let tickerDeps: ReleaseGateTickerDeps | null = null;
/** In-flight guard so an event nudge can't overlap the interval sweep. */
let sweeping = false;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultLog(msg: string): void {
  console.log(msg);
}

function resolversFor(deps: ReleaseGateTickerDeps): ReleaseGateResolvers {
  return deps.resolvers ?? buildReleaseGateResolvers(getStmts());
}

async function cleanupCheckout(checkout: CheckoutResult | null): Promise<void> {
  if (!checkout) return;
  try {
    await rm(checkout.worktreePath, { recursive: true, force: true });
  } catch {
    /* best-effort — a leaked temp dir is preferable to crashing the sweep */
  }
}

/**
 * Fire a single satisfied gate: checkout `ref`, confirm the environment is still
 * deployable, enqueue the deployment under the owner's identity, and flip the
 * gate to `fired`. A genuine enqueue error flips it to `failed`; transient
 * conditions (busy env, missing deploy.yaml, non-deployable env) leave it armed.
 * Never rejects — every failure is logged and swallowed. Exported for tests.
 */
export async function fireReleaseGate(
  gate: DeploymentEnvironmentReleaseGateRow,
  deps: ReleaseGateTickerDeps,
): Promise<void> {
  const prepareCheckout = deps.prepareCheckout ?? prepareDeploymentCheckout;
  const loadConfig = deps.loadConfig ?? loadDeployConfig;
  const trigger = deps.triggerDeployment ?? defaultTriggerDeployment;
  const isDeployable = deps.isEnvironmentDeployable ?? defaultIsEnvironmentDeployable;
  const getGate = deps.getReleaseGate ?? defaultGetReleaseGate;
  const markFired = deps.markReleaseGateFired ?? defaultMarkReleaseGateFired;
  const markFailed = deps.markReleaseGateFailed ?? defaultMarkReleaseGateFailed;
  const log = deps.log ?? defaultLog;

  // Re-read: the sweep snapshot can be stale by the time we fire this gate (an
  // earlier gate's fire awaited git I/O). The DB row is the source of truth.
  const current = getGate(gate.project_id, gate.id);
  if (!current || current.status !== 'armed' || current.enabled !== 1) return;

  // Re-evaluate against the freshest state — the condition must still hold.
  const evaluation = evaluateReleaseGate(current, resolversFor(deps));
  if (!evaluation.satisfied) return;

  const project = deps.findProject(current.project_id);
  if (!project) {
    log(`[release-gate] ${current.project_id}/${current.id}: project not found — skipped`);
    return;
  }

  const orchestratorDeps = buildDeployOrchestratorDeps({
    broadcast: deps.broadcast,
    config: deps.config,
    findProject: deps.findProject,
    prepareCheckout,
    releaseDigestRunner: deps.releaseDigestRunner,
    overrides: deps.orchestratorDeps,
  });

  const label = `${project.id} env "${current.environment_name}" @ ${current.ref}`;
  let checkout: CheckoutResult | null = null;
  try {
    checkout = await prepareCheckout({ project, ref: current.ref });
    const config = await loadConfig(path.join(checkout.worktreePath, '.agent-hub', 'deploy.yaml'));
    const declared = [...config.environments.keys()];
    // environments-config: absent from deploy.yaml OR operator-paused ⇒ transient
    // skip; leave the gate armed to retry once the env is deployable again.
    if (!isDeployable(project.id, current.environment_name, declared)) {
      log(`[release-gate] ${label}: not deployable — left armed`);
      await cleanupCheckout(checkout);
      return;
    }

    const deployment = await trigger(
      {
        projectId: project.id,
        environment: current.environment_name,
        ref: checkout.resolvedRef,
        worktreePath: checkout.worktreePath,
        config,
        trigger: 'release_gate',
        triggeredBy: current.owner_user_id,
        meta: { triggeredByReleaseGate: current.id },
        deferRun: true,
        cleanupWorktreeOnTerminal: true,
      },
      orchestratorDeps,
    );
    // Ownership of the worktree transfers to the orchestrator once the row
    // exists; on ANY throw below/above we still own it (cleanup is idempotent).
    checkout = null;
    markFired(current.project_id, current.id, deployment.id);
    log(`[release-gate] ${label} → deploy (${deployment.id}) — gate fired`);
  } catch (err) {
    await cleanupCheckout(checkout);
    if (err instanceof EnvironmentBusyError) {
      // Transient: another deployment holds the env. Retry on a later sweep.
      log(`[release-gate] ${label}: env busy — left armed`);
    } else if (err instanceof DeployConfigError && err.reason === 'not_found') {
      // No deploy.yaml at this ref (or the ref vanished). Retry on a later sweep.
      log(`[release-gate] ${label}: no deploy.yaml at ref — left armed`);
    } else {
      // A genuine enqueue failure — mark the gate failed (decision).
      markFailed(current.project_id, current.id, errMessage(err));
      log(`[release-gate] ${label}: deploy failed: ${errMessage(err)} — gate failed`);
    }
  }
}

/**
 * Evaluate every armed + enabled gate once and fire the satisfied ones. Guarded
 * so the interval sweep and an event nudge can never overlap. Exported for tests.
 */
export async function sweepReleaseGates(deps: ReleaseGateTickerDeps): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const listActive = deps.listActiveReleaseGates ?? defaultListActiveReleaseGates;
    const resolvers = resolversFor(deps);
    for (const gate of listActive()) {
      try {
        if (evaluateReleaseGate(gate, resolvers).satisfied) {
          await fireReleaseGate(gate, deps);
        }
      } catch (err) {
        console.error(
          `[release-gate] sweep error for ${gate.project_id}/${gate.id}:`,
          errMessage(err),
        );
      }
    }
  } finally {
    sweeping = false;
  }
}

/**
 * Register the once-a-minute sweep and stash deps so event seams can nudge an
 * off-cadence evaluation. Idempotent: stops any existing task first so a re-init
 * re-syncs cleanly.
 */
export function initReleaseGates(deps: ReleaseGateTickerDeps): void {
  tickerDeps = deps;
  if (sweepTask) {
    sweepTask.stop();
    sweepTask = null;
  }
  const scheduleFn = deps.scheduleFn ?? cron.schedule;
  const name = 'release-gate-sweep';
  sweepTask = scheduleFn(
    SWEEP_CRON,
    wrapCronTick(
      () =>
        sweepReleaseGates(deps).catch((err: unknown) => {
          console.error('[release-gate] sweep tick error:', errMessage(err));
        }),
      name,
    ),
    defaultTickOptions({ intervalSeconds: 60, name }),
  );
  console.log('[release-gate] sweep registered (every minute)');
}

/**
 * Nudge an off-cadence sweep after a merge/epic change so a satisfied gate fires
 * promptly instead of waiting up to a minute. No-op before {@link initReleaseGates}
 * (unit tests / disabled deployments). Fire-and-forget: never rejects.
 */
export function requestReleaseGateSweep(reason?: string): void {
  if (!tickerDeps) return;
  const deps = tickerDeps;
  void sweepReleaseGates(deps).catch((err: unknown) => {
    console.error(`[release-gate] nudged sweep (${reason ?? 'event'}) error:`, errMessage(err));
  });
}

/** Test/shutdown helper: stop the sweep and clear injected deps. */
export function stopReleaseGates(): void {
  if (sweepTask) {
    sweepTask.stop();
    sweepTask = null;
  }
  tickerDeps = null;
  sweeping = false;
}

/** Test introspection: whether the sweep task is registered. */
export function isReleaseGateSweepRegistered(): boolean {
  return sweepTask !== null;
}
