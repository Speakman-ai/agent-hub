import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { wrapCronTick, defaultTickOptions, estimateIntervalSeconds } from './cron-tick.js';
import { getOrCreateBoard } from './routes/board.js';
import {
  buildSpikeSessionContext,
  buildSpikeSessionContextFallback,
  countOpenSpecItems,
  countOpenSpecItemsForPhase,
  ensureSpecItemForSpikeCard,
  formatEpicSpecDecisionsForContext,
  getSpecItemForSpikeCard,
  isLinkedSpikeCard,
  isSpikeCard,
  loadChosenSpecItemsForEpic,
} from './epic-spec.js';
import { lastDispatchedReviewId } from './review-feedback-dedup.js';
import { resolveAgentSpawnEngineAndModel } from './effective-model.js';
import {
  loadBoardBlockers,
  hasUnresolvedBlockers,
  isColumnDone,
  isColumnCancelled,
} from './kanban-blockers.js';
import { pickAgentForCard, pickLead } from './routing.js';
import { agentAcceptsAutonomousTickets } from './agent-autonomy.js';
import { hasHoldLabel } from './epic-manager-events.js';
import type {
  Stmts,
  Project,
  Agent,
  KanbanEpicRow,
  KanbanPhaseRow,
  KanbanCardRow,
  KanbanColumnRow,
  AppConfig,
  BroadcastFn,
  ChatMessage,
  SessionRow,
} from './types.js';
import { defaultSessionUseWorktreeFlag } from './project-mode.js';
import { setSessionOwner, resolveAutonomousOwnerUserId } from './session-ownership.js';
import { enrichSessionForClient } from './session-checkpoint-rewind.js';
import { cardNeedsDevHubKey, getDevHubApiKey } from './secrets.js';
import { autoGitChildEnv, resolveOrgOwnerGithubToken } from './auto-git.js';
import { markSessionAutoShipOnComplete, markSessionFinalizeAutomation } from './session-ship.js';
import {
  assignedFinalizeAutomationLevel,
  type FinalizeAutomationLevel,
} from './finalize/automation.js';
import { resolveShouldAutoMerge } from './auto-merge.js';
import { loadCardReplayContext } from './replays/replay-context-loader.js';
import { loadCardSupportTicketCommentContext } from './support-ticket-comment-context.js';
import { loadCardUploadAttachments } from './card-attachments.js';
import {
  blockerPlacementHazardById,
  type BlockerPlacementHazard,
} from './kanban-blocker-placement.js';

/** Placement check for the skip comment; a lookup failure must not block dispatch. */
function safePlacementHazard(
  stmts: Stmts,
  cardId: string,
  blockerId: string,
): BlockerPlacementHazard | null {
  try {
    return blockerPlacementHazardById(stmts, cardId, blockerId);
  } catch {
    return null;
  }
}

const execFileAsync = promisify(execFile);

// Umbrella feature-branch management (opt-in)
//
// Per-run umbrella branching is OPT-IN via the epic's `pr_base_branch` field.
//
//   • Field BLANK (null/empty)  → no umbrella branch is created. Every card's
//     auto-PR targets the repo's default branch (main/master). This is the
//     default behaviour — autonomous mode behaves like a regular dev workflow
//     unless the operator explicitly asks for an integration branch.
//   • Field has a VALUE (e.g. `feature/q3-launch`) → that branch name is
//     respected as the PR base for every card dispatched in the run. The
//     operator is responsible for ensuring the branch exists on origin
//     (`auto-git.ts` falls back to the default branch with a logged reason
//     if `git ls-remote` doesn't find it). The value is never overwritten
//     or cleared by the autonomous loop.
//
// `createUmbrellaBranch` (below) remains exported for tests and as a helper
// that an operator-facing route may call in the future, but the autonomous
// dispatch path no longer invokes it automatically.

const AUTONOMOUS_BRANCH_PREFIX = 'feature/autonomous-';

/**
 * Creates an umbrella feature branch on the remote rooted at the current
 * remote HEAD (main/master). Returns the branch name on success, null on any
 * failure (caller falls back to PR-to-main behaviour).
 *
 * Exported for unit testing.
 */
export async function createUmbrellaBranch(
  project: Project,
  epic: KanbanEpicRow,
): Promise<string | null> {
  const cwd = project.cwd;
  if (!cwd) return null;

  const epicShort = epic.id.replace(/-/g, '').substring(0, 8);
  const runShort = crypto.randomUUID().replace(/-/g, '').substring(0, 8);
  const branchName = `${AUTONOMOUS_BRANCH_PREFIX}${epicShort}-${runShort}`;

  try {
    // Fetch to ensure remote refs are current (shallow ok — we just need the SHA).
    await execFileAsync('git', ['fetch', 'origin', '--no-tags'], { cwd, timeout: 30_000 });

    // Resolve the remote HEAD SHA. Try symbolic-ref first (fastest), then
    // fall back to explicit branch names used by most repos.
    let sha: string | null = null;
    for (const ref of ['origin/HEAD', 'origin/main', 'origin/master']) {
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', ref], { cwd, timeout: 5_000 });
        sha = stdout.trim();
        if (sha) break;
      } catch {
        // try next candidate
      }
    }

    if (!sha) {
      console.warn(
        `[Autonomous] Cannot resolve remote HEAD for project "${project.name}" — umbrella branch skipped, PRs will target default branch`,
      );
      return null;
    }

    // Push the SHA directly as the new branch — no local checkout needed.
    await execFileAsync('git', ['push', 'origin', `${sha}:refs/heads/${branchName}`], {
      cwd,
      timeout: 30_000,
    });

    console.log(
      `[Autonomous] ✅ Created umbrella branch "${branchName}" for epic "${epic.name}" (base SHA: ${sha.substring(0, 7)})`,
    );
    return branchName;
  } catch (err) {
    console.error(
      `[Autonomous] Failed to create umbrella branch for epic "${epic.name}": ${(err as Error).message} — PRs will target default branch`,
    );
    return null;
  }
}

// Operator-set base branch — auto-create if missing
//
// When the operator types a value into `epic.pr_base_branch` (e.g.
// `feature/auth`), they want every card dispatched under that epic to open a
// PR against that branch. If the branch doesn't exist on `origin` yet,
// `auto-git.ts` would otherwise silently fall back to the repo default
// branch. We close that gap here: before dispatch, check `origin` for the
// branch and push it (rooted at current `origin/HEAD`) if it isn't there.
//
// Idempotent — repeated dispatch ticks find the branch already on origin
// and skip the push. Validation matches the same SAFE_BRANCH regex used by
// `parsePrBaseBranchInput` so a hand-edited DB row can't smuggle a bad
// branch name into `git push`. Failure (permission denied, network) is
// logged and treated as non-fatal: dispatch continues, and `auto-git.ts`
// will fall back to default branch and post an explanatory card comment.

const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

export type EnsureOperatorBaseBranchOutcome =
  | 'exists'
  | 'created'
  | 'invalid'
  | 'failed'
  | 'skipped';

/**
 * Debounce key → last-logged failure signature for
 * `ensureOperatorBaseBranch`. The autonomous loop runs every 60 seconds (and
 * on several other triggers), and each tick calls this function. Without
 * debouncing, a missing per-user GitHub credential produces a fresh
 * `Authentication failed` error line on every tick — drowning the rest of
 * the server log and the Electron client's surfaced error toast.
 *
 * Key: `${projectId}:${branchName}` so a different operator-typed branch on
 * the same project (or the same branch across different projects) gets its
 * own debounce slot. Value: the last error/no-token signature we logged.
 *
 * Cleared on a successful outcome (`exists` / `created`) so the next failure
 * is logged again — operators see when transient errors resolve, and a new
 * regression isn't silently swallowed.
 *
 * Exported so tests can reset it between cases.
 */
export const lastOperatorBaseBranchFailureSignature = new Map<string, string>();

/**
 * Options for `ensureOperatorBaseBranch`. All fields optional so existing
 * callers / tests don't need to change.
 */
export interface EnsureOperatorBaseBranchOptions {
  /**
   * App config. When supplied, the function resolves the org owner's
   * GitHub OAuth/PAT via `resolveOrgOwnerGithubToken` and wires it into
   * the `git` child env using `autoGitChildEnv`. This matches the
   * auto-commit/push path in `auto-git.ts` so the ls-remote / fetch /
   * push probe authenticates the same way.
   *
   * Note: regardless of whether this is supplied, `autoGitChildEnv` always
   * scrubs inherited `GH_TOKEN` / `GITHUB_TOKEN` and installs the empty
   * `credential.https://github.com.helper` sentinel so the host operator's
   * `gh auth login` (typically a GitHub-App installation token) cannot
   * piggy-back on this probe. The only effect of omitting this option is
   * that no per-user token gets injected — git then runs unauthenticated.
   */
  config?: Pick<AppConfig, 'personalOAuth'>;
  /**
   * Test seam. When supplied, used in place of
   * `resolveOrgOwnerGithubToken(config)`. Lets tests inject a fake token
   * (or null) without mocking the entire OAuth/refresh path.
   */
  resolveToken?: () => Promise<string | null>;
}

/**
 * Ensure an operator-supplied PR base branch exists on `origin`. Creates it
 * from the current `origin/HEAD` (falling back to `origin/main` / `origin/master`)
 * if missing. Returns the outcome so the caller can log without re-doing the
 * decision.
 *
 * Exported for unit testing.
 *
 * **Credentials**: when `opts.config` (or `opts.resolveToken`) is supplied,
 * the spawned `git` processes inherit a `GH_TOKEN` + process-scoped
 * credential helper for `https://github.com` — wired by `autoGitChildEnv`.
 * Even without a supplied token, `autoGitChildEnv` always scrubs inherited
 * `GH_TOKEN` / `GITHUB_TOKEN` and installs the empty-helper sentinel so the
 * host operator's `gh auth login` cannot piggy-back on this probe and turn
 * the run into a bot-attributed operation. See the "Auto-PRs opened by
 * reviewer bot instead of session owner" fix and the
 * `troubleshooting-auto-commit-push-authentication-failed-...` runbook.
 */
export async function ensureOperatorBaseBranch(
  project: Project,
  branchName: string | null | undefined,
  opts?: EnsureOperatorBaseBranchOptions,
): Promise<EnsureOperatorBaseBranchOutcome> {
  if (!branchName || !branchName.trim()) return 'skipped';
  const name = branchName.trim();

  // Never touch the auto-generated umbrella prefix — those names are reserved
  // for the (currently dormant) `createUmbrellaBranch` helper and have their
  // own lifecycle. If something writes such a value into `pr_base_branch`,
  // skip it here and let `auto-git.ts` handle the lookup/fallback.
  if (name.startsWith(AUTONOMOUS_BRANCH_PREFIX)) return 'skipped';

  if (!SAFE_BRANCH_RE.test(name)) {
    console.warn(
      `[Autonomous] Refusing to ensure unsafe pr_base_branch value: ${JSON.stringify(name)}`,
    );
    return 'invalid';
  }

  const cwd = project.cwd;
  if (!cwd) return 'skipped';

  // Debounce key — same scope as the failure signature map.
  const debounceKey = `${project.id}:${name}`;

  /**
   * Log a failure once per distinct signature for this (project, branch).
   * Subsequent ticks that hit the same signature stay silent until either
   * the outcome changes (we clear the slot on success) or the signature
   * itself changes (a different underlying error appears).
   */
  const logFailureOnce = (sig: string, line: string) => {
    if (lastOperatorBaseBranchFailureSignature.get(debounceKey) === sig) return;
    lastOperatorBaseBranchFailureSignature.set(debounceKey, sig);
    console.error(line);
  };

  // Resolve the GitHub token (best-effort). Mirrors `resolveAutoGitGithubToken`
  // in auto-git.ts — null when no owner is reachable, no token is stored, or
  // any error occurs. We never throw out of token resolution.
  let token: string | null = null;
  try {
    if (opts?.resolveToken) {
      token = (await opts.resolveToken()) ?? null;
    } else if (opts?.config) {
      token = await resolveOrgOwnerGithubToken(opts.config);
    }
  } catch (err: unknown) {
    // resolveOrgOwnerGithubToken already swallows internally; this catches
    // the test-seam resolver throwing. Preserve pre-fix behaviour by falling
    // through with no token.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Autonomous] Token resolver threw while preparing base-branch probe: ${msg}`);
    token = null;
  }

  // Surface a single actionable warning when no per-user GitHub credential is
  // reachable — debounced separately from the failure-line debounce so it
  // doesn't get cleared by a successful unauthenticated probe (against a
  // public repo, say). The state we're tracking here is "credential is
  // configured", which only changes when the operator connects/disconnects
  // a GitHub account — not on a per-call basis.
  if (!token && (opts?.config || opts?.resolveToken)) {
    const credKey = `cred:${project.id}`;
    if (lastOperatorBaseBranchFailureSignature.get(credKey) !== 'no-token') {
      lastOperatorBaseBranchFailureSignature.set(credKey, 'no-token');
      console.error(
        `[Autonomous] No per-user GitHub credential reachable for project "${project.name}" — base-branch probe will run unauthenticated. ` +
          `Connect a GitHub account at Settings → Integrations to silence this and allow private-repo access.`,
      );
    }
  } else if (token && (opts?.config || opts?.resolveToken)) {
    // Token became available — clear the "no-cred" warning slot so a later
    // disconnect/refresh-failure logs again.
    lastOperatorBaseBranchFailureSignature.delete(`cred:${project.id}`);
  }

  const childEnv = autoGitChildEnv(token);

  try {
    // Best-effort fetch so the existence check sees recently-created branches.
    try {
      await execFileAsync('git', ['fetch', 'origin', '--no-tags'], {
        cwd,
        timeout: 30_000,
        env: childEnv,
      });
    } catch {
      // Non-fatal: we still try ls-remote, which talks to the remote directly.
    }

    // `ls-remote --heads` is the source of truth — it bypasses stale local
    // refs and asks origin directly.
    const { stdout: lsOut } = await execFileAsync('git', ['ls-remote', '--heads', 'origin', name], {
      cwd,
      timeout: 15_000,
      env: childEnv,
    });
    if (lsOut.trim()) {
      lastOperatorBaseBranchFailureSignature.delete(debounceKey);
      return 'exists';
    }

    // Resolve a base SHA from origin/HEAD (with main/master fallback).
    let sha: string | null = null;
    for (const ref of ['origin/HEAD', 'origin/main', 'origin/master']) {
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', ref], {
          cwd,
          timeout: 5_000,
          env: childEnv,
        });
        sha = stdout.trim();
        if (sha) break;
      } catch {
        // try next candidate
      }
    }
    if (!sha) {
      logFailureOnce(
        'no-remote-head',
        `[Autonomous] Cannot resolve remote HEAD for project "${project.name}" — operator base branch "${name}" not created; PRs will fall back to default branch`,
      );
      return 'failed';
    }

    await execFileAsync('git', ['push', 'origin', `${sha}:refs/heads/${name}`], {
      cwd,
      timeout: 30_000,
      env: childEnv,
    });
    console.log(
      `[Autonomous] ✅ Created operator-set base branch "${name}" for project "${project.name}" (base SHA: ${sha.substring(0, 7)})`,
    );
    lastOperatorBaseBranchFailureSignature.delete(debounceKey);
    return 'created';
  } catch (err) {
    const msg = (err as Error).message;
    // Stable signature: collapse changing transient bits (timestamps, request
    // ids) by hashing on the first line only. Most git failures here put the
    // actionable text on line 1.
    const firstLine = msg.split('\n', 1)[0] || msg;
    logFailureOnce(
      `err:${firstLine}`,
      `[Autonomous] Failed to ensure operator base branch "${name}" for project "${project.name}": ${msg} — PRs will fall back to default branch`,
    );
    return 'failed';
  }
}

// Dependency Types

/** A card the tick found ready, with the agent routing suggests for it. */
export interface ReadyCardOffer {
  card: KanbanCardRow;
  agentId: string;
  phaseId: string | null;
}

/** Something a worker or the board did that the epic's manager should hear about. */
export type EpicWorkerEventKind =
  | 'done'
  | 'cancelled'
  | 'requeued'
  | 'turn_finished'
  | 'needs_input'
  | 'finalize_failed'
  | 'error'
  | 'phase_complete'
  | 'epic_complete';

export interface EpicWorkerEvent {
  kind: EpicWorkerEventKind;
  cardId?: string | null;
  sessionId?: string | null;
  /** The phase a phase-level event is about (phase_complete). */
  phaseId?: string | null;
  detail?: string | null;
}

/**
 * The epic's manager thread, as the tick sees it. Readiness stays here; the
 * manager writes the worker brief and starts the worker from a forward card,
 * which lands back in `spawnEpicWorkerForCard`.
 */
export interface EpicManagerPort {
  offerReady(args: {
    projectId: string;
    epic: KanbanEpicRow;
    phase: KanbanPhaseRow | null;
    ready: ReadyCardOffer[];
    ownerUserId: string;
  }): void | Promise<void>;
  /** Whether the epic has a live manager session. The server never creates one. */
  hasLiveManager(epicId: string): boolean;
  /** Cards with an offer the manager has not acted on yet (they hold a slot). */
  liveOffers(epicId: string): string[];
  withdrawOffer(cardId: string): void;
  isOffered(cardId: string): boolean;
  /** Held by the manager, at the retry cap, or reported stalled. */
  isHeld(cardId: string): boolean;
  isAtRetryCap(cardId: string): boolean;
  noteWorkerStarted(cardId: string, epicId: string): void;
  /** An explicit kickoff by a different person makes the manager theirs. */
  handOver(epicId: string, ownerUserId: string): boolean;
  noteWorkerEvent(epicId: string, event: EpicWorkerEvent): void;
  /** Brief the epic's live manager if it has not been briefed. Never creates a session. */
  kickoff(projectId: string, epic: KanbanEpicRow, ownerUserId: string): unknown;
  /** The epic stopped: no more wakes, offers lapse, pending Auto starts cancelled. */
  pause(epicId: string): void;
  noteRetryCapRefusal(epicId: string, cardId: string): void;
  /** Diff the epic's cards against the last look; Done and Cancelled moves become events. */
  observeCards(
    epic: KanbanEpicRow,
    cards: KanbanCardRow[],
    columnNameById: Record<string, string>,
  ): void;
}

interface AutonomousDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  findProject: (projectId: string) => Project | undefined;
  findAgent: (agentId: string) => { project: Project; agent: Agent } | null;
  handleChat: (ws: unknown, msg: ChatMessage) => Promise<void>;
  /**
   * Clone the session worktree, boot the VM/container, and wait for project
   * session-startup hooks before the first autonomous chat turn. Optional in
   * tests. Interactive session open uses `POST …/workspace/ensure` instead
   * (VM boot, but startup hooks stay in the background).
   */
  prepareSessionEnv?: (sessionId: string) => Promise<void>;
  handleCancel: (sessionId: string) => void;
  getActiveProcesses: () => Map<string, unknown>;
  getProjects: () => Project[];
  getConfig: () => AppConfig;
  getGhAuthenticatedUser: () => string | null;
  /**
   * Access to the underlying SQLite handle. Used by the transactional
   * slot-claim path inside `runAutonomousLoop` to wrap the re-read of
   * `activeCardCount` and the move-to-In-Progress in a single
   * `BEGIN IMMEDIATE` so two callers can't race a card into a breached cap.
   * Tests inject a fake whose `transaction()` wrapper just calls the body
   * synchronously.
   */
  getDb: () => Database;
  /** Drain per-session message queues when no CLI is in flight. */
  drainIdleSessionQueues?: () => number;
  /** The epic manager threads. Ready cards are only ever handed to these. */
  epicManager?: EpicManagerPort;
}

// Module-level state
const autonomousCrons = new Map<string, cron.ScheduledTask>();
const autonomousProjects = new Set<string>();

// A board may run MORE THAN ONE epic in autonomous mode at once. `autonomousCrons`
// is keyed by epic id, but `autonomousProjects` (consumed by `tryAutonomousDispatch`
// and `chat.ts`) is a flat set of project ids — so when one epic of a multi-epic
// project flips off we must NOT drop the project until its LAST autonomous epic
// is gone. This tracks the live autonomous-epic ids per project so membership in
// `autonomousProjects` is reference-counted, not last-writer-wins.
const autonomousEpicsByProject = new Map<string, Set<string>>();

/**
 * Debounce key for blocker-skip card comments: cardId → signature of the
 * unresolved-blocker set the last time we commented. Without this the
 * 60-second safety-net cron would post a "still blocked" comment every
 * minute, which would bury the rest of the card's discussion.
 *
 * The signature is a stable join of `id:column_id` for each unresolved
 * blocker, so we re-comment only when the blocking set actually changes
 * (new blocker added, blocker moved to a different non-Done column, etc.).
 * When the card becomes eligible again, the entry is deleted so a future
 * blocker triggers a fresh comment.
 */
const lastBlockerSkipSignature = new Map<string, string>();

// Injected dependencies (set via init())
let deps: AutonomousDeps | null = null;

function getDeps(): AutonomousDeps {
  if (!deps) throw new Error('autonomous: initAutonomous() must be called before use');
  return deps;
}

/**
 * Reverse lookup: which engine owns this model id? Returns null when the
 * model isn't in any configured engine's allowlist. Used to honour a
 * cross-engine model override at dispatch time (e.g. an operator picks
 * `composer-2.5`, a Cursor model, for an autonomous epic whose dispatchable
 * agents default to `claude-code` — without this we'd silently drop the
 * override and fall back to the agent's default model).
 *
 * Exported for unit testing.
 */
export function engineForModel(
  model: string,
  engineValidModels: Record<string, string[]>,
): string | null {
  for (const [engine, models] of Object.entries(engineValidModels)) {
    if (Array.isArray(models) && models.includes(model)) return engine;
  }
  return null;
}

/**
 * Engine + model for a new autonomous session, derived from (in priority
 * order):
 *   1. `epic.autonomous_model`, if valid for the agent's default engine →
 *      keep the agent engine, use the model.
 *   2. `epic.autonomous_model`, if valid for SOME OTHER configured engine →
 *      switch the spawn to that engine + model. This is the cross-engine
 *      override path: the agent's identity (id, workspace, skills) is
 *      preserved, but the CLI spawn runs under the engine that actually
 *      owns the model. `chat.ts` reads `session.engine` from the DB row
 *      when spawning, so the override flows end-to-end.
 *   3. Otherwise → the agent's effective engine + model for the autonomous
 *      session owner (their per-user engine override, else the shared engine).
 *
 * "The agent's engine" in 1–2 is also the owner's effective engine.
 *
 * Card-level `assign_model` follows the same precedence but is resolved by
 * the dispatch loop directly (the function used to handle only the epic
 * level, but the card path now shares the cross-engine logic too).
 */
function sessionEngineAndModelForAutonomousDispatch(
  epic: KanbanEpicRow,
  agent: Agent,
  engineValidModels: Record<string, string[]>,
  cfg: AppConfig,
  ownerUserId: string | null,
): { engine: string; model: string } {
  const resolved = resolveAgentSpawnEngineAndModel(cfg, agent, ownerUserId);
  const agentEngine = resolved.engine;
  const raw = typeof epic.autonomous_model === 'string' ? epic.autonomous_model.trim() : '';
  if (raw) {
    const agentAllowed = engineValidModels[agentEngine] || [];
    if (agentAllowed.includes(raw)) return { engine: agentEngine, model: raw };
    const otherEngine = engineForModel(raw, engineValidModels);
    if (otherEngine) return { engine: otherEngine, model: raw };
  }
  return resolved;
}

export function initAutonomous(d: AutonomousDeps): void {
  deps = d;
}

/** Attach the epic manager threads (built after `initAutonomous` in index.ts). */
export function attachEpicManager(manager: EpicManagerPort | null): void {
  getDeps().epicManager = manager ?? undefined;
}

// Getters for shared state (used by index.ts)

export {
  autonomousCrons,
  autonomousProjects,
  autonomousEpicsByProject,
  lastDispatchedReviewId,
  lastBlockerSkipSignature,
};

/**
 * List every epic on a board that is currently in autonomous mode.
 *
 * Prefers the plural `getAutonomousEpics` statement (multi-epic aware). Falls
 * back to the singular `getAutonomousEpic` for callers/tests that only wired the
 * older statement — in that case the board behaves as it did before (one epic),
 * so existing single-epic mocks keep working unchanged.
 */
function listAutonomousEpics(stmts: Stmts, boardId: string): KanbanEpicRow[] {
  const plural = (stmts as { getAutonomousEpics?: { all?: (id: string) => unknown } })
    .getAutonomousEpics;
  if (plural?.all) {
    return (plural.all(boardId) as KanbanEpicRow[]) ?? [];
  }
  const one = stmts.getAutonomousEpic?.get(boardId) as KanbanEpicRow | undefined;
  return one ? [one] : [];
}

function findColumnByName(
  cols: Array<Pick<KanbanColumnRow, 'id' | 'name'>>,
  name: string,
): Pick<KanbanColumnRow, 'id' | 'name'> | undefined {
  const normalized = name.trim().toLowerCase();
  return cols.find((c) => c.name.trim().toLowerCase() === normalized);
}

// Core Dispatch

/**
 * Per-epic single-flight gate. The autonomous loop is fan-in from FIVE
 * concurrent triggers (60s safety-net cron, end-of-session timer, PR-merged
 * webhook, scheduling kickoff, manual `POST /dispatch`), each of which calls
 * `runAutonomousLoop` without a mutex. Between the read of `activeCardCount`
 * and the move-to-In-Progress there are multiple `await` points — each yields
 * the event loop — so two invocations could both observe `activeCardCount=0`,
 * both pass the slot check, and both dispatch, producing 2 in-flight cards
 * under a `max_concurrent=1` epic.
 *
 * Fix: coalesce, don't queue. When a loop is already running for a given
 * epic, return the existing promise instead of starting a second body. The
 * caller still sees a resolved promise once dispatch settles, but no second
 * body runs. The map key is the epic id (not project id) because
 * `autonomous_max_concurrent` is an epic-level setting and a board may run
 * several epics autonomously at once — each gets its own single-flight gate so
 * coalescing one epic's burst never blocks a sibling epic's dispatch.
 */
const inflightLoops = new Map<string, Promise<void>>();

/**
 * Run the dispatch body for a single epic behind the per-epic single-flight
 * gate. Shared by the whole-board sweep (`runAutonomousLoop`) and the
 * per-epic cron tick (`runAutonomousLoopForEpic`) so both honor the same
 * coalescing rule.
 */
function dispatchEpicGated(projectId: string, epic: KanbanEpicRow): Promise<void> {
  const existing = inflightLoops.get(epic.id);
  if (existing) return existing;

  const p = runAutonomousLoopInner(projectId, epic).finally(() => {
    inflightLoops.delete(epic.id);
  });
  inflightLoops.set(epic.id, p);
  return p;
}

function phaseInflightKey(phaseId: string): string {
  return `phase:${phaseId}`;
}

function dispatchPhaseGated(projectId: string, phase: KanbanPhaseRow): Promise<void> {
  const key = phaseInflightKey(phase.id);
  const existing = inflightLoops.get(key);
  if (existing) return existing;

  const p = runAutonomousLoopInnerForPhase(projectId, phase).finally(() => {
    inflightLoops.delete(key);
  });
  inflightLoops.set(key, p);
  return p;
}

async function runAutonomousLoopInnerForPhase(
  projectId: string,
  phase: KanbanPhaseRow,
): Promise<void> {
  const d = getDeps();
  const epic = d.stmts.getKanbanEpic.get(phase.epic_id) as KanbanEpicRow | undefined;
  if (!epic) return;
  await runAutonomousLoopInner(projectId, epic, phase);
}

/**
 * Whole-board sweep: dispatch EVERY autonomous epic on the project's board.
 *
 * This is the right entry point for board-level triggers (manual
 * `POST /autonomous/run`, the event-driven `tryAutonomousDispatch` after a
 * session ends, the PR-merged webhook) where we want to give every epic a
 * chance to pick up newly-freed slots. The per-epic 60s safety-net cron does
 * NOT call this — see `runAutonomousLoopForEpic` — so a board with N
 * autonomous epics does not produce N full-board sweeps every minute.
 */
export async function runAutonomousLoop(projectId: string): Promise<void> {
  const d = getDeps();
  const project = d.findProject(projectId);
  if (!project) return Promise.resolve();

  const boardData = getOrCreateBoard(d.stmts, projectId);
  if (!boardData?.board) return Promise.resolve();

  // A board can run several epics autonomously at once. Tick each one
  // independently — every epic carries its own slot cap and its own per-epic
  // single-flight gate, so a slow dispatch on one epic never stalls another.
  const epics = listAutonomousEpics(d.stmts, boardData.board.id);
  const phases = (d.stmts.getAutonomousPhases?.all(boardData.board.id) as KanbanPhaseRow[]) ?? [];
  if (epics.length === 0 && phases.length === 0) return Promise.resolve();

  await Promise.all(epics.map((epic) => dispatchEpicGated(projectId, epic)));
  await Promise.all(phases.map((phase) => dispatchPhaseGated(projectId, phase)));
}

/**
 * Single-epic dispatch: tick ONLY the named epic.
 *
 * Each autonomous epic owns its own cron (keyed by epic id). That cron fires
 * this — not the whole-board `runAutonomousLoop` — so one epic's tick never
 * dispatches its siblings. Without this, N per-epic crons would each sweep the
 * full board, causing N× duplicate dispatch attempts per tick and letting a
 * fast-ticking epic drive a slower sibling.
 *
 * The epic is re-read fresh from the DB on every tick (the cron closure only
 * captures the id) so a mid-flight settings change or an autonomous-off
 * transition is honored without rescheduling.
 */
export async function runAutonomousLoopForEpic(projectId: string, epicId: string): Promise<void> {
  const d = getDeps();
  const project = d.findProject(projectId);
  if (!project) return;

  const boardData = getOrCreateBoard(d.stmts, projectId);
  if (!boardData?.board) return;

  const epic = d.stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined;
  // Skip if the epic was deleted, turned off, or somehow belongs to a different
  // board than this project's — the stale cron will be torn down on the next
  // `scheduleAutonomousEpic` call.
  if (!epic || !epic.autonomous || epic.board_id !== boardData.board.id) return;

  await dispatchEpicGated(projectId, epic);
}

/**
 * When an autonomous phase completes, start the next armed phase in the same
 * epic so a multi-phase run advances on its own. Mirrors the gates in
 * `startAutonomousPhase`: only an armed phase (`autonomous = 1`) auto-starts,
 * and a resolvable credential owner is required (the completed phase's runner,
 * falling back to the next phase's own `autonomous_enabled_by`). If the
 * next phase is not armed, there is no next phase, or no owner resolves, we
 * leave it stopped — same as before. Cascades naturally: starting the next
 * phase re-enters the loop, so an already-complete next phase advances again.
 */
async function maybeAdvanceToNextPhase(
  projectId: string,
  epic: KanbanEpicRow,
  completedPhase: KanbanPhaseRow,
): Promise<void> {
  const d = getDeps();
  const phases = d.stmts.getKanbanPhasesByEpic.all(epic.id) as KanbanPhaseRow[];
  const idx = phases.findIndex((p) => p.id === completedPhase.id);
  const columns = d.stmts.getKanbanColumns.all(epic.board_id) as KanbanColumnRow[];
  const colNames = new Map(columns.map((c) => [c.id, c.name]));
  // Skip later phases with no live work (empty, all-Done, or all-Cancelled)
  // when picking what to advance to. Such a phase never reaches a state that
  // cascades, so landing on one would strand the epic. `findIncompletePredecessor`
  // still enforces ordering against any live work in between.
  const next =
    idx >= 0
      ? phases.slice(idx + 1).find((p) => {
          const cards = d.stmts.getKanbanCardsByPhase.all(p.id) as KanbanCardRow[];
          return cards.some((c) => !isCardSettled(colNames.get(c.column_id)));
        })
      : undefined;
  if (!next) return; // no later phase with live work — nothing to advance to

  if (!next.autonomous) {
    console.log(
      `[Autonomous] phase "${completedPhase.name}" complete — next phase "${next.name}" is not armed for auto-dispatch; leaving stopped`,
    );
    return;
  }
  if (findIncompletePredecessor(epic, next.id)) return;
  if (next.autonomous_running) return; // already running — nothing to do

  // The user who ran the completed phase owns the continuation. The next
  // phase's own stamp only records who once armed it, which can be a different
  // user (or an agent session acting as them), so it is a fallback.
  const owner = completedPhase.autonomous_enabled_by ?? next.autonomous_enabled_by ?? null;
  if (!owner) {
    console.log(
      `[Autonomous] phase "${completedPhase.name}" complete — cannot auto-start next phase "${next.name}": no resolvable owner for credential resolution`,
    );
    return;
  }

  d.stmts.setPhaseAutonomousEnabledBy.run(owner, next.id);
  d.stmts.setPhaseAutonomousRunning.run(1, next.id);
  const started = d.stmts.getKanbanPhase.get(next.id) as KanbanPhaseRow;
  scheduleAutonomousPhase(projectId, started);
  d.broadcast({ type: 'kanban_update', projectId });
  console.log(
    `[Autonomous] phase "${completedPhase.name}" complete — auto-started next phase "${next.name}"`,
  );
}

/**
 * A card is "settled" once it reaches a terminal lane — Done **or** Cancelled.
 * Cancelled cards are dropped work, not live tickets: they never move to Done,
 * so a phase-completion gate that only counts `isColumnDone` treats a phase
 * whose remaining cards are Cancelled as incomplete *forever*, permanently
 * deadlocking every later phase (the reported bug: P0 sat at 28 Done + 2
 * Cancelled and blocked the whole epic). Only a card that is neither Done nor
 * Cancelled represents live, unfinished work.
 */
function isCardSettled(columnName: string | null | undefined): boolean {
  return isColumnDone(columnName) || isColumnCancelled(columnName);
}

/** Every earlier phase must finish, regardless of its armed/running flags. */
function findIncompletePredecessor(
  epic: KanbanEpicRow,
  phaseId: string,
): KanbanPhaseRow | undefined {
  const d = getDeps();
  const phases = d.stmts.getKanbanPhasesByEpic.all(epic.id) as KanbanPhaseRow[];
  const index = phases.findIndex((p) => p.id === phaseId);
  if (index <= 0) return undefined;
  const columns = d.stmts.getKanbanColumns.all(epic.board_id) as KanbanColumnRow[];
  const names = new Map(columns.map((c) => [c.id, c.name]));
  return phases.slice(0, index).find((p) => {
    const cards = d.stmts.getKanbanCardsByPhase.all(p.id) as KanbanCardRow[];
    // An earlier phase blocks its successors only while it holds at least one
    // card that is still live (neither Done nor Cancelled). An empty phase, an
    // all-Done phase, and an all-Cancelled phase all have no live work, so none
    // of them block — otherwise a phase that can never reach a pure-Done state
    // (empty, or with dropped/Cancelled cards) would deadlock the epic forever.
    return cards.some((c) => !isCardSettled(names.get(c.column_id)));
  });
}

/**
 * Live autonomous-dispatched sessions per agent within one dispatch scope
 * (the phase when dispatching a phase, else the epic). The tick's routing and
 * the worker start both read capacity from here, so they cannot disagree.
 */
function scopeAgentActiveCounts(
  epic: KanbanEpicRow,
  phase: KanbanPhaseRow | null,
): Map<string, number> {
  const d = getDeps();
  const activeProcesses = d.getActiveProcesses();
  const agentSessionCounts = new Map<string, number>();
  // Only autonomous-dispatched sessions count toward the per-agent slot cap.
  // An interactive human chat with the same agent is unrelated to the
  // autonomous concurrency budget (and unrelated to integration-branch
  // serialization, which exists to keep two *autonomous* PRs from racing onto
  // the same umbrella branch). Previously every active process — interactive
  // or autonomous — consumed a slot, so a single human chat could pin the
  // only assignable agent at 0 slots forever and the dispatch loop would
  // silently break with no log line.
  //
  // DO NOT "fix" this by filtering on `session.ask_mode`
  // It looks tempting — `ask_mode` is on the SessionRow and easy to read
  // here — but `ask_mode` is the read-only / plan-mode flag (see
  // `chat.ts:~2319` where it gates `--yolo`), not a dispatch-origin marker.
  // Autonomous-dispatched sessions are created with `ask_mode = 0`
  // (`createSession.run(..., 0, 1)` at the autonomous spawn site below;
  // column order at `db.ts: createSession`'s prepare), *identical* to a
  // default interactive chat. So `session.ask_mode !== 0` would only
  // separate plan-mode sessions from everything else, and the original
  // bug (regular human chat consuming an autonomous slot) would still fire.
  // The kanban card's `dispatched_by_autonomous` flag is the only signal
  // that distinguishes the two; it's set inside the slot-claim transaction
  // (`markCardDispatchedByAutonomous` further down) before the session is
  // created, so any session linked to a card with that flag is autonomous
  // by construction. Sessions without a linked card (interactive chat,
  // cron-spawned, ad-hoc heartbeats) are never autonomous-dispatched by
  // this loop. (See PR #1064 history if a reviewer flags this filter again.)
  for (const [sid] of activeProcesses) {
    const session = d.stmts.getSession.get(sid) as { agent_id: string } | undefined;
    if (!session) continue;
    const linkedCard = d.stmts.getKanbanCardBySession.get(sid) as KanbanCardRow | undefined;
    if (!linkedCard || !linkedCard.dispatched_by_autonomous) continue;
    // Per-agent slot accounting is scoped to the CURRENT dispatch scope
    // A session that belongs to a *different* epic (or, when dispatching a
    // phase, a different phase) is unrelated to THIS scope's concurrency
    // budget: epics and phases run independently and must never starve one
    // another through a shared board-wide per-agent cap. Previously this
    // counted every autonomous-dispatched session board-wide, so a single Dev
    // agent already working two *other* epics' cards would show 0 remaining
    // slots here, and this scope's dispatch loop would hit
    // `agentsWithSlots.length === 0` and silently return — the exact "I turned
    // on the phase but nothing gets picked up, those are different epics
    // though" report. The only real ceiling on dispatch volume is the
    // per-scope `slotsAvailable` (In Progress + Review cards within this
    // epic/phase vs. its own `max_concurrent`), which is already scoped the
    // same way (`allScopeCards`). Aligning the per-agent count with it makes
    // "different epics don't block each other" true by construction.
    const inCurrentScope = phase
      ? linkedCard.phase_id === phase.id
      : linkedCard.epic_id === epic.id;
    if (!inCurrentScope) continue;
    agentSessionCounts.set(session.agent_id, (agentSessionCounts.get(session.agent_id) || 0) + 1);
  }
  return agentSessionCounts;
}

/**
 * Why this card may not start a worker right now, or null when it may. The
 * single definition of "ready to start" (apart from the scope's concurrency
 * cap): the tick runs it before offering a card and on every live offer before
 * counting slots, and the worker start runs it inside its claim transaction.
 */
export function cardStartRefusal(
  card: KanbanCardRow | undefined,
  epic: KanbanEpicRow,
  todoColId: string | undefined,
): { code: SpawnEpicWorkerRefusal; error: string } | null {
  const d = getDeps();
  if (!card || card.epic_id !== epic.id) {
    return { code: 'not_found', error: 'The card is gone or no longer on this epic' };
  }
  if (
    card.column_id !== todoColId ||
    (card.assignee != null && String(card.assignee).trim() !== '')
  ) {
    return { code: 'ineligible', error: `"${card.title}" is no longer in To Do and unassigned` };
  }
  if (d.epicManager?.isAtRetryCap(card.id)) {
    return { code: 'retry_cap', error: `"${card.title}" reached its worker retry limit` };
  }
  if (hasHoldLabel(card.labels) || d.epicManager?.isHeld(card.id)) {
    return { code: 'held', error: `"${card.title}" is on hold` };
  }
  if (card.phase_id && findIncompletePredecessor(epic, card.phase_id)) {
    return { code: 'ineligible', error: `An earlier phase than "${card.title}"'s is still open` };
  }
  if (hasUnresolvedBlockers(card.id, loadBoardBlockers(d.stmts, epic.board_id))) {
    return { code: 'ineligible', error: `"${card.title}" still has unresolved blockers` };
  }
  if (!isSpikeCard(card)) {
    const { phase } = dispatchScopeForCard(epic, card);
    const openSpec = phase
      ? countOpenSpecItemsForPhase(d.stmts, epic.id, phase.id)
      : countOpenSpecItems(d.stmts, epic.id);
    if (openSpec > 0) {
      return {
        code: 'ineligible',
        error: `Spec decisions are still open; "${card.title}" waits for them`,
      };
    }
  }
  return null;
}

async function runAutonomousLoopInner(
  projectId: string,
  epic: KanbanEpicRow,
  phase?: KanbanPhaseRow | null,
): Promise<void> {
  const d = getDeps();
  const project = d.findProject(projectId);
  if (!project) return;

  const boardData = getOrCreateBoard(d.stmts, projectId);
  if (!boardData?.board) return;

  // All entry points (including board sweeps and restored crons) share this
  // gate. Clear stale later-phase runs so completion can restart them in order.
  if (phase) {
    const current = d.stmts.getKanbanPhase.get(phase.id) as KanbanPhaseRow | undefined;
    if (!current?.autonomous_running) return;
    phase = current;
    const predecessor = findIncompletePredecessor(epic, phase.id);
    if (predecessor) {
      stopAutonomousPhase(projectId, phase.id);
      console.log(
        `[Autonomous] Phase "${phase.name}" is waiting for phase "${predecessor.name}" to complete`,
      );
      return;
    }
  }

  // Scope the open-spec dispatch gate to the unit being dispatched. For a phase
  // run, only the phase's own (and epic-wide unphased) decisions may hold back
  // its build cards — an open spec in a sibling phase must not strand this phase,
  // which would otherwise leave the whole epic unable to run autonomously.
  const openSpecCount = phase
    ? countOpenSpecItemsForPhase(d.stmts, epic.id, phase.id)
    : countOpenSpecItems(d.stmts, epic.id);
  if (openSpecCount > 0) {
    console.log(
      `[Autonomous] ${openSpecCount} open spec decision(s) on ${phase ? `phase "${phase.name}"` : `epic "${epic.name}"`} — dispatching spike tickets only until decisions are locked`,
    );
  }

  const settings = phase ?? epic;
  const scopeLabel = phase ? `phase "${phase.name}"` : `epic "${epic.name}"`;
  const dispatchEpic: KanbanEpicRow = phase
    ? {
        ...epic,
        autonomous_model: phase.autonomous_model,
        autonomous_send_it: phase.autonomous_send_it ?? 0,
        autonomous_max_concurrent: phase.autonomous_max_concurrent,
        autonomous_enabled_by: phase.autonomous_enabled_by ?? null,
      }
    : epic;

  const colsForDoneCheck = d.stmts.getKanbanColumns.all(boardData.board.id) as KanbanColumnRow[];
  const colNameByIdForEpic = Object.fromEntries(colsForDoneCheck.map((c) => [c.id, c.name]));
  const allScopeCards = (
    phase ? d.stmts.getKanbanCardsByPhase.all(phase.id) : d.stmts.getKanbanCardsByEpic.all(epic.id)
  ) as KanbanCardRow[];
  // A scope is complete once every card is settled (Done or Cancelled) — a
  // Cancelled card is finished, dropped work, so a phase left at "all Done + a
  // few Cancelled" must still count as complete (else it never disarms and
  // never advances). `length > 0` keeps a not-yet-scoped empty phase from
  // declaring itself done.
  const scopeWorkComplete =
    allScopeCards.length > 0 &&
    allScopeCards.every((c) => isCardSettled(colNameByIdForEpic[c.column_id]));

  // Done / Cancelled / requeued moves, however they happened (merge, manual
  // move, the manager's own override), reach the manager from here.
  d.epicManager?.observeCards(
    epic,
    phase ? (d.stmts.getKanbanCardsByEpic.all(epic.id) as KanbanCardRow[]) : allScopeCards,
    colNameByIdForEpic,
  );

  if (scopeWorkComplete && settings.autonomous) {
    if (epic.pr_base_branch && !epic.pr_base_branch.startsWith(AUTONOMOUS_BRANCH_PREFIX)) {
      console.log(
        `[Autonomous] 🎉 ${scopeLabel} complete — integration branch "${epic.pr_base_branch}" is ready.`,
      );
    }

    if (phase) {
      d.stmts.updateKanbanPhase.run(
        phase.name,
        phase.description,
        0,
        phase.autonomous_interval,
        phase.autonomous_max_concurrent,
        phase.autonomous_model ?? null,
        // Preserve the phase's Auto Merge setting across the disarm-on-complete.
        phase.autonomous_send_it ?? 0,
        phase.id,
      );
      d.stmts.setPhaseAutonomousRunning.run(0, phase.id);
      const clearedPhase = d.stmts.getKanbanPhase.get(phase.id) as KanbanPhaseRow;
      scheduleAutonomousPhase(projectId, clearedPhase);
      d.broadcast({ type: 'kanban_update', projectId });
      console.log(`[Autonomous] ${scopeLabel} — all cards are Done; autonomous mode disabled`);
      d.epicManager?.noteWorkerEvent(epic.id, {
        kind: 'phase_complete',
        phaseId: phase.id,
        detail: `phase "${phase.name}" is complete`,
      });
      // Sequential phases: when one finishes, automatically start the next
      // armed phase in the epic instead of stranding the operator on a manual
      // "Run phase" click. Cascades through already-complete phases.
      await maybeAdvanceToNextPhase(projectId, epic, clearedPhase);
      return;
    } else {
      d.stmts.updateKanbanEpic.run(
        epic.name,
        epic.description,
        epic.color,
        0,
        epic.autonomous_interval,
        epic.autonomous_max_concurrent,
        epic.autonomous_model ?? null,
        epic.orchestration_budgets_json ?? null,
        epic.pr_base_branch ?? null,
        epic.labels ?? null,
        epic.id,
      );
      // Tell the manager before the epic stops, so the wrap-up is not dropped
      // as a paused epic's wake.
      d.epicManager?.noteWorkerEvent(epic.id, {
        kind: 'epic_complete',
        detail: 'every card is Done or Cancelled',
      });
      const clearedEpic = d.stmts.getKanbanEpic.get(epic.id) as KanbanEpicRow;
      scheduleAutonomousEpic(projectId, clearedEpic);
    }
    d.broadcast({ type: 'kanban_update', projectId });
    console.log(`[Autonomous] ${scopeLabel} — all cards are Done; autonomous mode disabled`);
    return;
  }

  // The server never creates an epic's manager. Without a live one there is
  // nobody to hand ready cards to, so the tick stops here.
  if (d.epicManager && !epicHasManager(d.epicManager, epic, scopeLabel)) return;

  const rawEligible = (
    phase
      ? d.stmts.getEligibleAutonomousCardsByPhase.all(phase.id)
      : d.stmts.getEligibleAutonomousCards.all(epic.id)
  ) as KanbanCardRow[];

  const rawSpikeEligible = (
    phase
      ? d.stmts.getEligibleAutonomousSpikeCardsByPhase.all(phase.id)
      : d.stmts.getEligibleAutonomousSpikeCards.all(epic.id)
  ) as KanbanCardRow[];

  // Filter out cards whose blockers aren't all Done. Re-loaded on every
  // tick so newly-cleared blockers (the blocking card landed in Done since
  // the last run) become eligible without restarting the cron. We log each
  // skip and post a one-shot card comment naming the blockers so operators
  // can see WHY autonomous mode isn't picking up a card that otherwise
  // matches the SQL eligibility criteria — `console.log` alone is invisible
  // to a user watching the UI.
  const blockerIndex = loadBoardBlockers(d.stmts, boardData.board.id);
  let anyBlockerCommentPosted = false;
  const filterEligibleCards = (cards: KanbanCardRow[]): KanbanCardRow[] => {
    const result: KanbanCardRow[] = [];
    for (const card of cards) {
      // Epic-wide dispatch must obey the same sequence as phase dispatch.
      if (card.phase_id && findIncompletePredecessor(epic, card.phase_id)) continue;
      if (hasUnresolvedBlockers(card.id, blockerIndex)) {
        const unresolvedLinks = (blockerIndex.blockersByCard.get(card.id) ?? []).filter(
          (b) => !b.done,
        );
        const titles = unresolvedLinks.map((b) => b.title);
        console.log(
          `[Autonomous] Skipping "${card.title}" — blocked by ${unresolvedLinks.length} unresolved card(s): ${titles.join(', ')}`,
        );

        const signature = unresolvedLinks
          .map((b) => `${b.id}:${b.column_id ?? ''}`)
          .sort()
          .join('|');
        const prev = lastBlockerSkipSignature.get(card.id);
        if (prev !== signature) {
          try {
            const hazards = unresolvedLinks.map((b) => safePlacementHazard(d.stmts, card.id, b.id));
            const bulletList = unresolvedLinks
              .map((b, i) => {
                const hazard = hazards[i];
                return `- **${b.title}** (\`${b.id}\`)${hazard ? `\n  ⚠️ ${hazard.message}` : ''}`;
              })
              .join('\n');
            const footer = hazards.some(Boolean)
              ? 'At least one blocker cannot be reached by this phase order, so the phase will stall until it is moved.'
              : 'This card will be picked up automatically once every blocker lands in a Done column. No restart needed.';
            d.stmts.createKanbanCardComment.run(
              uuidv4(),
              card.id,
              'system',
              `⏸️ **Autonomous dispatch skipped — unresolved blockers**\n\nWaiting on:\n${bulletList}\n\n${footer}`,
            );
            lastBlockerSkipSignature.set(card.id, signature);
            anyBlockerCommentPosted = true;
          } catch (_) {
            /* best-effort: a failed comment write must not strand the dispatch loop */
          }
        }
        continue;
      }
      if (lastBlockerSkipSignature.has(card.id)) {
        lastBlockerSkipSignature.delete(card.id);
      }
      result.push(card);
    }
    return result;
  };

  const spikeEligible = filterEligibleCards(rawSpikeEligible);
  const buildEligible = filterEligibleCards(
    rawEligible.filter((card) => !isSpikeCard(card) && !isLinkedSpikeCard(d.stmts, card.id)),
  );

  const eligible = openSpecCount > 0 ? spikeEligible : [...spikeEligible, ...buildEligible];
  if (anyBlockerCommentPosted) {
    d.broadcast({ type: 'kanban_update', projectId });
  }

  if (eligible.length === 0) {
    console.log(
      `[Autonomous] No eligible cards for ${scopeLabel} (all assigned, done, or blocked)`,
    );
    return;
  }

  // Umbrella / integration branch (opt-in via operator-set value)
  // We do NOT auto-create a branch when `epic.pr_base_branch` is blank.
  // Blank → every card's auto-PR targets the repo's default branch (handled
  // by `auto-git.ts` falling back when `effectivePrBaseBranch()` returns
  // null).
  //
  // Operator-set values: if the branch doesn't exist on origin yet, create
  // it (rooted at current origin/HEAD). Idempotent — once the branch is on
  // origin, subsequent ticks short-circuit at the ls-remote check. Failure
  // is non-fatal; `auto-git.ts` will fall back to default and comment on
  // the card so the operator sees what happened.
  if (epic.pr_base_branch && epic.pr_base_branch.trim()) {
    await ensureOperatorBaseBranch(project, epic.pr_base_branch, { config: d.getConfig() });
  }

  const agentSessionCounts = scopeAgentActiveCounts(epic, phase ?? null);

  // Reviewer/docs are out-of-band roles — never autonomously assigned.
  // Leads are always assignable and are the safety net for cards without a
  // matching specialist label.
  const roleFiltered = project.agents.filter((a) => a.role !== 'docs' && a.role !== 'reviewer');
  let assignableAgents: Agent[] = roleFiltered;

  // Honour the per-agent "Dev" flag: an agent that is not a Dev (explicit
  // `isDev: false`) never receives autonomously-dispatched tickets. Default
  // Dev roles (dev/lead) are always kept; out-of-band roles are already gone.
  // `undefined` stays eligible so pre-flag rosters don't silently stop.
  assignableAgents = assignableAgents.filter((a) => agentAcceptsAutonomousTickets(a));

  // Integration-branch serialization override
  // When an epic targets an operator-set integration branch
  // (`epic.pr_base_branch`), parallel dispatch defeats the whole point of
  // the integration: cards N and N+1 would both branch off `umbrella@SHA1`,
  // and once N merges the umbrella advances to SHA2, guaranteeing a stale
  // conflict on N+1. Force the effective cap to 1 in that case so cards
  // land serially onto the umbrella. The stored `epic.autonomous_max_concurrent`
  // is NOT overwritten — this is a runtime cap only, surfaced in the editor UI.
  const isIntegrationBranch = !!epic.pr_base_branch && epic.pr_base_branch.trim().length > 0;
  const effectiveMaxConcurrent = isIntegrationBranch ? 1 : settings.autonomous_max_concurrent;

  const agentCount = assignableAgents.length;
  if (agentCount === 0) {
    const msg = `No assignable agents for project "${project.name}" — check agent roles`;
    console.log(`[Autonomous] ${msg}`);
    const firstCard = eligible[0];
    if (firstCard?.id) {
      try {
        d.stmts.createKanbanCardComment.run(
          uuidv4(),
          firstCard.id,
          'system',
          `ℹ️ **Autonomous dispatch skipped**\n\n${msg}`,
        );
        d.broadcast({ type: 'kanban_update', projectId });
      } catch (_) {
        /* best-effort */
      }
    }
    return;
  }
  // Per-agent cap = epic-wide cap. Any single agent may absorb up to the
  // epic's effective max-concurrent cards in flight at once — there is no
  // implicit `ceil(max_concurrent / agentCount)` partition that previously
  // forced each agent to ~1 card when agentCount > max_concurrent. The
  // epic-wide ceiling (`slotsAvailable`, computed below from In Progress +
  // Review card counts) remains the only global gate on dispatch volume.
  // Integration-branch epics force `effectiveMaxConcurrent = 1` (see above)
  // so all caps collapse to serial dispatch.
  const perAgentLimit = effectiveMaxConcurrent;

  interface AgentSlot {
    agent: Agent;
    active: number;
    slots: number;
  }

  const agentsWithSlots: AgentSlot[] = assignableAgents
    .map((a) => {
      const active = agentSessionCounts.get(a.id) || 0;
      return { agent: a, active, slots: Math.max(0, perAgentLimit - active) };
    })
    .filter((a) => a.slots > 0);
  if (agentsWithSlots.length === 0) return;

  const cols = d.stmts.getKanbanColumns.all(boardData.board.id) as Array<{
    id: string;
    name: string;
  }>;
  const inProgressColId = findColumnByName(cols, 'In Progress')?.id;
  const reviewColId = findColumnByName(cols, 'Review')?.id;
  if (!inProgressColId) {
    console.error(
      `[Autonomous] Cannot dispatch for epic "${epic.name}": board ${boardData.board.id} has no In Progress column`,
    );
    return;
  }
  const epicCards = allScopeCards;
  const activeCardCount = epicCards.filter(
    (c) => c.column_id === inProgressColId || c.column_id === reviewColId,
  ).length;
  const slotsAvailable = Math.max(0, effectiveMaxConcurrent - activeCardCount);
  if (slotsAvailable === 0) {
    const capLabel = isIntegrationBranch
      ? `${effectiveMaxConcurrent} (integration branch — serial)`
      : `${effectiveMaxConcurrent}`;
    console.log(
      `[Autonomous] No slots for epic "${epic.name}" — ${activeCardCount}/${capLabel} active (in-progress + in-review)`,
    );
    return;
  }

  // Cards already offered to the manager hold a slot until the manager's
  // forward claims them (or the offer lapses), so the next tick does not
  // offer more work than the cap allows.
  const manager = d.epicManager;
  if (!manager) {
    console.error(`[Autonomous] No epic manager wired; ${scopeLabel} cannot hand out ready cards`);
    return;
  }
  // Reconcile live offers against the same readiness check a worker start
  // uses: an offered card that was held, deleted, moved out of the epic, or
  // otherwise became unstartable releases its slot now, not when it lapses.
  const todoColId = findColumnByName(cols, 'To Do')?.id;
  let outstanding = 0;
  for (const cardId of manager.liveOffers(epic.id)) {
    const offered = d.stmts.getKanbanCard.get(cardId) as KanbanCardRow | undefined;
    if (cardStartRefusal(offered, epic, todoColId)) {
      manager.withdrawOffer(cardId);
      continue;
    }
    if (phase && offered?.phase_id !== phase.id) continue;
    outstanding++;
  }
  const offerSlots = Math.max(0, slotsAvailable - outstanding);
  if (offerSlots === 0) return;

  // Routing pool for `pickAgentForCard`:
  //   - The project lead is treated as fallback-only; it never matches as a
  //     specialist. Even when the dispatcher's `assignableAgents` includes
  //     the lead, we strip it from the routing pool here so a card labelled
  //     "lead" doesn't accidentally land on the lead via id/role-match.
  //   - The lead's slot count comes from `agentSlotsCopy` if it's already
  //     in the assignable pool, otherwise from a synthetic per-agent cap so
  //     the lead can absorb overflow on specialist-scoped projects too.
  const agentSlotsCopy = agentsWithSlots.map((a) => ({ ...a }));
  const lead = pickLead(project);
  const slotsByAgentId = new Map<string, number>();
  for (const slot of agentSlotsCopy) {
    slotsByAgentId.set(slot.agent.id, slot.slots);
  }
  const routingPool = agentSlotsCopy.map((s) => s.agent).filter((a) => !lead || a.id !== lead.id);
  if (lead && !slotsByAgentId.has(lead.id)) {
    slotsByAgentId.set(lead.id, perAgentLimit);
  }

  // The manager's workers run as the person who kicked the epic (or phase)
  // off; scheduled kickoffs fall back to the card-level owner chain.
  const ownerUserId =
    resolveAutonomousOwnerUserId(null, dispatchEpic) ??
    eligible.map((card) => resolveAutonomousOwnerUserId(card, dispatchEpic)).find(Boolean) ??
    null;
  if (!ownerUserId) {
    console.log(
      `[Autonomous] Skipping ${scopeLabel} — no authenticated owner for credential resolution (run phase while logged in)`,
    );
    const firstCard = eligible[0];
    try {
      d.stmts.createKanbanCardComment.run(
        uuidv4(),
        firstCard.id,
        'system',
        `⚠️ **Autonomous dispatch skipped — no session owner**\n\nRun phase while logged in so your account credentials are used, or assign the spike manually from the card.`,
      );
      d.broadcast({ type: 'kanban_update', projectId });
    } catch (_) {
      /* best-effort */
    }
    return;
  }

  // Label-based routing: route to the first specialist whose id/role/name
  // matches a card label, falling back to the project lead. The pick is a
  // suggestion the manager may override when it writes the forward card.
  const ready: ReadyCardOffer[] = [];
  for (const card of eligible) {
    if (ready.length >= offerSlots) break;
    if (manager.isOffered(card.id)) continue;
    const refusal = cardStartRefusal(card, epic, todoColId);
    if (refusal) {
      // A card back in To Do after its last allowed worker needs a person;
      // say so (once) rather than skipping it silently.
      if (refusal.code === 'retry_cap') manager.noteRetryCapRefusal(epic.id, card.id);
      continue;
    }
    const picked = pickAgentForCard({
      card,
      assignableAgents: routingPool,
      lead: lead ?? null,
      ctx: { slotsByAgentId },
    });
    if (!picked) break;
    const poolIdx = agentSlotsCopy.findIndex((s) => s.agent.id === picked.id);
    if (poolIdx >= 0) agentSlotsCopy[poolIdx].slots--;
    slotsByAgentId.set(picked.id, (slotsByAgentId.get(picked.id) ?? 1) - 1);
    ready.push({ card, agentId: picked.id, phaseId: card.phase_id ?? null });
  }
  if (ready.length === 0) return;

  await manager.offerReady({ projectId, epic, phase: phase ?? null, ready, ownerUserId });
  console.log(
    `[Autonomous] Offered ${ready.length} ready card(s) for ${scopeLabel} to the epic manager`,
  );
}

/** The epic or phase whose run settings (cap, model, Auto Merge) govern a card. */
function dispatchScopeForCard(
  epic: KanbanEpicRow,
  card: Pick<KanbanCardRow, 'phase_id'>,
): { phase: KanbanPhaseRow | null; dispatchEpic: KanbanEpicRow; running: boolean } {
  const d = getDeps();
  const phase = card.phase_id
    ? ((d.stmts.getKanbanPhase?.get(card.phase_id) as KanbanPhaseRow | undefined) ?? null)
    : null;
  if (phase?.autonomous_running) {
    return {
      phase,
      dispatchEpic: {
        ...epic,
        autonomous_model: phase.autonomous_model,
        autonomous_send_it: phase.autonomous_send_it ?? 0,
        autonomous_max_concurrent: phase.autonomous_max_concurrent,
        autonomous_enabled_by: phase.autonomous_enabled_by ?? null,
      },
      running: true,
    };
  }
  return { phase: null, dispatchEpic: epic, running: !!epic.autonomous };
}

export interface SpawnEpicWorkerArgs {
  projectId: string;
  cardId: string;
  /** The manager's choice; falls back to routing when it cannot take tickets. */
  agentId?: string | null;
  /** The worker brief the manager wrote. Null uses the card's own text. */
  prompt?: string | null;
  ownerUserId: string;
  /** The manager session; the worker shows on its rail. */
  parentSessionId?: string | null;
}

export type SpawnEpicWorkerRefusal =
  | 'not_found'
  | 'paused'
  | 'ineligible'
  | 'cap'
  | 'no_agent'
  | 'retry_cap'
  | 'held'
  | 'agent_busy';

export type SpawnEpicWorkerResult =
  | {
      status: 'started';
      sessionId: string;
      agentId: string;
      name: string;
      /** Finalize automation level the worker runs at. */
      mode: string;
      /** Settles once the worker's first turn is handed to the CLI. */
      turn: Promise<void>;
    }
  | { status: 'refused'; code: SpawnEpicWorkerRefusal; error: string };

function pickWorkerAgent(
  project: Project,
  card: KanbanCardRow,
  requested: string | null | undefined,
  activeByAgent: Map<string, number>,
  perAgentLimit: number,
): Agent | null {
  const assignable = project.agents.filter(
    (a) => a.role !== 'docs' && a.role !== 'reviewer' && agentAcceptsAutonomousTickets(a),
  );
  const lead = pickLead(project);
  const slotsByAgentId = new Map(
    [...assignable, ...(lead ? [lead] : [])].map((a) => [
      a.id,
      Math.max(0, perAgentLimit - (activeByAgent.get(a.id) ?? 0)),
    ]),
  );
  const chosen = requested ? assignable.find((a) => a.id === requested) : undefined;
  if (chosen && (slotsByAgentId.get(chosen.id) ?? 0) > 0) return chosen;
  return (
    pickAgentForCard({
      card,
      assignableAgents: assignable.filter((a) => !lead || a.id !== lead.id),
      lead: lead ?? null,
      ctx: { slotsByAgentId },
    }) ?? null
  );
}

/**
 * Start a worker session for one epic card: claim the card (To Do → In
 * Progress under the scope's concurrency cap), create the session linked to
 * the card, and hand it its first turn. The epic manager's forward cards are
 * the only caller in production, so every worker goes through the manager.
 *
 * Synchronous up to the session row so the dispatch route can answer with the
 * session id; the first turn (replay, attachments, env prep) runs after.
 */
export function spawnEpicWorkerForCard(args: SpawnEpicWorkerArgs): SpawnEpicWorkerResult {
  const d = getDeps();
  const refuse = (code: SpawnEpicWorkerRefusal, error: string): SpawnEpicWorkerResult => ({
    status: 'refused',
    code,
    error,
  });
  const { projectId, ownerUserId } = args;
  const project = d.findProject(projectId);
  if (!project) return refuse('not_found', 'Project not found');
  const boardData = getOrCreateBoard(d.stmts, projectId);
  if (!boardData?.board) return refuse('not_found', 'Board not found');
  const card = d.stmts.getKanbanCard.get(args.cardId) as KanbanCardRow | undefined;
  if (!card || !card.epic_id) return refuse('not_found', 'Card not found on an epic');
  const epic = d.stmts.getKanbanEpic.get(card.epic_id) as KanbanEpicRow | undefined;
  if (!epic || epic.board_id !== boardData.board.id) return refuse('not_found', 'Epic not found');
  const { phase, dispatchEpic, running } = dispatchScopeForCard(epic, card);
  if (!running) return refuse('paused', `Epic "${epic.name}" is not running`);

  const isIntegrationBranch = !!epic.pr_base_branch && epic.pr_base_branch.trim().length > 0;
  const effectiveMaxConcurrent = isIntegrationBranch ? 1 : dispatchEpic.autonomous_max_concurrent;
  // Same per-agent capacity the tick routes with. The manager may pick
  // another agent, so a full one is rerouted, or the start refused.
  const agentCounts = scopeAgentActiveCounts(epic, phase);
  const agent = pickWorkerAgent(project, card, args.agentId, agentCounts, effectiveMaxConcurrent);
  if (!agent) {
    return refuse('agent_busy', `No agent has room for "${card.title}" right now`);
  }

  const cols = d.stmts.getKanbanColumns.all(boardData.board.id) as Array<{
    id: string;
    name: string;
  }>;
  const inProgressColId = findColumnByName(cols, 'In Progress')?.id;
  const reviewColId = findColumnByName(cols, 'Review')?.id;
  const todoColId = findColumnByName(cols, 'To Do')?.id;
  if (!inProgressColId) return refuse('not_found', 'Board has no In Progress column');

  // Transactional slot claim. `BEGIN IMMEDIATE` serializes this against every
  // other writer, so the re-read below sees the latest board: either the card
  // is still claimable under the cap, or we refuse.
  //
  // Column + assignee are the only re-verification signals. Do NOT gate on
  // `dispatched_by_autonomous` (sticky: set on first dispatch and kept when a
  // card is returned to To Do) or on `session_id` (a stale link can survive a
  // requeue); either would reject a requeued card forever.
  const db = d.getDb();
  // Readiness is the server's call, whatever the manager forwards. The shared
  // check runs on the freshly read row inside the transaction, so a hold, a
  // move, or a new blocker that landed after the offer refuses the start.
  let refusal: { code: SpawnEpicWorkerRefusal; error: string } | null = null;
  const claimSlot = db.transaction((cardId: string): 'claimed' | 'cap' | 'refused' => {
    const fresh = d.stmts.getKanbanCard.get(cardId) as KanbanCardRow | undefined;
    refusal = cardStartRefusal(fresh, epic, todoColId);
    if (refusal) return 'refused';
    const scopeCardsNow = (
      phase
        ? d.stmts.getKanbanCardsByPhase.all(phase.id)
        : d.stmts.getKanbanCardsByEpic.all(epic.id)
    ) as KanbanCardRow[];
    const activeNow = scopeCardsNow.filter(
      (c) => c.column_id === inProgressColId || c.column_id === reviewColId,
    ).length;
    if (activeNow >= effectiveMaxConcurrent) return 'cap';
    d.stmts.markCardDispatchedByAutonomous.run(cardId);
    d.stmts.moveKanbanCard.run(inProgressColId, 0, cardId);
    return 'claimed';
  });
  const claimResult = claimSlot.immediate(card.id);
  if (claimResult === 'cap') {
    console.log(
      `[Autonomous] Slot claim refused for "${card.title}" — ${effectiveMaxConcurrent} active${isIntegrationBranch ? ' (integration branch serial cap)' : ''}`,
    );
    return refuse(
      'cap',
      `Epic "${epic.name}" is at its concurrency cap (${effectiveMaxConcurrent})`,
    );
  }
  if (claimResult === 'refused' && refusal) {
    const { code, error } = refusal as { code: SpawnEpicWorkerRefusal; error: string };
    if (code === 'retry_cap') d.epicManager?.noteRetryCapRefusal(epic.id, card.id);
    return refuse(code, error);
  }
  console.log(`[Autonomous] Assigning "${card.title}" to ${agent.name}`);

  const rollbackCard = (err: unknown): void => {
    try {
      d.stmts.updateKanbanCard.run(
        card.title,
        card.description,
        card.priority,
        card.assignee,
        card.labels,
        card.session_id,
        card.github_issue_url,
        card.pr_url,
        card.epic_id,
        card.phase_id ?? null,
        card.assign_model,
        card.assign_engine ?? null,
        card.pr_base_branch ?? null,
        card.id,
      );
      d.stmts.moveKanbanCard.run(card.column_id, card.position, card.id);
    } catch (rollbackErr: unknown) {
      const msg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      console.error(`[Autonomous] Rollback failed for card "${card.title}":`, msg);
    }
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `[Autonomous] Dispatch failed for card "${card.title}" (${card.id}) on agent ${agent.name}: ${reason}`,
    );
    d.epicManager?.noteWorkerEvent(epic.id, {
      kind: 'error',
      cardId: card.id,
      detail: `the worker could not start: ${reason}`,
    });
  };

  let sessionId: string;
  let finalizeLevel: FinalizeAutomationLevel;
  let spikeAssign: boolean;
  let linkedSpecItem: ReturnType<typeof getSpecItemForSpikeCard>;
  try {
    sessionId = crypto.randomUUID();
    const cfg = d.getConfig();
    const { engine, model } = engineAndModelForCard(card, agent, dispatchEpic, cfg, ownerUserId);
    const projRow = d.findProject(projectId);
    spikeAssign = isSpikeCard(card);
    // Spikes get a worktree so they can try code; ship routes refuse them.
    const wt = defaultSessionUseWorktreeFlag(projRow);
    linkedSpecItem = spikeAssign ? getSpecItemForSpikeCard(d.stmts, card.id) : null;
    if (spikeAssign && card.epic_id) {
      linkedSpecItem = ensureSpecItemForSpikeCard(d.stmts, card) ?? linkedSpecItem;
    }
    d.stmts.createSession.run(sessionId, agent.id, card.title, engine, model, wt, 0, 1);
    if (spikeAssign) {
      d.stmts.updateSessionMode.run('scoping', sessionId);
      d.stmts.updateSessionSpikeCard.run(card.id, sessionId);
      d.stmts.updateSessionLinkedEpic.run(epic.id, sessionId);
      if (linkedSpecItem) {
        d.stmts.updateSessionLinkedSpecItem.run(linkedSpecItem.id, sessionId);
      }
      finalizeLevel = 'manual';
      markSessionFinalizeAutomation(d.stmts, sessionId, finalizeLevel);
    } else {
      d.stmts.updateSessionLinkedEpic.run(epic.id, sessionId);
      markSessionAutoShipOnComplete(d.stmts, sessionId);
      // Autonomous cards run at least "Build and Push"; they escalate to
      // "Auto Merge" only when the project's auto-merge is enabled. The
      // epic's (or phase's) "Auto Merge" override forces `merge`.
      finalizeLevel = dispatchEpic.autonomous_send_it
        ? 'merge'
        : assignedFinalizeAutomationLevel(
            resolveShouldAutoMerge(undefined, projRow?.githubWorkflow),
          );
      markSessionFinalizeAutomation(d.stmts, sessionId, finalizeLevel);
    }
    // Attributed to the person who kicked the epic off so per-user GitHub
    // tokens, CLI credentials, and skill secrets resolve, and the session is
    // theirs under strict-mode auth.
    setSessionOwner(sessionId, ownerUserId);
    if (args.parentSessionId) {
      d.stmts.markSessionSpawnedFrom?.run(args.parentSessionId, sessionId);
    }
    const row = d.stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (row) {
      d.broadcast({
        type: 'session_created',
        agentId: agent.id,
        session: enrichSessionForClient(row, d.stmts),
      });
    }
    // The claim already moved the card; stamp the session and the assignee.
    d.stmts.updateKanbanCard.run(
      card.title,
      card.description,
      card.priority,
      agent.name,
      card.labels,
      sessionId,
      card.github_issue_url,
      card.pr_url,
      card.epic_id,
      card.phase_id ?? null,
      card.assign_model,
      card.assign_engine ?? null,
      card.pr_base_branch ?? null,
      card.id,
    );
  } catch (err: unknown) {
    rollbackCard(err);
    return refuse('ineligible', err instanceof Error ? err.message : String(err));
  }
  d.epicManager?.noteWorkerStarted(card.id, epic.id);

  d.broadcast({
    type: 'autonomous_assigned',
    projectId,
    epicId: epic.id,
    cardId: card.id,
    cardTitle: card.title,
    agentId: agent.id,
    agentName: agent.name,
  });
  d.broadcast({ type: 'kanban_update', projectId });

  const turn = startEpicWorkerTurn({
    projectId,
    card,
    agent,
    sessionId,
    spikeAssign,
    linkedSpecItem,
    managerPrompt: args.prompt?.trim() || null,
    rollbackCard,
  });
  return {
    status: 'started',
    sessionId,
    agentId: agent.id,
    name: card.title,
    mode: finalizeLevel,
    turn,
  };
}

/**
 * Engine + model for a worker. Card-level `assign_engine` hard-pins the
 * engine; `assign_model` then wins over the epic/phase `autonomous_model`.
 * Either may cross engines (an operator picks `composer-2.5` for an agent
 * whose default engine is `claude-code`), in which case the spawn runs under
 * the engine that owns the model. Falls back to the epic-level resolver.
 */
function engineAndModelForCard(
  card: KanbanCardRow,
  agent: Agent,
  dispatchEpic: KanbanEpicRow,
  cfg: AppConfig,
  ownerUserId: string,
): { engine: string; model: string } {
  const engineValidModels = cfg.engineValidModels || {};
  const agentEngine = resolveAgentSpawnEngineAndModel(cfg, agent, ownerUserId).engine;
  const cardRawModel = typeof card.assign_model === 'string' ? card.assign_model.trim() : '';
  const cardRawEngine = typeof card.assign_engine === 'string' ? card.assign_engine.trim() : '';
  const cardEngineValid =
    cardRawEngine && Object.prototype.hasOwnProperty.call(engineValidModels, cardRawEngine)
      ? cardRawEngine
      : '';
  if (cardEngineValid) {
    const allowedForEngine = engineValidModels[cardEngineValid] || [];
    if (cardRawModel && allowedForEngine.includes(cardRawModel)) {
      return { engine: cardEngineValid, model: cardRawModel };
    }
    return {
      engine: cardEngineValid,
      model: cfg.engineDefaultModels?.[cardEngineValid] || allowedForEngine[0] || '',
    };
  }
  if (cardRawModel) {
    const agentAllowed = engineValidModels[agentEngine] || [];
    if (agentAllowed.includes(cardRawModel)) return { engine: agentEngine, model: cardRawModel };
    const otherEngine = engineForModel(cardRawModel, engineValidModels);
    if (otherEngine) return { engine: otherEngine, model: cardRawModel };
  }
  return sessionEngineAndModelForAutonomousDispatch(
    dispatchEpic,
    agent,
    engineValidModels,
    cfg,
    ownerUserId,
  );
}

/** The worker's first turn: the manager's brief plus the context the server owns. */
async function startEpicWorkerTurn(args: {
  projectId: string;
  card: KanbanCardRow;
  agent: Agent;
  sessionId: string;
  spikeAssign: boolean;
  linkedSpecItem: ReturnType<typeof getSpecItemForSpikeCard>;
  managerPrompt: string | null;
  rollbackCard: (err: unknown) => void;
}): Promise<void> {
  const d = getDeps();
  const { projectId, card, agent, sessionId, spikeAssign, linkedSpecItem, managerPrompt } = args;
  try {
    const contextLines: string[] = [];
    if (spikeAssign) {
      if (managerPrompt) contextLines.push(`## From the epic manager\n${managerPrompt}\n`);
      contextLines.push(
        linkedSpecItem
          ? buildSpikeSessionContext({ card, specItem: linkedSpecItem, projectId })
          : buildSpikeSessionContextFallback({ card, projectId }),
      );
    } else {
      // The card is the requirement of record and always goes in whole, from
      // the board. The manager's brief adds context on top; it never stands in
      // for the card, so nothing it shortened or left out is lost.
      contextLines.push(`# Task: ${card.title}`);
      if (card.description) contextLines.push(`\n## Description\n${card.description}`);
      if (card.priority) contextLines.push(`\n**Priority:** ${card.priority}`);
      if (card.labels) contextLines.push(`**Labels:** ${card.labels}`);
      if (managerPrompt) contextLines.push(`\n## Brief from the epic manager\n${managerPrompt}`);
      if (card.epic_id) {
        const specBlock = formatEpicSpecDecisionsForContext(
          loadChosenSpecItemsForEpic(d.stmts, card.epic_id),
        );
        if (specBlock) contextLines.push(`\n${specBlock}`);
      }
      // Same replay seeding as the manual assign path (server/routes/board.ts):
      // a bug card must see what the customer did, not just the ticket text.
      const replayContext = await loadCardReplayContext(
        { stmts: d.stmts, config: d.getConfig() },
        card.id,
      );
      if (replayContext) contextLines.push(`\n${replayContext}`);
      contextLines.push(
        `\n---\nYou have been assigned this task by the epic's manager thread. Review the brief above and begin working on it.`,
        ``,
        `**This session is linked to kanban card \`${card.id}\`.** Do **NOT** create a new card for this work. Comment and update this card via the board API as you progress, but do **not** move it to Done yourself — Done means merged, and the platform closes the card automatically when your change lands.`,
      );
    }

    const commentContext = loadCardSupportTicketCommentContext(d.stmts, card, projectId);
    if (commentContext) contextLines.push(`\n${commentContext}`);
    const images = await loadCardUploadAttachments(
      { stmts: d.stmts, config: d.getConfig() },
      card,
      projectId,
    );

    // Scoped cross-hub secret injection: only cards with an opt-in label
    // receive `DEV_HUB_API_KEY`. Best-effort (see server/secrets.ts).
    const extraEnv: Record<string, string> = {};
    if (cardNeedsDevHubKey(card.labels)) {
      const devHubKey = await getDevHubApiKey();
      if (devHubKey) extraEnv.DEV_HUB_API_KEY = devHubKey;
    }

    if (d.prepareSessionEnv) await d.prepareSessionEnv(sessionId);

    d.handleChat(null, {
      type: 'chat',
      agentId: agent.id,
      sessionId,
      content: contextLines.join('\n'),
      ...(images.length > 0 ? { images } : {}),
      hookSpecificOutput: { sessionTitle: card.title },
      // Autonomous-dispatch origin: the spawn credential policy in `chat.ts`
      // (`resolveGithubSpawnToken`) strips the owner's per-user OAuth token so
      // the worker cannot post a formal PR review as the human.
      _fromAutonomousDispatch: true,
      ...(Object.keys(extraEnv).length > 0 ? { extraEnv } : {}),
    }).catch(args.rollbackCard);
  } catch (err: unknown) {
    args.rollbackCard(err);
  }
}

/**
 * An explicit kickoff (Run phase, or turning the epic on) by a person other
 * than the manager's owner hands the manager to them. No-op without a manager.
 */
export function handOverEpicManager(epicId: string, userId: string | null | undefined): void {
  const d = getDeps();
  if (!d.epicManager || !userId) return;
  try {
    d.epicManager.handOver(epicId, userId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Autonomous] Could not hand over the manager for epic ${epicId}:`, msg);
  }
}

/** Epics last seen with no live manager, so the tick logs that once per change. */
const epicsWithoutManager = new Set<string>();

/** Whether the epic has a live manager; logs once when it goes missing. */
function epicHasManager(
  manager: EpicManagerPort,
  epic: KanbanEpicRow,
  scopeLabel: string,
): boolean {
  if (manager.hasLiveManager(epic.id)) {
    epicsWithoutManager.delete(epic.id);
    return true;
  }
  if (!epicsWithoutManager.has(epic.id)) {
    epicsWithoutManager.add(epic.id);
    console.log(
      `[Autonomous] No epic session for ${scopeLabel}; no cards offered until a person starts one`,
    );
  }
  return false;
}

/** Test hook: forget which epics were logged as having no manager. */
export function resetEpicManagerPresenceForTest(): void {
  epicsWithoutManager.clear();
}

/** Pause the manager once neither the epic nor any of its phases is running. */
function pauseEpicManagerIfIdle(epicId: string): void {
  const d = getDeps();
  if (!d.epicManager) return;
  const epic = d.stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined;
  if (!epic) return;
  if (epic.autonomous) return;
  const phases = (d.stmts.getKanbanPhasesByEpic?.all(epicId) as KanbanPhaseRow[] | undefined) ?? [];
  if (phases.some((p) => p.autonomous_running)) return;
  d.epicManager.pause(epicId);
}

export function tryAutonomousDispatch(): void {
  for (const projectId of autonomousProjects) {
    runAutonomousLoop(projectId).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Autonomous] Dispatch error for "${projectId}":`, msg);
    });
  }
}

export function scheduleAutonomousEpic(projectId: string, epic: KanbanEpicRow): void {
  const key = epic.id;

  const existing = autonomousCrons.get(key);
  if (existing) {
    existing.stop();
    autonomousCrons.delete(key);
  }

  if (!epic.autonomous) {
    // Drop this epic from the project's live set. Only remove the PROJECT from
    // `autonomousProjects` once its LAST autonomous epic is gone — other epics
    // on the same board may still be dispatching.
    const liveEpics = autonomousEpicsByProject.get(projectId);
    if (liveEpics) {
      liveEpics.delete(key);
      if (liveEpics.size === 0) {
        autonomousEpicsByProject.delete(projectId);
        autonomousProjects.delete(projectId);
      }
    } else {
      autonomousProjects.delete(projectId);
    }
    pauseEpicManagerIfIdle(epic.id);
    console.log(`[Autonomous] Stopped for epic "${epic.name}"`);
    return;
  }

  let liveEpics = autonomousEpicsByProject.get(projectId);
  if (!liveEpics) {
    liveEpics = new Set<string>();
    autonomousEpicsByProject.set(projectId, liveEpics);
  }
  liveEpics.add(key);
  autonomousProjects.add(projectId);

  // This epic's safety-net cron dispatches ONLY this epic, not the whole board.
  // With multiple autonomous epics, a per-board sweep here would mean every
  // epic's cron re-dispatches every sibling each minute (N× duplicate sweeps,
  // and the fastest cron driving the slowest epic). Whole-board sweeps stay on
  // the event-driven / manual paths via `runAutonomousLoop`.
  const epicId = epic.id;
  const task = cron.schedule(
    '* * * * *',
    wrapCronTick(
      () =>
        runAutonomousLoopForEpic(projectId, epicId).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[Autonomous] Safety-net error for "${epic.name}":`, msg);
        }),
      `autonomous:${projectId}:${epicId}`,
    ),
    defaultTickOptions({
      intervalSeconds: estimateIntervalSeconds('* * * * *'),
      name: `autonomous:${projectId}:${epicId}`,
    }),
  );
  autonomousCrons.set(key, task);
  console.log(
    `[Autonomous] Activated epic "${epic.name}" for project "${projectId}" (event-driven + 60s safety net)`,
  );

  runAutonomousLoopForEpic(projectId, epicId).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Autonomous] Initial dispatch error:`, msg);
  });
}

export function scheduleAutonomousPhase(projectId: string, phase: KanbanPhaseRow): void {
  const key = phaseInflightKey(phase.id);

  const existing = autonomousCrons.get(key);
  if (existing) {
    existing.stop();
    autonomousCrons.delete(key);
  }

  if (!phase.autonomous_running) {
    pauseEpicManagerIfIdle(phase.epic_id);
    console.log(`[Autonomous] Stopped phase "${phase.name}"`);
    return;
  }

  autonomousProjects.add(projectId);
  const phaseId = phase.id;
  const task = cron.schedule(
    '* * * * *',
    wrapCronTick(
      () =>
        runAutonomousLoopForPhase(projectId, phaseId).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[Autonomous] Safety-net error for phase "${phase.name}":`, msg);
        }),
      `autonomous-phase:${projectId}:${phaseId}`,
    ),
    defaultTickOptions({
      intervalSeconds: estimateIntervalSeconds('* * * * *'),
      name: `autonomous-phase:${projectId}:${phaseId}`,
    }),
  );
  autonomousCrons.set(key, task);
  console.log(
    `[Autonomous] Activated phase "${phase.name}" for project "${projectId}" (event-driven + 60s safety net)`,
  );

  runAutonomousLoopForPhase(projectId, phaseId).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Autonomous] Initial phase dispatch error:`, msg);
  });
}

export async function runAutonomousLoopForPhase(projectId: string, phaseId: string): Promise<void> {
  const d = getDeps();
  const project = d.findProject(projectId);
  if (!project) return;

  const boardData = getOrCreateBoard(d.stmts, projectId);
  if (!boardData?.board) return;

  const phase = d.stmts.getKanbanPhase.get(phaseId) as KanbanPhaseRow | undefined;
  if (!phase || !phase.autonomous_running || phase.board_id !== boardData.board.id) return;

  await dispatchPhaseGated(projectId, phase);
}

/** Start autonomous dispatch for a phase — only runs after explicit operator action. */
export async function startAutonomousPhase(
  projectId: string,
  phaseId: string,
  operatorUserId?: string | null,
): Promise<void> {
  const d = getDeps();
  const project = d.findProject(projectId);
  if (!project) throw new Error('Project not found');

  const boardData = getOrCreateBoard(d.stmts, projectId);
  if (!boardData?.board) throw new Error('Board not found');

  const phase = d.stmts.getKanbanPhase.get(phaseId) as KanbanPhaseRow | undefined;
  if (!phase || phase.board_id !== boardData.board.id) {
    throw new Error('Phase not found');
  }
  if (!phase.autonomous) {
    throw new Error('Enable auto-dispatch on this phase before running it');
  }

  const epic = d.stmts.getKanbanEpic.get(phase.epic_id) as KanbanEpicRow | undefined;
  if (!epic) throw new Error('Epic not found');

  // Require a resolvable owner on EVERY run. Phase dispatch later resolves
  // spawn credentials from `autonomous_enabled_by`, so a stop/re-run from an
  // unauthenticated / API-key path (where `resolveOwnerUserId` returns null)
  // must NOT restart work under whatever stale owner happens to still be
  // stored. Refuse to start, and only ever advance the stored owner to the
  // current operator (never leave a prior one in place for a new run).
  if (!operatorUserId) {
    throw new Error(
      'Authentication required to run a phase — no resolvable owner for credential resolution (run while logged in)',
    );
  }
  const predecessor = findIncompletePredecessor(epic, phaseId);
  if (predecessor) {
    throw new Error(
      `Phase "${predecessor.name}" must complete before "${phase.name}" can run. ` +
        'Finish its cards or correct the phase order and dependencies.',
    );
  }
  d.stmts.setPhaseAutonomousEnabledBy.run(operatorUserId, phaseId);
  handOverEpicManager(epic.id, operatorUserId);

  d.stmts.setPhaseAutonomousRunning.run(1, phaseId);
  const updated = d.stmts.getKanbanPhase.get(phaseId) as KanbanPhaseRow;
  scheduleAutonomousPhase(projectId, updated);
}

/** Stop autonomous dispatch for a phase — in-flight sessions keep running. */
export function stopAutonomousPhase(projectId: string, phaseId: string): KanbanPhaseRow {
  const d = getDeps();
  const project = d.findProject(projectId);
  if (!project) throw new Error('Project not found');

  const boardData = getOrCreateBoard(d.stmts, projectId);
  if (!boardData?.board) throw new Error('Board not found');

  const phase = d.stmts.getKanbanPhase.get(phaseId) as KanbanPhaseRow | undefined;
  if (!phase || phase.board_id !== boardData.board.id) {
    throw new Error('Phase not found');
  }

  d.stmts.setPhaseAutonomousRunning.run(0, phaseId);
  const updated = d.stmts.getKanbanPhase.get(phaseId) as KanbanPhaseRow;
  scheduleAutonomousPhase(projectId, updated);
  d.broadcast({ type: 'kanban_update', projectId });
  return updated;
}

// Startup Restoration

export function restoreAutonomousCrons(): void {
  const d = getDeps();
  const projects = d.getProjects();
  for (const project of projects) {
    try {
      const boardData = getOrCreateBoard(d.stmts, project.id);
      if (!boardData?.board) continue;
      // Restore a cron for EVERY autonomous epic on the board, not just the first.
      const epics = listAutonomousEpics(d.stmts, boardData.board.id);
      for (const epic of epics) {
        scheduleAutonomousEpic(project.id, epic);
      }
      const phases =
        (d.stmts.getAutonomousPhases?.all(boardData.board.id) as KanbanPhaseRow[]) ?? [];
      for (const phase of phases) {
        scheduleAutonomousPhase(project.id, phase);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Autonomous] Failed to restore cron for project "${project.id}":`, msg);
    }
  }
}
