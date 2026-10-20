/**
 * Default-branch CI health: the backstop behind selected Finalize runs.
 *
 * Every merge to the default branch runs the full CI suite through push CI
 * (`server/git-host/push-ci.ts`). This module turns those runs into state:
 *
 *   - {@link recordDefaultBranchCiResult}: after a default-branch run, record
 *     its failing instances as "failing on default branch" and clear the ones
 *     it passed. A red streak is one *breakage* (keyed on project + first
 *     failing sha) with one kanban card listing the merges in range, the
 *     sessions behind them, and the failing step logs. A later red run
 *     comments on the same card; the run that clears the last failing
 *     instance closes the breakage with a "fixed by <sha>" comment.
 *
 *   - {@link classifyInheritedFailures}: a session Finalize run whose only
 *     failures are instances already red on the default branch at its base
 *     is "inherited". The orchestrator skips the fix turn and lets the run
 *     reach ready_to_push, recording the summary on
 *     `finalize_runs.inherited_failures`.
 *
 * Nothing here blocks merges: a red default branch is reported, never gated.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import type {
  BroadcastFn,
  FinalizeRunJobRow,
  FinalizeRunStepRow,
  KanbanCardRow,
  KanbanColumnRow,
  PullRequestRow,
  Stmts,
} from '../types.js';
import { getOrCreateBoard } from '../routes/board.js';
import { loadFinalizeStepOutput, loadRunnerQueueStepOutput } from './step-output.js';
import { jobInstanceKey } from './base-drift-policy.js';

const execFileP = promisify(execFile);

const CARD_AUTHOR = 'Agent Hub CI';
const MAX_RANGE_COMMITS = 50;
const LOG_TAIL_LINES = 40;
const MAX_LOGGED_STEPS = 5;
const MAX_DESCRIPTION_CHARS = 30_000;

export interface DefaultBranchCiStateRow {
  project_id: string;
  branch: string;
  last_sha: string;
  range_from_sha: string | null;
  last_status: 'succeeded' | 'failed';
  last_run_id: string | null;
  updated_at: number;
}

export interface DefaultBranchBreakageRow {
  id: string;
  project_id: string;
  branch: string;
  first_failing_sha: string;
  last_failing_sha: string;
  range_from_sha: string | null;
  status: 'open' | 'fixed';
  card_id: string | null;
  opened_run_id: string | null;
  last_run_id: string | null;
  fixed_sha: string | null;
  fixed_run_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface DefaultBranchFailureRow {
  project_id: string;
  job_id: string;
  matrix_key: string;
  branch: string;
  first_failing_sha: string;
  last_failing_sha: string;
  last_run_id: string | null;
  breakage_id: string | null;
  recorded_at: number;
}

/** One commit on the default branch covered by a CI run. */
export interface RangeMerge {
  sha: string;
  subject: string;
  pr: { number: number; title: string; headBranch: string } | null;
  sessionIds: string[];
}

/** `git merge-base --is-ancestor`: true / false, or null when git can't tell. */
export type IsAncestorFn = (
  repoDir: string,
  ancestor: string,
  descendant: string,
  env?: NodeJS.ProcessEnv,
) => Promise<boolean | null>;

/** First-parent commits in `(from, to]`, newest first. Null on git failure. */
export type ListRangeFn = (
  repoDir: string,
  from: string | null,
  to: string,
) => Promise<Array<{ sha: string; subject: string }> | null>;

/** Tail of a failed step's output, or [] when none is stored. */
export type StepLogTailFn = (args: {
  stmts: Pick<Stmts, 'getMessages'>;
  projectId: string;
  runId: string;
  sessionId: string | null;
  step: FinalizeRunStepRow;
}) => string[];

export const defaultIsAncestor: IsAncestorFn = async (repoDir, ancestor, descendant, env) => {
  if (ancestor === descendant) return true;
  try {
    await execFileP('git', ['-C', repoDir, 'merge-base', '--is-ancestor', ancestor, descendant], {
      timeout: 30_000,
      ...(env ? { env } : {}),
    });
    return true;
  } catch (err) {
    // Exit 1 means "not an ancestor"; anything else (missing object, bad
    // repo) means we couldn't tell.
    const code = (err as { code?: unknown }).code;
    return code === 1 ? false : null;
  }
};

export const defaultListRange: ListRangeFn = async (repoDir, from, to) => {
  const range = from ? [`${from}..${to}`] : ['-1', to];
  try {
    const { stdout } = await execFileP(
      'git',
      [
        '-C',
        repoDir,
        'log',
        '--first-parent',
        `--max-count=${MAX_RANGE_COMMITS}`,
        '--format=%H%x09%s',
        ...range,
      ],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        const tab = l.indexOf('\t');
        return tab < 0
          ? { sha: l.trim(), subject: '' }
          : { sha: l.slice(0, tab), subject: l.slice(tab + 1) };
      });
  } catch {
    return null;
  }
};

export const defaultStepLogTail: StepLogTailFn = ({ stmts, projectId, runId, sessionId, step }) => {
  let lines: string[] = [];
  if (sessionId) {
    try {
      lines = loadFinalizeStepOutput(stmts, {
        sessionId,
        runId,
        stepIndex: step.step_index,
      }).map((l) => l.text);
    } catch {
      lines = [];
    }
  }
  if (lines.length === 0) {
    try {
      lines = loadRunnerQueueStepOutput({
        projectId,
        runId,
        step,
        maxLines: LOG_TAIL_LINES,
      }).lines.map((l) => l.text);
    } catch {
      lines = [];
    }
  }
  return lines.slice(-LOG_TAIL_LINES);
};

export interface DefaultBranchHealthDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  now?: () => number;
  newId?: () => string;
  isAncestor?: IsAncestorFn;
  listRange?: ListRangeFn;
  stepLogTail?: StepLogTailFn;
  log?: (msg: string) => void;
}

export interface RecordDefaultBranchArgs {
  projectId: string;
  branch: string;
  headSha: string;
  runId: string;
  /** Session that holds the run's step output (push CI's sentinel session). */
  logSessionId: string | null;
  outcome: 'succeeded' | 'failed';
  /**
   * True when the run covered every instance in ci.yaml (not a single-job
   * re-run). A full run is authoritative for the instance set: stored
   * failures for instances it no longer has (a removed or renamed job or
   * shard) are cleared. Defaults to true.
   */
  fullRun?: boolean;
  /** Repo used for ancestry and range lookups (the hosted bare repo). */
  repoDir: string;
}

export type RecordDefaultBranchResult =
  | { kind: 'stale' }
  | { kind: 'recorded'; failing: number; breakageId: string | null; cardId: string | null };

function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 8) : '?';
}

function instanceLabel(jobId: string, matrixKey: string): string {
  return matrixKey ? `${jobId} (${matrixKey})` : jobId;
}

/**
 * Record a finished default-branch CI run. Call it only for full runs on the
 * default branch that produced job results (checks failed, timed out, or
 * passed); infra errors, cancels, and config errors say nothing about tests.
 *
 * Never throws for card/log failures: the failing-instance rows are the
 * source of truth and are written first.
 */
export function recordDefaultBranchCiResult(
  deps: DefaultBranchHealthDeps,
  args: RecordDefaultBranchArgs,
): Promise<RecordDefaultBranchResult> {
  // One recording at a time per project, card creation included. Recording
  // awaits git (ancestry, merge range) between reading and writing state, so
  // two overlapping completions could otherwise both read the same state and
  // let an older result overwrite a newer one, or each open a card.
  const prev = recordLanes.get(args.projectId) ?? Promise.resolve();
  const next = prev.then(() => recordUnserialized(deps, args));
  const lane = next.then(
    () => undefined,
    () => undefined,
  );
  recordLanes.set(args.projectId, lane);
  void lane.then(() => {
    if (recordLanes.get(args.projectId) === lane) recordLanes.delete(args.projectId);
  });
  return next;
}

const recordLanes = new Map<string, Promise<void>>();

async function recordUnserialized(
  deps: DefaultBranchHealthDeps,
  args: RecordDefaultBranchArgs,
): Promise<RecordDefaultBranchResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.log(m));
  const isAncestor = deps.isAncestor ?? defaultIsAncestor;
  const { stmts } = deps;
  const { projectId, branch, headSha, runId } = args;

  const state = stmts.getDefaultBranchCiState.get(projectId) as DefaultBranchCiStateRow | undefined;
  // A result for a commit older than the last one CI reported on (a re-run of
  // an old sha, or runs finishing out of order) must not rewrite the current
  // state: a passing re-run of an old commit would clear today's failures.
  if (state && state.last_sha !== headSha) {
    const older = await isAncestor(args.repoDir, headSha, state.last_sha);
    if (older === true) {
      log(
        `[default-branch-health] ${projectId}: ignoring run=${runId} for ${short(headSha)}, ` +
          `older than last reported ${short(state.last_sha)}`,
      );
      return { kind: 'stale' };
    }
  }
  const rangeFrom =
    state && state.last_sha === headSha ? state.range_from_sha : (state?.last_sha ?? null);

  const jobs = stmts.listFinalizeRunJobsForRun.all(runId) as FinalizeRunJobRow[];
  const failingJobs = jobs.filter((j) => j.state === 'failed');
  const passedJobs = jobs.filter((j) => j.state === 'passed');
  const at = now();

  for (const j of passedJobs) {
    stmts.deleteDefaultBranchFailure.run(projectId, j.job_id, j.matrix_key ?? '');
  }
  if (args.fullRun !== false && jobs.length > 0) {
    // Without this, a red instance that was deleted or renamed would stay
    // "failing" forever, keep its breakage open, and excuse a later instance
    // reusing the name with a stale first failing sha.
    const present = new Set(jobs.map((j) => jobInstanceKey(j.job_id, j.matrix_key ?? '')));
    for (const f of stmts.listDefaultBranchFailures.all(projectId) as DefaultBranchFailureRow[]) {
      if (!present.has(jobInstanceKey(f.job_id, f.matrix_key))) {
        stmts.deleteDefaultBranchFailure.run(projectId, f.job_id, f.matrix_key);
      }
    }
  }

  let breakage: DefaultBranchBreakageRow | null = null;
  if (args.outcome === 'failed' && failingJobs.length > 0) {
    breakage = openOrContinueBreakage(deps, { ...args, rangeFrom, at });
    for (const j of failingJobs) {
      stmts.upsertDefaultBranchFailure.run(
        projectId,
        j.job_id,
        j.matrix_key ?? '',
        branch,
        headSha,
        headSha,
        runId,
        breakage.id,
        at,
      );
    }
  }

  stmts.upsertDefaultBranchCiState.run(
    projectId,
    branch,
    headSha,
    rangeFrom,
    args.outcome,
    runId,
    at,
  );

  const remaining = stmts.listDefaultBranchFailures.all(projectId) as DefaultBranchFailureRow[];
  const open =
    breakage ??
    ((stmts.getOpenDefaultBranchBreakage.get(projectId) as DefaultBranchBreakageRow | undefined) ||
      null);

  if (open && remaining.length === 0) {
    stmts.fixDefaultBranchBreakage.run(headSha, runId, at, open.id);
    if (open.card_id) {
      addComment(
        deps,
        open.card_id,
        projectId,
        `Fixed by \`${short(headSha)}\`: CI run ${runId} on \`${branch}\` passed every instance ` +
          `that was failing since \`${short(open.first_failing_sha)}\`.`,
      );
    }
    log(
      `[default-branch-health] ${projectId}: breakage ${open.id} fixed by ${short(headSha)} (run=${runId})`,
    );
    return { kind: 'recorded', failing: 0, breakageId: open.id, cardId: open.card_id };
  }

  if (breakage) {
    const cardId = await ensureBreakageCard(deps, {
      breakage,
      args,
      rangeFrom,
      failing: failingJobs,
      stillFailing: remaining,
    });
    return { kind: 'recorded', failing: remaining.length, breakageId: breakage.id, cardId };
  }
  return {
    kind: 'recorded',
    failing: remaining.length,
    breakageId: open?.id ?? null,
    cardId: open?.card_id ?? null,
  };
}

function openOrContinueBreakage(
  deps: DefaultBranchHealthDeps,
  args: RecordDefaultBranchArgs & { rangeFrom: string | null; at: number },
): DefaultBranchBreakageRow {
  const { stmts } = deps;
  const open = stmts.getOpenDefaultBranchBreakage.get(args.projectId) as
    | DefaultBranchBreakageRow
    | undefined;
  if (open) {
    stmts.touchDefaultBranchBreakage.run(args.headSha, args.runId, args.at, open.id);
    return { ...open, last_failing_sha: args.headSha, last_run_id: args.runId };
  }
  // Idempotent on (project, first failing sha): a replay or re-run of the same
  // red commit reopens the same breakage instead of creating a second card.
  stmts.insertDefaultBranchBreakage.run(
    (deps.newId ?? uuidv4)(),
    args.projectId,
    args.branch,
    args.headSha,
    args.headSha,
    args.rangeFrom,
    args.runId,
    args.runId,
    args.at,
    args.at,
  );
  const row = stmts.getDefaultBranchBreakageByFirstSha.get(
    args.projectId,
    args.headSha,
  ) as DefaultBranchBreakageRow;
  if (row.status !== 'open') {
    stmts.touchDefaultBranchBreakage.run(args.headSha, args.runId, args.at, row.id);
    return { ...row, status: 'open', last_failing_sha: args.headSha, last_run_id: args.runId };
  }
  return row;
}

/** Resolve the commits a run covers to merged PRs and the sessions behind them. */
export async function resolveRangeMerges(
  deps: Pick<DefaultBranchHealthDeps, 'stmts' | 'listRange'>,
  args: { projectId: string; repoDir: string; from: string | null; to: string },
): Promise<RangeMerge[]> {
  const commits = (await (deps.listRange ?? defaultListRange)(
    args.repoDir,
    args.from,
    args.to,
  )) ?? [{ sha: args.to, subject: '' }];
  return commits.map((c) => {
    const pr = deps.stmts.getMergedPullRequestByMergedSha.get(args.projectId, c.sha) as
      | PullRequestRow
      | undefined;
    const sessionIds = new Set<string>();
    if (pr) {
      for (const row of deps.stmts.getSessionIdsByWorktreeBranch.all(pr.head_branch) as Array<{
        id: string;
      }>) {
        sessionIds.add(row.id);
      }
    }
    // A Finalize run that validated this exact commit pushed it straight to
    // the default branch (mainline / push-to-default-branch).
    const validated = deps.stmts.getValidatedFinalizeRunForSha.get(args.projectId, c.sha) as
      | { session_id: string | null }
      | undefined;
    if (validated?.session_id) sessionIds.add(validated.session_id);
    return {
      sha: c.sha,
      subject: c.subject,
      pr: pr ? { number: pr.number, title: pr.title, headBranch: pr.head_branch } : null,
      sessionIds: [...sessionIds],
    };
  });
}

function formatRange(from: string | null, to: string, merges: RangeMerge[]): string[] {
  const lines = [
    from
      ? `Merges covered: \`${short(from)}..${short(to)}\` (${merges.length} commit${merges.length === 1 ? '' : 's'})`
      : `Merges covered: \`${short(to)}\` (no earlier CI result on record)`,
  ];
  for (const m of merges) {
    const pr = m.pr ? ` PR #${m.pr.number} "${m.pr.title}" (\`${m.pr.headBranch}\`)` : '';
    const sessions = m.sessionIds.length > 0 ? `, session ${m.sessionIds.join(', ')}` : '';
    lines.push(`- \`${short(m.sha)}\` ${m.subject}${pr}${sessions}`);
  }
  return lines;
}

function failingStepLogs(
  deps: DefaultBranchHealthDeps,
  args: RecordDefaultBranchArgs,
  failing: FinalizeRunJobRow[],
): string[] {
  const failingKeys = new Set(failing.map((j) => jobInstanceKey(j.job_id, j.matrix_key ?? '')));
  let steps: FinalizeRunStepRow[] = [];
  try {
    steps = (deps.stmts.listFinalizeRunStepsForRun.all(args.runId) as FinalizeRunStepRow[]).filter(
      (s) =>
        s.state === 'failed' && failingKeys.has(jobInstanceKey(s.job_id ?? '', s.matrix_key ?? '')),
    );
  } catch {
    return [];
  }
  const tail = deps.stepLogTail ?? defaultStepLogTail;
  const out: string[] = [];
  for (const step of steps.slice(0, MAX_LOGGED_STEPS)) {
    let lines: string[] = [];
    try {
      lines = tail({
        stmts: deps.stmts,
        projectId: args.projectId,
        runId: args.runId,
        sessionId: args.logSessionId,
        step,
      });
    } catch {
      lines = [];
    }
    out.push('', `#### ${step.name} (exit ${step.exit_code ?? '?'})`);
    out.push(lines.length > 0 ? ['```', ...lines, '```'].join('\n') : '_No output captured._');
  }
  if (steps.length > MAX_LOGGED_STEPS) {
    out.push('', `_${steps.length - MAX_LOGGED_STEPS} more failing step(s) in run ${args.runId}._`);
  }
  return out;
}

async function ensureBreakageCard(
  deps: DefaultBranchHealthDeps,
  input: {
    breakage: DefaultBranchBreakageRow;
    args: RecordDefaultBranchArgs;
    rangeFrom: string | null;
    failing: FinalizeRunJobRow[];
    stillFailing: DefaultBranchFailureRow[];
  },
): Promise<string | null> {
  const { breakage, args, rangeFrom, failing, stillFailing } = input;
  const log = deps.log ?? ((m: string) => console.log(m));
  try {
    const merges = await resolveRangeMerges(deps, {
      projectId: args.projectId,
      repoDir: args.repoDir,
      from: rangeFrom,
      to: args.headSha,
    });
    const failingLines = stillFailing.map(
      (f) =>
        `- ${instanceLabel(f.job_id, f.matrix_key)}: failing since \`${short(f.first_failing_sha)}\``,
    );
    const body = [
      ...formatRange(rangeFrom, args.headSha, merges),
      '',
      `Failing on \`${args.branch}\` (CI run ${args.runId}):`,
      ...failingLines,
      '',
      '### Failing step logs',
      ...failingStepLogs(deps, args, failing),
    ].join('\n');

    if (breakage.card_id) {
      addComment(
        deps,
        breakage.card_id,
        args.projectId,
        `Still failing at \`${short(args.headSha)}\`.\n\n${body}`.slice(0, MAX_DESCRIPTION_CHARS),
      );
      return breakage.card_id;
    }

    const labels = failing.map((j) => instanceLabel(j.job_id, j.matrix_key ?? ''));
    const title =
      `Default branch red: ${labels.slice(0, 3).join(', ')}` +
      (labels.length > 3 ? ` +${labels.length - 3} more` : '') +
      ` failing at ${short(args.headSha)}`;
    const description = [
      `Full CI on \`${args.branch}\` failed at \`${args.headSha}\`. Merges are not blocked; ` +
        'session Finalize runs whose only failures are the instances below are reported as ' +
        'inherited and skip their fix turn until this is fixed.',
      '',
      body,
    ]
      .join('\n')
      .slice(0, MAX_DESCRIPTION_CHARS);
    const cardId = createCard(deps, args.projectId, title.slice(0, 200), description);
    deps.stmts.setDefaultBranchBreakageCard.run(cardId, (deps.now ?? Date.now)(), breakage.id);
    log(
      `[default-branch-health] ${args.projectId}: opened breakage ${breakage.id} card=${cardId} ` +
        `at ${short(args.headSha)}`,
    );
    return cardId;
  } catch (err) {
    log(
      `[default-branch-health] ${args.projectId}: breakage card failed for ${breakage.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return breakage.card_id;
  }
}

function resolveTodoColumnId(columns: KanbanColumnRow[]): string {
  const todo = columns.find((c) => c.name.toLowerCase() === 'to do');
  if (todo) return todo.id;
  const sorted = [...columns].sort((a, b) => a.position - b.position);
  if (!sorted[0]) throw new Error('Board has no columns');
  return sorted[0].id;
}

function createCard(
  deps: DefaultBranchHealthDeps,
  projectId: string,
  title: string,
  description: string,
): string {
  const { board, columns } = getOrCreateBoard(deps.stmts, projectId, { includeCards: false });
  const columnId = resolveTodoColumnId(columns);
  const existing = deps.stmts.getKanbanCardsByColumn.all(columnId) as KanbanCardRow[];
  const position = existing.length > 0 ? Math.max(...existing.map((c) => c.position)) + 1 : 0;
  const id = (deps.newId ?? uuidv4)();
  deps.stmts.createKanbanCard.run(
    id,
    columnId,
    board.id,
    title,
    description,
    'high',
    null, // assignee
    'ci,default-branch',
    null, // session_id: the merging sessions are listed in the description
    null, // github_issue_url
    null, // created_by
    null, // assign_model
    position,
  );
  deps.broadcast({ type: 'kanban_update', projectId });
  return id;
}

function addComment(
  deps: DefaultBranchHealthDeps,
  cardId: string,
  projectId: string,
  content: string,
): void {
  try {
    deps.stmts.createKanbanCardComment.run((deps.newId ?? uuidv4)(), cardId, CARD_AUTHOR, content);
    deps.broadcast({ type: 'kanban_update', projectId });
  } catch (err) {
    (deps.log ?? console.log)(
      `[default-branch-health] comment on card ${cardId} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Inherited failures (session Finalize runs on a red default branch)
// ---------------------------------------------------------------------------

export interface InheritedFailures {
  count: number;
  instances: Array<{ jobId: string; matrixKey: string; firstFailingSha: string }>;
  breakageId: string | null;
  cardId: string | null;
}

export type InheritedClassification =
  | { kind: 'inherited'; summary: InheritedFailures }
  | { kind: 'not_inherited'; reason: string };

/**
 * Decide whether a failed checks round only failed on instances that were
 * already failing on the default branch at the session's base.
 *
 * An instance counts as inherited when it is recorded as failing on the
 * default branch and the commit where it first failed is an ancestor of (or
 * equal to) `baseSha`. A skipped instance is allowed only when it belongs to
 * a job that has an inherited failure (a fail-fast sibling): its job is
 * already red on the default branch. Anything else (a new failure, an
 * instance skipped because a needed job failed, a base the failure postdates,
 * an ancestry check git can't answer) is not inherited, so the run gets its
 * normal fix turn.
 */
export type InheritedFailureStmts = Pick<
  Stmts,
  | 'listDefaultBranchFailures'
  | 'listFinalizeRunJobsForRun'
  | 'getDefaultBranchBreakage'
  | 'getOpenDefaultBranchBreakage'
>;

export async function classifyInheritedFailures(
  deps: { stmts: InheritedFailureStmts; isAncestor?: IsAncestorFn },
  args: {
    projectId: string;
    runId: string;
    baseSha: string | null;
    repoDir: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<InheritedClassification> {
  if (!args.baseSha) return { kind: 'not_inherited', reason: 'no base sha' };
  const red = deps.stmts.listDefaultBranchFailures.all(args.projectId) as DefaultBranchFailureRow[];
  if (red.length === 0) return { kind: 'not_inherited', reason: 'default branch is green' };
  const redByKey = new Map(red.map((r) => [jobInstanceKey(r.job_id, r.matrix_key), r]));

  const jobs = deps.stmts.listFinalizeRunJobsForRun.all(args.runId) as FinalizeRunJobRow[];
  const failed = jobs.filter((j) => j.state === 'failed');
  if (failed.length === 0) return { kind: 'not_inherited', reason: 'no failed instances' };

  const isAncestor = deps.isAncestor ?? defaultIsAncestor;
  const ancestry = new Map<string, boolean | null>();
  const instances: InheritedFailures['instances'] = [];
  const breakageIds = new Set<string>();
  for (const j of failed) {
    const rec = redByKey.get(jobInstanceKey(j.job_id, j.matrix_key ?? ''));
    if (!rec) {
      return {
        kind: 'not_inherited',
        reason: `${instanceLabel(j.job_id, j.matrix_key ?? '')} is not failing on the default branch`,
      };
    }
    let atBase = ancestry.get(rec.first_failing_sha);
    if (atBase === undefined) {
      atBase = await isAncestor(args.repoDir, rec.first_failing_sha, args.baseSha, args.env);
      ancestry.set(rec.first_failing_sha, atBase);
    }
    if (atBase !== true) {
      return {
        kind: 'not_inherited',
        reason:
          `${instanceLabel(j.job_id, j.matrix_key ?? '')} first failed at ` +
          `${short(rec.first_failing_sha)}, ` +
          (atBase === false ? 'after the session base' : 'ancestry unknown'),
      };
    }
    instances.push({
      jobId: j.job_id,
      matrixKey: j.matrix_key ?? '',
      firstFailingSha: rec.first_failing_sha,
    });
    if (rec.breakage_id) breakageIds.add(rec.breakage_id);
  }

  const redJobs = new Set(instances.map((i) => i.jobId));
  const unexplainedSkip = jobs.find((j) => j.state === 'skipped' && !redJobs.has(j.job_id));
  if (unexplainedSkip) {
    return {
      kind: 'not_inherited',
      reason: `${instanceLabel(unexplainedSkip.job_id, unexplainedSkip.matrix_key ?? '')} was skipped`,
    };
  }
  const stillRunning = jobs.find((j) => j.state === 'queued' || j.state === 'running');
  if (stillRunning) return { kind: 'not_inherited', reason: 'instances still in flight' };

  let breakage: DefaultBranchBreakageRow | undefined;
  for (const id of breakageIds) {
    breakage = deps.stmts.getDefaultBranchBreakage.get(id) as DefaultBranchBreakageRow | undefined;
    if (breakage) break;
  }
  breakage ??= deps.stmts.getOpenDefaultBranchBreakage.get(args.projectId) as
    | DefaultBranchBreakageRow
    | undefined;
  return {
    kind: 'inherited',
    summary: {
      count: instances.length,
      instances,
      breakageId: breakage?.id ?? null,
      cardId: breakage?.card_id ?? null,
    },
  };
}

/** Parse `finalize_runs.inherited_failures`; null when absent or malformed. */
export function parseInheritedFailures(raw: string | null | undefined): InheritedFailures | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<InheritedFailures>;
    if (!v || typeof v.count !== 'number' || !Array.isArray(v.instances)) return null;
    return {
      count: v.count,
      instances: v.instances,
      breakageId: v.breakageId ?? null,
      cardId: v.cardId ?? null,
    };
  } catch {
    return null;
  }
}
