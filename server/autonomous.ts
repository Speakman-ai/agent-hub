import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { wrapCronTick, defaultTickOptions, estimateIntervalSeconds } from './cron-tick.js';
import { getOrCreateBoard } from './routes/board.js';
import {
  notifyDispatchFailure,
  dispatchReviewFeedback,
  dispatchReviewerForPR,
  isReviewerDispatchPending,
} from './routes/webhooks.js';
import { dispatchAutofixFeedback } from './autofix-dispatch.js';
import { createEscalation } from './routes/escalations.js';
import {
  lastDispatchedReviewId,
  recordDispatchedChangesRequestedReview,
} from './review-feedback-dedup.js';
import { resolveEffectiveModel } from './effective-model.js';
import { loadBoardBlockers, hasUnresolvedBlockers, isColumnDone } from './kanban-blockers.js';
import { linkKanbanCardPrUrl } from './kanban-pr-link.js';
import { CI_FAIL_CONCLUSIONS } from './ci-conclusions.js';
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
import { markSessionAutoShipOnComplete } from './session-ship.js';

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
  getGhBotUser: () => string | null;
  getGhAppSlug: () => string | null;
  getWebhookHandlerDeps: () => WebhookHandlerDeps;
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

interface WebhookHandlerDeps {
  stmts: Stmts;
  findAgent: (agentId: string) => { project: Project; agent: Agent } | null;
  handleChat: (ws: unknown, msg: ChatMessage) => Promise<void>;
  broadcast: BroadcastFn;
}

// ─── Module-level state ────────────────────────────────────────────────────
const autonomousCrons = new Map<string, cron.ScheduledTask>();
const autonomousProjects = new Set<string>();
let reviewPollCron: cron.ScheduledTask | null = null;

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

export { autonomousCrons, autonomousProjects, lastDispatchedReviewId, lastBlockerSkipSignature };

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
 * `autonomous_max_concurrent` is an epic-level setting and a project may
 * legitimately have multiple epics in flight (today only one is autonomous,
 * but the gate is forward-compatible).
 */
const inflightLoops = new Map<string, Promise<void>>();

export async function runAutonomousLoop(projectId: string): Promise<void> {
  const d = getDeps();
  const project = d.findProject(projectId);
  if (!project) return Promise.resolve();

  const boardData = getOrCreateBoard(d.stmts, projectId);
  if (!boardData?.board) return Promise.resolve();

  const epic = d.stmts.getAutonomousEpic.get(boardData.board.id) as KanbanEpicRow | undefined;
  if (!epic) return Promise.resolve();

  const existing = inflightLoops.get(epic.id);
  if (existing) return existing;

  const p = runAutonomousLoopInner(projectId).finally(() => {
    inflightLoops.delete(epic.id);
  });
  inflightLoops.set(epic.id, p);
  return p;
}

async function runAutonomousLoopInner(projectId: string): Promise<void> {
  const d = getDeps();
  const project = d.findProject(projectId);
  if (!project) return;

  const boardData = getOrCreateBoard(d.stmts, projectId);
  if (!boardData?.board) return;

  const epic = d.stmts.getAutonomousEpic.get(boardData.board.id) as KanbanEpicRow | undefined;
  if (!epic) return;

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
  const webhookHandlerDeps = d.getWebhookHandlerDeps();

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
      notifyDispatchFailure(webhookHandlerDeps, {
        source: 'Autonomous',
        cardId: card.id,
        cardTitle: card.title,
        projectId,
        agentName: agent.name,
        reason: 'Failed to create session or start chat for autonomous card',
        error: err,
      });
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
  autonomousProjects.delete(projectId);

  if (!epic.autonomous) {
    console.log(`[Autonomous] Stopped for epic "${epic.name}"`);
    return;
  }

  autonomousProjects.add(projectId);

  const task = cron.schedule(
    '* * * * *',
    wrapCronTick(
      () =>
        runAutonomousLoop(projectId).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[Autonomous] Safety-net error for "${epic.name}":`, msg);
        }),
      `autonomous:${projectId}`,
    ),
    defaultTickOptions({
      intervalSeconds: estimateIntervalSeconds('* * * * *'),
      name: `autonomous:${projectId}`,
    }),
  );
  autonomousCrons.set(key, task);
  console.log(
    `[Autonomous] Activated epic "${epic.name}" for project "${projectId}" (event-driven + 60s safety net)`,
  );

  runAutonomousLoop(projectId).catch((err: unknown) => {
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
      const epic = d.stmts.getAutonomousEpic.get(boardData.board.id) as KanbanEpicRow | undefined;
      if (epic) {
        scheduleAutonomousEpic(project.id, epic);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Autonomous] Failed to restore cron for project "${project.id}":`, msg);
    }
  }
}

// ─── Polling Fallback ──────────────────────────────────────────────────────
//
// The webhook handler is the primary path for both:
//   • dispatching the Reviewer agent on PR opened/synchronize
//   • dispatching changes_requested feedback to the original session
//
// This polling cron is a safety net for missed webhook deliveries. It:
//   1. reconciles merged PRs back to the Done column (`reconcileKanbanWithGitHub`)
//   2. catches `changes_requested` reviews we never received a webhook for
//      (`pollForMissedReviews`)

export function startReviewPollingFallback(): void {
  if (reviewPollCron) return;

  setTimeout(async () => {
    try {
      console.log('[ReviewPoll] Running initial startup reconciliation...');
      await reconcileKanbanWithGitHub();
      await pollForMissedReviews();
      await pollForLanModeReviewerDispatch();
      drainIdleSessionQueuesAfterPoll();
      console.log('[ReviewPoll] Startup reconciliation complete');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[ReviewPoll] Startup reconciliation error:', msg);
    }
  }, 10_000);

  reviewPollCron = cron.schedule(
    '*/3 * * * *',
    wrapCronTick(async () => {
      try {
        await reconcileKanbanWithGitHub();
        await pollForMissedReviews();
        await pollForLanModeReviewerDispatch();
        drainIdleSessionQueuesAfterPoll();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[ReviewPoll] Polling error:', msg);
      }
    }, 'review-poll'),
    defaultTickOptions({
      intervalSeconds: estimateIntervalSeconds('*/3 * * * *'),
      name: 'review-poll',
    }),
  );
  console.log('[ReviewPoll] Fallback polling started (every 3 minutes)');
}

/** Failure-mode B safety net: queued autofix/review messages with no live worker. */
function drainIdleSessionQueuesAfterPoll(): void {
  try {
    const drained = getDeps().drainIdleSessionQueues?.() ?? 0;
    if (drained > 0) {
      console.log(`[ReviewPoll] Drained idle queued messages for ${drained} session(s)`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[ReviewPoll] Idle queue drain failed:', msg);
  }
}

/**
 * Lowercased merge states GitHub returns when a PR cannot cleanly merge into
 * its base. `dirty` means textual conflicts; `behind` means the head is behind
 * a protected base that requires strict status checks. Both are "blocked until
 * human (or agent) reconciles the branch" from our perspective.
 *
 * Note: `mergeable_state` is a docs-level REST field — GitHub does not
 * formally commit to its set of values, but the ones we care about have been
 * stable for years. We treat anything else (clean, blocked, unstable, …) as
 * not-our-problem-for-this-check.
 */
const DIRTY_MERGE_STATES = new Set(['dirty', 'behind']);

/**
 * Does this PR need a merge-conflict escalation? True when GitHub has already
 * computed a merge state AND that state is known-dirty. We intentionally
 * return false when `mergeable` is `null` (GitHub hasn't finished the async
 * computation yet) so the next poll cycle catches it once the state lands.
 */
export function isPrMergeDirty(pr: {
  mergeable?: boolean | null;
  mergeable_state?: string | null;
}): boolean {
  if (pr.mergeable === false) return true;
  const state = typeof pr.mergeable_state === 'string' ? pr.mergeable_state.toLowerCase() : null;
  return state !== null && DIRTY_MERGE_STATES.has(state);
}

async function reconcileKanbanWithGitHub(): Promise<void> {
  const d = getDeps();
  const projects = d.getProjects();

  for (const project of projects) {
    const boardData = getOrCreateBoard(d.stmts, project.id);
    if (!boardData?.board) continue;

    const cols = d.stmts.getKanbanColumns.all(boardData.board.id) as Array<{
      id: string;
      name: string;
    }>;
    const doneCol = cols.find((c) => c.name.toLowerCase() === 'done');
    if (!doneCol) continue;

    let repoFullName: string | null = (project as Record<string, unknown>).github
      ? (((project as Record<string, unknown>).github as { repo?: string })?.repo ?? null)
      : null;
    if (!repoFullName) {
      const webhookConfigs = d.stmts.getWebhookConfigsByProject?.all(project.id) as
        | Array<{ repo_url: string }>
        | undefined;
      const repoUrl = webhookConfigs?.[0]?.repo_url;
      if (repoUrl) {
        const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
        if (match) repoFullName = `${match[1]}/${match[2]}`;
      }
    }
    if (!repoFullName) continue;

    const nonDoneCols = cols.filter((c) => c.id !== doneCol.id);
    for (const col of nonDoneCols) {
      const cards = d.stmts.getKanbanCardsByColumn.all(col.id) as KanbanCardRow[];
      for (const card of cards) {
        if (!card.pr_url && card.session_id) {
          try {
            const session = d.stmts.getSession?.get(card.session_id) as
              | { worktree_branch?: string }
              | undefined;
            const branch = session?.worktree_branch;
            if (branch) {
              const { stdout } = await execFileAsync(
                'gh',
                [
                  'api',
                  `repos/${repoFullName}/pulls?head=${repoFullName!.split('/')[0]}:${branch}&state=all`,
                  '--jq',
                  'first | {url: .html_url, state: .state, merged: .merged} // empty',
                ],
                { timeout: 15000 },
              );

              if (stdout.trim()) {
                const pr = JSON.parse(stdout.trim()) as {
                  url?: string;
                  state?: string;
                  merged?: boolean;
                };
                if (pr.url) {
                  if (
                    linkKanbanCardPrUrl(
                      d.stmts,
                      d.broadcast,
                      project.id,
                      card,
                      pr.url,
                      'branch_worktree',
                    )
                  ) {
                    (card as { pr_url: string | null }).pr_url = pr.url;
                  }
                }
              }
            }
          } catch {
            // gh CLI not available or API error — skip silently
          }
        }

        if (!card.pr_url) continue;

        const prMatch = card.pr_url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
        if (!prMatch) continue;

        const [, cardRepo, prNumber] = prMatch;

        try {
          const { stdout } = await execFileAsync(
            'gh',
            [
              'api',
              `repos/${cardRepo}/pulls/${prNumber}`,
              '--jq',
              '{state: .state, merged: .merged, mergeable: .mergeable, mergeable_state: .mergeable_state, html_url: .html_url}',
            ],
            { timeout: 15000 },
          );

          const pr = JSON.parse(stdout.trim()) as {
            state: string;
            merged: boolean;
            mergeable: boolean | null;
            mergeable_state: string | null;
            html_url: string | null;
          };

          if (pr.state === 'closed' && pr.merged) {
            d.stmts.moveKanbanCard.run(doneCol.id, 0, card.id);
            d.broadcast({ type: 'kanban_update', projectId: project.id });
            console.log(
              `[Reconcile] PR #${prNumber} already merged — card "${card.title}" moved to Done`,
            );

            tryAutonomousDispatch();
          } else if (pr.state === 'closed' && !pr.merged) {
            console.log(
              `[Reconcile] PR #${prNumber} closed without merge — card "${card.title}" left for triage`,
            );
          } else if (pr.state === 'open' && isPrMergeDirty(pr)) {
            // GitHub does NOT emit a webhook when PR A merges and dirties PR B
            // (the base changed, not the head). The only way to detect this
            // failure mode is to poll GET /pulls/:n and inspect mergeable /
            // mergeable_state. See `handleWebhookPrSynchronize` in
            // server/routes/webhooks.ts — this branch mirrors its escalation
            // behavior so the polling path surfaces the conflict in the UI.
            const prNum = Number.parseInt(prNumber, 10);
            const existing = d.stmts.getRecentEscalationByTypeAndPr?.get(
              project.id,
              'merge_conflict',
              prNum,
            );
            if (!existing) {
              createEscalation(
                { stmts: d.stmts, broadcast: d.broadcast },
                {
                  projectId: project.id,
                  type: 'merge_conflict',
                  title: `Merge conflicts on PR #${prNum}`,
                  description: `PR "${card.title}" has merge conflicts detected by the reconciliation poller (mergeable=${pr.mergeable}, mergeable_state=${pr.mergeable_state}). Rebase or merge the base branch to resolve.`,
                  prNumber: prNum,
                  prUrl: pr.html_url || card.pr_url,
                  cardId: card.id,
                  source: 'poller',
                },
              );
              console.log(
                `[Reconcile] PR #${prNumber} is DIRTY (${pr.mergeable_state}) — escalation created for card "${card.title}"`,
              );
            }
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.debug(`[Reconcile] Skipping PR #${prNumber}: ${msg}`);
        }
      }
    }
  }
}

/** Kanban columns where an open PR on the card is no longer actionable. */
const TERMINAL_KANBAN_COLUMN_NAMES = new Set(['done', 'cancelled', 'canceled', 'closed']);

/**
 * Bot login names whose review comments should never trigger an author-side
 * dispatch — mirrors the webhook handler's filter in
 * `handleWebhookReviewComment` so poll-detected comments behave the same way.
 */
const COMMENT_BOT_LOGINS = new Set(['github-actions[bot]', 'github-actions']);

/**
 * Magic marker the agent injects when *it* leaves a PR comment, so we never
 * re-dispatch our own bot comments back to the session. Same string used by
 * the webhook path; kept in sync intentionally.
 */
const AGENT_HUB_BOT_COMMENT_MARKER = '<!-- agent-hub-bot -->';

/**
 * Catch `changes_requested` reviews where the GitHub webhook was missed.
 * Scans cards in **Review** and **In Progress** (author work often lives there
 * after a `changes_requested` webhook moves the card). For each card with a
 * PR URL, compares GitHub `CHANGES_REQUESTED` review ids to
 * `lastDispatchedReviewId` (also updated when the webhook path dispatches and
 * the user message is actually persisted). New ids are pushed through
 * `dispatchReviewFeedback`.
 *
 * Also covers the two failure modes where the webhook delivery can quietly
 * drop and the original "missed reviews" probe wouldn't notice:
 *
 *   • **Failed check runs** — `gh api repos/:o/:r/commits/:sha/check-runs`
 *     for the PR's head SHA, filtered to `CI_FAIL_CONCLUSIONS`, deduped via
 *     `last_dispatched_check_run_id`.
 *   • **Inline review comments** — `gh api repos/:o/:r/pulls/:n/comments`,
 *     filtered to non-bot / non-self / no `<!-- agent-hub-bot -->` marker,
 *     deduped via `last_dispatched_review_comment_id`.
 *
 * Both reuse `dispatchReviewFeedback` for delivery so the session-routing
 * rules (worktree owner, owner_user_id, queue handling) are identical to the
 * event-driven path.
 *
 * Exported for Vitest; production only schedules this via `startReviewPollingFallback`.
 */
export async function pollForMissedReviews(): Promise<void> {
  const d = getDeps();
  const projects = d.getProjects();
  const ghAuthenticatedUser = d.getGhAuthenticatedUser();
  const webhookHandlerDeps = d.getWebhookHandlerDeps();
  const config = d.getConfig();

  for (const project of projects) {
    const ghToken = await resolveOrgOwnerGithubToken(config, undefined);
    const ghEnv = autoGitChildEnv(ghToken);
    const boardData = getOrCreateBoard(d.stmts, project.id);
    if (!boardData?.board) continue;

    const cols = d.stmts.getKanbanColumns.all(boardData.board.id) as Array<{
      id: string;
      name: string;
    }>;
    const reviewCol = cols.find((c) => c.name.toLowerCase() === 'review');
    const inProgressCol = cols.find((c) => c.name.toLowerCase() === 'in progress');

    // Scan every non-terminal card with a linked PR — not only Review/In Progress.
    // Autonomous cards often sit in To Do while a PR is open; Done cards are
    // excluded so we don't spend a gh call per merged PR every poll cycle.
    const terminalColIds = new Set(
      cols
        .filter((c) => TERMINAL_KANBAN_COLUMN_NAMES.has(c.name.toLowerCase().trim()))
        .map((c) => c.id),
    );
    const cardsToScan = (d.stmts.getKanbanCards.all(boardData.board.id) as KanbanCardRow[]).filter(
      (c) => c.pr_url && !terminalColIds.has(c.column_id),
    );

    for (const card of cardsToScan) {
      if (!card.pr_url) continue;

      // Skip cards whose PR has already been approved — no point re-notifying
      // the agent about stale `changes_requested` reviews that were superseded
      // by an approval. This guards against the case where the reviewer approved
      // but the old `changes_requested` review remains in GitHub's history.
      if (card.review_status === 'approved') continue;

      const prMatch = card.pr_url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
      if (!prMatch) continue;
      const [, repoFullName, prNumber] = prMatch;

      try {
        const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
          execFile(
            'gh',
            [
              'api',
              `repos/${repoFullName}/pulls/${prNumber}/reviews`,
              '--jq',
              '[.[] | select(.state == "CHANGES_REQUESTED") | {id: .id, submitted_at: .submitted_at}]',
            ],
            { timeout: 15000, env: ghEnv },
            (err, stdout, _stderr) => {
              if (err) reject(err);
              else resolve({ stdout });
            },
          );
        });
        const reviews = JSON.parse(stdout.trim() || '[]') as Array<{
          id: number;
          submitted_at: string;
        }>;

        // Prefer the in-memory dedup value (fast path). On server restart the
        // in-memory map is empty, so we fall back to the DB-persisted value on
        // the card row. This prevents re-dispatching the same review feedback
        // after every server restart (the original source of the repeated-ack
        // bug where the agent kept saying "Another auto background-task
        // notification — no action needed").
        const inMemory = lastDispatchedReviewId.get(card.id);
        const dbPersisted =
          inMemory === undefined && card.last_dispatched_review_id != null
            ? Number(card.last_dispatched_review_id)
            : undefined;
        const lastDispatched = inMemory ?? dbPersisted;
        const newReviews =
          lastDispatched !== undefined ? reviews.filter((r) => r.id > lastDispatched) : reviews;

        if (newReviews.length > 0) {
          console.log(
            `[ReviewPoll] Card "${card.title}" has ${newReviews.length} new change request(s) — dispatching`,
          );

          const feedbackMessage = `# Missed Review Feedback Detected (Polling)

Your PR #${prNumber} has **${newReviews.length}** pending "changes requested" review(s) that may not have been addressed yet.

## What to do:
1. Read the review comments: \`gh pr view ${prNumber} --comments\`
2. Check for inline comments: \`gh api repos/${repoFullName}/pulls/${prNumber}/comments --jq '.[] | select(.user.login != "${ghAuthenticatedUser || ''}") | {user: .user.login, body: .body, path: .path, line: .line}'\`
3. Address each issue — fix the code or explain why no change is needed
4. Commit and push:
   \`\`\`bash
   git add -A
   git commit -m "Address review feedback"
   git push
   \`\`\``;

          if (inProgressCol && card.column_id !== inProgressCol.id) {
            d.stmts.moveKanbanCard.run(inProgressCol.id, 0, card.id);
            d.broadcast({ type: 'kanban_update', projectId: project.id });
          }

          const result = await dispatchAutofixFeedback(
            { stmts: d.stmts },
            card,
            project,
            'review-missed-poll',
            feedbackMessage,
            (c, p, content) => dispatchReviewFeedback(webhookHandlerDeps, c, p, content),
          );
          if (result.userMessagePersisted) {
            const latestId = Math.max(...newReviews.map((r) => r.id));
            // Update in-memory dedup map.
            recordDispatchedChangesRequestedReview(card.id, latestId);
            // Also persist to DB so the dedup state survives server restarts.
            // Without this, the map is cleared on every restart and the same
            // reviews are re-dispatched each time the server comes back up.
            try {
              d.stmts.setCardLastDispatchedReviewId?.run(latestId, card.id);
            } catch (persistErr) {
              console.warn(
                `[ReviewPoll] Failed to persist last_dispatched_review_id for card ${card.id}:`,
                (persistErr as Error).message,
              );
            }
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[ReviewPoll] CHANGES_REQUESTED probe failed for card "${card.title}" (${repoFullName}#${prNumber}): ${msg}`,
        );
      }

      // ── Missed CI failures + inline review comments ────────────────────
      //
      // The GitHub event delivery for `check_run.completed` and
      // `pull_request_review_comment.created` is the primary path; this is a
      // safety net for deliveries that never reached us (network blip,
      // server restart, webhook secret rotation, etc.). Resolving PR head
      // SHA and open-state first lets us skip closed PRs entirely.
      let prSnapshot: { state: string | null; head_sha: string | null } | null = null;
      try {
        const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
          execFile(
            'gh',
            [
              'api',
              `repos/${repoFullName}/pulls/${prNumber}`,
              '--jq',
              '{state: .state, head_sha: .head.sha}',
            ],
            { timeout: 15000, env: ghEnv },
            (err, stdout, _stderr) => {
              if (err) reject(err);
              else resolve({ stdout });
            },
          );
        });
        const trimmed = stdout.trim();
        if (trimmed) {
          prSnapshot = JSON.parse(trimmed) as { state: string | null; head_sha: string | null };
        }
      } catch {
        // PR fetch failed — skip the secondary probes for this card.
      }

      if (!prSnapshot || prSnapshot.state !== 'open') {
        continue;
      }

      // ── CI failure probe ────────────────────────────────────────────────
      if (prSnapshot.head_sha) {
        try {
          const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
            execFile(
              'gh',
              [
                'api',
                `repos/${repoFullName}/commits/${prSnapshot!.head_sha}/check-runs`,
                '--jq',
                '[.check_runs[] | {id: .id, name: .name, conclusion: .conclusion}]',
              ],
              { timeout: 15000, env: ghEnv },
              (err, stdout, _stderr) => {
                if (err) reject(err);
                else resolve({ stdout });
              },
            );
          });
          const runs = JSON.parse(stdout.trim() || '[]') as Array<{
            id: number;
            name: string;
            conclusion: string | null;
          }>;
          const failed = runs.filter(
            (r) => r.conclusion !== null && CI_FAIL_CONCLUSIONS.has(r.conclusion),
          );

          const lastDispatched =
            card.last_dispatched_check_run_id != null
              ? Number(card.last_dispatched_check_run_id)
              : undefined;
          const newFailed =
            lastDispatched !== undefined ? failed.filter((r) => r.id > lastDispatched) : failed;

          if (newFailed.length > 0) {
            console.log(
              `[ReviewPoll] Card "${card.title}" has ${newFailed.length} new failed check run(s) — dispatching CI fix`,
            );

            const checkSummary = newFailed
              .slice(0, 5)
              .map((r) => `- **${r.name}** (${r.conclusion})`)
              .join('\n');
            const feedbackMessage = `# Missed CI Failure Detected (Polling)

Your PR #${prNumber} has **${newFailed.length}** failing check run(s) that may not have been addressed yet.

## Failing checks
${checkSummary}${newFailed.length > 5 ? `\n…and ${newFailed.length - 5} more.` : ''}

## What to do
1. Read the failing logs: \`gh pr checks ${prNumber}\`
2. Drill into specific failures: \`gh run view <run-id> --log-failed\`
3. Fix the issues in your code
4. Commit and push:
   \`\`\`bash
   git add -A
   git commit -m "Fix CI failures"
   git push
   \`\`\`

The CI will re-run automatically once you push.`;

            if (inProgressCol && card.column_id !== inProgressCol.id) {
              d.stmts.moveKanbanCard.run(inProgressCol.id, 0, card.id);
              d.broadcast({ type: 'kanban_update', projectId: project.id });
            }

            const result = await dispatchAutofixFeedback(
              { stmts: d.stmts },
              card,
              project,
              'ci-failure',
              feedbackMessage,
              (c, p, content) => dispatchReviewFeedback(webhookHandlerDeps, c, p, content),
            );
            if (result.userMessagePersisted) {
              const latestId = Math.max(...newFailed.map((r) => r.id));
              try {
                d.stmts.setCardLastDispatchedCheckRunId?.run(latestId, card.id);
              } catch (persistErr) {
                console.warn(
                  `[ReviewPoll] Failed to persist last_dispatched_check_run_id for card ${card.id}:`,
                  (persistErr as Error).message,
                );
              }
            }
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[ReviewPoll] check-runs probe failed for card "${card.title}" (${repoFullName}#${prNumber}): ${msg}`,
          );
        }
      }

      // ── Inline review comment probe ─────────────────────────────────────
      try {
        const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
          execFile(
            'gh',
            [
              'api',
              `repos/${repoFullName}/pulls/${prNumber}/comments`,
              '--jq',
              '[.[] | {id: .id, body: .body, path: .path, line: .line, user: .user.login}]',
            ],
            { timeout: 15000, env: ghEnv },
            (err, stdout, _stderr) => {
              if (err) reject(err);
              else resolve({ stdout });
            },
          );
        });
        const comments = JSON.parse(stdout.trim() || '[]') as Array<{
          id: number;
          body: string | null;
          path: string | null;
          line: number | null;
          user: string | null;
        }>;

        const ghBotUser = d.getGhBotUser?.() ?? null;
        const eligible = comments.filter((c) => {
          if (!c.user) return false;
          if (COMMENT_BOT_LOGINS.has(c.user)) return false;
          if (ghAuthenticatedUser && c.user === ghAuthenticatedUser) return false;
          if (ghBotUser && c.user === ghBotUser) return false;
          if (c.body && c.body.includes(AGENT_HUB_BOT_COMMENT_MARKER)) return false;
          return true;
        });

        const lastDispatched =
          card.last_dispatched_review_comment_id != null
            ? Number(card.last_dispatched_review_comment_id)
            : undefined;
        const newComments =
          lastDispatched !== undefined ? eligible.filter((c) => c.id > lastDispatched) : eligible;

        if (newComments.length > 0) {
          console.log(
            `[ReviewPoll] Card "${card.title}" has ${newComments.length} new inline review comment(s) — dispatching`,
          );

          const commentSummary = newComments
            .slice(0, 5)
            .map((c) => {
              const loc = c.path ? `\`${c.path}\`${c.line ? `:${c.line}` : ''}` : '(general)';
              const preview = (c.body || '').replace(/\s+/g, ' ').trim().slice(0, 160);
              return `- **${c.user}** on ${loc}: ${preview || '(empty body)'}`;
            })
            .join('\n');
          const feedbackMessage = `# Missed Inline Review Comment(s) Detected (Polling)

Your PR #${prNumber} has **${newComments.length}** unaddressed inline review comment(s).

## Comments
${commentSummary}${newComments.length > 5 ? `\n…and ${newComments.length - 5} more.` : ''}

## What to do
1. Read all comments: \`gh api repos/${repoFullName}/pulls/${prNumber}/comments\`
2. For each comment, either:
   - Fix the code in the referenced file/line, OR
   - Reply with rationale (prefix the body with \`<!-- agent-hub-bot -->\`).
3. Commit and push:
   \`\`\`bash
   git add -A
   git commit -m "Address inline review feedback"
   git push
   \`\`\``;

          if (inProgressCol && card.column_id !== inProgressCol.id) {
            d.stmts.moveKanbanCard.run(inProgressCol.id, 0, card.id);
            d.broadcast({ type: 'kanban_update', projectId: project.id });
          }

          const result = await dispatchAutofixFeedback(
            { stmts: d.stmts },
            card,
            project,
            'inline-comment-poll',
            feedbackMessage,
            (c, p, content) => dispatchReviewFeedback(webhookHandlerDeps, c, p, content),
          );
          if (result.userMessagePersisted) {
            const latestId = Math.max(...newComments.map((c) => c.id));
            try {
              d.stmts.setCardLastDispatchedReviewCommentId?.run(latestId, card.id);
            } catch (persistErr) {
              console.warn(
                `[ReviewPoll] Failed to persist last_dispatched_review_comment_id for card ${card.id}:`,
                (persistErr as Error).message,
              );
            }
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[ReviewPoll] inline-comment probe failed for card "${card.title}" (${repoFullName}#${prNumber}): ${msg}`,
        );
      }
    }
  }
}

/**
 * LAN-mode equivalent of the `pull_request.opened` webhook → `dispatchReviewerForPR`
 * path. In cloud mode the webhook handler in `server/routes/webhooks.ts` fires
 * the reviewer the moment GitHub delivers `pull_request.opened`. On a LAN
 * install GitHub can't reach us, so a freshly-opened PR never gets reviewed
 * unless someone manually nudges it. This poller closes that gap by finding
 * cards whose PR is open, has no recorded reviewer dispatch yet, and isn't
 * already in flight, then routing them through the same
 * `dispatchReviewerForPR` entry point as the webhook path.
 *
 * Hard-gated by `config.lanMode`: when LAN mode is off the webhook is the
 * single source of truth and double-firing here would produce duplicate
 * reviews. When LAN mode is on, the webhook can't fire at all, so there is
 * nothing to double-fire with.
 *
 * Subsequent reviewer dispatches (after `synchronize`, after a
 * `CHANGES_REQUESTED`, etc.) are NOT handled here — `pollForMissedReviews`
 * already covers the post-first-review cases via `dispatchReviewFeedback`.
 * This function is strictly the "we've never reviewed this PR" path.
 *
 * Exported for Vitest; production only schedules it via
 * `startReviewPollingFallback`.
 */
export async function pollForLanModeReviewerDispatch(): Promise<void> {
  const d = getDeps();
  const cfg = d.getConfig();
  if (!cfg.lanMode) return;

  const projects = d.getProjects();
  // `getWebhookHandlerDeps()` returns the same shared deps object the
  // webhook handler uses, so the reviewer it dispatches here will run
  // through the identical chat / broadcast / DB writes — there is no
  // second "LAN" dispatch path.
  const reviewerDeps = d.getWebhookHandlerDeps();

  for (const project of projects) {
    const reviewer = project.agents?.find((a) => a.role === 'reviewer');
    if (!reviewer) continue;

    const boardData = getOrCreateBoard(d.stmts, project.id);
    if (!boardData?.board) continue;

    const cols = d.stmts.getKanbanColumns.all(boardData.board.id) as Array<{
      id: string;
      name: string;
    }>;
    const reviewCol = cols.find((c) => c.name.toLowerCase() === 'review');
    if (!reviewCol) continue;

    const cards = d.stmts.getKanbanCardsByColumn.all(reviewCol.id) as KanbanCardRow[];
    for (const card of cards) {
      if (!card.pr_url) continue;
      // Already dispatched at least once via webhook / manual nudge / a
      // previous pass of this poller — the post-first-review surface
      // (changes-requested replay, CI failure, inline comments) is
      // handled by `pollForMissedReviews`.
      if (card.last_dispatched_review_id != null) continue;
      // Approved PRs don't need a reviewer dispatch.
      if (card.review_status === 'approved') continue;

      const prMatch = card.pr_url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
      if (!prMatch) continue;
      const [, repoFullName, prNumberStr] = prMatch;
      const prNumber = Number.parseInt(prNumberStr, 10);
      if (!Number.isFinite(prNumber)) continue;

      // Defense-in-depth dedup: same key the webhook handler uses, so an
      // in-flight debounce (set by either path) blocks us.
      if (
        isReviewerDispatchPending(project.id, prNumber, {
          stmts: d.stmts,
          repoFullName,
        })
      ) {
        continue;
      }

      // Fetch PR title + head SHA + state. Closed PRs are skipped — the
      // reviewer should never run against a merged or abandoned PR.
      //
      // Uses the raw `execFile` callback form (matching `pollForMissedReviews`
      // and `reconcileKanbanWithGitHub` above) rather than the promisified
      // `execFileAsync`. Vitest's `child_process` mock replaces `execFile`
      // with a `vi.fn()` that lacks the `util.promisify.custom` symbol, so
      // the promisified form would lose the `{ stdout, stderr }` packing
      // and tests would see `undefined`. Callback form sidesteps that.
      let pr: { title: string; state: string; head_sha: string | null } | null = null;
      try {
        const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
          execFile(
            'gh',
            [
              'api',
              `repos/${repoFullName}/pulls/${prNumber}`,
              '--jq',
              '{title: .title, state: .state, head_sha: .head.sha}',
            ],
            { timeout: 15000 },
            (err, stdout, _stderr) => {
              if (err) reject(err);
              else resolve({ stdout });
            },
          );
        });
        const trimmed = stdout.trim();
        if (trimmed) {
          pr = JSON.parse(trimmed) as { title: string; state: string; head_sha: string | null };
        }
      } catch {
        // gh CLI unavailable or PR fetch errored — try again next tick.
        continue;
      }
      if (!pr || pr.state !== 'open') continue;

      // Persist the dispatch marker BEFORE firing so a crash mid-dispatch
      // can't loop the same PR through the reviewer on every tick. The
      // webhook path sets this on review submission via `pr-review`; we
      // can't wait for that here because the whole point of this function
      // is to bootstrap the first review when no webhook will arrive. Use
      // a sentinel of `0` ("dispatched but no review submitted yet") so
      // the value is clearly distinguishable from a real review id; any
      // subsequent real submission will overwrite it via
      // `recordDispatchedChangesRequestedReview` / the `/api/pr/review`
      // path.
      try {
        d.stmts.setCardLastDispatchedReviewId?.run(0, card.id);
      } catch (persistErr) {
        console.warn(
          `[ReviewPoll/LAN] Failed to persist initial dispatch marker for card ${card.id}:`,
          (persistErr as Error).message,
        );
        // Keep going — a missing marker just means we'll retry next tick.
      }

      const scheduled = dispatchReviewerForPR(
        reviewerDeps as unknown as Parameters<typeof dispatchReviewerForPR>[0],
        project,
        {
          prUrl: card.pr_url,
          prNumber,
          prTitle: pr.title || card.title,
          repoFullName,
          reason: 'opened',
          headSha: pr.head_sha ?? undefined,
        },
      );
      if (scheduled) {
        console.log(
          `[ReviewPoll/LAN] Dispatched reviewer for PR #${prNumber} on "${project.name}" (card "${card.title}")`,
        );
      }
    }
  }
}
