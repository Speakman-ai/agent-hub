/**
 * reviewer-dispatch.ts — Finalize Code Changes, Phase 3 (review phase).
 *
 * Numbering matches §3 of the design doc, where the pipeline runs:
 *   1. rebase   → `server/finalize/rebase.ts`
 *   2. parse    → `.agent-hub/ci.yaml` parser (future card)
 *   3. review   → this file
 *   4. tasks    → step executor (future card)
 *   5. push     → push gate + PR open (future card)
 *
 * Per design (`finalize-code-changes-architecture-v0` §3, §8): once the
 * rebase phase has produced a clean tree on top of `origin/<default>`,
 * a cold-eye reviewer agent runs over the **local diff** in the session's
 * worktree — **before** any GitHub PR exists. The diff is computed
 * locally (`git diff baseSha..headSha` + `git diff --name-only`); no
 * GitHub API is touched in this phase (§11: external-PR-review webhook
 * surface is dormant at v0, and the internal-PR PR object does not even
 * exist yet).
 *
 * Outputs (per §8):
 *   - Zero or more rows in `reviewer_threads` (file_path, line_start,
 *     line_end, body, author = 'reviewer-agent').
 *   - A single top-level verdict written to `finalize_runs.reviewer_verdict`:
 *     `'approved'` or `'changes_requested'`.
 *
 * The dispatch loop is invoked by the orchestrator. The actual reviewer
 * turn (driving the project's reviewer agent identity over the diff
 * inputs) is injected as a {@link RunReviewerOnLocalDiff} dependency so
 * tests can stub the LLM call deterministically — production wires this
 * to the same reviewer agent identity / engine the project already uses
 * for PR reviews (no new agent role per the acceptance contract).
 *
 * Transactional contract: threads + verdict are written inside a single
 * `BEGIN ... COMMIT` so a half-applied review never reaches downstream
 * phases. Per-row `reviewer_thread_added` WebSocket events fire **after**
 * the COMMIT so subscribers never observe phantom threads.
 *
 * Reviewer comments are **also** included verbatim in the fix-dispatch
 * message body composed downstream (per card `490d6c41` — see
 * {@link formatThreadsForDispatchBody} below for the canonical shape).
 * The `reviewer_threads` table is the read-only side-panel store; the
 * dispatch body is what the originating session actually sees.
 *
 * Loop invariant inherited from §3: the review phase runs after every
 * fix dispatch re-enters from rebase. A reviewer verdict produced on
 * one HEAD is stale the moment any commit lands; the push gate (§9) is
 * the only place these signals are trusted to be current.
 */
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import type {
  BroadcastFn,
  FinalizeRunPhase,
  FinalizeRunRow,
  FinalizeRunStatus,
  KanbanCardRow,
  Project,
  ReviewerThreadRow,
  Stmts,
} from '../types.js';
import { SAFE_ARG_STRLEN_BYTES } from '../spawn-prompt-payload.js';
import {
  readFinalizeLoopRound,
  writeFinalizeReviewRoundTimeline,
  type TimelineMessageDeps,
} from './timeline-message.js';

const execFileAsync = promisify(execFile);

/** Active-seconds billed for the review phase, charged once per dispatch. */
export const REVIEW_PHASE_ACTIVE_SECONDS = 30;

/**
 * Maximum number of reviewer threads we accept from a single dispatch.
 * Pathological cases (a reviewer that returns a thread per line) get
 * truncated rather than blowing up the side-panel UI and the dispatch
 * body. The cap is generous; production runs typically produce 0–20.
 */
export const REVIEWER_THREAD_HARD_CAP = 200;

/**
 * Maximum body length per reviewer thread (characters). Anything longer
 * is truncated with a trailing `[…N chars truncated]` marker. Mirrors
 * the GitHub review-comment 65 535-char limit but with enough headroom
 * to keep the dispatch body readable.
 */
export const REVIEWER_THREAD_BODY_LIMIT = 8_000;

/**
 * Bytes reserved inside {@link SAFE_ARG_STRLEN_BYTES} for everything in the
 * prompt that is not the patch body: headers, the severity rubric, the
 * output-format contract, and the partial-input notice (~3 KB measured), plus
 * the changed-file list (bounded by {@link REVIEWER_FILE_LIST_BYTE_BUDGET}).
 * The remainder is slack for the diff's truncation marker and prompt growth.
 *
 * Every component of the prompt must be bounded in BYTES for this reserve to
 * mean anything — a count-only cap on a variable-length section is not a size
 * cap. The worst-case assertions live in reviewer-dispatch.test.ts.
 */
const REVIEWER_PROMPT_RESERVE_BYTES = 20_000;

/** Changed-file names listed before the tail is summarised as a count. */
export const REVIEWER_FILE_LIST_CAP = 200;

/**
 * Byte ceiling for the rendered changed-file list.
 *
 * {@link REVIEWER_FILE_LIST_CAP} alone bounds the file *count*, which is not a
 * bound on size: a path may be up to PATH_MAX (4096 bytes), so 200 of them is
 * ~819 KB — eight times {@link SAFE_ARG_STRLEN_BYTES} on its own, and enough to
 * push the prompt back over the argv cap that {@link REVIEWER_DIFF_BYTE_LIMIT}
 * is derived to stay under. Both limits apply; whichever binds first wins.
 *
 * Sized to fit inside {@link REVIEWER_PROMPT_RESERVE_BYTES} alongside the
 * prompt scaffolding (headers + rubric + output contract + the partial-input
 * notice, ~3 KB measured), leaving ~5 KB of slack for the diff's truncation
 * marker and future prompt growth.
 */
export const REVIEWER_FILE_LIST_BYTE_BUDGET = 12_000;

/**
 * Byte ceiling for the unified diff embedded in the reviewer prompt.
 *
 * Derived from the argv cap rather than picked freely, because the reviewer's
 * **user** prompt is passed as a positional argv argument on every engine and
 * re-trimmed by `applyArgvPromptCap` (`session-multi-engine.ts`). That trim
 * keeps the *tail* and drops the head, so an over-budget prompt loses its
 * headers, its file list, and the truncation notice below — and what survives
 * is a raw byte slice with severed hunks. Budgeting under the cap here keeps
 * that second trim from ever firing, so the reviewer receives whole file
 * patches plus an explicit statement of what was left out.
 *
 * Truncation is at whole-file-patch boundaries so every hunk the reviewer does
 * see is syntactically complete. Silently feeding a partial diff is the failure
 * this bounds.
 */
export const REVIEWER_DIFF_BYTE_LIMIT = SAFE_ARG_STRLEN_BYTES - REVIEWER_PROMPT_RESERVE_BYTES;

/**
 * Buffer ceiling for the `git diff` spawn itself, deliberately far above
 * {@link REVIEWER_DIFF_BYTE_LIMIT} so ordinary-large changesets are captured
 * whole and trimmed here rather than killing git with
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`. That overflow used to reject out of
 * `collectLocalDiffInputs` and surface as `no_diff_inputs`, whose UI copy
 * claims "There were no code changes" — the opposite of the truth on the
 * 325-file session that reported this. Mirrors the 32 MB precedent in
 * `session-changes.ts`, with headroom for reformat-scale diffs.
 */
const DIFF_SPAWN_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Reviewer's verdict — the same domain as `finalize_runs.reviewer_verdict`.
 */
export type ReviewerVerdict = 'approved' | 'changes_requested';

/**
 * One finding the reviewer agent produced about the local diff.
 *
 * Coordinates are relative to the **head** revision of the file (the
 * post-rebase state in the session's worktree). The reviewer renders
 * line numbers from there, so the side-panel anchors stay valid even
 * if upstream lines shift around in `baseSha`.
 *
 * `line_end` is optional; when omitted the comment is treated as a
 * single-line note anchored at `line_start`. Both can be null for a
 * file-level comment (a general note about `file_path` with no line
 * anchor).
 */
export interface ReviewerThreadInput {
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  body: string;
}

/**
 * Inputs the reviewer driver consumes. The orchestrator computes these
 * **locally** before calling {@link runReviewerDispatch}:
 *
 *   - `baseSha`: tip of `origin/<default>` after the rebase phase.
 *   - `headSha`: worktree HEAD.
 *   - `changedFiles`: `git diff --name-only baseSha..headSha`.
 *   - `unifiedDiff`: `git diff baseSha..headSha` — the patch body.
 *
 * Everything here is plain text. No GitHub API calls are performed by
 * the dispatch path or its caller; the orchestrator passes the
 * already-computed strings through.
 */
export interface ReviewerLocalDiffInputs {
  baseSha: string;
  headSha: string;
  changedFiles: string[];
  unifiedDiff: string;
  /**
   * File patches dropped to fit {@link REVIEWER_DIFF_BYTE_LIMIT}. Zero/absent
   * when the whole diff fit. Rendered into the prompt so the reviewer knows
   * its view is partial instead of approving unseen code.
   */
  omittedFileCount?: number;
  /**
   * True when the patch body could not be captured at all and `unifiedDiff`
   * holds a `--stat` summary instead. The review still runs — a large
   * changeset must never be reported as having no changes.
   */
  diffDegraded?: boolean;
  /**
   * True when a single patch exceeded the whole budget and was cut mid-file.
   * Tracked separately from {@link omittedFileCount} because such a file is
   * partly shown rather than omitted, and a lone oversized patch would
   * otherwise report zero omissions and disclose nothing.
   */
  severedPatch?: boolean;
  /**
   * True when the changed-file list could not be read. Distinguishes "the list
   * is unavailable" from "the change set is empty" so the prompt never claims
   * the latter on a session that is full of changes.
   */
  fileListUnavailable?: boolean;
}

/**
 * Result the {@link RunReviewerOnLocalDiff} driver returns to the
 * dispatch loop. Threads may be empty (an `approved` verdict with no
 * blocking notes is fine). The driver is responsible for severity
 * scoring; `verdict` is the final summary signal.
 */
export interface ReviewerRunResult {
  verdict: ReviewerVerdict;
  threads: ReviewerThreadInput[];
  /** Optional active-seconds the reviewer's turn actually consumed; defaults to REVIEW_PHASE_ACTIVE_SECONDS. */
  activeSecondsBilled?: number;
}

/**
 * Mirror of {@link CancelSignal} from `./fix-dispatch.js` — repeated
 * inline to avoid a circular import. Stays in lockstep with the canonical
 * shape; a richer signal (full AbortSignal) is a structural superset.
 */
export interface ReviewerCancelSignal {
  readonly aborted: boolean;
  onAbort(listener: () => void): () => void;
}

/**
 * Driver type: takes the local-diff inputs + context, returns the
 * reviewer's verdict and (zero or more) findings. Production wires this
 * to the project's reviewer agent identity over a session that consumes
 * a local-diff prompt; tests inject a fake that resolves synchronously
 * to a fixed result.
 *
 * `sessionId` is the originating session the orchestrator is driving —
 * the in-session reviewer driver attaches the reviewer agent there and
 * surfaces its turn in the session timeline. Optional for backwards
 * compatibility: legacy out-of-band drivers (and unit-test stubs) may
 * ignore it.
 *
 * `signal` plumbs the orchestrator's cancel signal through so a mid-
 * review Finalize cancel kills the reviewer CLI cleanly. The dispatch
 * helper itself does not inject a signal; production wires this at the
 * orchestrator's call site.
 */
export type RunReviewerOnLocalDiff = (args: {
  runId: string;
  worktreePath: string;
  card: KanbanCardRow;
  project: Project;
  inputs: ReviewerLocalDiffInputs;
  sessionId?: string | null;
  signal?: ReviewerCancelSignal;
}) => Promise<ReviewerRunResult>;

export interface ReviewerDispatchDeps {
  stmts: Pick<
    Stmts,
    | 'getFinalizeRun'
    | 'updateFinalizeRunPhase'
    | 'updateFinalizeRunActiveSeconds'
    | 'updateFinalizeRunReviewerVerdict'
    | 'insertReviewerThread'
    | 'deleteReviewerThreadsForRun'
    | 'failFinalizeRun'
    | 'addMessage'
    | 'touchSession'
    | 'getMessageById'
  >;
  broadcast: BroadcastFn;
  /** The reviewer driver. See {@link RunReviewerOnLocalDiff}. */
  runReviewer: RunReviewerOnLocalDiff;
  /**
   * Optional sqlite transaction wrapper. Production threads the
   * `better-sqlite3` `db.transaction(...)` helper through here so the
   * thread inserts + verdict update commit atomically; tests inject a
   * synchronous identity wrapper (the prepared-statement stubs hold the
   * fakes in-memory).
   */
  transactional?: <T>(fn: () => T) => T;
  /**
   * Optional spawn override for git invocations (the local-diff
   * collector below). Tests swap this with a stub; production lets it
   * fall through to `execFile`.
   */
  runGit?: (
    args: string[],
    opts: {
      cwd: string;
      timeoutMs: number;
      env?: NodeJS.ProcessEnv;
      /** Per-call stdout ceiling; only the diff body needs the large one. */
      maxBufferBytes?: number;
    },
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Deterministic clock injection for `created_at` timestamps. */
  now?: () => number;
  /** Deterministic id generator injection. */
  newId?: () => string;
}

export interface ReviewerDispatchOptions {
  /** finalize_runs.id. */
  runId: string;
  /** The session's worktree path. Pre-resolved upstream. */
  worktreePath: string;
  /**
   * Optional pre-computed local-diff inputs. Production usually omits
   * this so {@link collectLocalDiffInputs} runs against the worktree;
   * tests pass deterministic strings to bypass the git spawn entirely.
   */
  inputs?: ReviewerLocalDiffInputs;
  /** Default branch on origin (e.g. 'main'). Needed when `inputs` is omitted. */
  baseBranch?: string;
  /** Env to inject so git commands respect any per-session credentials. */
  env?: NodeJS.ProcessEnv;
  /** The kanban card the run is anchored to. */
  card: KanbanCardRow;
  /** The project the card belongs to. */
  project: Project;
  /**
   * Originating session id — threaded into the reviewer driver so the
   * in-session driver can attach the reviewer agent and persist its
   * turn into the chat timeline. Optional: legacy out-of-band drivers
   * ignore it.
   */
  sessionId?: string | null;
  /**
   * Cancellation signal — threaded into the reviewer driver so a Finalize
   * cancel mid-review kills the reviewer turn cleanly. Optional.
   */
  signal?: ReviewerCancelSignal;
}

/**
 * Outcome of a reviewer dispatch. `kind: 'success'` carries the verdict
 * + thread count so the orchestrator can decide whether to advance to
 * the tasks phase or dispatch a fix back into the originating session.
 */
export type ReviewerDispatchOutcome =
  | {
      kind: 'success';
      verdict: ReviewerVerdict;
      threadCount: number;
      activeSecondsBilled: number;
    }
  | {
      kind: 'failed';
      failureReason: 'review_failed' | 'no_worktree' | 'no_diff_inputs';
      detail: string;
      activeSecondsBilled: number;
    };

/**
 * Run the review phase end-to-end. Caller is responsible for having
 * already INSERTed the `finalize_runs` row and run the rebase phase to
 * completion — `runReviewerDispatch` only mutates the row + the
 * `reviewer_threads` rows tied to it.
 */
export async function runReviewerDispatch(
  deps: ReviewerDispatchDeps,
  opts: ReviewerDispatchOptions,
): Promise<ReviewerDispatchOutcome> {
  const { stmts, broadcast } = deps;
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => randomUUID());
  const runGit = deps.runGit ?? defaultRunGit;
  const transactional = deps.transactional ?? defaultTransactional;

  if (!opts.worktreePath) {
    // Pre-setPhase guard rail. We still emit a phase-change event so a
    // UI subscriber that joined before this call observes the terminal
    // status (it would otherwise see no event at all for this run).
    return terminate(
      stmts,
      broadcast,
      opts.runId,
      opts.sessionId ?? null,
      'no_worktree',
      'worktree path missing',
      0,
    );
  }

  // Phase change is published BEFORE the (potentially slow) reviewer
  // turn so the UI's checks panel can render the spinner row.
  setPhase(stmts, broadcast, opts.runId, opts.sessionId ?? null, 'review', 'reviewing');

  // Resolve local-diff inputs. Tests pass them pre-computed; production
  // collects them from the worktree.
  let inputs: ReviewerLocalDiffInputs;
  if (opts.inputs) {
    inputs = opts.inputs;
  } else {
    if (!opts.baseBranch) {
      return terminate(
        stmts,
        broadcast,
        opts.runId,
        opts.sessionId ?? null,
        'no_diff_inputs',
        'baseBranch required when inputs not pre-computed',
        0,
      );
    }
    try {
      inputs = await collectLocalDiffInputs({
        worktreePath: opts.worktreePath,
        baseBranch: opts.baseBranch,
        env: opts.env,
        runGit,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return terminate(
        stmts,
        broadcast,
        opts.runId,
        opts.sessionId ?? null,
        'no_diff_inputs',
        `git diff failed: ${msg}`,
        0,
      );
    }
  }

  // Run the reviewer agent. Driver may throw on engine-level failures;
  // we surface those as `review_failed` so the orchestrator can decide
  // whether to retry or terminate.
  let result: ReviewerRunResult;
  try {
    result = await deps.runReviewer({
      runId: opts.runId,
      worktreePath: opts.worktreePath,
      card: opts.card,
      project: opts.project,
      inputs,
      sessionId: opts.sessionId ?? null,
      signal: opts.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    clearReviewerStateForFailedPass(stmts, opts.runId);
    return terminate(
      stmts,
      broadcast,
      opts.runId,
      opts.sessionId ?? null,
      'review_failed',
      `reviewer agent failed: ${msg}`,
      0,
    );
  }

  // Sanitise + cap inputs from the driver. Truncation is silent so a
  // misbehaving reviewer does not break the dispatch path.
  const sanitised = sanitiseThreads(result.threads);
  const billed = Math.max(1, Math.floor(result.activeSecondsBilled ?? REVIEW_PHASE_ACTIVE_SECONDS));

  // Persist threads + verdict atomically. Wipe any prior threads tied
  // to this run first — a re-entry of the review phase after a fix
  // dispatch should reflect the **current** reviewer pass, not stack
  // findings across iterations.
  const insertedRows: ReviewerThreadRow[] = transactional(() => {
    stmts.deleteReviewerThreadsForRun.run(opts.runId);
    const created = now();
    const rows: ReviewerThreadRow[] = [];
    for (const t of sanitised) {
      const id = newId();
      stmts.insertReviewerThread.run(
        id,
        opts.runId,
        t.file_path,
        t.line_start,
        t.line_end,
        t.body,
        'reviewer-agent',
        created,
      );
      rows.push({
        id,
        run_id: opts.runId,
        file_path: t.file_path,
        line_start: t.line_start,
        line_end: t.line_end,
        body: t.body,
        author: 'reviewer-agent',
        created_at: created,
      });
    }
    stmts.updateFinalizeRunReviewerVerdict.run(result.verdict, opts.runId);
    return rows;
  });

  // Active-seconds is billed outside the transaction so a fail-fast
  // commit doesn't double-count on retry. The orchestrator's budget
  // enforcer rolls this up against the 60-minute cap (§13).
  stmts.updateFinalizeRunActiveSeconds.run(billed, opts.runId);

  // Per-row events fire **after** the commit so subscribers never
  // observe a thread that doesn't exist yet on a read-back.
  for (const row of insertedRows) {
    broadcast({
      type: 'reviewer_thread_added',
      run_id: opts.runId,
      thread_id: row.id,
      file_path: row.file_path,
      line_start: row.line_start,
    });
  }

  const runRow = stmts.getFinalizeRun.get(opts.runId) as FinalizeRunRow | undefined;
  writeFinalizeReviewRoundTimeline(reviewerTimelineDeps(deps), {
    sessionId: opts.sessionId,
    runId: opts.runId,
    round: readFinalizeLoopRound(runRow),
    verdict: result.verdict,
    threads: insertedRows.map((row) => ({
      id: row.id,
      file_path: row.file_path,
      line_start: row.line_start,
      line_end: row.line_end,
      body: row.body,
    })),
  });

  return {
    kind: 'success',
    verdict: result.verdict,
    threadCount: insertedRows.length,
    activeSecondsBilled: billed,
  };
}

function clearReviewerStateForFailedPass(
  stmts: Pick<
    ReviewerDispatchDeps['stmts'],
    'deleteReviewerThreadsForRun' | 'updateFinalizeRunReviewerVerdict'
  >,
  runId: string,
): void {
  try {
    stmts.deleteReviewerThreadsForRun.run(runId);
  } catch {
    /* best-effort: terminal failure write below is more important */
  }
  try {
    stmts.updateFinalizeRunReviewerVerdict.run(null, runId);
  } catch {
    /* best-effort: terminal failure write below is more important */
  }
}

// ─── helpers ─────────────────────────────────────────────────────

function reviewerTimelineDeps(deps: ReviewerDispatchDeps): TimelineMessageDeps {
  return { stmts: deps.stmts, broadcast: deps.broadcast };
}

function setPhase(
  stmts: ReviewerDispatchDeps['stmts'],
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
  stmts: ReviewerDispatchDeps['stmts'],
  broadcast: BroadcastFn,
  runId: string,
  sessionId: string | null,
  reason: 'review_failed' | 'no_worktree' | 'no_diff_inputs',
  detail: string,
  billedSeconds: number,
): ReviewerDispatchOutcome {
  stmts.failFinalizeRun.run('failed', reason, runId);
  // Emit a terminal phase event so any subscriber that received the
  // earlier `{ status: 'reviewing' }` event sees the corresponding
  // failure transition and clears the spinner row. Without this, the
  // UI's checks panel would hang on `reviewing` forever for any
  // dispatch that bailed after the initial setPhase call.
  broadcast({
    type: 'finalize_run_phase_changed',
    run_id: runId,
    ...(sessionId ? { session_id: sessionId } : {}),
    phase: 'review',
    status: 'failed',
    failure_reason: reason,
  });
  return { kind: 'failed', failureReason: reason, detail, activeSecondsBilled: billedSeconds };
}

function defaultRunGit(
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv; maxBufferBytes?: number },
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeoutMs,
    maxBuffer: opts.maxBufferBytes ?? 10 * 1024 * 1024,
  }).then(({ stdout, stderr }) => ({ stdout, stderr }));
}

function defaultTransactional<T>(_fn: () => T): T {
  // The module's transactional contract (threads + verdict written in a
  // single BEGIN..COMMIT, see file header) is only honoured when the
  // caller injects a real transaction wrapper — typically
  // `db.transaction(...)` from `better-sqlite3`. We refuse to run the
  // body inline because a silent fallback would leave a crash between
  // `insertReviewerThread` and `updateFinalizeRunReviewerVerdict` with
  // either dangling threads or a verdict with no findings. Production
  // callers must wire `transactional` explicitly; tests pass an
  // identity wrapper because their FakeStmts are already deterministic.
  throw new Error(
    "reviewer-dispatch: 'transactional' dep is required — inject db.transaction(...) " +
      'from better-sqlite3 (or an identity wrapper in tests).',
  );
}

interface CollectDiffArgs {
  worktreePath: string;
  baseBranch: string;
  env?: NodeJS.ProcessEnv;
  runGit: NonNullable<ReviewerDispatchDeps['runGit']>;
}

/**
 * Collect base/head SHAs, the list of changed files, and the unified
 * diff body for the worktree's current HEAD vs. `origin/<baseBranch>`.
 * Fully local — no GitHub API.
 *
 * Exported for tests; the production path threads through {@link runReviewerDispatch}.
 */
export async function collectLocalDiffInputs(
  args: CollectDiffArgs,
): Promise<ReviewerLocalDiffInputs> {
  const { worktreePath, baseBranch, env, runGit } = args;
  const spawnOpts = { cwd: worktreePath, env, timeoutMs: 60_000 };

  // Resolve SHAs first so the diff is anchored to immutable refs.
  const baseRefRes = await runGit(['rev-parse', `origin/${baseBranch}`], spawnOpts);
  const headRefRes = await runGit(['rev-parse', 'HEAD'], spawnOpts);
  const baseSha = baseRefRes.stdout.trim();
  const headSha = headRefRes.stdout.trim();

  if (!baseSha || !headSha) {
    throw new Error(`failed to resolve base/head SHA (base=${baseSha}, head=${headSha})`);
  }

  // File list + unified diff. We use `baseSha..headSha` (two-dot) so
  // the diff reflects what's actually on the feature branch relative
  // to the rebase target — three-dot would include changes on base
  // that we don't own and would pollute the reviewer's view.
  //
  // The file list scales with the change set too, so it gets the same large
  // buffer and the same never-fatal handling as the patch body below. Under the
  // default buffer a pathological path count could overflow here and throw
  // *before* the patch fallback ever ran, reintroducing `no_diff_inputs` on the
  // exact input this function exists to survive.
  let changedFiles: string[] = [];
  let fileListUnavailable = false;
  try {
    const filesRes = await runGit(['diff', '--name-only', `${baseSha}..${headSha}`], {
      ...spawnOpts,
      maxBufferBytes: DIFF_SPAWN_MAX_BUFFER,
    });
    changedFiles = filesRes.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    fileListUnavailable = true;
  }

  // The patch body is the only unbounded input here, and its failure modes all
  // scale with change-set size. Capture it under a large buffer, then trim to
  // the prompt budget. Every failure degrades to a `--stat` summary rather than
  // propagating: a throw here becomes `no_diff_inputs`, which the UI reports as
  // "There were no code changes" — the worst possible answer for a session with
  // hundreds of changed files.
  let unifiedDiff = '';
  let omittedFileCount = 0;
  let severedPatch = false;
  let diffDegraded = false;
  try {
    const diffRes = await runGit(['diff', `${baseSha}..${headSha}`], {
      ...spawnOpts,
      maxBufferBytes: DIFF_SPAWN_MAX_BUFFER,
    });
    const trimmed = truncateDiffAtFileBoundary(diffRes.stdout);
    unifiedDiff = trimmed.diff;
    omittedFileCount = trimmed.omittedFileCount;
    severedPatch = trimmed.severedPatch;
  } catch {
    diffDegraded = true;
    try {
      const statRes = await runGit(['diff', '--stat', `${baseSha}..${headSha}`], {
        ...spawnOpts,
        maxBufferBytes: DIFF_SPAWN_MAX_BUFFER,
      });
      unifiedDiff = truncateDiffAtFileBoundary(statRes.stdout).diff;
    } catch {
      // Both the patch and the stat were unreadable. The SHAs already resolved
      // above, so the refs are sound and this is a size/transient problem —
      // hand the reviewer the file list it already has rather than killing the
      // run.
      unifiedDiff = '';
    }
  }

  return {
    baseSha,
    headSha,
    changedFiles,
    unifiedDiff,
    omittedFileCount,
    severedPatch,
    diffDegraded,
    fileListUnavailable,
  };
}

/**
 * Trim a unified diff to `limit` bytes on whole-file-patch boundaries.
 *
 * Cutting at a raw byte offset would hand the reviewer a half-written hunk and
 * invite findings anchored to lines that do not exist. Splitting on `diff --git`
 * headers keeps every retained patch complete, and the caller reports the
 * dropped count so the prompt can say what was not reviewed.
 *
 * A single file patch larger than the whole budget is the one case where a
 * clean boundary does not exist; it is byte-clipped so the reviewer still sees
 * the head of that file rather than nothing at all. That case is reported
 * separately as `severedPatch` — it is NOT an omission (the file is partly
 * shown), and conflating the two would let a mid-file cut pass with no
 * disclosure whenever it is the only patch.
 *
 * Exported for tests.
 */
/**
 * Clip a string to at most `limit` **UTF-8 bytes**, never splitting a character.
 *
 * `String.prototype.slice` counts UTF-16 code units, so on non-ASCII content
 * (any diff touching CJK, emoji, or accented text) it can emit up to 3-4x
 * `limit` bytes and can cut a surrogate pair in half. Both matter here: the
 * byte budget exists precisely to keep the prompt under the engine argv cap, so
 * overshooting it re-triggers the head-dropping trim this function exists to
 * prevent, and a severed code point corrupts the patch text the reviewer
 * anchors findings to.
 */
function clipToUtf8Bytes(s: string, limit: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= limit) return s;
  // Walk back off any UTF-8 continuation byte (0b10xxxxxx) so the cut lands on
  // a character boundary and the decode can't produce a replacement char.
  let end = limit;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Render the changed-file list bounded by BOTH
 * {@link REVIEWER_FILE_LIST_CAP} (count) and
 * {@link REVIEWER_FILE_LIST_BYTE_BUDGET} (UTF-8 bytes), summarising whatever
 * did not fit as a trailing count. The byte bound is the load-bearing one:
 * path lengths are attacker-shaped in the sense that nothing in the repo
 * constrains them, so a count-only cap is not a size cap.
 *
 * Exported for tests.
 */
/** Trailing "…and N more" line summarising paths that did not fit. */
function renderFileListSuffix(unlisted: number): string {
  return `\n- …and ${unlisted} more file(s) not listed here.`;
}

/** Fallback when not even one path fits the budget. */
function renderFileListOverflowNotice(total: number): string {
  return `- …${total} file(s), paths too long to list here.`;
}

/**
 * Bytes reserved for {@link renderFileListSuffix}, derived from a worst-case
 * render rather than hardcoded so rewording the suffix cannot push the list
 * past its budget.
 */
const FILE_LIST_SUFFIX_RESERVE_BYTES = Buffer.byteLength(
  renderFileListSuffix(Number.MAX_SAFE_INTEGER),
  'utf8',
);

export function renderChangedFileList(
  files: string[],
  opts: { countCap?: number; byteBudget?: number } = {},
): string {
  if (files.length === 0) return '_(no files changed)_';
  const countCap = opts.countCap ?? REVIEWER_FILE_LIST_CAP;
  const byteBudget = opts.byteBudget ?? REVIEWER_FILE_LIST_BYTE_BUDGET;

  // Paths are budgeted against the byte budget MINUS the "…and N more" suffix,
  // because that suffix is appended after the loop. Without the reservation a
  // path landing near the boundary is accepted, the suffix is appended anyway,
  // and the result exceeds the budget it advertises — the same defect the diff
  // truncation marker had.
  const contentBudget = Math.max(0, byteBudget - FILE_LIST_SUFFIX_RESERVE_BYTES);
  const lines: string[] = [];
  let used = 0;
  for (const f of files) {
    if (lines.length >= countCap) break;
    const line = `- ${f}`;
    const size = Buffer.byteLength(line, 'utf8') + 1; // + newline
    if (used + size > contentBudget) break;
    lines.push(line);
    used += size;
  }

  // Degenerate case: even one path blew the budget. Still report the count so
  // the reviewer knows the change set is non-empty. Clipped so the contract
  // holds even for a budget smaller than the notice.
  if (lines.length === 0) {
    return clipToUtf8Bytes(renderFileListOverflowNotice(files.length), byteBudget);
  }

  const unlisted = files.length - lines.length;
  return lines.join('\n') + (unlisted > 0 ? renderFileListSuffix(unlisted) : '');
}

/** The `[diff truncated …]` footer appended to a trimmed diff. */
function renderDiffTruncationMarker(
  limit: number,
  omittedFileCount: number,
  severedPatch: boolean,
): string {
  const completeness = severedPatch
    ? 'the LAST patch shown is cut off mid-file and is INCOMPLETE'
    : 'every patch shown above is complete';
  return (
    `\n[diff truncated to fit the reviewer's ${limit}-byte budget: ` +
    `${omittedFileCount} file patch(es) omitted, and ${completeness}; ` +
    `the full changed-file list is in "Changed files".]\n`
  );
}

/**
 * Bytes the truncation marker may consume, derived from a worst-case render of
 * the marker itself rather than hardcoded, so rewording the footer can never
 * silently push the result past `limit`.
 *
 * The patch content is budgeted against `limit` MINUS this, because the marker
 * is appended after clipping: without the reservation the returned string
 * exceeds the very budget it advertises, and the whole point of that budget is
 * that `applyArgvPromptCap` never has to re-trim the prompt.
 */
export const DIFF_MARKER_RESERVE_BYTES = Buffer.byteLength(
  renderDiffTruncationMarker(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true),
  'utf8',
);

export function truncateDiffAtFileBoundary(
  diff: string,
  limit: number = REVIEWER_DIFF_BYTE_LIMIT,
): { diff: string; omittedFileCount: number; severedPatch: boolean } {
  if (Buffer.byteLength(diff, 'utf8') <= limit)
    return { diff, omittedFileCount: 0, severedPatch: false };

  // Content is budgeted against the limit MINUS the marker that gets appended
  // below, so the returned string honours `limit` rather than overshooting it
  // by the footer's length.
  const contentBudget = Math.max(0, limit - DIFF_MARKER_RESERVE_BYTES);
  const sections = diff.split(/(?=^diff --git )/m).filter((s) => s.length > 0);
  const kept: string[] = [];
  let used = 0;
  let omittedFileCount = 0;
  let severedPatch = false;

  for (const section of sections) {
    const size = Buffer.byteLength(section, 'utf8');
    if (used + size <= contentBudget) {
      kept.push(section);
      used += size;
    } else {
      omittedFileCount += 1;
    }
  }

  if (kept.length === 0) {
    // One oversized patch (a lockfile, a vendored blob). Clip it so the
    // reviewer gets the beginning instead of an empty diff, and flag that the
    // patch shown is cut mid-content so the disclosure below fires even when it
    // is the only file in the change set.
    const head = sections[0] ?? diff;
    kept.push(clipToUtf8Bytes(head, contentBudget));
    severedPatch = true;
    omittedFileCount = Math.max(0, sections.length - 1);
  }

  return {
    diff: kept.join('') + renderDiffTruncationMarker(limit, omittedFileCount, severedPatch),
    omittedFileCount,
    severedPatch,
  };
}

function sanitiseThreads(threads: ReviewerThreadInput[]): ReviewerThreadInput[] {
  const out: ReviewerThreadInput[] = [];
  for (const t of threads.slice(0, REVIEWER_THREAD_HARD_CAP)) {
    const filePath = (t.file_path ?? '').toString().trim();
    if (!filePath) continue;
    const body = (t.body ?? '').toString();
    if (!body.trim()) continue;
    out.push({
      file_path: filePath,
      line_start: coerceLine(t.line_start),
      line_end: coerceLine(t.line_end),
      body: truncateBody(body),
    });
  }
  return out;
}

function coerceLine(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
}

function truncateBody(body: string): string {
  if (body.length <= REVIEWER_THREAD_BODY_LIMIT) return body;
  const head = body.slice(0, REVIEWER_THREAD_BODY_LIMIT);
  const removed = body.length - REVIEWER_THREAD_BODY_LIMIT;
  return `${head}\n\n[…${removed} chars truncated]`;
}

/**
 * Render reviewer threads as the verbatim block included in the fix-
 * dispatch message body (per design doc §7 + card `490d6c41`). The
 * orchestrator concatenates this with the failed-step output tail to
 * build the final message it injects into the originating session.
 *
 * Exposed as a pure function so the dispatch path and unit tests share
 * the same formatting.
 */
export function formatThreadsForDispatchBody(threads: ReviewerThreadRow[]): string {
  if (threads.length === 0) return '';
  const lines: string[] = ['Reviewer notes:'];
  for (const t of threads) {
    const anchor = renderAnchor(t);
    lines.push(`- ${t.file_path}${anchor} — ${t.body}`);
  }
  return lines.join('\n');
}

function renderAnchor(t: Pick<ReviewerThreadRow, 'line_start' | 'line_end'>): string {
  if (t.line_start === null) return '';
  if (t.line_end === null || t.line_end === t.line_start) return `:${t.line_start}`;
  return `:${t.line_start}-${t.line_end}`;
}

/**
 * Build the prompt the reviewer agent consumes for a single local-diff
 * review pass. The reviewer's job is to read the diff, identify
 * severity-rated findings, and return:
 *
 *   1. A verdict (`approved` | `changes_requested`).
 *   2. Zero or more anchored findings.
 *
 * The prompt is pure — no I/O — so it stays unit-testable. Production
 * wires it as the system-message body for the reviewer agent's session;
 * tests assert on its substrings rather than running an LLM.
 *
 * The prompt explicitly forbids GitHub API calls (the PR does not exist
 * yet) and instructs the reviewer to use only the inputs provided. The
 * severity rubric mirrors the PR-review path so a reviewer can't drift
 * scoring between internal local-diff review and post-PR review.
 */
export function buildLocalDiffReviewerPrompt(args: {
  inputs: ReviewerLocalDiffInputs;
  card: KanbanCardRow;
  project: Project;
}): string {
  const { inputs, card, project } = args;
  const fileList = inputs.fileListUnavailable
    ? '_(the changed-file list could not be read — see the diff below)_'
    : renderChangedFileList(inputs.changedFiles);

  // A partial diff must be stated, not implied. Without this the reviewer reads
  // a trimmed patch as the whole change and can approve code it never saw. A
  // severed patch counts as partial even when nothing was omitted — a lone
  // oversized file is cut mid-content and is the easiest case to miss.
  const omitted = inputs.omittedFileCount ?? 0;
  const coverageNotice = inputs.diffDegraded
    ? `\n> **Partial input.** The patch body for this change set was too large to\n` +
      `> capture, so the section below is a per-file summary rather than the full\n` +
      `> diff. Review what is visible, and say so in your summary — do not treat\n` +
      `> the absence of visible problems as evidence the change is clean.\n`
    : inputs.severedPatch
      ? `\n> **Partial input.** The diff exceeded the size budget and the last patch\n` +
        `> shown is cut off mid-file, so you are seeing an incomplete version of\n` +
        `> that file${omitted > 0 ? `, with ${omitted} further file patch(es) omitted` : ''}.\n` +
        `> Do not treat it as fully reviewed, and say so in your summary.\n`
      : omitted > 0
        ? `\n> **Partial input.** ${omitted} file patch(es) were omitted\n` +
          `> to fit the size budget; the patches shown are complete but do not cover\n` +
          `> every changed file. Scope your findings to what is visible and note the\n` +
          `> omission in your summary.\n`
        : '';

  return `# Pre-PR Code Review (Local Diff)
${coverageNotice}

You are reviewing the **local diff** of a feature branch in the session's
worktree for project \`${project.id}\` (${project.name ?? ''}), card
\`${card.id}\` — "${card.title ?? ''}".

**No GitHub PR exists yet.** Do NOT call \`gh\`, the GitHub API, or any
HTTP endpoint to fetch PR data — there is nothing to fetch. The diff
below is the complete input.

## Diff inputs

- **Base SHA**: \`${inputs.baseSha}\` (tip of \`origin/<default>\` after rebase)
- **Head SHA**: \`${inputs.headSha}\` (worktree HEAD)
- **Changed files** (${inputs.changedFiles.length}):

${fileList}

## Unified diff

\`\`\`diff
${inputs.unifiedDiff}
\`\`\`

## Your task

1. Read the diff in full.
2. For every issue you find, assign a **severity score from 1 to 10**.
3. Anchor each finding to a specific file + line range in the **head**
   revision (post-rebase line numbers — the diff shows them on the right
   side of each hunk).

### Severity rubric (1–10)

- **1–2**: pure nit — whitespace, naming preference, wording in a comment.
- **3**: minor polish — small refactor opportunity, redundant code.
- **4–5**: real issue — missing test for non-trivial new logic, unclear
  error handling, convention violation that will propagate.
- **6–7**: correctness concern — likely bug in an edge case, weak input
  validation, brittle assumption, subtle race.
- **8–9**: serious defect — reproducible bug on the happy path, real
  security hole, data-loss risk, breaking API change.
- **10**: showstopper — production will be down, credentials leaked,
  destructive migration.

### Verdict decision tree

Walk in order, take the first match:

1. **Any finding scores > 3?** → verdict = \`changes_requested\`.
2. **Otherwise** → verdict = \`approved\`. (Non-blocking notes ≤ 3 are
   still included in the findings list.)

When in doubt about a score, **round up, not down.** Under-scoring to
avoid blocking is the failure mode this rubric exists to prevent.

## Output contract

Return your result as a single JSON object — no prose around it:

\`\`\`json
{
  "verdict": "approved" | "changes_requested",
  "threads": [
    {
      "file_path": "server/foo.ts",
      "line_start": 42,
      "line_end": 45,
      "body": "**[6/10]** Race on \`config.bin\` — overlapping writes from heartbeat + cron will interleave."
    }
  ]
}
\`\`\`

- \`threads\` may be empty when there is genuinely nothing worth noting.
- \`line_start\` / \`line_end\` may be \`null\` for a file-level comment.
- Prefix every \`body\` with \`**[N/10]**\` (the severity score) so the
  side-panel UI can sort and filter.

The host parses this JSON, persists each thread to \`reviewer_threads\`,
and uses the verdict to gate the next phase. Anything outside the JSON
block is discarded.`;
}
