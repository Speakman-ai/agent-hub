import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { wrapCronTick, defaultTickOptions, estimateIntervalSeconds } from './cron-tick.js';
import { getOrCreateBoard } from './routes/board.js';
import { lastDispatchedReviewId } from './review-feedback-dedup.js';
import { resolveEffectiveModel } from './effective-model.js';
import { loadBoardBlockers, hasUnresolvedBlockers, isColumnDone } from './kanban-blockers.js';
import { pickAgentForCard, pickLead } from './routing.js';
import type {
  Stmts,
  Project,
  Agent,
  KanbanEpicRow,
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
import { assignedFinalizeAutomationLevel } from './finalize/automation.js';
import { resolveShouldAutoMerge } from './auto-merge.js';

const execFileAsync = promisify(execFile);

// ─── Umbrella feature-branch management (opt-in) ───────────────────────────
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

// ─── Operator-set base branch — auto-create if missing ────────────────────
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
  config?: Pick<AppConfig, 'personalOAuth' | 'githubApp'>;
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

// ─── Dependency Types ───────────────────────────────────────────────────────

interface AutonomousDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  findProject: (projectId: string) => Project | undefined;
  findAgent: (agentId: string) => { project: Project; agent: Agent } | null;
  handleChat: (ws: unknown, msg: ChatMessage) => Promise<void>;
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
  /** Drain per-session message queues when no CLI/delegation is in flight. */
  drainIdleSessionQueues?: () => number;
}

// ─── Module-level state ────────────────────────────────────────────────────
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

// ─── Injected dependencies (set via init()) ────────────────────────────────
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
 *   3. Otherwise → agent default engine + resolved model (`resolveEffectiveModel`
 *      using the autonomous session owner as `ownerUserId`).
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
  const agentEngine = agent.engine || 'claude-code';
  const raw = typeof epic.autonomous_model === 'string' ? epic.autonomous_model.trim() : '';
  if (raw) {
    const agentAllowed = engineValidModels[agentEngine] || [];
    if (agentAllowed.includes(raw)) return { engine: agentEngine, model: raw };
    const otherEngine = engineForModel(raw, engineValidModels);
    if (otherEngine) return { engine: otherEngine, model: raw };
  }
  return {
    engine: agentEngine,
    model: resolveEffectiveModel(cfg, agentEngine, {
      agentModel: agent.model,
      ownerUserId,
    }),
  };
}

export function initAutonomous(d: AutonomousDeps): void {
  deps = d;
}

// ─── Getters for shared state (used by index.ts) ───────────────────────────

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

// ─── Core Dispatch ─────────────────────────────────────────────────────────

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
  if (epics.length === 0) return Promise.resolve();

  await Promise.all(epics.map((epic) => dispatchEpicGated(projectId, epic)));
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

async function runAutonomousLoopInner(projectId: string, epic: KanbanEpicRow): Promise<void> {
  const d = getDeps();
  const project = d.findProject(projectId);
  if (!project) return;

  const boardData = getOrCreateBoard(d.stmts, projectId);
  if (!boardData?.board) return;

  const colsForDoneCheck = d.stmts.getKanbanColumns.all(boardData.board.id) as KanbanColumnRow[];
  const colNameByIdForEpic = Object.fromEntries(colsForDoneCheck.map((c) => [c.id, c.name]));
  const allEpicCardsForDone = d.stmts.getKanbanCardsByEpic.all(epic.id) as KanbanCardRow[];
  const epicWorkComplete =
    allEpicCardsForDone.length > 0 &&
    allEpicCardsForDone.every((c) => isColumnDone(colNameByIdForEpic[c.column_id]));

  if (epicWorkComplete && epic.autonomous) {
    // Operator-set integration branch — flag it so the operator knows to open
    // the final PR from it. With auto-umbrella creation removed, this path
    // only fires when someone explicitly typed a branch name into the epic.
    if (epic.pr_base_branch && !epic.pr_base_branch.startsWith(AUTONOMOUS_BRANCH_PREFIX)) {
      console.log(
        `[Autonomous] 🎉 Epic "${epic.name}" complete — integration branch "${epic.pr_base_branch}" is ready. Open a PR from it to merge all changes into main.`,
      );
    }

    d.stmts.updateKanbanEpic.run(
      epic.name,
      epic.description,
      epic.color,
      0,
      epic.autonomous_interval,
      epic.autonomous_max_concurrent,
      epic.autonomous_model ?? null,
      epic.orchestration_budgets_json ?? null,
      // Preserve whatever the operator set (or null). We never auto-clear or
      // overwrite the operator's value here.
      epic.pr_base_branch ?? null,
      epic.id,
    );
    const clearedEpic = d.stmts.getKanbanEpic.get(epic.id) as KanbanEpicRow;
    scheduleAutonomousEpic(projectId, clearedEpic);
    d.broadcast({ type: 'kanban_update', projectId });
    console.log(`[Autonomous] Epic "${epic.name}" — all cards are Done; autonomous mode disabled`);
    return;
  }

  const rawEligible = d.stmts.getEligibleAutonomousCards.all(epic.id) as KanbanCardRow[];

  // Filter out cards whose blockers aren't all Done. Re-loaded on every
  // tick so newly-cleared blockers (the blocking card landed in Done since
  // the last run) become eligible without restarting the cron. We log each
  // skip and post a one-shot card comment naming the blockers so operators
  // can see WHY autonomous mode isn't picking up a card that otherwise
  // matches the SQL eligibility criteria — `console.log` alone is invisible
  // to a user watching the UI.
  const blockerIndex = loadBoardBlockers(d.stmts, boardData.board.id);
  const eligible: KanbanCardRow[] = [];
  let anyBlockerCommentPosted = false;
  for (const card of rawEligible) {
    if (hasUnresolvedBlockers(card.id, blockerIndex)) {
      const unresolvedLinks = (blockerIndex.blockersByCard.get(card.id) ?? []).filter(
        (b) => !b.done,
      );
      const titles = unresolvedLinks.map((b) => b.title);
      console.log(
        `[Autonomous] Skipping "${card.title}" — blocked by ${unresolvedLinks.length} unresolved card(s): ${titles.join(', ')}`,
      );

      // Stable signature of the blocking set. Sorted so iteration order
      // doesn't false-positive a "changed" check. Includes column_id so
      // moving a blocker from one non-Done column to another (e.g. To Do
      // → In Progress) is treated as a meaningful change worth noting.
      const signature = unresolvedLinks
        .map((b) => `${b.id}:${b.column_id ?? ''}`)
        .sort()
        .join('|');
      const prev = lastBlockerSkipSignature.get(card.id);
      if (prev !== signature) {
        try {
          const bulletList = unresolvedLinks
            .map((b) => `- **${b.title}** (\`${b.id}\`)`)
            .join('\n');
          d.stmts.createKanbanCardComment.run(
            uuidv4(),
            card.id,
            'system',
            `⏸️ **Autonomous dispatch skipped — unresolved blockers**\n\nWaiting on:\n${bulletList}\n\nThis card will be picked up automatically once every blocker lands in a Done column. No restart needed.`,
          );
          lastBlockerSkipSignature.set(card.id, signature);
          anyBlockerCommentPosted = true;
        } catch (_) {
          /* best-effort: a failed comment write must not strand the dispatch loop */
        }
      }
      continue;
    }
    // Card is no longer blocked. Clear the debounce key so a future block
    // (e.g. someone manually adds a new blocker edge) re-emits the comment.
    if (lastBlockerSkipSignature.has(card.id)) {
      lastBlockerSkipSignature.delete(card.id);
    }
    eligible.push(card);
  }
  if (anyBlockerCommentPosted) {
    d.broadcast({ type: 'kanban_update', projectId });
  }

  if (eligible.length === 0) {
    console.log(
      `[Autonomous] No eligible cards for epic "${epic.name}" (all assigned, done, or blocked)`,
    );
    return;
  }

  // ── Umbrella / integration branch (opt-in via operator-set value) ──────
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
  // ───────────────────────────────────────────────────────────────────────
  if (epic.pr_base_branch && epic.pr_base_branch.trim()) {
    await ensureOperatorBaseBranch(project, epic.pr_base_branch, { config: d.getConfig() });
  }

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
  // ── DO NOT "fix" this by filtering on `session.ask_mode` ────────────────
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
    agentSessionCounts.set(session.agent_id, (agentSessionCounts.get(session.agent_id) || 0) + 1);
  }

  // Reviewer/docs/intake are out-of-band roles — never autonomously assigned.
  // Leads are always assignable: they can implement directly or `<handoff>`
  // to a specialist, and they're the right safety net when a project's
  // `subAgents` list is stale or empty.
  const roleFiltered = project.agents.filter(
    (a) => a.role !== 'docs' && a.role !== 'intake' && a.role !== 'reviewer',
  );
  const leadAgent = project.agents.find((a) => a.role === 'lead');
  const allLeads = project.agents.filter((a) => a.role === 'lead');
  let assignableAgents: Agent[];
  if (leadAgent && leadAgent.subAgents?.length) {
    const resolvedSubAgents = leadAgent.subAgents
      .map((sa) => {
        const saId = typeof sa === 'string' ? sa : (sa as { id: string }).id;
        return project.agents.find((a) => a.id === saId) || d.findAgent(saId)?.agent;
      })
      .filter((a): a is Agent => !!a);
    // Union of resolved subAgents and all leads, deduped by id.
    const byId = new Map<string, Agent>();
    for (const a of [...resolvedSubAgents, ...allLeads]) byId.set(a.id, a);
    assignableAgents = Array.from(byId.values());
    // Stale/unresolved subAgent IDs and no leads in the project → fall back
    // to the role-filter so a misconfigured roster doesn't strand the loop.
    if (assignableAgents.length === 0) {
      assignableAgents = roleFiltered;
    }
  } else {
    assignableAgents = roleFiltered;
  }

  // ── Integration-branch serialization override ──────────────────────────
  // When an epic targets an operator-set integration branch
  // (`epic.pr_base_branch`), parallel dispatch defeats the whole point of
  // the integration: cards N and N+1 would both branch off `umbrella@SHA1`,
  // and once N merges the umbrella advances to SHA2, guaranteeing a stale
  // conflict on N+1. Force the effective cap to 1 in that case so cards
  // land serially onto the umbrella. The stored `epic.autonomous_max_concurrent`
  // is NOT overwritten — this is a runtime cap only, surfaced in the editor UI.
  const isIntegrationBranch = !!epic.pr_base_branch && epic.pr_base_branch.trim().length > 0;
  const effectiveMaxConcurrent = isIntegrationBranch ? 1 : epic.autonomous_max_concurrent;

  const agentCount = assignableAgents.length;
  if (agentCount === 0) {
    const msg = `No assignable agents for project "${project.name}" — check subAgents config or agent roles`;
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
  const inProgressColId = cols.find((c) => c.name === 'In Progress')?.id;
  const reviewColId = cols.find((c) => c.name === 'Review')?.id;
  const epicCards = d.stmts.getKanbanCardsByEpic.all(epic.id) as KanbanCardRow[];
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

  let assigned = 0;
  const agentSlotsCopy = agentsWithSlots.map((a) => ({ ...a }));

  // Routing pool for `pickAgentForCard`:
  //   - The project lead is treated as fallback-only; it never matches as a
  //     specialist. Even when the dispatcher's `assignableAgents` includes
  //     the lead (no-subAgents projects), we strip it from the routing
  //     pool here so a card labelled "lead" doesn't accidentally land on
  //     the lead via id/role-match.
  //   - The lead's slot count comes from `agentSlotsCopy` if it's already
  //     in the assignable pool, otherwise from a synthetic per-agent cap so
  //     the lead can absorb overflow on subAgents-scoped projects too. The
  //     synthetic cap mirrors `perAgentLimit` (= epic.autonomous_max_concurrent)
  //     so a fallback lead isn't artificially capped at one overflow card.
  const lead = pickLead(project);
  const slotsByAgentId = new Map<string, number>();
  for (const slot of agentSlotsCopy) {
    slotsByAgentId.set(slot.agent.id, slot.slots);
  }
  const routingPool = agentSlotsCopy.map((s) => s.agent).filter((a) => !lead || a.id !== lead.id);
  if (lead && !slotsByAgentId.has(lead.id)) {
    slotsByAgentId.set(lead.id, perAgentLimit);
  }

  // Label-based routing: every eligible card is dispatchable. The intake
  // ("ticketing") agent stamps labels at card-creation time; we route to
  // the first specialist whose id/role/name matches a label, falling back
  // to the project lead (which can implement directly or `<handoff>`).
  const dispatchable = eligible;

  while (assigned < slotsAvailable && assigned < dispatchable.length) {
    const card = dispatchable[assigned];

    const picked = pickAgentForCard({
      card,
      assignableAgents: routingPool,
      lead: lead ?? null,
      ctx: { slotsByAgentId },
    });
    if (!picked) break;

    const agent = picked;
    // Decrement bookkeeping. Pool members also decrement their per-agent
    // slot in `agentSlotsCopy` so the caps stay enforced across the loop;
    // an out-of-pool lead only decrements the synthetic slots map.
    const poolIdx = agentSlotsCopy.findIndex((s) => s.agent.id === agent.id);
    if (poolIdx >= 0) agentSlotsCopy[poolIdx].slots--;
    slotsByAgentId.set(agent.id, (slotsByAgentId.get(agent.id) ?? 1) - 1);

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
    };

    try {
      // ── Transactional slot claim (defense-in-depth) ────────────────────
      // The per-epic mutex above already prevents two `runAutonomousLoop`
      // invocations from interleaving, but the move-to-In-Progress can
      // still race with manual user moves, the webhook handler, or future
      // callers we don't yet have. Wrap the re-read of `activeCardCount`
      // and the move in a `BEGIN IMMEDIATE` so SQLite refuses concurrent
      // writers: either we observe the latest state and proceed, or we
      // observe `>= max_concurrent` and bail.
      //
      // We also re-read the count here (not just at the top of the loop)
      // because the previous iteration of this `while` block may have just
      // claimed a slot — that's the in-loop check the description calls out.
      const db = d.getDb();
      const claimSlot = db.transaction((cardId: string): boolean => {
        const epicCardsNow = d.stmts.getKanbanCardsByEpic.all(epic.id) as KanbanCardRow[];
        const activeNow = epicCardsNow.filter(
          (c) => c.column_id === inProgressColId || c.column_id === reviewColId,
        ).length;
        if (activeNow >= effectiveMaxConcurrent) return false;
        d.stmts.markCardDispatchedByAutonomous.run(cardId);
        d.stmts.moveKanbanCard.run(inProgressColId || card.column_id, 0, cardId);
        return true;
      });
      const claimed = claimSlot.immediate(card.id);
      if (!claimed) {
        console.log(
          `[Autonomous] Slot claim aborted for "${card.title}" — cap reached during dispatch (${effectiveMaxConcurrent} active${isIntegrationBranch ? ', integration branch serial cap' : ''})`,
        );
        break;
      }
      console.log(`[Autonomous] Assigning "${card.title}" to ${agent.name}`);

      const sessionId = crypto.randomUUID();
      const cfg = d.getConfig();
      const engineValidModels = cfg.engineValidModels || {};
      const agentEngine = agent.engine || 'claude-code';
      const autonomousOwnerId = resolveAutonomousOwnerUserId(card, epic);

      // Resolve the (engine, model) pair for the spawn. Card-level
      // `assign_engine` (when set) hard-pins the engine; `assign_model` then
      // wins over epic-level `autonomous_model`. Either may cross engines
      // (e.g. operator picks `composer-2.5` for an agent whose default
      // engine is `claude-code`), in which case we spawn under the
      // engine that owns the model so the operator's selection isn't
      // silently dropped.
      //
      // Falls back to the epic-level resolver (and ultimately the agent's
      // default model + engine) when no override is set or the override
      // isn't recognised by any configured engine.
      let engine: string;
      let model: string;
      const cardRawModel = typeof card.assign_model === 'string' ? card.assign_model.trim() : '';
      const cardRawEngine = typeof card.assign_engine === 'string' ? card.assign_engine.trim() : '';
      const cardEngineValid =
        cardRawEngine && Object.prototype.hasOwnProperty.call(engineValidModels, cardRawEngine)
          ? cardRawEngine
          : '';
      if (cardEngineValid) {
        // Explicit engine override always wins — pair it with the chosen
        // model when that model is valid for the override engine, otherwise
        // fall back to the engine's default.
        engine = cardEngineValid;
        const allowedForEngine = engineValidModels[cardEngineValid] || [];
        if (cardRawModel && allowedForEngine.includes(cardRawModel)) {
          model = cardRawModel;
        } else {
          model = cfg.engineDefaultModels?.[cardEngineValid] || allowedForEngine[0] || '';
        }
      } else if (cardRawModel) {
        const agentAllowed = engineValidModels[agentEngine] || [];
        if (agentAllowed.includes(cardRawModel)) {
          engine = agentEngine;
          model = cardRawModel;
        } else {
          const otherEngine = engineForModel(cardRawModel, engineValidModels);
          if (otherEngine) {
            engine = otherEngine;
            model = cardRawModel;
          } else {
            ({ engine, model } = sessionEngineAndModelForAutonomousDispatch(
              epic,
              agent,
              engineValidModels,
              cfg,
              autonomousOwnerId,
            ));
          }
        }
      } else {
        ({ engine, model } = sessionEngineAndModelForAutonomousDispatch(
          epic,
          agent,
          engineValidModels,
          cfg,
          autonomousOwnerId,
        ));
      }
      const projRow = d.findProject(projectId);
      const wt = defaultSessionUseWorktreeFlag(projRow);
      d.stmts.createSession.run(sessionId, agent.id, card.title, engine, model, wt, 0, 1);
      markSessionAutoShipOnComplete(d.stmts, sessionId);
      // Autonomous cards run at least "Build and Push"; they escalate to
      // "Auto Merge" (auto-merge) only when the project's auto-merge is enabled.
      // The epic's "Auto Merge" override forces `merge` regardless of project
      // auto-merge config — operators opt into auto-merge per autonomous epic.
      const finalizeLevel = epic.autonomous_send_it
        ? 'merge'
        : assignedFinalizeAutomationLevel(
            resolveShouldAutoMerge(undefined, projRow?.githubWorkflow),
          );
      markSessionFinalizeAutomation(d.stmts, sessionId, finalizeLevel);
      // Autonomous-dispatch sessions are created by the system (no
      // human caller in scope), but we still want to attribute them to
      // the real human responsible so per-user GitHub tokens, CLI
      // credentials, and skill secrets resolve correctly — and so the
      // session actually shows up on that user's session list under
      // strict-mode auth. `resolveAutonomousOwnerUserId` walks
      // card.created_by → card.session_id owner → epic.autonomous_enabled_by
      // → org owner; only the last hop matches the old behaviour.
      setSessionOwner(sessionId, autonomousOwnerId);
      {
        const row = d.stmts.getSession.get(sessionId) as SessionRow | undefined;
        if (row) {
          d.broadcast({
            type: 'session_created',
            agentId: agent.id,
            session: enrichSessionForClient(row, d.stmts),
          });
        }
      }

      // `moveKanbanCard` already ran inside the transactional slot claim
      // above. We still need to stamp `session_id` (and the agent name as
      // assignee) onto the card now that the session exists.
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
        card.assign_model,
        card.assign_engine ?? null,
        card.pr_base_branch ?? null,
        card.id,
      );

      const contextLines: string[] = [`# Task: ${card.title}`];
      if (card.description) contextLines.push(`\n## Description\n${card.description}`);
      if (card.priority) contextLines.push(`\n**Priority:** ${card.priority}`);
      if (card.labels) contextLines.push(`**Labels:** ${card.labels}`);
      contextLines.push(
        `\n---\nYou have been assigned this task by the autonomous dispatch system. Review the description above and begin working on it. When done, commit your changes — a PR will be created automatically.`,
      );

      // Scoped cross-hub secret injection: only cards that carry an opt-in
      // label (`cross-hub:dev` or `survey-tracker`) receive `DEV_HUB_API_KEY`
      // in their spawn environment. The fetch is best-effort — if Secrets
      // Manager is unreachable the session starts without the key and the
      // error is logged via the TOOL_ERROR pattern (see server/secrets.ts).
      const extraEnv: Record<string, string> = {};
      if (cardNeedsDevHubKey(card.labels)) {
        const devHubKey = await getDevHubApiKey();
        if (devHubKey) {
          extraEnv.DEV_HUB_API_KEY = devHubKey;
        }
      }

      d.handleChat(null, {
        type: 'chat',
        agentId: agent.id,
        sessionId,
        content: contextLines.join('\n'),
        hookSpecificOutput: { sessionTitle: card.title },
        // Mark this chat as an autonomous-dispatch origin so the spawn
        // credential policy in `chat.ts` (`resolveGithubSpawnToken` in
        // `github-spawn-token-resolver.ts`) strips the org owner's
        // per-user OAuth token from the env.
        // Without this, an agent in an autonomous-dispatch session can
        // bypass the `gh-pr.sh` wrapper guard by calling
        // `gh api repos/.../reviews -X POST` directly and posting a
        // formal PR review under the human-owner identity.
        _fromAutonomousDispatch: true,
        ...(Object.keys(extraEnv).length > 0 ? { extraEnv } : {}),
      }).catch(rollbackCard);

      d.broadcast({
        type: 'autonomous_assigned',
        projectId,
        epicId: epic.id,
        cardId: card.id,
        cardTitle: card.title,
        agentId: agent.id,
        agentName: agent.name,
      });
      assigned++;
    } catch (err: unknown) {
      rollbackCard(err);
    }
  }

  if (assigned > 0) {
    d.broadcast({ type: 'kanban_update', projectId });
    console.log(`[Autonomous] Dispatched ${assigned} card(s) for epic "${epic.name}"`);
  }
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

// ─── Startup Restoration ───────────────────────────────────────────────────

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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Autonomous] Failed to restore cron for project "${project.id}":`, msg);
    }
  }
}
