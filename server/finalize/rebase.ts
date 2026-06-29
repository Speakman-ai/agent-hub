/**
 * rebase.ts — Finalize Code Changes, Phase 1 (rebase phase).
 *
 * Per design (`finalize-code-changes-architecture-v0` §3): before any other
 * Finalize phase runs, the session's existing worktree branch is rebased
 * onto `origin/<default>`. There is no separate CI worktree — we mutate
 * the session's tree in place (§6, "no dedicated Hub CI agent").
 *
 * Flow:
 *
 *   1. Move `finalize_runs.phase = 'rebase'`, `status = 'rebasing'`, emit
 *      `finalize_run_phase_changed` over the broadcast bus.
 *   2. Loop:
 *        a. `git fetch origin <base>` + `git rebase origin/<base>` via
 *           {@link rebaseOntoBase} (shared with pre-push rebase so the
 *           two code paths can never disagree on the exact git semantics).
 *        b. Outcome is `noop` / `rebased` — phase succeeds, return
 *           `{ kind: 'success', ... }` so the orchestrator can advance to
 *           the next phase.
 *        c. Outcome is `skipped` (e.g. fetch failed, unsafe base branch) —
 *           we surface as success-of-sorts so the rest of Finalize can
 *           decide whether to abort or proceed. Phase 1 fails fast; later
 *           phases may differ.
 *        d. Outcome is `conflict` — re-issue the rebase under our own
 *           control and run an **inner per-commit loop**: list conflicted
 *           files (`git diff --name-only --diff-filter=U`), classify each
 *           via {@link classifyFileResolution}. If every file is
 *           trivially resolvable (whitespace / import-order / lockfile),
 *           apply the fixes, `git add`, `git rebase --continue`. If the
 *           `--continue` produces **another** conflict on the next commit
 *           in the series, the inner loop walks that one too — a feature
 *           branch with trivial conflicts on three commits gets resolved
 *           in one inner pass per commit, not three separate outer
 *           attempts. Any non-trivial file at any inner step aborts the
 *           rebase and dispatches the unresolved hunks into the
 *           originating session as a chat message; we await turn-end
 *           and re-enter from the top of the outer loop.
 *   3. Budget guard: every loop pass increments
 *      `finalize_runs.active_seconds_consumed`. If the running total ever
 *      crosses the cap (default 60 minutes, may be lowered by ci.yaml at
 *      v1+), we hard-fail terminal with `failure_reason = 'timeout'`.
 *
 * Loop invariant: a fresh rebase happens on **every** re-entry, even
 * after a "trivial" auto-fix. The auto-fix branch and the
 * dispatch-and-wait branch share the same retry path; nothing about the
 * worktree-state-after-a-fix is trusted without re-validating against
 * `origin/<base>`.
 */
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';
import type {
  BroadcastFn,
  FinalizeRunPhase,
  FinalizeRunRow,
  FinalizeRunStatus,
  KanbanCardRow,
  Project,
  Stmts,
} from '../types.js';
import { rebaseOntoBase } from '../pre-push-rebase.js';
import type { RebaseOntoBaseOptions, RebaseOutcome } from '../pre-push-rebase.js';
import {
  capturePreRebaseBaseline,
  rebaseDroppedAllChanges,
  worktreeHasChangesVsBase,
} from './prerebase-backup.js';
import {
  classifyFileResolution,
  regenerateLockfile,
  type ConflictHunk,
  type FileResolution,
} from './trivial-conflict-resolver.js';

const execFileAsync = promisify(execFile);

import { FINALIZE_BUDGET_DEFAULT_SECONDS } from './budget.js';

/** Hard cap on Finalize active time. Mirrors design §13. */
export const FINALIZE_BUDGET_SECONDS = FINALIZE_BUDGET_DEFAULT_SECONDS;
/** Budget billed per rebase attempt that didn't conflict-loop (cheap path). */
const REBASE_ATTEMPT_ACTIVE_SECONDS = 5;
/** Budget billed per trivial-conflict auto-resolve pass. */
const TRIVIAL_RESOLVE_ACTIVE_SECONDS = 10;
/** Cap on dispatch/retry loops before we surface as `failed` to avoid runaway. */
const MAX_REBASE_PASSES = 25;
/**
 * Cap on inner `--continue` passes within a single rebase attempt. Each
 * commit in the feature branch can produce its own conflict during a
 * single rebase, so the inner conflict loop steps through them one at a
 * time. The cap exists so a pathological branch (e.g. 200 commits all
 * conflicting) can't exhaust the outer budget by attrition.
 */
const MAX_INNER_CONFLICT_PASSES = 50;

/**
 * Outcome of the rebase phase. `kind: 'success'` advances the
 * orchestrator; everything else is terminal for the run.
 */
export type RebasePhaseOutcome =
  | {
      kind: 'success';
      /** `noop` / `rebased` / `skipped` from {@link rebaseOntoBase}. */
      rebaseKind: 'noop' | 'rebased' | 'skipped';
      /** True iff at least one fix pass (trivial or dispatched) ran. */
      requiredFix: boolean;
      /**
       * Count of non-trivial conflict passes that were dispatched into
       * the originating session (each one issued a chat message and
       * awaited the next turn-end). Trivial auto-resolves don't bump
       * this — they're invisible to the user. Surfaced so the
       * orchestrator can distinguish a "rebase: clean (or trivially
       * cleaned)" outcome from a "rebase: conflict dispatched to
       * session" outcome when mirroring transitions onto the kanban
       * card. Defaults to `0`.
       */
      conflictsDispatchedCount: number;
      activeSecondsBilled: number;
    }
  | {
      kind: 'failed';
      failureReason:
        | 'rebase_aborted'
        | 'timeout'
        | 'unsafe_base_branch'
        | 'no_worktree'
        | 'rebase_dropped_commits';
      detail: string;
      activeSecondsBilled: number;
    };

export interface RebasePhaseDeps {
  stmts: Pick<
    Stmts,
    | 'getFinalizeRun'
    | 'updateFinalizeRunPhase'
    | 'updateFinalizeRunActiveSeconds'
    | 'failFinalizeRun'
  >;
  broadcast: BroadcastFn;
  /**
   * Dispatches a chat message into the originating session and resolves
   * once the session's NEXT turn ends. Implemented atop
   * `dispatchReviewFeedback` + a session-event listener in production;
   * tests inject a controlled promise so the loop is deterministic.
   *
   * The implementation MUST resolve `userMessagePersisted = true` only
   * when the message actually entered the session queue (the dispatch
   * path's `userMessagePersisted` flag). On `false` we treat it as a
   * dispatch failure and surface the run as `failed`.
   */
  dispatchAndWaitForTurnEnd: (args: {
    sessionId: string;
    cardId: string;
    body: string;
  }) => Promise<{ userMessagePersisted: boolean }>;
  /**
   * Optional spawn override for git invocations the rebase phase makes
   * directly (the rebase itself goes through {@link rebaseOntoBase}'s own
   * spawn). Tests swap this; production lets it fall through to
   * `execFile`.
   */
  runGit?: (
    args: string[],
    opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Optional override of {@link rebaseOntoBase}. Tests stub the whole call. */
  rebase?: (opts: RebaseOntoBaseOptions) => Promise<RebaseOutcome>;
  /** Optional override of {@link regenerateLockfile}. Tests stub the npm side-effect. */
  regenerateLockfile?: typeof regenerateLockfile;
  /** Override the budget cap (testing fast-timeout). Defaults to {@link FINALIZE_BUDGET_SECONDS}. */
  budgetSeconds?: number;
  /** Inject deterministic time for the active-seconds counter. */
  now?: () => number;
}

export interface RebasePhaseOptions {
  /** finalize_runs.id. */
  runId: string;
  /** The session's existing worktree path. Pre-resolved upstream. */
  worktreePath: string;
  /** Default branch on origin (e.g. 'main'). Pre-resolved by the trigger. */
  baseBranch: string;
  /** The feature branch the session committed to. Used for `--force-with-lease` pinning later. */
  featureBranch?: string;
  /** Env to inject so `git fetch` uses the session's GitHub token. */
  env?: NodeJS.ProcessEnv;
  /** The kanban card the run is anchored to (for dispatch context). */
  card: KanbanCardRow;
  /** The project the card belongs to (for dispatch context). */
  project: Project;
}

/**
 * Run the rebase phase end-to-end. Caller is responsible for having
 * already INSERTed the `finalize_runs` row with `status = 'queued'` (or
 * a prior phase's status) — `runRebasePhase` only mutates it.
 */
export async function runRebasePhase(
  deps: RebasePhaseDeps,
  opts: RebasePhaseOptions,
): Promise<RebasePhaseOutcome> {
  const { stmts, broadcast } = deps;
  const budget = deps.budgetSeconds ?? FINALIZE_BUDGET_SECONDS;
  const rebase = deps.rebase ?? rebaseOntoBase;
  const regenLock = deps.regenerateLockfile ?? regenerateLockfile;
  const runGit = deps.runGit ?? defaultRunGit;

  // Guard-rail validation BEFORE we publish a phase change — a guaranteed
  // failure should not surface as a phantom `rebasing` status that the UI
  // briefly renders. Both terminations below skip the broadcast.
  if (!opts.worktreePath) {
    return terminate(stmts, opts.runId, 'failed', 'no_worktree', 'worktree path missing', 0);
  }
  if (!opts.baseBranch) {
    return terminate(stmts, opts.runId, 'failed', 'unsafe_base_branch', 'base branch missing', 0);
  }

  // Enter the rebase phase. Updates DB + broadcasts the phase change so the
  // UI checks panel can show the in-flight row before the first git spawn.
  setPhase(stmts, broadcast, opts.runId, opts.card.session_id ?? null, 'rebase', 'rebasing');

  // Commit-loss guard, part 1: snapshot the branch tip to a durable backup ref
  // BEFORE the first rebase rewrites the branch, and record whether the branch
  // had net changes vs base. The snapshot keeps the pre-rebase commits
  // reachable (recoverable) no matter what the rebase does; the recorded
  // baseline powers the drop-detection below. Best-effort — see
  // `capturePreRebaseBaseline`.
  const preRebaseBaseline = await capturePreRebaseBaseline(runGit, {
    cwd: opts.worktreePath,
    baseBranch: opts.baseBranch,
    runId: opts.runId,
    env: opts.env,
  });

  let billedSeconds = 0;
  let requiredFix = false;
  let conflictsDispatchedCount = 0;

  for (let pass = 0; pass < MAX_REBASE_PASSES; pass += 1) {
    if (billedSeconds >= budget) {
      return terminate(
        stmts,
        opts.runId,
        'timed_out',
        'timeout',
        `active-time budget of ${budget}s exceeded after ${pass} rebase pass(es)`,
        billedSeconds,
      );
    }

    const outcome = await rebase({
      cwd: opts.worktreePath,
      baseBranch: opts.baseBranch,
      featureBranch: opts.featureBranch,
      env: opts.env,
    });
    billedSeconds += REBASE_ATTEMPT_ACTIVE_SECONDS;
    stmts.updateFinalizeRunActiveSeconds.run(REBASE_ATTEMPT_ACTIVE_SECONDS, opts.runId);

    if (outcome.kind === 'noop' || outcome.kind === 'rebased') {
      // Commit-loss guard, part 2: a clean rebase that left the branch with
      // ZERO net changes vs base, when it HAD changes before, means the rebase
      // silently dropped the session's commits (patch-equivalent to work
      // already on base, or a conflict resolved to base's side). Fail loudly
      // instead of advancing to push — otherwise Finalize ships an empty diff
      // and (under Merge Automatically) moves the card to Done. The pre-rebase
      // commits remain recoverable from the backup ref captured above.
      if (preRebaseBaseline.headSha && preRebaseBaseline.hadChangesVsBase) {
        let postHasChanges = true;
        try {
          postHasChanges = await worktreeHasChangesVsBase(runGit, {
            cwd: opts.worktreePath,
            baseBranch: opts.baseBranch,
            env: opts.env,
          });
        } catch {
          // Can't determine post-state — fail open (assume not dropped) so a
          // transient git error never blocks an otherwise-clean rebase. The
          // push-side empty-integration gate is the backstop.
          postHasChanges = true;
        }
        if (rebaseDroppedAllChanges(preRebaseBaseline, postHasChanges)) {
          return terminate(
            stmts,
            opts.runId,
            'failed',
            'rebase_dropped_commits',
            `rebase onto origin/${opts.baseBranch} dropped all session changes ` +
              `(branch had net changes before the rebase, none after). The ` +
              `pre-rebase commit is preserved at ${preRebaseBaseline.backupRef} ` +
              `(${preRebaseBaseline.headSha}); recover with ` +
              `\`git branch <name> ${preRebaseBaseline.backupRef}\`. This usually ` +
              `means equivalent work already landed on ${opts.baseBranch} or a ` +
              `conflict was resolved to the base side.`,
            billedSeconds,
          );
        }
      }
      return {
        kind: 'success',
        rebaseKind: outcome.kind,
        requiredFix,
        conflictsDispatchedCount,
        activeSecondsBilled: billedSeconds,
      };
    }
    if (outcome.kind === 'skipped') {
      // `skipped` is fatal at the rebase phase — we cannot guarantee the
      // session tree is on top of `origin/<base>` so the rest of Finalize
      // cannot proceed. The trigger surface should report the skip reason
      // to the user.
      return {
        kind: 'success',
        rebaseKind: 'skipped',
        requiredFix,
        conflictsDispatchedCount,
        activeSecondsBilled: billedSeconds,
      };
    }

    // `conflict` — the rebase has already been aborted by `rebaseOntoBase`
    // (its own contract; see `pre-push-rebase.ts`). We re-issue the rebase
    // here under our own control so the conflict markers reappear and the
    // inline fix loop can step through them commit-by-commit.
    requiredFix = true;
    const conflictAttempt = await attemptInlineConflictFix({
      worktreePath: opts.worktreePath,
      baseBranch: opts.baseBranch,
      env: opts.env,
      runGit,
      regenLock,
    });
    // Bill one TRIVIAL_RESOLVE unit per inner conflict pass so the budget
    // tracks the real number of resolution rounds, not just the outer
    // attempts. `attemptInlineConflictFix` always reports at least 1 pass
    // (the initial re-rebase) so this stays monotonic.
    const innerSeconds = TRIVIAL_RESOLVE_ACTIVE_SECONDS * Math.max(1, conflictAttempt.innerPasses);
    billedSeconds += innerSeconds;
    stmts.updateFinalizeRunActiveSeconds.run(innerSeconds, opts.runId);

    if (conflictAttempt.kind === 'all-trivial-resolved') {
      // Loop — re-rebase from scratch so the cheap path is taken next.
      continue;
    }

    if (conflictAttempt.kind === 'aborted') {
      return terminate(
        stmts,
        opts.runId,
        'failed',
        'rebase_aborted',
        conflictAttempt.detail,
        billedSeconds,
      );
    }

    // Non-trivial conflict or dirty worktree: dispatch to session, wait
    // for turn-end, retry. Both are session-fixable; only the message
    // body differs.
    setPhase(stmts, broadcast, opts.runId, opts.card.session_id ?? null, 'rebase', 'dispatching');
    conflictsDispatchedCount += 1;
    const sessionId = await resolveSessionIdForRun(stmts, opts);
    if (!sessionId) {
      return terminate(
        stmts,
        opts.runId,
        'failed',
        'rebase_aborted',
        conflictAttempt.kind === 'dirty-worktree'
          ? `worktree has uncommitted changes (${conflictAttempt.files.join(', ')}) and no session is linked to dispatch a fix`
          : 'no session linked to card; cannot dispatch conflict fix',
        billedSeconds,
      );
    }
    const body =
      conflictAttempt.kind === 'dirty-worktree'
        ? buildDirtyWorktreeDispatchMessage(
            conflictAttempt.files,
            opts.baseBranch,
            conflictAttempt.detail,
          )
        : buildConflictDispatchMessage(conflictAttempt.unresolved, opts.baseBranch);
    const dispatchResult = await deps.dispatchAndWaitForTurnEnd({
      sessionId,
      cardId: opts.card.id,
      body,
    });
    if (!dispatchResult.userMessagePersisted) {
      return terminate(
        stmts,
        opts.runId,
        'failed',
        'rebase_aborted',
        'dispatched conflict-fix message was not persisted',
        billedSeconds,
      );
    }
    // Active time spent inside the session's own turn is billed by the
    // orchestrator's session-event hook (phase 2+), not here. We move the
    // status back to `rebasing` so the next outer pass re-enters the
    // rebase path cleanly.
    setPhase(stmts, broadcast, opts.runId, opts.card.session_id ?? null, 'rebase', 'rebasing');
  }

  return terminate(
    stmts,
    opts.runId,
    'failed',
    'rebase_aborted',
    `rebase loop hit MAX_REBASE_PASSES=${MAX_REBASE_PASSES}`,
    billedSeconds,
  );
}

// ─── helpers ─────────────────────────────────────────────────────

function setPhase(
  stmts: RebasePhaseDeps['stmts'],
  broadcast: BroadcastFn,
  runId: string,
  sessionId: string | null,
  phase: FinalizeRunPhase,
  status: FinalizeRunStatus,
): void {
  stmts.updateFinalizeRunPhase.run(phase, status, runId);
  broadcast({
    type: 'finalize_run_phase_changed',
    run_id: runId,
    ...(sessionId ? { session_id: sessionId } : {}),
    phase,
    status,
  });
}

function terminate(
  stmts: RebasePhaseDeps['stmts'],
  runId: string,
  status: 'failed' | 'timed_out',
  reason:
    | 'rebase_aborted'
    | 'timeout'
    | 'unsafe_base_branch'
    | 'no_worktree'
    | 'rebase_dropped_commits',
  detail: string,
  billedSeconds: number,
): RebasePhaseOutcome {
  stmts.failFinalizeRun.run(status, reason, runId);
  return { kind: 'failed', failureReason: reason, detail, activeSecondsBilled: billedSeconds };
}

/**
 * Look up the session linked to the run / card. The orchestrator stores
 * the resolved session on the `finalize_runs` row when it spawns one for
 * a card that had no live session; we honor that first, then fall back to
 * the card's `session_id`.
 */
async function resolveSessionIdForRun(
  stmts: RebasePhaseDeps['stmts'],
  opts: RebasePhaseOptions,
): Promise<string | null> {
  const row = stmts.getFinalizeRun.get(opts.runId) as FinalizeRunRow | undefined;
  if (row?.session_id) return row.session_id;
  if (opts.card.session_id) return opts.card.session_id;
  return null;
}

function defaultRunGit(
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  }).then(({ stdout, stderr }) => ({ stdout, stderr }));
}

type RunGit = NonNullable<RebasePhaseDeps['runGit']>;

interface InlineFixArgs {
  worktreePath: string;
  baseBranch: string;
  env?: NodeJS.ProcessEnv;
  runGit: RunGit;
  regenLock: typeof regenerateLockfile;
}

type InlineFixOutcome =
  | { kind: 'all-trivial-resolved'; innerPasses: number }
  | {
      kind: 'non-trivial';
      unresolved: Array<{ path: string; hunks: ConflictHunk[] }>;
      innerPasses: number;
    }
  | {
      /**
       * `git rebase` refused to start because the worktree has uncommitted
       * changes to tracked files (unstaged or staged). Common in Resolve PR
       * sessions where the agent's last turn left edits uncommitted. The
       * outer driver dispatches a fix-it message into the session and
       * retries instead of failing terminal.
       */
      kind: 'dirty-worktree';
      files: string[];
      detail: string;
      innerPasses: number;
    }
  | { kind: 'aborted'; detail: string; innerPasses: number };

/**
 * Re-attempt the rebase under our own control so we can intercept the
 * conflict mid-flight, apply trivial fixes, run `git rebase --continue`,
 * and **handle each subsequent commit's conflicts in the same call**.
 *
 * Why the per-commit loop matters: `git rebase --continue` replays the
 * next commit in the series, and that replay may itself produce a fresh
 * conflict. Previous implementations exited at the first `--continue`
 * failure, which meant a feature branch with conflicts on more than one
 * commit would always terminate as `rebase_aborted` — even when every
 * conflict along the way was trivial. The inner loop here walks the
 * series until either the rebase finishes, a non-trivial conflict
 * appears (dispatched to the session), or {@link MAX_INNER_CONFLICT_PASSES}
 * is hit.
 *
 * Returns:
 *   - `all-trivial-resolved` when every conflict along the chain was
 *      whitespace / import-order trivial, or a lockfile we regenerated.
 *      Caller loops and re-rebases (the loop invariant — always
 *      re-validate against `origin/<base>` after a fix).
 *   - `non-trivial` with the list of files we declined to touch on the
 *      first commit where mechanical resolution gave up.
 *   - `dirty-worktree` when the rebase never started because tracked
 *      files have uncommitted changes — dispatched to the session like
 *      `non-trivial` so the agent can commit/revert and Finalize retries.
 *   - `aborted` on hard infra-style failures (e.g. `git rebase` itself
 *      crashing, fs read/write errors, the inner cap tripping). The
 *      caller surfaces these as `rebase_aborted`.
 *
 * Every outcome reports `innerPasses` so the outer driver can bill
 * active seconds proportionally.
 */
async function attemptInlineConflictFix(args: InlineFixArgs): Promise<InlineFixOutcome> {
  const { worktreePath, baseBranch, env, runGit, regenLock } = args;

  // Re-trigger the rebase. If it succeeds we are done; otherwise enter
  // the conflict resolution loop. Keep git's actual stderr/stdout from
  // the failure — when the rebase stops with zero conflicted files, that
  // text is the only honest explanation of what happened (dirty tree,
  // untracked collision, paused empty commit, …).
  let rebaseRunning = false;
  let rebaseFailureDetail = '';
  try {
    await runGit(['rebase', '--empty=drop', `origin/${baseBranch}`], {
      cwd: worktreePath,
      env,
      timeoutMs: 120_000,
    });
    // Surprise success — the previous abort left us clean and the
    // re-rebase landed without conflict. The next outer pass will hit
    // `noop`/`rebased` and exit successfully.
    return { kind: 'all-trivial-resolved', innerPasses: 1 };
  } catch (err) {
    rebaseRunning = true;
    rebaseFailureDetail = formatGitError(err);
  }

  let pass = 0;
  while (rebaseRunning && pass < MAX_INNER_CONFLICT_PASSES) {
    pass += 1;
    const list = await listConflictedFiles(runGit, worktreePath, env);
    if (!list.ok) {
      await safeAbort(runGit, worktreePath, env);
      return { kind: 'aborted', detail: list.detail, innerPasses: pass };
    }
    const conflictedFiles = list.files;
    if (conflictedFiles.length === 0) {
      // The rebase exited non-zero but the index has no unmerged paths.
      // Two very different situations land here, and conflating them was
      // the source of the chronic `(possibly an empty commit)` failures on
      // Resolve PR sessions:
      //
      //   1. The rebase NEVER STARTED — `git rebase` refused up front,
      //      most commonly "cannot rebase: You have unstaged changes."
      //      (dirty worktree) or an untracked-file collision. There is no
      //      rebase to abort; the worktree state is the problem.
      //   2. The rebase genuinely STARTED and paused with nothing
      //      unmerged — e.g. an empty commit produced by an auto-fix on a
      //      previous round. Abort and surface; we don't want a silent
      //      `--skip` that drops a commit the session intended to land.
      const inProgress = await isRebaseInProgressInWorktree(worktreePath);
      if (!inProgress) {
        const dirty = await listDirtyTrackedFiles(runGit, worktreePath, env);
        if (dirty.length > 0) {
          // Self-healable: dispatch into the session so the agent commits
          // (or reverts) the leftover edits, then retry the rebase.
          return {
            kind: 'dirty-worktree',
            files: dirty,
            detail: rebaseFailureDetail,
            innerPasses: pass,
          };
        }
        return {
          kind: 'aborted',
          detail: `rebase could not start (worktree reports clean): ${
            rebaseFailureDetail || 'unknown git failure'
          }`,
          innerPasses: pass,
        };
      }
      await safeAbort(runGit, worktreePath, env);
      return {
        kind: 'aborted',
        detail: `rebase paused with no conflicted files (possibly an empty commit)${
          rebaseFailureDetail ? `: ${rebaseFailureDetail}` : ''
        }`,
        innerPasses: pass,
      };
    }

    const unresolved: Array<{ path: string; hunks: ConflictHunk[] }> = [];

    for (const rel of conflictedFiles) {
      const abs = path.join(worktreePath, rel);
      let body = '';
      try {
        body = await fs.readFile(abs, 'utf8');
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await safeAbort(runGit, worktreePath, env);
        return { kind: 'aborted', detail: `failed to read ${rel}: ${detail}`, innerPasses: pass };
      }
      const res: FileResolution = classifyFileResolution(rel, body);
      if (res.kind === 'whitespace' || res.kind === 'import-order') {
        try {
          await fs.writeFile(abs, res.resolvedText ?? body, 'utf8');
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          await safeAbort(runGit, worktreePath, env);
          return {
            kind: 'aborted',
            detail: `failed to write ${rel}: ${detail}`,
            innerPasses: pass,
          };
        }
        await runGit(['add', '--', rel], { cwd: worktreePath, env, timeoutMs: 30_000 });
      } else if (res.kind === 'lockfile') {
        const regen = await regenLock(worktreePath, { env });
        if (!regen.ok) {
          await safeAbort(runGit, worktreePath, env);
          return {
            kind: 'aborted',
            detail: `lockfile regeneration failed for ${rel}: ${regen.detail}`,
            innerPasses: pass,
          };
        }
        await runGit(['add', '--', rel], { cwd: worktreePath, env, timeoutMs: 30_000 });
      } else {
        unresolved.push({ path: rel, hunks: res.unresolved ?? [] });
      }
    }

    if (unresolved.length > 0) {
      // Restore the worktree to pre-rebase state before dispatching — the
      // session agent does its own commits and we don't want them landing
      // on top of half-applied auto-fixes from this round or earlier ones.
      await safeAbort(runGit, worktreePath, env);
      return { kind: 'non-trivial', unresolved, innerPasses: pass };
    }

    // All trivial for this commit — advance the rebase. If `--continue`
    // succeeds, the rebase finished. If it exits non-zero AND there are
    // still conflicted files, the next commit in the series conflicted
    // and we loop to resolve it. Otherwise (non-zero with no conflicts,
    // e.g. "Cannot 'continue': You have unmerged paths" after a manual
    // tree mutation) we surface as aborted.
    try {
      await runGit(['-c', 'core.editor=true', 'rebase', '--continue'], {
        cwd: worktreePath,
        env,
        timeoutMs: 120_000,
      });
      // Rebase finished — every commit replayed cleanly after our fixes.
      rebaseRunning = false;
      return { kind: 'all-trivial-resolved', innerPasses: pass };
    } catch (err) {
      // Probe: did `--continue` produce a fresh conflict on the next
      // commit, or did git fail for a different reason?
      const probe = await listConflictedFiles(runGit, worktreePath, env);
      if (probe.ok && probe.files.length > 0) {
        // Yes — fresh conflict. Loop and resolve.
        continue;
      }
      const detail = err instanceof Error ? err.message : String(err);
      await safeAbort(runGit, worktreePath, env);
      return {
        kind: 'aborted',
        detail: `\`git rebase --continue\` failed with no further conflicts: ${detail}`,
        innerPasses: pass,
      };
    }
  }

  // Inner cap hit — too many conflicts in one rebase attempt. Surface as
  // aborted so the outer driver can give up rather than spin further.
  await safeAbort(runGit, worktreePath, env);
  return {
    kind: 'aborted',
    detail: `inner conflict loop hit MAX_INNER_CONFLICT_PASSES=${MAX_INNER_CONFLICT_PASSES}`,
    innerPasses: pass,
  };
}

/**
 * Read the worktree's currently-conflicted file list. Wrapped so both
 * the initial scan and the `--continue` re-probe use the same code path.
 */
async function listConflictedFiles(
  runGit: RunGit,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ ok: true; files: string[] } | { ok: false; detail: string }> {
  try {
    const { stdout } = await runGit(['diff', '--name-only', '--diff-filter=U'], {
      cwd,
      env,
      timeoutMs: 30_000,
    });
    const files = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    return { ok: true, files };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `failed to list conflicted files: ${detail}` };
  }
}

/**
 * True iff a rebase is actually in progress on disk. Session worktrees are
 * dedicated clones (`.git` is a directory), so probing the two state dirs
 * directly is sufficient — same approach as `isRebaseInProgressOnDisk` in
 * `pre-push-rebase.ts`, async because everything in this module is.
 */
async function isRebaseInProgressInWorktree(worktreePath: string): Promise<boolean> {
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    try {
      await fs.access(path.join(worktreePath, '.git', dir));
      return true;
    } catch {
      /* not present — keep probing */
    }
  }
  return false;
}

/**
 * Uncommitted changes to TRACKED files (unstaged or staged) — exactly the
 * set that makes `git rebase` refuse to start. Untracked files are excluded
 * (`-uno`) because they don't block a rebase unless they collide, and a
 * collision surfaces through git's own stderr instead.
 */
async function listDirtyTrackedFiles(
  runGit: RunGit,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<string[]> {
  try {
    const { stdout } = await runGit(['status', '--porcelain', '--untracked-files=no'], {
      cwd,
      env,
      timeoutMs: 30_000,
    });
    return stdout
      .split('\n')
      .map((l) => l.trimEnd())
      .filter(Boolean)
      .map((l) => l.slice(3));
  } catch {
    // Status failing is itself a sign of a broken worktree — report "not
    // dirty" so the caller falls through to the aborted path with git's
    // original rebase stderr.
    return [];
  }
}

/** Flatten an execFile-style error into `stderr + stdout + message`. */
function formatGitError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const stderrOut =
    typeof (err as { stderr?: unknown })?.stderr === 'string'
      ? ((err as { stderr: string }).stderr as string)
      : '';
  const stdoutOut =
    typeof (err as { stdout?: unknown })?.stdout === 'string'
      ? ((err as { stdout: string }).stdout as string)
      : '';
  return [stderrOut, stdoutOut, msg]
    .map((s) => (s ?? '').toString().trim())
    .filter(Boolean)
    .join('\n');
}

async function safeAbort(runGit: RunGit, cwd: string, env?: NodeJS.ProcessEnv): Promise<void> {
  try {
    await runGit(['rebase', '--abort'], { cwd, env, timeoutMs: 30_000 });
  } catch {
    /* best-effort: nothing to do if abort itself fails */
  }
}

/**
 * Compose the chat message dispatched into the session when conflicts
 * can't be resolved automatically. Plain markdown so it renders in the
 * transcript; structured enough that the agent (or a human reading the
 * thread) can see what we tried.
 *
 * Exported so tests can pin the wording.
 */
export function buildConflictDispatchMessage(
  unresolved: Array<{ path: string; hunks: ConflictHunk[] }>,
  baseBranch: string,
): string {
  const fileBlocks = unresolved.map(({ path: p, hunks }) => {
    const header = `### \`${p}\` (${hunks.length} hunk${hunks.length === 1 ? '' : 's'})`;
    const samples = hunks
      .slice(0, 3)
      .map((h, idx) => {
        const ours = h.ours.join('\n');
        const theirs = h.theirs.join('\n');
        return [
          `**Hunk ${idx + 1}** (lines ${h.start + 1}–${h.end + 1})`,
          '',
          '<<<<<<< OURS (your branch)',
          '```',
          ours,
          '```',
          '=======',
          'THEIRS (from `origin/' + baseBranch + '`)',
          '```',
          theirs,
          '```',
          '>>>>>>>',
        ].join('\n');
      })
      .join('\n\n');
    const more =
      hunks.length > 3 ? `\n\n_…and ${hunks.length - 3} more hunk(s) in this file._` : '';
    return `${header}\n\n${samples}${more}`;
  });

  return [
    `## Finalize Code Changes: rebase conflict needs your eyes`,
    '',
    `I tried to rebase your branch onto \`origin/${baseBranch}\`. Trivial conflicts (whitespace, import order, \`package-lock.json\`) were resolved automatically; the conflicts below are not mechanically resolvable.`,
    '',
    `Please resolve them in this worktree and commit. When your turn ends I'll re-rebase and continue the Finalize pipeline. If you need to back out, leave the conflict markers in place and the run will time out.`,
    '',
    ...fileBlocks,
  ].join('\n');
}

/**
 * Message dispatched into the session when the rebase can't even start
 * because the worktree has uncommitted tracked changes. Exported so tests
 * can pin the wording.
 */
export function buildDirtyWorktreeDispatchMessage(
  files: string[],
  baseBranch: string,
  gitDetail?: string,
): string {
  const fileList = files.map((f) => `- \`${f}\``).join('\n');
  return [
    `## Finalize Code Changes: uncommitted changes are blocking the rebase`,
    '',
    `I need to rebase your branch onto \`origin/${baseBranch}\`, but \`git rebase\` refuses to start because the worktree has uncommitted changes to tracked files:`,
    '',
    fileList,
    '',
    `Please either commit these changes (if they belong in this branch) or revert them (\`git checkout -- <file>\`) if they're leftovers. When your turn ends I'll retry the rebase and continue the Finalize pipeline.`,
    ...(gitDetail ? ['', '```', gitDetail, '```'] : []),
  ].join('\n');
}

export const __test = {
  attemptInlineConflictFix,
  listConflictedFiles,
  listDirtyTrackedFiles,
  isRebaseInProgressInWorktree,
  formatGitError,
  setPhase,
  terminate,
  REBASE_ATTEMPT_ACTIVE_SECONDS,
  TRIVIAL_RESOLVE_ACTIVE_SECONDS,
  MAX_REBASE_PASSES,
  MAX_INNER_CONFLICT_PASSES,
};
