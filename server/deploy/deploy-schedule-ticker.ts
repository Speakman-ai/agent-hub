/**
 * deploy-schedule-ticker.ts — node-cron registration + firing for operator
 * configured DEPLOY SCHEDULES (multi-environment management — the scheduling
 * phase). The store + CRUD live in `deployment-schedule-store.ts`; this module
 * owns the running side: it turns each enabled schedule row into a node-cron
 * task and, on tick, enqueues a deployment for the mapped environment.
 *
 * Locked epic decision `deploy-scheduling`:
 *   Schedule = DB row `{environment, ref, cron, timezone, owner_user_id,
 *   enabled}`. Reuses the node-cron + owner + timezone pattern from
 *   crons/heartbeats; runs under the owner identity. Disabled = a retained
 *   temporary pause. Fires `trigger=schedule` (a new value; `deployments.trigger`
 *   has no CHECK so no migration), honoring the per-env concurrency lock.
 *
 * Gating on each tick mirrors the push/merge trigger hook so the two automated
 * enqueue paths never drift:
 *   1. Re-read the row — a schedule flipped off/deleted between the last minute
 *      boundary and this tick must not fire (the registry stops the task, but a
 *      tick can already be in flight when the row changes).
 *   2. `deploy.yaml` must declare the environment AND the operator must not have
 *      paused it ({@link isEnvironmentDeployable}). A schedule for a removed or
 *      disabled environment is retained but never fires (decision
 *      `environments-config`).
 *   3. The per-environment concurrency lock inside {@link triggerDeployment}: a
 *      busy environment rejects with {@link EnvironmentBusyError}, treated as a
 *      normal skip.
 *
 * Every failure is logged and swallowed — a bad schedule (missing deploy.yaml,
 * vanished ref, busy env) must never take down the scheduler or crash the tick.
 */
import path from 'path';
import { rm } from 'fs/promises';
import cron, { type ScheduledTask } from 'node-cron';
import type {
  AppConfig,
  BroadcastFn,
  DeploymentEnvironmentScheduleRow,
  Project,
} from '../types.js';
import { defaultTickOptions, estimateIntervalSeconds, wrapCronTick } from '../cron-tick.js';
import {
  triggerDeployment as defaultTriggerDeployment,
  EnvironmentBusyError,
  type DeployOrchestratorDeps,
} from './deploy-orchestrator.js';
import { DeployConfigError, loadDeployConfig, type DeployConfig } from './deploy-config.js';
import { prepareDeploymentCheckout } from './deployment-checkout.js';
import { isEnvironmentDeployable as defaultIsEnvironmentDeployable } from './deployment-env-config-store.js';
import {
  getSchedule as defaultGetSchedule,
  listEnabledSchedules as defaultListEnabledSchedules,
} from './deployment-schedule-store.js';
import { buildDeployOrchestratorDeps } from './deploy-trigger-hook.js';
import type { ReleaseDigestRunner } from '../release-digest.js';

type CheckoutResult = { worktreePath: string; resolvedRef: string };

export interface DeployScheduleTickerDeps {
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
  /** Test seam — defaults to {@link defaultGetSchedule}. */
  getSchedule?: typeof defaultGetSchedule;
  /** Test seam — defaults to {@link defaultListEnabledSchedules}. */
  listEnabledSchedules?: typeof defaultListEnabledSchedules;
  /** Test seam — the node-cron scheduler. Defaults to {@link cron.schedule}. */
  scheduleFn?: typeof cron.schedule;
  /** Orchestrator overrides (runner backend, clock, env, …) for tests. */
  orchestratorDeps?: Partial<DeployOrchestratorDeps>;
  /** Override for tests to capture log lines. */
  log?: (msg: string) => void;
}

// ─── Module-level state ────────────────────────────────────────────────────
/** scheduleId → running node-cron task. Registered at boot + on CRUD change. */
const scheduleTasks = new Map<string, ScheduledTask>();

/** Injected deps (set via {@link initDeploySchedules}). */
let tickerDeps: DeployScheduleTickerDeps | null = null;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultLog(msg: string): void {
  console.log(msg);
}

async function cleanupCheckout(checkout: CheckoutResult | null): Promise<void> {
  if (!checkout) return;
  try {
    await rm(checkout.worktreePath, { recursive: true, force: true });
  } catch {
    /* best-effort — a leaked temp dir is preferable to crashing the tick */
  }
}

/**
 * Fire a single schedule: checkout `ref`, confirm the environment is still
 * deployable, and enqueue the deployment under the owner's identity. Never
 * rejects — every failure is logged and swallowed. Exported for tests.
 */
export async function runScheduledDeployment(
  schedule: DeploymentEnvironmentScheduleRow,
  deps: DeployScheduleTickerDeps,
): Promise<void> {
  const prepareCheckout = deps.prepareCheckout ?? prepareDeploymentCheckout;
  const loadConfig = deps.loadConfig ?? loadDeployConfig;
  const trigger = deps.triggerDeployment ?? defaultTriggerDeployment;
  const isDeployable = deps.isEnvironmentDeployable ?? defaultIsEnvironmentDeployable;
  const getSchedule = deps.getSchedule ?? defaultGetSchedule;
  const log = deps.log ?? defaultLog;

  // Re-read: the task is stopped when a schedule flips off / is deleted, but a
  // tick already dispatched to the macrotask queue can still run against a stale
  // snapshot. The DB row is the source of truth for enabled + ref + owner.
  const current = getSchedule(schedule.project_id, schedule.id);
  if (!current || current.enabled !== 1) return;

  const project = deps.findProject(current.project_id);
  if (!project) {
    log(`[deploy-schedule] ${current.project_id}/${current.id}: project not found — skipped`);
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
    // environments-config: absent from deploy.yaml OR operator-paused ⇒ skip.
    if (!isDeployable(project.id, current.environment_name, declared)) {
      log(`[deploy-schedule] ${label}: not deployable — skipped`);
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
        trigger: 'schedule',
        // Runs under the schedule owner's identity (deploy-scheduling); null =
        // system-owned, matching a push-driven trigger.
        triggeredBy: current.owner_user_id,
        meta: { triggeredBySchedule: current.id, cron: current.cron },
        deferRun: true,
        cleanupWorktreeOnTerminal: true,
      },
      orchestratorDeps,
    );
    // Ownership of the worktree transfers to the orchestrator once the row
    // exists; on ANY throw below/above we still own it (cleanup is idempotent).
    checkout = null;
    log(`[deploy-schedule] ${label} → deploy (${deployment.id})`);
  } catch (err) {
    await cleanupCheckout(checkout);
    if (err instanceof EnvironmentBusyError) {
      log(`[deploy-schedule] ${label}: env busy — skipped`);
    } else if (err instanceof DeployConfigError && err.reason === 'not_found') {
      // No deploy.yaml at this ref (or the ref vanished) ⇒ nothing to deploy.
      log(`[deploy-schedule] ${label}: no deploy.yaml at ref — skipped`);
    } else {
      log(`[deploy-schedule] ${label}: deploy failed: ${errMessage(err)}`);
    }
  }
}

/** Stop and drop the running task for a schedule (if any). */
function stopTask(scheduleId: string): void {
  const existing = scheduleTasks.get(scheduleId);
  if (existing) {
    existing.stop();
    scheduleTasks.delete(scheduleId);
  }
}

/**
 * (Re)register a node-cron task for a schedule row. A disabled row stops any
 * running task and registers nothing (a retained pause). Called at boot for
 * every enabled schedule and by the CRUD routes after a create/update.
 */
function registerSchedule(
  row: DeploymentEnvironmentScheduleRow,
  deps: DeployScheduleTickerDeps,
): void {
  stopTask(row.id);
  if (row.enabled !== 1) return;

  const scheduleFn = deps.scheduleFn ?? cron.schedule;
  const name = `deploy-schedule:${row.project_id}:${row.id}`;
  const task = scheduleFn(
    row.cron,
    wrapCronTick(
      () =>
        runScheduledDeployment(row, deps).catch((err: unknown) => {
          console.error(`[deploy-schedule] ${name} tick error:`, errMessage(err));
        }),
      name,
    ),
    defaultTickOptions({
      intervalSeconds: estimateIntervalSeconds(row.cron),
      timezone: row.timezone ?? undefined,
      name,
    }),
  );
  scheduleTasks.set(row.id, task);
}

/**
 * Register every enabled schedule at boot and stash deps so the CRUD routes can
 * refresh individual registrations without re-plumbing the orchestrator wiring.
 * Idempotent: clears any existing tasks first, so a re-init re-syncs cleanly.
 */
export function initDeploySchedules(deps: DeployScheduleTickerDeps): void {
  tickerDeps = deps;
  for (const id of [...scheduleTasks.keys()]) stopTask(id);

  const listEnabled = deps.listEnabledSchedules ?? defaultListEnabledSchedules;
  let count = 0;
  for (const row of listEnabled()) {
    try {
      registerSchedule(row, deps);
      count += 1;
    } catch (err) {
      console.error(
        `[deploy-schedule] failed to register ${row.project_id}/${row.id}:`,
        errMessage(err),
      );
    }
  }
  if (count > 0) console.log(`[deploy-schedule] registered ${count} enabled schedule(s) on boot`);
}

/**
 * Re-sync one schedule's node-cron registration from the DB row. Called by the
 * CRUD routes after a create or update so a new/edited/paused schedule takes
 * effect immediately without a restart. No-op before {@link initDeploySchedules}
 * (e.g. in unit tests that never boot the scheduler).
 */
export function refreshScheduleRegistration(projectId: string, scheduleId: string): void {
  if (!tickerDeps) return;
  const getSchedule = tickerDeps.getSchedule ?? defaultGetSchedule;
  const row = getSchedule(projectId, scheduleId);
  if (!row) {
    stopTask(scheduleId);
    return;
  }
  try {
    registerSchedule(row, tickerDeps);
  } catch (err) {
    console.error(
      `[deploy-schedule] failed to refresh ${projectId}/${scheduleId}:`,
      errMessage(err),
    );
  }
}

/** Stop and drop a schedule's task — called by the CRUD delete route. */
export function unregisterSchedule(scheduleId: string): void {
  stopTask(scheduleId);
}

/** Test/shutdown helper: stop every registered task and clear injected deps. */
export function stopAllDeploySchedules(): void {
  for (const id of [...scheduleTasks.keys()]) stopTask(id);
  tickerDeps = null;
}

/** Test introspection: ids of schedules with a live node-cron task. */
export function getRegisteredScheduleIds(): string[] {
  return [...scheduleTasks.keys()];
}
