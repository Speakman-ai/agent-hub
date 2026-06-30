/**
 * deploy-orchestrator.ts — Deployment Module, Phase 3.
 *
 * Executes a project's `.agent-hub/deploy.yaml` environment pipeline inside a
 * RunnerBackend lease (the SAME local-DinD / remote-fleet seam Finalize uses,
 * `server/finalize/runner-backend.ts`). Responsibilities:
 *
 *   1. Resolve the requested environment from the parsed {@link DeployConfig}.
 *   2. Acquire the per-environment concurrency lock (one deploy per env) — a
 *      trigger to a busy environment is rejected with {@link EnvironmentBusyError}
 *      (the REST layer maps this to 409). Mirrors a GitHub concurrency group
 *      with `cancel-in-progress: false` (epic decision `concurrency`).
 *   3. Create the `deployments` row + per-step `deployment_steps` rows.
 *   4. GATED environments (`approval: true`) park at `awaiting_approval` and do
 *      NOT run steps here — the approval gate + resume live in a later phase
 *      (epic decision `approval-auth`). The env lock stays held while parked so
 *      the environment remains serialized.
 *   5. Otherwise run each step in declaration order as a single
 *      `bash -euo pipefail -c <run>` invocation via the lease's `spawnStep`,
 *      fail-fast on the first non-zero exit (remaining steps → `skipped`).
 *   6. On success: record the now-live ref on the environment and release the
 *      lock. On any terminal state: release the lease + lock (idempotent).
 *
 * Locked epic decisions encoded here:
 *   - Runner profile: deploy jobs run UNCONSTRAINED (full CPU/RAM + egress). The
 *     GitHub-parity caps exist only to keep the correctness GATE honest and must
 *     not throttle real deploys (`runner-profile`). We force `'unconstrained'`
 *     on the lease.
 *   - Secrets: PROJECT-level secrets are injected into the job env via
 *     `mergeProjectSecretsSpawnEnv` — the same store Finalize/previews use
 *     (`secrets`). No per-environment secret scoping in v1.
 *
 * Live progress: every state transition broadcasts a `deployment_update`
 * WebSocket event carrying the full deployment row + ordered steps so the UI
 * re-renders the progress list without a refetch.
 *
 * TESTS MUST MOCK the RunnerBackend — never spawn a real CLI/container. Inject
 * `deps.runnerBackend` with a fake lease whose `spawnStep` emits scripted
 * stdout/close events (see `deploy-orchestrator.test.ts`).
 */
import { rmSync } from 'fs';
import type { BroadcastFn, DeploymentRow } from '../types.js';
import type { JobClaimSpec, RunnerBackend, RunnerLease } from '../finalize/runner-backend.js';
import { resolveRunnerBackend } from '../finalize/runner-backend.js';
import type { SpawnedStep } from '../finalize/step-runner.js';
import { resolveRunsOnImage } from '../finalize/runner-images.js';
import { mergeProjectSecretsSpawnEnv } from '../project-secrets-spawn.js';
import { applyGithubSpawnCredentials } from '../spawn-github-credentials.js';
import { hasAtLeastRole, parseRole } from '../roles.js';
import {
  acquireEnvironmentLock,
  addDeploymentStep,
  claimDeploymentApproval,
  createDeployment,
  ensureDeploymentEnvironment,
  getDeployment,
  getDeploymentEnvironment,
  listDeploymentSteps,
  recordDeploymentReleaseItems,
  releaseEnvironmentLock,
  resolveDeploymentReleaseCandidates,
  setEnvironmentCurrentRef,
  updateDeploymentStatus,
  updateDeploymentStepStatus,
} from './deployment-store.js';
import {
  resolveDeployEnvironment,
  type DeployConfig,
  type DeployEnvironmentConfig,
  type DeployStep,
} from './deploy-config.js';
import {
  countUnreadSupportTickets,
  markSupportTicketsReleasedToProd,
  supportTicketIdsForCards,
} from '../support-tickets-store.js';
import { serializeSupportTicketForBroadcast } from '../support-ticket-serialization.js';
import { enqueueReleaseNotificationsForDeployment } from '../release-notification-outbox.js';

/** Max lines of combined step output retained for the failure message / step error. */
const STEP_TAIL_LINES = 50;

/**
 * Byte cap on a single un-terminated output line. A deploy command that streams
 * without ever emitting a newline would otherwise grow the per-step buffer
 * unbounded until the Hub process is pressured/OOM-killed. We keep only the last
 * N bytes of an in-flight line, so total retained output is bounded regardless of
 * what arbitrary `deploy.yaml` commands print.
 */
const STEP_TAIL_LINE_MAX_BYTES = 64 * 1024;

/**
 * Minimal env allowlist a deploy step starts from. Project-scoped secrets
 * (merged via `mergeProjectSecretsSpawnEnv`) are layered ON TOP of this; the
 * runner backend adds its own basics (HOME/USER/…). We deliberately do NOT pass
 * the Hub server's full `process.env` into arbitrary `deploy.yaml` commands —
 * that would expose the Hub's own app/API keys and infra credentials. Only these
 * harmless locale/path basics pass through.
 */
const DEPLOY_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
] as const;

/** Build the minimal allowlisted base env for a deploy job (before secret merge). */
function buildDeployBaseEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const key of DEPLOY_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) base[key] = value;
  }
  return base;
}

/**
 * Rejection for a trigger against an environment that already holds an in-flight
 * (or awaiting-approval) deploy. The REST layer maps this to HTTP 409.
 */
export class EnvironmentBusyError extends Error {
  readonly activeDeploymentId: string | null;
  constructor(activeDeploymentId: string | null) {
    super(
      activeDeploymentId
        ? `environment is busy: deployment ${activeDeploymentId} is in flight`
        : 'environment is busy: another deployment is in flight',
    );
    this.name = 'EnvironmentBusyError';
    this.activeDeploymentId = activeDeploymentId;
  }
}

/**
 * Rejection for an approval attempt that cannot legally resume a deployment.
 * Phase 5's REST layer maps `reason` to 403/404/409/422 as appropriate.
 */
export class DeploymentApprovalError extends Error {
  readonly reason:
    | 'forbidden'
    | 'not_found'
    | 'approval_not_required'
    | 'invalid_status'
    | 'lock_lost'
    | 'missing_plan';

  constructor(reason: DeploymentApprovalError['reason'], message: string) {
    super(message);
    this.name = 'DeploymentApprovalError';
    this.reason = reason;
  }
}

export interface DeployOrchestratorDeps {
  broadcast: BroadcastFn;
  /** RunnerBackend to lease a runner from. Defaults to {@link resolveRunnerBackend}. */
  runnerBackend?: RunnerBackend;
  /** Clock injection for deterministic timeout tests. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Source env that is ALLOWLIST-FILTERED to a minimal set (see
   * {@link DEPLOY_ENV_ALLOWLIST}) before project secrets are merged on top.
   * Defaults to `process.env`. Filtering means the Hub's own environment is
   * never handed wholesale to deploy commands.
   */
  env?: NodeJS.ProcessEnv;
  /** orgId for the multi-tenant queue (local backend ignores it). */
  orgId?: string;
  /**
   * Resolve the GitHub token to inject into deploy step env on behalf of the
   * user who triggered the deploy (the deployment row's `triggered_by`). Lets a
   * deploy step run `gh ...` / `git push` against GitHub HTTPS as the initiating
   * user instead of relying on a global `gh auth login` on the host (which does
   * not exist in the runner container). Returns `null` (or omitted) → no token
   * is injected. Best-effort: a resolver throw is swallowed so the deploy still
   * runs and surfaces a clearer auth error if creds are genuinely missing.
   */
  resolveGithubToken?: (userId: string) => Promise<string | null>;
}

export interface TriggerDeploymentInput {
  projectId: string;
  environment: string;
  ref: string;
  /** Hub-local worktree checked out at `ref` (the lease bind-mounts it). */
  worktreePath: string;
  /** Parsed deploy.yaml for the project. */
  config: DeployConfig;
  /** Trigger source. Known v1 values: 'manual' | 'push' | 'rollback'. Default 'manual'. */
  trigger?: string;
  /** User id that triggered the deploy; omit for system/push-driven runs. */
  triggeredBy?: string | null;
  /** For rollback: the historical deployment whose ref this run re-runs. */
  sourceDeploymentId?: string | null;
  /** Chat session driving the trigger (secret-decrypt audit attribution). */
  sessionId?: string | null;
  /** Free-form metadata stashed on the deployment row. */
  meta?: unknown;
  /**
   * Return as soon as the deployment row is created and step rows are registered.
   * The runner continues in the background. REST uses this so deploy triggers do
   * not hold the HTTP request open for the full pipeline.
   */
  deferRun?: boolean;
  /**
   * Remove the materialized checkout once the deployment reaches a terminal
   * state. REST-created deployment checkouts set this; direct orchestrator tests
   * and callers that manage their own worktree leave it false.
   */
  cleanupWorktreeOnTerminal?: boolean;
}

export interface ApproveDeploymentInput {
  deploymentId: string;
  /** User id approving the gated deploy. */
  approverUserId: string;
  /** Org role held by the approver at approval time. Must be Admin or Owner. */
  approverRole: string;
  /** Optional approver note persisted with the audit row. */
  note?: string | null;
  /** Chat session driving approval/resume (secret-decrypt audit attribution). */
  sessionId?: string | null;
  /**
   * Return after claiming approval and start the runner in the background. REST
   * uses this so approval requests do not block for the full deploy pipeline.
   */
  deferRun?: boolean;
}

export interface CancelDeploymentInput {
  deploymentId: string;
  reason?: string | null;
}

export class DeploymentCancelError extends Error {
  readonly reason: 'not_found' | 'already_terminal';
  constructor(reason: DeploymentCancelError['reason'], message: string) {
    super(message);
    this.name = 'DeploymentCancelError';
    this.reason = reason;
  }
}

const TERMINAL_DEPLOYMENT_STATUSES = new Set<DeploymentRow['status']>([
  'success',
  'error',
  'cancelled',
]);

const DEPLOYMENT_PLAN_META_KEY = 'agentHubDeploymentPlan';

interface DeploymentPlanSnapshot {
  version: 1;
  worktreePath: string;
  environment: DeployEnvironmentConfig;
  cleanupWorktreeOnTerminal?: boolean;
}

interface ActiveDeploymentRun {
  cancelRequested: boolean;
  child?: SpawnedStep;
  killTimer?: NodeJS.Timeout;
}

const activeDeploymentRuns = new Map<string, ActiveDeploymentRun>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function snapshotDeploymentPlan(
  worktreePath: string,
  envConfig: DeployEnvironmentConfig,
  cleanupWorktreeOnTerminal: boolean,
): DeploymentPlanSnapshot {
  return {
    version: 1,
    worktreePath,
    cleanupWorktreeOnTerminal,
    environment: {
      name: envConfig.name,
      approval: envConfig.approval,
      runsOn: envConfig.runsOn,
      timeoutMinutes: envConfig.timeoutMinutes,
      steps: envConfig.steps.map((step) => ({ name: step.name, run: step.run })),
    },
  };
}

function mergeDeploymentPlanMeta(meta: unknown, plan: DeploymentPlanSnapshot): unknown {
  if (meta == null) return { [DEPLOYMENT_PLAN_META_KEY]: plan };
  if (isRecord(meta)) return { ...meta, [DEPLOYMENT_PLAN_META_KEY]: plan };
  return { userMeta: meta, [DEPLOYMENT_PLAN_META_KEY]: plan };
}

function parseDeploymentPlan(deployment: DeploymentRow): DeploymentPlanSnapshot | null {
  if (!deployment.meta) return null;
  let meta: unknown;
  try {
    meta = JSON.parse(deployment.meta);
  } catch {
    return null;
  }
  if (!isRecord(meta)) return null;
  const plan = meta[DEPLOYMENT_PLAN_META_KEY];
  if (!isRecord(plan) || plan.version !== 1 || typeof plan.worktreePath !== 'string') {
    return null;
  }

  const environment = plan.environment;
  if (!isRecord(environment)) return null;
  const { name, approval, runsOn, timeoutMinutes, steps } = environment;
  if (
    typeof name !== 'string' ||
    typeof approval !== 'boolean' ||
    typeof runsOn !== 'string' ||
    typeof timeoutMinutes !== 'number' ||
    !Array.isArray(steps)
  ) {
    return null;
  }

  const parsedSteps: DeployStep[] = [];
  for (const step of steps) {
    if (!isRecord(step) || typeof step.name !== 'string' || typeof step.run !== 'string') {
      return null;
    }
    parsedSteps.push({ name: step.name, run: step.run });
  }

  return {
    version: 1,
    worktreePath: plan.worktreePath,
    cleanupWorktreeOnTerminal: plan.cleanupWorktreeOnTerminal === true,
    environment: {
      name,
      approval,
      runsOn,
      timeoutMinutes,
      steps: parsedSteps,
    },
  };
}

function stringListFromMetaValue(value: unknown, keys: string[] = ['id']): string[] {
  if (typeof value === 'string') return [value.trim()].filter(Boolean);
  if (Array.isArray(value)) return value.flatMap((item) => stringListFromMetaValue(item, keys));
  if (!isRecord(value)) return [];
  return keys
    .flatMap((key) => {
      const item = value[key];
      return typeof item === 'string' ? [item] : [];
    })
    .map((id) => id.trim())
    .filter(Boolean);
}

function parseReleaseInclusionMeta(metaText: string | null): {
  cardIds: string[];
  supportTicketIds: string[];
  prUrls: string[];
  sessionIds: string[];
  refs: string[];
  branches: string[];
} {
  const empty = {
    cardIds: [],
    supportTicketIds: [],
    prUrls: [],
    sessionIds: [],
    refs: [],
    branches: [],
  };
  if (!metaText) return empty;
  let meta: unknown;
  try {
    meta = JSON.parse(metaText);
  } catch {
    return empty;
  }
  if (!isRecord(meta)) return empty;
  const cardIds = [
    ...stringListFromMetaValue(meta.cardId),
    ...stringListFromMetaValue(meta.card_id),
    ...stringListFromMetaValue(meta.cardIds, ['id', 'cardId', 'card_id']),
    ...stringListFromMetaValue(meta.card_ids, ['id', 'cardId', 'card_id']),
    ...stringListFromMetaValue(meta.cards, ['id', 'cardId', 'card_id']),
  ];
  const supportTicketIds = [
    ...stringListFromMetaValue(meta.supportTicketId),
    ...stringListFromMetaValue(meta.support_ticket_id),
    ...stringListFromMetaValue(meta.supportTicketIds, [
      'id',
      'supportTicketId',
      'support_ticket_id',
    ]),
    ...stringListFromMetaValue(meta.support_ticket_ids, [
      'id',
      'supportTicketId',
      'support_ticket_id',
    ]),
    ...stringListFromMetaValue(meta.supportTickets, ['id', 'supportTicketId', 'support_ticket_id']),
    ...stringListFromMetaValue(meta.support_tickets, [
      'id',
      'supportTicketId',
      'support_ticket_id',
    ]),
  ];
  const prUrls = [
    ...stringListFromMetaValue(meta.prUrl),
    ...stringListFromMetaValue(meta.pr_url),
    ...stringListFromMetaValue(meta.prUrls, ['url', 'html_url', 'prUrl', 'pr_url']),
    ...stringListFromMetaValue(meta.pr_urls, ['url', 'html_url', 'prUrl', 'pr_url']),
    ...stringListFromMetaValue(meta.pullRequests, ['url', 'html_url', 'prUrl', 'pr_url']),
    ...stringListFromMetaValue(meta.pull_requests, ['url', 'html_url', 'prUrl', 'pr_url']),
  ];
  const sessionIds = [
    ...stringListFromMetaValue(meta.sessionId),
    ...stringListFromMetaValue(meta.session_id),
    ...stringListFromMetaValue(meta.sessionIds, ['id', 'sessionId', 'session_id']),
    ...stringListFromMetaValue(meta.session_ids, ['id', 'sessionId', 'session_id']),
  ];
  const refs = [
    ...stringListFromMetaValue(meta.ref),
    ...stringListFromMetaValue(meta.refs),
    ...stringListFromMetaValue(meta.commit),
    ...stringListFromMetaValue(meta.commits, ['sha', 'id', 'commit', 'commitSha', 'commit_sha']),
    ...stringListFromMetaValue(meta.commitSha),
    ...stringListFromMetaValue(meta.commit_sha),
    ...stringListFromMetaValue(meta.headSha),
    ...stringListFromMetaValue(meta.head_sha),
  ];
  const branches = [
    ...stringListFromMetaValue(meta.branch),
    ...stringListFromMetaValue(meta.branches),
    ...stringListFromMetaValue(meta.headBranch),
    ...stringListFromMetaValue(meta.head_branch),
  ];
  return {
    cardIds: [...new Set(cardIds)],
    supportTicketIds: [...new Set(supportTicketIds)],
    prUrls: [...new Set(prUrls)],
    sessionIds: [...new Set(sessionIds)],
    refs: [...new Set(refs)],
    branches: [...new Set(branches)],
  };
}

function isProductionEnvironment(environment: string): boolean {
  const normalized = environment.trim().toLowerCase();
  return normalized === 'prod' || normalized === 'production';
}

function markReleasedSupportTicketsForDeployment(
  deps: DeployOrchestratorDeps,
  deployment: DeploymentRow,
  sessionId?: string | null,
): void {
  if (!isProductionEnvironment(deployment.environment)) return;
  const meta = parseReleaseInclusionMeta(deployment.meta);
  const explicitSupportTicketIds = meta.supportTicketIds;
  const resolution = resolveDeploymentReleaseCandidates({
    projectId: deployment.project_id,
    ...meta,
    refs: [...new Set([deployment.ref, ...meta.refs].filter(Boolean))],
    branches: [...new Set([deployment.ref, ...meta.branches].filter(Boolean))],
    sessionIds: [...new Set([sessionId ?? '', ...meta.sessionIds].filter(Boolean))],
  });
  const releaseItems = recordDeploymentReleaseItems({
    deployment,
    candidates: resolution.candidates,
  });
  const includedReleaseItems = releaseItems.filter((item) => item.inclusion_status === 'included');
  const excludedReleaseItems = releaseItems.filter((item) => item.inclusion_status === 'excluded');
  const excludedCardIds = excludedReleaseItems
    .map((item) => item.card_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const excludedSupportTicketIds = new Set(
    [
      ...excludedReleaseItems.map((item) => item.support_ticket_id),
      ...supportTicketIdsForCards(deployment.project_id, excludedCardIds),
    ].filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  const cardIds = includedReleaseItems
    .map((item) => item.card_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const supportTicketIds = [
    ...new Set([
      ...includedReleaseItems.map((item) => item.support_ticket_id),
      ...explicitSupportTicketIds,
    ]),
  ].filter(
    (id): id is string =>
      typeof id === 'string' && id.length > 0 && !excludedSupportTicketIds.has(id),
  );
  console.info(
    `[deploy-release-resolver] deployment=${deployment.id} project=${deployment.project_id} ` +
      `env=${deployment.environment} ref=${deployment.ref} ` +
      `resolvedItems=${releaseItems.length} ` +
      `resolvedCards=${includedReleaseItems.length} ` +
      `resolvedSupportTickets=${supportTicketIds.length} ` +
      `missingExplicitCards=${resolution.diagnostics.missingExplicitCardIds.length} ` +
      `missingExplicitTickets=${resolution.diagnostics.missingExplicitSupportTicketIds.length}`,
  );
  if (!cardIds.length && !supportTicketIds.length) return;
  for (const ticket of markSupportTicketsReleasedToProd({
    projectId: deployment.project_id,
    deploymentId: deployment.id,
    cardIds,
    supportTicketIds,
  })) {
    deps.broadcast({
      type: 'support_ticket_updated',
      projectId: ticket.project_id,
      unreadCount: countUnreadSupportTickets(ticket.project_id),
      ticket: serializeSupportTicketForBroadcast(ticket),
    });
  }
}

function cleanupDeploymentWorktree(worktreePath: string, deploymentId: string): void {
  try {
    rmSync(worktreePath, { recursive: true, force: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(
      `[deploy-orchestrator] failed to remove deployment checkout ` +
        `deployment=${deploymentId} path=${worktreePath}: ${detail}`,
    );
  }
}

function clearActiveChild(active: ActiveDeploymentRun, child: SpawnedStep): void {
  if (active.child === child) active.child = undefined;
  if (active.killTimer) {
    clearTimeout(active.killTimer);
    active.killTimer = undefined;
  }
}

function requestActiveDeploymentCancel(deploymentId: string): boolean {
  const active = activeDeploymentRuns.get(deploymentId);
  if (!active) return false;
  active.cancelRequested = true;
  const child = active.child;
  if (child) {
    child.kill('SIGTERM');
    active.killTimer =
      active.killTimer ??
      setTimeout(() => {
        if (activeDeploymentRuns.get(deploymentId) === active && active.child === child) {
          child.kill('SIGKILL');
        }
      }, 5_000);
  }
  return true;
}

/**
 * Broadcast the full deployment snapshot (row + ordered steps) for live UI.
 *
 * BEST-EFFORT by contract: live progress is a notification, never authoritative.
 * Many call sites fire while the environment lock is held and outside the
 * lease/lock cleanup wrapper (e.g. right after the `running` transition), so a
 * transient WebSocket/fanout failure here must NOT reject the deploy path and
 * strand the deployment in `pending`/`running` with the env lock held. We swallow
 * (and log) any broadcast/read failure — the SQLite state transitions and lock
 * cleanup remain the source of truth; the UI reconciles on its next fetch/event.
 */
function emitDeploymentUpdate(
  deps: DeployOrchestratorDeps,
  projectId: string,
  deploymentId: string,
): void {
  try {
    const deployment = getDeployment(deploymentId);
    if (!deployment) return;
    const steps = listDeploymentSteps(deploymentId);
    deps.broadcast({ type: 'deployment_update', projectId, deployment, steps });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[deploy-orchestrator] deployment_update broadcast failed (best-effort) ` +
        `deployment=${deploymentId} project=${projectId}: ${detail}`,
    );
  }
}

/** Lowercase, docker-safe compose project name for the deploy job. */
function deployComposeProjectName(deploymentId: string, environment: string): string {
  return `deploy-${deploymentId}-${environment}`
    .replace(/[^a-z0-9_-]+/gi, '-')
    .toLowerCase()
    .slice(0, 120);
}

interface StepRunOutcome {
  exitCode: number;
  /** Bounded trailing tail of combined stdout+stderr, for the failure message. */
  tail: string[];
  /** True if the step was killed because the deployment budget expired. */
  timedOut: boolean;
  /** Set when the child emitted an `error` event (spawn failure). */
  spawnError?: string;
}

/**
 * Drive a single step through the lease's spawnStep, collecting a bounded
 * output tail and the exit code. Enforces `budgetMs` as a kill deadline — when
 * it elapses the child is signalled and the outcome is flagged `timedOut`.
 */
function runStep(
  lease: RunnerLease,
  step: DeployStep,
  index: number,
  cwd: string,
  env: NodeJS.ProcessEnv,
  budgetMs: number,
  active?: ActiveDeploymentRun,
): Promise<StepRunOutcome> {
  return new Promise<StepRunOutcome>((resolve) => {
    let child: SpawnedStep;
    try {
      child = lease.spawnStep({ step: { name: step.name, run: step.run }, index, cwd, env });
    } catch (err) {
      resolve({ exitCode: -1, tail: [], timedOut: false, spawnError: String(err) });
      return;
    }
    if (active) {
      active.child = child;
      if (active.cancelRequested) child.kill('SIGTERM');
    }

    const tail: string[] = [];
    let buffered = '';
    const pushChunk = (chunk: Buffer | string): void => {
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        // Cap each retained line so a single giant (but newline-terminated) line
        // can't blow up memory either.
        tail.push(
          line.length > STEP_TAIL_LINE_MAX_BYTES ? line.slice(-STEP_TAIL_LINE_MAX_BYTES) : line,
        );
        if (tail.length > STEP_TAIL_LINES) tail.shift();
      }
      // Bound the un-terminated remainder: a stream with no newline keeps
      // appending here, so retain only the last STEP_TAIL_LINE_MAX_BYTES.
      if (buffered.length > STEP_TAIL_LINE_MAX_BYTES) {
        buffered = buffered.slice(-STEP_TAIL_LINE_MAX_BYTES);
      }
    };
    child.stdout?.on('data', pushChunk);
    child.stderr?.on('data', pushChunk);

    let settled = false;
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill('SIGKILL');
      },
      Math.max(1, budgetMs),
    );

    const finish = (outcome: StepRunOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (buffered) {
        tail.push(buffered);
        if (tail.length > STEP_TAIL_LINES) tail.shift();
      }
      if (active) clearActiveChild(active, child);
      resolve({ ...outcome, tail });
    };

    child.on('error', (err) => {
      finish({ exitCode: -1, tail, timedOut, spawnError: String(err) });
    });
    child.on('close', (code) => {
      finish({ exitCode: code ?? -1, tail, timedOut });
    });
  });
}

/**
 * Execute (or resume) a deployment whose row + step rows already exist and whose
 * environment lock is already held by `deploymentId`. Runs steps in order,
 * persists state, broadcasts progress, records the live ref on success, and
 * ALWAYS releases the lease + env lock on a terminal state. Returns the terminal
 * deployment row.
 *
 * Exported so the later approval-resume phase can run a previously gated +
 * approved deployment without re-doing trigger-time setup.
 */
export async function runDeployment(
  deploymentId: string,
  ctx: {
    projectId: string;
    environment: string;
    ref: string;
    worktreePath: string;
    envConfig: DeployEnvironmentConfig;
    sessionId?: string | null;
    cleanupWorktreeOnTerminal?: boolean;
  },
  deps: DeployOrchestratorDeps,
): Promise<DeploymentRow> {
  const { projectId, environment, ref, worktreePath, envConfig } = ctx;
  const now = deps.now ?? Date.now;
  const active: ActiveDeploymentRun = activeDeploymentRuns.get(deploymentId) ?? {
    cancelRequested: false,
  };
  activeDeploymentRuns.set(deploymentId, active);
  const shouldCleanupWorktree = ctx.cleanupWorktreeOnTerminal === true;
  const cleanupIfOwned = (): void => {
    if (shouldCleanupWorktree) cleanupDeploymentWorktree(worktreePath, deploymentId);
  };
  const currentDeploymentIsCancelled = (): boolean =>
    active.cancelRequested || getDeployment(deploymentId)?.status === 'cancelled';

  const fail = (error: string): DeploymentRow => {
    if (currentDeploymentIsCancelled()) {
      releaseEnvironmentLock(projectId, environment, deploymentId);
      activeDeploymentRuns.delete(deploymentId);
      cleanupIfOwned();
      emitDeploymentUpdate(deps, projectId, deploymentId);
      return getDeployment(deploymentId) as DeploymentRow;
    }
    // Terminalize the still-pending step rows so a terminal errored deployment
    // never shows steps stuck "waiting" (this path covers unsupported runs-on,
    // secret/backend resolution failures, and runner acquire failures — none of
    // which started a step). The first unstarted step carries the error; the
    // rest are skipped.
    let erroredOne = false;
    for (const s of listDeploymentSteps(deploymentId)) {
      if (s.status !== 'pending') continue;
      if (!erroredOne) {
        updateDeploymentStepStatus(s.id, 'error', { error });
        erroredOne = true;
      } else {
        updateDeploymentStepStatus(s.id, 'skipped');
      }
    }
    updateDeploymentStatus(deploymentId, 'error', { error });
    releaseEnvironmentLock(projectId, environment, deploymentId);
    activeDeploymentRuns.delete(deploymentId);
    cleanupIfOwned();
    emitDeploymentUpdate(deps, projectId, deploymentId);
    return getDeployment(deploymentId) as DeploymentRow;
  };

  const image = resolveRunsOnImage(envConfig.runsOn);
  if (!image) {
    // Still pending here — mark error + release the lock before any `running`
    // transition, so a bad runs-on never strands the env lock.
    return fail(`unsupported runs-on: ${envConfig.runsOn}`);
  }

  updateDeploymentStatus(deploymentId, 'running');
  emitDeploymentUpdate(deps, projectId, deploymentId);

  // Everything from the `running` transition through acquiring the lease is
  // wrapped so ANY failure (secret decrypt/audit, backend resolution, or the
  // acquire itself) marks the deployment `error` AND releases the environment
  // lock. Without this, a throw here would reject with the deployment stuck at
  // `running` and `deployment_environments.active_deployment_id` held forever —
  // every future deploy to the env would 409 until manual DB repair.
  // Start from a MINIMAL allowlisted env (NOT the Hub's full process.env) so
  // arbitrary deploy.yaml commands can't read the Hub server's own credentials;
  // project-scoped secrets are layered on top. `minimalEnv: true` on the spec
  // also stops the runner backend folding process.env at step-exec time.
  const baseEnv: NodeJS.ProcessEnv = buildDeployBaseEnv(deps.env ?? process.env);
  let lease: RunnerLease;
  try {
    // Inject the initiating user's GitHub token so deploy steps can run
    // `gh ...` / `git push` over HTTPS as the user who triggered the deploy —
    // the runner container has no global `gh auth login`. Applied BEFORE the
    // project-secret merge so an explicit project `GH_TOKEN`/`GITHUB_TOKEN`
    // secret still wins; best-effort, so a resolver failure never blocks the
    // deploy (the step then surfaces its own auth error).
    const triggeredBy = getDeployment(deploymentId)?.triggered_by ?? null;
    if (triggeredBy && deps.resolveGithubToken) {
      let userGhToken: string | null = null;
      try {
        userGhToken = await deps.resolveGithubToken(triggeredBy);
      } catch (err) {
        console.warn(
          `[deploy-orchestrator] GitHub token resolution failed deployment=${deploymentId} ` +
            `user=${triggeredBy}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      applyGithubSpawnCredentials(baseEnv, userGhToken);
    }

    mergeProjectSecretsSpawnEnv(baseEnv, {
      projectId,
      sessionId: ctx.sessionId ?? null,
      overwriteExisting: true,
    });

    const backend = deps.runnerBackend ?? resolveRunnerBackend();
    const spec: JobClaimSpec = {
      orgId: deps.orgId ?? '',
      projectId,
      runId: deploymentId,
      jobId: environment,
      matrixKey: 'deploy',
      image,
      worktreePath,
      composeProjectName: deployComposeProjectName(deploymentId, environment),
      env: baseEnv,
      labels: {
        'agent-hub.deploy.deployment_id': deploymentId,
        'agent-hub.deploy.project_id': projectId,
        'agent-hub.deploy.environment': environment,
      },
      // Deploys are real build/ship work, NOT the GitHub-parity gate — never cap.
      resourceProfile: 'unconstrained',
      // Steps run from the minimal `env` above only — never the Hub's process.env.
      minimalEnv: true,
    };

    lease = await backend.acquire(spec);
  } catch (err) {
    return fail(
      `failed to start deploy runner: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const steps = listDeploymentSteps(deploymentId);
  const deadline = now() + envConfig.timeoutMinutes * 60_000;
  let failure: { error: string } | null = null;
  let failedAtOrder = -1;

  try {
    for (const stepRow of steps) {
      if (currentDeploymentIsCancelled()) {
        return getDeployment(deploymentId) as DeploymentRow;
      }
      const stepCfg = envConfig.steps[stepRow.step_order - 1];
      if (!stepCfg) continue; // defensive: row/config drift

      const remaining = deadline - now();
      if (remaining <= 0) {
        updateDeploymentStepStatus(stepRow.id, 'error', {
          error: `deployment exceeded its ${envConfig.timeoutMinutes}m budget before this step started`,
        });
        emitDeploymentUpdate(deps, projectId, deploymentId);
        failure = { error: `timed out after ${envConfig.timeoutMinutes}m` };
        failedAtOrder = stepRow.step_order;
        break;
      }

      updateDeploymentStepStatus(stepRow.id, 'running');
      emitDeploymentUpdate(deps, projectId, deploymentId);

      const outcome = await runStep(
        lease,
        stepCfg,
        stepRow.step_order,
        worktreePath,
        baseEnv,
        remaining,
        active,
      );

      if (currentDeploymentIsCancelled()) {
        return getDeployment(deploymentId) as DeploymentRow;
      }

      if (outcome.timedOut) {
        updateDeploymentStepStatus(stepRow.id, 'error', {
          exitCode: outcome.exitCode,
          error: `step timed out (deployment ${envConfig.timeoutMinutes}m budget)`,
        });
        emitDeploymentUpdate(deps, projectId, deploymentId);
        failure = {
          error: `timed out after ${envConfig.timeoutMinutes}m on step "${stepCfg.name}"`,
        };
        failedAtOrder = stepRow.step_order;
        break;
      }

      if (outcome.exitCode === 0) {
        updateDeploymentStepStatus(stepRow.id, 'success', { exitCode: 0 });
        emitDeploymentUpdate(deps, projectId, deploymentId);
        continue;
      }

      const detail = outcome.spawnError
        ? `failed to spawn: ${outcome.spawnError}`
        : `exited ${outcome.exitCode}${outcome.tail.length ? `\n${outcome.tail.join('\n')}` : ''}`;
      updateDeploymentStepStatus(stepRow.id, 'error', {
        exitCode: outcome.exitCode,
        error: detail,
      });
      emitDeploymentUpdate(deps, projectId, deploymentId);
      failure = { error: `step "${stepCfg.name}" failed (exit ${outcome.exitCode})` };
      failedAtOrder = stepRow.step_order;
      break;
    }

    // Mark every step after the failure as skipped (none of them ran).
    if (failedAtOrder > 0) {
      for (const stepRow of steps) {
        if (stepRow.step_order > failedAtOrder) {
          updateDeploymentStepStatus(stepRow.id, 'skipped');
        }
      }
      emitDeploymentUpdate(deps, projectId, deploymentId);
    }
  } finally {
    try {
      await lease.release();
    } catch {
      // Release is best-effort; a teardown failure must not mask the deploy result.
    }
    releaseEnvironmentLock(projectId, environment, deploymentId);
    activeDeploymentRuns.delete(deploymentId);
    cleanupIfOwned();
  }

  if (currentDeploymentIsCancelled()) {
    emitDeploymentUpdate(deps, projectId, deploymentId);
    return getDeployment(deploymentId) as DeploymentRow;
  }

  if (failure) {
    updateDeploymentStatus(deploymentId, 'error', { error: failure.error });
    emitDeploymentUpdate(deps, projectId, deploymentId);
    return getDeployment(deploymentId) as DeploymentRow;
  }

  // Success: record the now-live ref on the environment, then mark success.
  setEnvironmentCurrentRef(projectId, environment, ref, deploymentId);
  const successDeployment = updateDeploymentStatus(deploymentId, 'success');
  if (successDeployment) {
    markReleasedSupportTicketsForDeployment(deps, successDeployment, ctx.sessionId ?? null);
    try {
      enqueueReleaseNotificationsForDeployment(successDeployment);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(
        `[deploy-orchestrator] release notification enqueue failed ` +
          `deployment=${successDeployment.id} project=${successDeployment.project_id}: ${detail}`,
      );
    }
  }
  emitDeploymentUpdate(deps, projectId, deploymentId);
  return getDeployment(deploymentId) as DeploymentRow;
}

/**
 * Trigger a deploy of `environment` at `ref`. Resolves the environment, acquires
 * the per-environment lock, creates the deployment + step rows, then either
 * parks a gated environment at `awaiting_approval` (lock retained) or runs the
 * pipeline to a terminal state.
 *
 * Throws {@link EnvironmentBusyError} (→ 409) when the environment already has an
 * in-flight or awaiting-approval deployment, and the config parser's
 * `DeployConfigError` (`unknown_environment` → 404) when the environment is not
 * declared in deploy.yaml.
 *
 * Returns the deployment row in its post-trigger state: the terminal row for a
 * non-gated run (this awaits the full pipeline), or the `awaiting_approval` row
 * for a gated environment. The REST layer (Phase 5) may choose to invoke this
 * without awaiting to return a 202 immediately while the run streams progress.
 */
export async function triggerDeployment(
  input: TriggerDeploymentInput,
  deps: DeployOrchestratorDeps,
): Promise<DeploymentRow> {
  const { projectId, environment, ref, worktreePath } = input;

  // Throws DeployConfigError('unknown_environment') for an undeclared env.
  const envConfig = resolveDeployEnvironment(input.config, environment);

  ensureDeploymentEnvironment(projectId, environment);

  // Fast pre-check: reject a visibly-busy environment without minting a row.
  const existing = getDeploymentEnvironment(projectId, environment);
  if (existing?.active_deployment_id) {
    throw new EnvironmentBusyError(existing.active_deployment_id);
  }

  const deployment = createDeployment({
    projectId,
    environment,
    ref,
    trigger: input.trigger ?? 'manual',
    triggeredBy: input.triggeredBy ?? null,
    sourceDeploymentId: input.sourceDeploymentId ?? null,
    status: 'pending',
    meta: mergeDeploymentPlanMeta(
      input.meta,
      snapshotDeploymentPlan(worktreePath, envConfig, input.cleanupWorktreeOnTerminal === true),
    ),
  });

  // Atomic acquire closes the TOCTOU window: only one of two racing triggers
  // wins the lock; the loser cancels its just-created row and is rejected.
  if (!acquireEnvironmentLock(projectId, environment, deployment.id)) {
    updateDeploymentStatus(deployment.id, 'cancelled', {
      error: 'environment busy: another deployment acquired the lock first',
    });
    if (input.cleanupWorktreeOnTerminal) cleanupDeploymentWorktree(worktreePath, deployment.id);
    const cur = getDeploymentEnvironment(projectId, environment);
    throw new EnvironmentBusyError(cur?.active_deployment_id ?? null);
  }

  // Register the step rows up front so the UI can render the full pipeline
  // (pending) before the first step runs.
  envConfig.steps.forEach((step, i) => {
    addDeploymentStep({ deploymentId: deployment.id, name: step.name, stepOrder: i + 1 });
  });
  emitDeploymentUpdate(deps, projectId, deployment.id);

  // Gated environment: park awaiting approval. The lock stays held so the env
  // remains serialized; the approval gate + resume land in a later phase.
  if (envConfig.approval) {
    updateDeploymentStatus(deployment.id, 'awaiting_approval');
    emitDeploymentUpdate(deps, projectId, deployment.id);
    return getDeployment(deployment.id) as DeploymentRow;
  }

  const runPromise = runDeployment(
    deployment.id,
    {
      projectId,
      environment,
      ref,
      worktreePath,
      envConfig,
      sessionId: input.sessionId ?? null,
      cleanupWorktreeOnTerminal: input.cleanupWorktreeOnTerminal === true,
    },
    deps,
  );
  if (input.deferRun) {
    void runPromise.catch((err) => {
      const detail = err instanceof Error ? err.message : String(err);
      updateDeploymentStatus(deployment.id, 'error', { error: detail });
      releaseEnvironmentLock(projectId, environment, deployment.id);
      activeDeploymentRuns.delete(deployment.id);
      if (input.cleanupWorktreeOnTerminal) cleanupDeploymentWorktree(worktreePath, deployment.id);
      emitDeploymentUpdate(deps, projectId, deployment.id);
    });
    return getDeployment(deployment.id) as DeploymentRow;
  }
  return runPromise;
}

export function cancelDeployment(
  input: CancelDeploymentInput,
  deps: DeployOrchestratorDeps,
): DeploymentRow {
  const deployment = getDeployment(input.deploymentId);
  if (!deployment) {
    throw new DeploymentCancelError('not_found', 'Deployment not found.');
  }
  if (TERMINAL_DEPLOYMENT_STATUSES.has(deployment.status)) {
    throw new DeploymentCancelError(
      'already_terminal',
      `Deployment is already terminal (${deployment.status}).`,
    );
  }

  const activeCancelRequested = requestActiveDeploymentCancel(deployment.id);
  for (const step of listDeploymentSteps(deployment.id)) {
    if (step.status === 'pending' || step.status === 'running') {
      updateDeploymentStepStatus(step.id, 'cancelled', {
        error: input.reason ?? 'Deployment cancelled.',
      });
    }
  }
  updateDeploymentStatus(deployment.id, 'cancelled', {
    error: input.reason ?? 'Deployment cancelled.',
  });
  if (!activeCancelRequested) {
    const plan = parseDeploymentPlan(deployment);
    releaseEnvironmentLock(deployment.project_id, deployment.environment, deployment.id);
    if (plan?.cleanupWorktreeOnTerminal) {
      cleanupDeploymentWorktree(plan.worktreePath, deployment.id);
    }
  }
  emitDeploymentUpdate(deps, deployment.project_id, deployment.id);
  return getDeployment(deployment.id) as DeploymentRow;
}

/**
 * Approve and resume a gated deployment parked by `triggerDeployment`.
 *
 * Authorization is intentionally role-based here, not "different user" based:
 * Admin/Owner may approve, and v1 explicitly allows the triggering user to
 * self-approve. The approver id + role are recorded before steps run so the
 * audit trail survives even if the deployment subsequently fails.
 */
export async function approveDeployment(
  input: ApproveDeploymentInput,
  deps: DeployOrchestratorDeps,
): Promise<DeploymentRow> {
  const role = parseRole(input.approverRole);
  if (!role || !hasAtLeastRole(role, 'Admin')) {
    throw new DeploymentApprovalError(
      'forbidden',
      'deployment approval requires the Admin role or higher',
    );
  }

  const deployment = getDeployment(input.deploymentId);
  if (!deployment) {
    throw new DeploymentApprovalError('not_found', 'deployment not found');
  }

  const plan = parseDeploymentPlan(deployment);
  if (!plan) {
    throw new DeploymentApprovalError(
      'missing_plan',
      'deployment is missing its trigger-time plan snapshot',
    );
  }

  if (!plan.environment.approval) {
    throw new DeploymentApprovalError(
      'approval_not_required',
      `environment "${deployment.environment}" does not require approval`,
    );
  }

  if (deployment.status !== 'awaiting_approval') {
    throw new DeploymentApprovalError(
      'invalid_status',
      `deployment is ${deployment.status}, not awaiting approval`,
    );
  }

  const env = getDeploymentEnvironment(deployment.project_id, deployment.environment);
  if (env?.active_deployment_id !== deployment.id) {
    throw new DeploymentApprovalError(
      'lock_lost',
      'deployment no longer holds the environment lock',
    );
  }

  const approval = claimDeploymentApproval({
    deploymentId: deployment.id,
    approverUserId: input.approverUserId,
    approverRole: role,
    decision: 'approved',
    note: input.note ?? null,
  });
  if (!approval) {
    const current = getDeployment(deployment.id);
    throw new DeploymentApprovalError(
      'invalid_status',
      `deployment is ${current?.status ?? 'missing'}, not awaiting approval`,
    );
  }
  emitDeploymentUpdate(deps, deployment.project_id, deployment.id);

  const runPromise = runDeployment(
    deployment.id,
    {
      projectId: deployment.project_id,
      environment: deployment.environment,
      ref: deployment.ref,
      worktreePath: plan.worktreePath,
      envConfig: plan.environment,
      sessionId: input.sessionId ?? null,
      cleanupWorktreeOnTerminal: plan.cleanupWorktreeOnTerminal === true,
    },
    deps,
  );
  if (input.deferRun) {
    void runPromise.catch((err) => {
      const detail = err instanceof Error ? err.message : String(err);
      updateDeploymentStatus(deployment.id, 'error', { error: detail });
      releaseEnvironmentLock(deployment.project_id, deployment.environment, deployment.id);
      activeDeploymentRuns.delete(deployment.id);
      if (plan.cleanupWorktreeOnTerminal) {
        cleanupDeploymentWorktree(plan.worktreePath, deployment.id);
      }
      emitDeploymentUpdate(deps, deployment.project_id, deployment.id);
    });
    return getDeployment(deployment.id) as DeploymentRow;
  }
  return runPromise;
}
