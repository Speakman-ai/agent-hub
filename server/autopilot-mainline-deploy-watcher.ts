/**
 * Mainline Autopilot deploy watcher: moves a landing slot from `landed`
 * through `deploying` to `reporting`, deploying each landed commit once.
 *
 * Spec invariants this module owns
 * (wiki: autopilot-mainline-mode-spec-default-branch-deploy-verification):
 * - Every slot write is a compare-and-set on the stored `(phase, attemptId)`
 *   (via `transitionMainlineSlot`); nothing is written from a snapshot.
 * - The landing key goes into the deployment meta at creation, and before any
 *   create the watcher adopts an existing deployment with that key in any
 *   status except a lock-race cancel. A lost `deploying` write, or a restart
 *   between creating the row and recording it, adopts instead of deploying
 *   twice.
 * - Only a fact about the commit makes a start error final: deploy.yaml at
 *   that commit is missing, invalid, or does not declare the environment.
 *   Checkout, runner, lock, I/O failures and a paused environment back off
 *   and escalate once after an hour; they never clear the slot.
 * - Obligations outlive run state: the sweep covers every session whose slot
 *   is owed, whatever its run status, mode, or archive state.
 * - `reporting` is handed to the `report` dep, which proves delivery by
 *   report key before freeing the slot.
 *
 * The sweep is serial and single-flight per process, so one process never
 * starts two deploys for the same landing.
 */
import { rm } from 'fs/promises';
import type { DeploymentRow, Project } from './types.js';
import {
  transitionMainlineSlot,
  type AutopilotRowStmts,
  type MainlineSlotWrite,
} from './session-autopilot-slot.js';
import { parseAutopilotSessionConfig } from '../shared/utils/sessionAutopilot.js';
import { type MainlineSlot, mainlineLandingKey } from '../shared/utils/autopilotMainlineSlot.js';
import { parseDeployConfig, type DeployConfig } from './deploy/deploy-config.js';
import {
  LOCK_RACE_CANCEL_ERROR,
  type TriggerDeploymentInput,
} from './deploy/deploy-orchestrator.js';
import type { DeployYamlAtCommit } from './deploy/deployment-checkout.js';

export const MAINLINE_DEPLOY_SWEEP_MS = 15_000;
export const MAINLINE_DEPLOY_BACKOFF_MIN_MS = 15_000;
export const MAINLINE_DEPLOY_BACKOFF_MAX_MS = 10 * 60_000;
export const MAINLINE_DEPLOY_ESCALATE_AFTER_MS = 60 * 60_000;

/** Deploy `trigger` value for Autopilot-created deployments. */
export const AUTOPILOT_DEPLOY_TRIGGER = 'autopilot';

const DEPLOYMENT_PLAN_META_KEY = 'agentHubDeploymentPlan';

export interface MainlineWatcherSessionRow {
  id: string;
  agent_id: string;
  owner_user_id?: string | null;
}

export interface MainlineDeployWatcherDeps {
  stmts: AutopilotRowStmts;
  /** Sessions whose stored config may be mainline, including archived ones. */
  listCandidates: () => MainlineWatcherSessionRow[];
  findProjectForAgent: (agentId: string) => Project | null;
  readDeployYamlAtCommit: (project: Project, sha: string) => Promise<DeployYamlAtCommit>;
  isEnvironmentDeployable: (projectId: string, environment: string, declared: string[]) => boolean;
  prepareCheckout: (
    project: Project,
    sha: string,
  ) => Promise<{ worktreePath: string; resolvedRef: string }>;
  /** Orchestrator entry point, already bound to its deps. */
  triggerDeployment: (input: TriggerDeploymentInput) => Promise<DeploymentRow>;
  listDeploymentsByLandingKey: (projectId: string, landingKey: string) => DeploymentRow[];
  getDeployment: (id: string) => DeploymentRow | null;
  /** Transcript line with no model turn. */
  postNotice: (sessionId: string, content: string) => void;
  /**
   * Settles a `pushing` or `uncertain` slot against the remote, and retries
   * an owed Finalize restart on an `idle` one (see
   * autopilot-mainline-reconciler.ts). Runs inside this sweep so the loop
   * stays single-flight; a slot it moves to `landed` deploys in the same pass.
   */
  reconcile?: (session: MainlineWatcherSessionRow) => Promise<void>;
  /**
   * Delivers the result of a `reporting` slot (see
   * autopilot-mainline-report.ts). Synchronous: it dispatches the verify turn
   * without awaiting it.
   */
  report?: (session: MainlineWatcherSessionRow) => void;
  now?: () => number;
  log?: (message: string) => void;
}

type StartOutcome =
  | { kind: 'started'; deploymentId: string; adopted: boolean }
  | { kind: 'final'; detail: string }
  | { kind: 'retry'; detail: string };

interface Backoff {
  failures: number;
  nextAt: number;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Next delay after `failures` consecutive retryable start errors. */
export function mainlineDeployBackoffMs(failures: number): number {
  const n = Math.max(1, Math.floor(failures));
  const delay = MAINLINE_DEPLOY_BACKOFF_MIN_MS * 2 ** Math.min(n - 1, 16);
  return Math.min(delay, MAINLINE_DEPLOY_BACKOFF_MAX_MS);
}

/** A row that lost the environment-lock race at creation and never ran. */
export function isLockRaceCancel(row: Pick<DeploymentRow, 'status' | 'error'>): boolean {
  return row.status === 'cancelled' && row.error === LOCK_RACE_CANCEL_ERROR;
}

/** Earliest deployment for this landing that is not a lock-race cancel. */
export function findAdoptableDeployment(rows: DeploymentRow[]): DeploymentRow | null {
  return rows.find((row) => !isLockRaceCancel(row)) ?? null;
}

type TerminalOutcome = 'succeeded' | 'failed' | 'cancelled';

function terminalOutcome(status: DeploymentRow['status']): TerminalOutcome | null {
  if (status === 'success') return 'succeeded';
  if (status === 'error') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return null;
}

/** Origin/readiness from the deploy.yaml snapshot taken when the row was created. */
export function deploymentPlanTargets(row: Pick<DeploymentRow, 'meta'>): {
  origin: string | null;
  readiness: string | null;
} {
  const none = { origin: null, readiness: null };
  if (!row.meta) return none;
  let meta: unknown;
  try {
    meta = JSON.parse(row.meta);
  } catch {
    return none;
  }
  if (!isRecord(meta)) return none;
  const plan = meta[DEPLOYMENT_PLAN_META_KEY];
  if (!isRecord(plan) || !isRecord(plan.environment)) return none;
  const { origin, readiness } = plan.environment;
  return {
    origin: typeof origin === 'string' && origin.trim() ? origin : null,
    readiness: typeof readiness === 'string' && readiness.trim() ? readiness : null,
  };
}

function shortSha(sha: string | null): string {
  return (sha ?? '').slice(0, 7);
}

export function createMainlineDeployWatcher(deps: MainlineDeployWatcherDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.warn(m));
  const backoffs = new Map<string, Backoff>();
  let running: Promise<void> | null = null;
  let rerun = false;

  function readSlot(sessionId: string): { slot: MainlineSlot; environment: string } | null {
    const row = deps.stmts.getSession.get(sessionId) as
      | { autopilot_session_config?: string | null }
      | undefined;
    const cfg = parseAutopilotSessionConfig(row?.autopilot_session_config ?? null);
    if (!cfg || cfg.target !== 'mainline' || !cfg.mainline) return null;
    return { slot: cfg.mainline.slot, environment: cfg.mainline.deployEnvironment };
  }

  function recordStarted(
    session: MainlineWatcherSessionRow,
    slot: MainlineSlot,
    environment: string,
    deploymentId: string,
    adopted: boolean,
  ): MainlineSlotWrite {
    const write = transitionMainlineSlot({
      stmts: deps.stmts,
      sessionId: session.id,
      expect: { phase: 'landed', attemptId: slot.attemptId },
      event: { type: 'deploy_started', deploymentId },
    });
    if (!write.wrote) {
      // The row carries the landing key, so the next sweep adopts it.
      log(
        `[autopilot-deploy] session=${session.id} deployment=${deploymentId} could not be ` +
          `recorded (${write.reason}); it will be adopted by landing key`,
      );
      return write;
    }
    deps.postNotice(
      session.id,
      adopted
        ? `Autopilot resumed tracking the deploy of ${shortSha(slot.sha)} to ${environment} (deployment ${deploymentId}).`
        : `Autopilot is deploying ${shortSha(slot.sha)} to ${environment} (deployment ${deploymentId}).`,
    );
    return write;
  }

  async function startDeploy(
    session: MainlineWatcherSessionRow,
    project: Project,
    slot: MainlineSlot,
    environment: string,
    landingKey: string,
  ): Promise<StartOutcome> {
    const sha = slot.sha as string;

    let yaml: DeployYamlAtCommit;
    try {
      yaml = await deps.readDeployYamlAtCommit(project, sha);
    } catch (err) {
      return {
        kind: 'retry',
        detail: `could not read deploy.yaml at ${shortSha(sha)}: ${errMessage(err)}`,
      };
    }
    if (yaml.kind === 'absent') {
      return { kind: 'final', detail: `No .agent-hub/deploy.yaml at ${shortSha(sha)}.` };
    }
    let config: DeployConfig;
    try {
      config = parseDeployConfig(yaml.raw);
    } catch (err) {
      return {
        kind: 'final',
        detail: `.agent-hub/deploy.yaml at ${shortSha(sha)} is invalid: ${errMessage(err)}`,
      };
    }
    const declared = [...config.environments.keys()];
    if (!config.environments.has(environment)) {
      return {
        kind: 'final',
        detail: `deploy.yaml at ${shortSha(sha)} does not declare environment "${environment}".`,
      };
    }
    let deployable: boolean;
    try {
      deployable = deps.isEnvironmentDeployable(project.id, environment, declared);
    } catch (err) {
      return {
        kind: 'retry',
        detail: `could not read the state of environment "${environment}": ${errMessage(err)}`,
      };
    }
    if (!deployable) {
      return { kind: 'retry', detail: `environment "${environment}" is paused` };
    }

    let checkout: { worktreePath: string; resolvedRef: string };
    try {
      checkout = await deps.prepareCheckout(project, sha);
    } catch (err) {
      return { kind: 'retry', detail: `checkout of ${shortSha(sha)} failed: ${errMessage(err)}` };
    }

    try {
      const row = await deps.triggerDeployment({
        projectId: project.id,
        environment,
        ref: sha,
        worktreePath: checkout.worktreePath,
        config,
        trigger: AUTOPILOT_DEPLOY_TRIGGER,
        triggeredBy: session.owner_user_id ?? null,
        sessionId: session.id,
        meta: { autopilotLandingKey: landingKey, sessionId: session.id, commitSha: sha },
        deferRun: true,
        cleanupWorktreeOnTerminal: true,
      });
      return { kind: 'started', deploymentId: row.id, adopted: false };
    } catch (err) {
      // A row with the key owns the checkout and the start error follows it:
      // adopt it now. Without one the checkout is ours to remove. An unknown
      // answer keeps the checkout and retries, where adoption runs first.
      let owner: DeploymentRow | null | undefined;
      try {
        owner = findAdoptableDeployment(deps.listDeploymentsByLandingKey(project.id, landingKey));
      } catch {
        owner = undefined;
      }
      if (owner) return { kind: 'started', deploymentId: owner.id, adopted: true };
      if (owner === null) {
        await rm(checkout.worktreePath, { recursive: true, force: true }).catch(() => {});
      }
      return { kind: 'retry', detail: `deploy start failed: ${errMessage(err)}` };
    }
  }

  function noteRetry(
    session: MainlineWatcherSessionRow,
    slot: MainlineSlot,
    environment: string,
    landingKey: string,
    detail: string,
  ): void {
    const prior = backoffs.get(landingKey);
    const failures = (prior?.failures ?? 0) + 1;
    const delay = mainlineDeployBackoffMs(failures);
    backoffs.set(landingKey, { failures, nextAt: now() + delay });
    log(
      `[autopilot-deploy] session=${session.id} landing=${landingKey} start deferred ` +
        `(attempt ${failures}, retry in ${Math.round(delay / 1000)}s): ${detail}`,
    );
    const since = slot.enteredAt ? Date.parse(slot.enteredAt) : NaN;
    if (slot.escalatedAt || !Number.isFinite(since)) return;
    if (now() - since < MAINLINE_DEPLOY_ESCALATE_AFTER_MS) return;
    const escalated = transitionMainlineSlot({
      stmts: deps.stmts,
      sessionId: session.id,
      expect: { phase: 'landed', attemptId: slot.attemptId },
      event: { type: 'escalate' },
      nowIso: new Date(now()).toISOString(),
    });
    if (escalated.wrote) {
      deps.postNotice(
        session.id,
        `Autopilot has not been able to start the deploy of ${shortSha(slot.sha)} to ${environment} ` +
          `for over an hour (${detail}). It keeps retrying; check the environment on the Deployments page.`,
      );
    }
  }

  /**
   * One attempt at a landed slot. Never throws: every failure, including a
   * dependency that throws, comes back as an outcome so {@link handleLanded}
   * settles it in one place.
   */
  async function attemptLanded(
    session: MainlineWatcherSessionRow,
    slot: MainlineSlot,
    environment: string,
    landingKey: string,
  ): Promise<StartOutcome> {
    try {
      const project = deps.findProjectForAgent(session.agent_id);
      if (!project) return { kind: 'retry', detail: 'project not found for this session' };
      let adoptable: DeploymentRow | null;
      try {
        adoptable = findAdoptableDeployment(
          deps.listDeploymentsByLandingKey(project.id, landingKey),
        );
      } catch (err) {
        return { kind: 'retry', detail: `deployment lookup failed: ${errMessage(err)}` };
      }
      if (adoptable) return { kind: 'started', deploymentId: adoptable.id, adopted: true };
      return await startDeploy(session, project, slot, environment, landingKey);
    } catch (err) {
      return { kind: 'retry', detail: `deploy start threw: ${errMessage(err)}` };
    }
  }

  /**
   * Gate, attempt, settle. The backoff deadline gates the whole attempt
   * (lookups included), and every outcome that did not move the slot backs
   * off through {@link noteRetry}. A refused write whose slot moved on
   * (`stale`) is not a failure: the next sweep reads the new phase.
   */
  async function handleLanded(
    session: MainlineWatcherSessionRow,
    slot: MainlineSlot,
    environment: string,
  ): Promise<void> {
    if (!slot.attemptId || !slot.sha) return;
    const landingKey = mainlineLandingKey(session.id, slot.attemptId);
    const wait = backoffs.get(landingKey);
    if (wait && now() < wait.nextAt) return;

    const outcome = await attemptLanded(session, slot, environment, landingKey);
    let write: MainlineSlotWrite;
    if (outcome.kind === 'started') {
      write = recordStarted(session, slot, environment, outcome.deploymentId, outcome.adopted);
    } else if (outcome.kind === 'final') {
      write = transitionMainlineSlot({
        stmts: deps.stmts,
        sessionId: session.id,
        expect: { phase: 'landed', attemptId: slot.attemptId },
        event: { type: 'deploy_undeployable', detail: outcome.detail },
      });
    } else {
      noteRetry(session, slot, environment, landingKey, outcome.detail);
      return;
    }
    if (write.wrote || write.reason === 'stale') {
      backoffs.delete(landingKey);
      return;
    }
    noteRetry(
      session,
      slot,
      environment,
      landingKey,
      `could not record the ${outcome.kind === 'started' ? 'deployment' : 'undeployable outcome'} (${write.reason})`,
    );
  }

  function handleDeploying(session: MainlineWatcherSessionRow, slot: MainlineSlot): void {
    if (!slot.deploymentId) return;
    let row: DeploymentRow | null;
    try {
      row = deps.getDeployment(slot.deploymentId);
    } catch (err) {
      log(
        `[autopilot-deploy] session=${session.id} deployment=${slot.deploymentId} read failed: ${errMessage(err)}`,
      );
      return;
    }
    const expect = { phase: 'deploying' as const, attemptId: slot.attemptId };
    if (!row) {
      transitionMainlineSlot({
        stmts: deps.stmts,
        sessionId: session.id,
        expect,
        event: {
          type: 'deploy_finished',
          status: 'missing',
          detail: `Deployment ${slot.deploymentId} no longer exists.`,
        },
      });
      return;
    }
    const status = terminalOutcome(row.status);
    if (!status) return;
    const targets = deploymentPlanTargets(row);
    transitionMainlineSlot({
      stmts: deps.stmts,
      sessionId: session.id,
      expect,
      event: {
        type: 'deploy_finished',
        status,
        detail: row.error,
        origin: targets.origin,
        readiness: targets.readiness,
      },
    });
  }

  async function sweepSession(session: MainlineWatcherSessionRow): Promise<void> {
    let state = readSlot(session.id);
    if (!state) return;
    // `idle` too: an owed Finalize restart lives on an idle slot.
    const settles = ['pushing', 'uncertain', 'idle'].includes(state.slot.phase);
    if (deps.reconcile && settles) {
      await deps.reconcile(session);
      state = readSlot(session.id);
      if (!state) return;
    }
    if (state.slot.phase === 'landed') {
      await handleLanded(session, state.slot, state.environment);
      // A fresh start moves straight on if the deploy already ended.
      const after = readSlot(session.id);
      if (after?.slot.phase === 'deploying') handleDeploying(session, after.slot);
    } else if (state.slot.phase === 'deploying') {
      handleDeploying(session, state.slot);
    }
    // A deploy that finished in this pass reports in the same pass.
    if (deps.report && readSlot(session.id)?.slot.phase === 'reporting') deps.report(session);
  }

  async function sweepOnce(): Promise<void> {
    let sessions: MainlineWatcherSessionRow[];
    try {
      sessions = deps.listCandidates();
    } catch (err) {
      log(`[autopilot-deploy] candidate scan failed: ${errMessage(err)}`);
      return;
    }
    for (const session of sessions) {
      try {
        await sweepSession(session);
      } catch (err) {
        log(`[autopilot-deploy] session=${session.id} sweep failed: ${errMessage(err)}`);
      }
    }
  }

  /** Run a sweep; a call during a sweep queues exactly one more. */
  function sweep(): Promise<void> {
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      do {
        rerun = false;
        await sweepOnce();
      } while (rerun);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  let timer: NodeJS.Timeout | null = null;

  return {
    sweep,
    /** Sweep soon (after a push lands) without waiting for the interval. */
    kick(): void {
      setImmediate(() => void sweep());
    },
    start(intervalMs: number = MAINLINE_DEPLOY_SWEEP_MS): void {
      if (timer) return;
      timer = setInterval(() => void sweep(), intervalMs);
      timer.unref?.();
      void sweep();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** Test seam: in-memory backoff for a landing key. */
    backoffFor(landingKey: string): Backoff | undefined {
      return backoffs.get(landingKey);
    },
  };
}

export type MainlineDeployWatcher = ReturnType<typeof createMainlineDeployWatcher>;

/** Sessions whose stored Autopilot config may be mainline, archived included. */
export function listMainlineWatcherSessions(db: {
  prepare: (sql: string) => { all: () => unknown[] };
}): MainlineWatcherSessionRow[] {
  return db
    .prepare(
      `SELECT id, agent_id, owner_user_id
         FROM sessions
        WHERE autopilot_session_config LIKE '%mainline%'`,
    )
    .all() as MainlineWatcherSessionRow[];
}
