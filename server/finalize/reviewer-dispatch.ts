/**
 * reviewer-dispatch.ts — Finalize Code Changes, Phase 2 (review phase).
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
  FinalizeRunStatus,
  KanbanCardRow,
  Project,
  ReviewerThreadRow,
  Stmts,
} from '../types.js';

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
 * Driver type: takes the local-diff inputs + context, returns the
 * reviewer's verdict and (zero or more) findings. Production wires this
 * to the project's reviewer agent identity over a session that consumes
 * a local-diff prompt; tests inject a fake that resolves synchronously
 * to a fixed result.
 */
export type RunReviewerOnLocalDiff = (args: {
  runId: string;
  worktreePath: string;
  card: KanbanCardRow;
  project: Project;
  inputs: ReviewerLocalDiffInputs;
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
    opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
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
    return terminate(stmts, opts.runId, 'no_worktree', 'worktree path missing', 0);
  }

  // Phase change is published BEFORE the (potentially slow) reviewer
  // turn so the UI's checks panel can render the spinner row.
  setPhase(stmts, broadcast, opts.runId, 'review', 'reviewing');

  // Resolve local-diff inputs. Tests pass them pre-computed; production
  // collects them from the worktree.
  let inputs: ReviewerLocalDiffInputs;
  if (opts.inputs) {
    inputs = opts.inputs;
  } else {
    if (!opts.baseBranch) {
      return terminate(
        stmts,
        opts.runId,
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
      return terminate(stmts, opts.runId, 'no_diff_inputs', `git diff failed: ${msg}`, 0);
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
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return terminate(stmts, opts.runId, 'review_failed', `reviewer agent failed: ${msg}`, 0);
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

  return {
    kind: 'success',
    verdict: result.verdict,
    threadCount: insertedRows.length,
    activeSecondsBilled: billed,
  };
}

// ─── helpers ─────────────────────────────────────────────────────

function setPhase(
  stmts: ReviewerDispatchDeps['stmts'],
  broadcast: BroadcastFn,
  runId: string,
  phase: FinalizeRunPhase,
  status: FinalizeRunStatus,
): void {
  stmts.updateFinalizeRunPhase.run(phase, status, runId);
  broadcast({
    type: 'finalize_run_phase_changed',
    run_id: runId,
    phase,
    status,
  });
}

function terminate(
  stmts: ReviewerDispatchDeps['stmts'],
  runId: string,
  reason: 'review_failed' | 'no_worktree' | 'no_diff_inputs',
  detail: string,
  billedSeconds: number,
): ReviewerDispatchOutcome {
  stmts.failFinalizeRun.run('failed', reason, runId);
  return { kind: 'failed', failureReason: reason, detail, activeSecondsBilled: billedSeconds };
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

function defaultTransactional<T>(fn: () => T): T {
  // Without a `better-sqlite3` handle injected, fall back to running
  // the body inline. The prepared-statement wrappers in production are
  // already wrapped in a `db.transaction(...)` at the caller boundary
  // when atomicity matters.
  return fn();
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
  const filesRes = await runGit(['diff', '--name-only', `${baseSha}..${headSha}`], spawnOpts);
  const diffRes = await runGit(['diff', `${baseSha}..${headSha}`], spawnOpts);

  const changedFiles = filesRes.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return {
    baseSha,
    headSha,
    changedFiles,
    unifiedDiff: diffRes.stdout,
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
  const fileList =
    inputs.changedFiles.length === 0
      ? '_(no files changed)_'
      : inputs.changedFiles.map((f) => `- ${f}`).join('\n');

  return `# Pre-PR Code Review (Local Diff)

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
