/**
 * "Run QA Tests" for a session: turn a session's merged work into a QA plan,
 * approve it, and run it against the project's default QA environment.
 *
 * One request per session (`qa_session_requests`):
 *   armed      the session's checkbox is ticked; waits for its pull request to
 *              merge (see `sessionMergedAt`).
 *   authoring  a plan exists and the QA agent is drafting its cases from the
 *              session's context in a hidden QA session.
 *   waiting    the drafting turn ended with cases, the plan is approved, and
 *              the run waits for `due_at` (merge time plus the project's
 *              "Default delay for automated QA", so the deploy can land).
 *   launching  written just before `launchQaRun`, so a restart in that window
 *              is reconciled at boot against the plan's runs (see `advance`).
 *   started    the run launched (`run_id`). Results are read on the QA page.
 *   failed     `error` says why (no default environment, no cases, ...).
 *
 * The plan is created with auto-rerun and auto-fix off: it only runs the
 * tests. The user turns either on from the plan page afterwards.
 *
 * Every transition runs under one per-session lock (`withRequestLock`).
 *
 * Triggers: PR-merge broadcasts sweep the project's armed requests,
 * every turn end checks for a drafting session, a timer fires at `due_at`, and
 * boot sweeps every open request for events missed while the server was down.
 */
import { randomUUID } from 'crypto';
import { getDb, getStmts } from './db.js';
import { resolveAgentSpawnEngineAndModel } from './effective-model.js';
import { subscribeAllTurnEnds } from './finalize/turn-end.js';
import {
  fetchGithubPrContextForSession,
  githubMergedAtForSession,
  reconcileGithubMergesForBranch,
} from './github-pr-merges.js';
import { findProjectQaAgent } from './qa-authoring.js';
import {
  buildQaEnvironmentsBlock,
  getDefaultQaEnvironment,
  getQaProjectSettings,
  listQaEnvironments,
  type QaEnvironmentView,
} from './qa-environments.js';
import { isQaRunLaunchInFlight, launchQaRun, type QaRunLaunchDeps } from './qa-run-launch.js';
import type { QaSessionRequestStatus } from './qa-schema.js';
import { approveQaPlan, cancelQaRun, QaStatusError } from './qa-status.js';
import { abandonUnseededSession, kickoffSeededTurn } from './seeded-session-kickoff.js';
import { setSessionOwner } from './session-ownership.js';
import type { Project, QaRunRow, SessionRow } from './types.js';

export type QaSessionRunDeps = QaRunLaunchDeps & {
  /** GitHub token for a repo; defaults to the org owner's (`resolveOrgOwnerGithubToken`). */
  resolveGithubToken?: (githubRepo: string) => Promise<string | null>;
  /** fetch for GitHub calls; tests inject one. */
  githubFetch?: typeof fetch;
};

export interface QaSessionRequestRow {
  session_id: string;
  project_id: string;
  status: QaSessionRequestStatus;
  requested_by: string | null;
  plan_id: string | null;
  authoring_session_id: string | null;
  run_id: string | null;
  due_at: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface QaSessionRequestView {
  sessionId: string;
  projectId: string;
  status: QaSessionRequestStatus;
  planId: string | null;
  planTitle: string | null;
  runId: string | null;
  /** ISO time the run starts at (merge time plus the project's delay). */
  dueAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export class QaSessionRequestError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409,
    public readonly code: string,
  ) {
    super(message);
  }
}

/** Long session texts are cut so the seed stays a reasonable size. */
export const MAX_SESSION_CONTEXT_CHARS = 4_000;

const OPEN_STATUSES: readonly QaSessionRequestStatus[] = [
  'armed',
  'authoring',
  'waiting',
  'launching',
];

function clip(text: string | null | undefined, max = MAX_SESSION_CONTEXT_CHARS): string {
  const t = (text ?? '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max).trimEnd()}\n\n[truncated]`;
}

export function getQaSessionRequest(sessionId: string): QaSessionRequestRow | null {
  return (
    (getDb().prepare('SELECT * FROM qa_session_requests WHERE session_id = ?').get(sessionId) as
      | QaSessionRequestRow
      | undefined) ?? null
  );
}

export function serializeQaSessionRequest(row: QaSessionRequestRow): QaSessionRequestView {
  const plan = row.plan_id ? getStmts().getQaPlan.get(row.plan_id) : undefined;
  return {
    sessionId: row.session_id,
    projectId: row.project_id,
    status: row.status,
    planId: plan ? plan.id : null,
    planTitle: plan ? plan.title : null,
    runId: row.run_id,
    dueAt: row.due_at != null ? new Date(row.due_at).toISOString() : null,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function update(sessionId: string, fields: Partial<Omit<QaSessionRequestRow, 'session_id'>>) {
  const keys = Object.keys(fields) as Array<keyof typeof fields>;
  if (keys.length === 0) return;
  getDb()
    .prepare(
      `UPDATE qa_session_requests SET ${keys.map((k) => `${k} = ?`).join(', ')},
         updated_at = datetime('now') WHERE session_id = ?`,
    )
    .run(...keys.map((k) => fields[k] ?? null), sessionId);
}

function emit(
  deps: Pick<QaRunLaunchDeps, 'broadcast'>,
  row: { session_id: string; project_id: string },
) {
  const current = getQaSessionRequest(row.session_id);
  deps.broadcast({
    type: 'qa_update',
    projectId: row.project_id,
    action: 'session_request_updated',
    sessionId: row.session_id,
    request: current ? serializeQaSessionRequest(current) : null,
  });
}

/**
 * When the session's work merged (epoch ms), or null when it has not.
 *
 * Only a pull request merge counts; a kanban card's column never does, since
 * a person can drag a card to Done before anything merged and a session may
 * have no card at all. Agent Hub-hosted repos (and any branch with a native
 * PR row) are answered by `pull_requests`; github.com PRs by
 * `github_pr_merges` (`github-pr-merges.ts`), which the Hub writes for merges
 * it performs and `reconcileSessionMerge` backfills from GitHub for the rest.
 */
export function sessionMergedAt(
  session: Pick<SessionRow, 'id' | 'worktree_branch'>,
  project: Pick<Project, 'id' | 'gitHost'>,
): number | null {
  const branch = session.worktree_branch || null;
  if (branch) {
    const prs = getDb()
      .prepare(
        `SELECT status, merged_at FROM pull_requests
          WHERE project_id = ? AND head_branch = ?`,
      )
      .all(project.id, branch) as Array<{ status: string; merged_at: number | null }>;
    if (prs.length > 0 || project.gitHost === 'agenthub') {
      const merged = prs
        .filter((p) => p.status === 'merged' && p.merged_at != null)
        .map((p) => p.merged_at as number);
      return merged.length > 0 ? Math.max(...merged) : null;
    }
  } else if (project.gitHost === 'agenthub') {
    return null;
  }
  return githubMergedAtForSession(project.id, session.id, branch);
}

/**
 * For a github.com session not yet known to be merged, ask GitHub (throttled)
 * and record any merge, so a PR merged on github.com, or before the Hub kept
 * merge records, still counts. Hub-hosted repos and branches with native PR
 * rows already have authoritative state. Never throws.
 */
export async function reconcileSessionMerge(
  deps: Pick<QaSessionRunDeps, 'config' | 'resolveGithubToken' | 'githubFetch'>,
  session: Pick<SessionRow, 'id' | 'worktree_branch'>,
  project: Pick<Project, 'id' | 'gitHost' | 'githubRepo'>,
): Promise<void> {
  if (project.gitHost === 'agenthub' || !session.worktree_branch || !project.githubRepo) return;
  if (sessionMergedAt(session, project) !== null) return;
  const native = getDb()
    .prepare('SELECT 1 FROM pull_requests WHERE project_id = ? AND head_branch = ? LIMIT 1')
    .get(project.id, session.worktree_branch);
  if (native) return;
  await reconcileGithubMergesForBranch({
    projectId: project.id,
    githubRepo: project.githubRepo,
    branch: session.worktree_branch,
    resolveToken: githubTokenResolver(deps),
    fetchImpl: deps.githubFetch,
  });
}

function githubTokenResolver(
  deps: Pick<QaSessionRunDeps, 'config' | 'resolveGithubToken'>,
): (repo: string) => Promise<string | null> {
  return (
    deps.resolveGithubToken ??
    (async (repo) => {
      const { resolveOrgOwnerGithubToken } = await import('./auto-git.js');
      return resolveOrgOwnerGithubToken(deps.config ?? {}, repo);
    })
  );
}

/** Refusals that apply both when arming and when triggering. */
function preflight(project: Project): QaEnvironmentView {
  if (!findProjectQaAgent(project)) {
    throw new QaSessionRequestError(
      'This project has no QA agent. Add an agent with the qa role first.',
      409,
      'no_qa_agent',
    );
  }
  const env = getDefaultQaEnvironment(project.id);
  if (!env) {
    throw new QaSessionRequestError(
      'No default QA environment. Mark one as Default in QA settings.',
      409,
      'no_default_environment',
    );
  }
  if (!env.baseUrl) {
    throw new QaSessionRequestError(
      `The default QA environment "${env.name}" has no base URL.`,
      409,
      'default_environment_no_url',
    );
  }
  return env;
}

interface SessionContext {
  session: Pick<SessionRow, 'id' | 'name'>;
  card: { id: string; shortId: number | null; title: string; description: string | null } | null;
  pr: { number: number; title: string; body: string } | null;
  task: string | null;
  outcome: string | null;
}

/**
 * The session's context for the drafting seed. A github.com PR has no
 * `pull_requests` row, so its title and body come from GitHub.
 */
async function loadSessionContext(
  deps: Pick<QaSessionRunDeps, 'config' | 'resolveGithubToken' | 'githubFetch'>,
  session: SessionRow,
  project: Project,
): Promise<SessionContext> {
  const projectId = project.id;
  const db = getDb();
  const card =
    (db
      .prepare(
        'SELECT id, short_id AS shortId, title, description FROM kanban_cards WHERE session_id = ? LIMIT 1',
      )
      .get(session.id) as SessionContext['card'] | undefined) ?? null;
  let pr: SessionContext['pr'] = null;
  if (session.worktree_branch) {
    try {
      pr =
        (db
          .prepare(
            `SELECT number, title, body FROM pull_requests
              WHERE project_id = ? AND head_branch = ? ORDER BY created_at DESC LIMIT 1`,
          )
          .get(projectId, session.worktree_branch) as SessionContext['pr'] | undefined) ?? null;
    } catch {
      pr = null;
    }
  }
  if (!pr && project.gitHost !== 'agenthub') {
    pr = await fetchGithubPrContextForSession({
      projectId,
      sessionId: session.id,
      githubRepo: project.githubRepo,
      branch: session.worktree_branch,
      resolveToken: githubTokenResolver(deps),
      fetchImpl: deps.githubFetch,
    });
  }
  const message = (role: 'user' | 'assistant', order: 'ASC' | 'DESC') =>
    (
      db
        .prepare(
          `SELECT content FROM messages WHERE session_id = ? AND role = ?
            ORDER BY created_at ${order}, rowid ${order} LIMIT 1`,
        )
        .get(session.id, role) as { content: string } | undefined
    )?.content ?? null;
  return { session, card, pr, task: message('user', 'ASC'), outcome: message('assistant', 'DESC') };
}

/** The first user turn of the hidden QA session that drafts the cases. Pure. */
export function buildQaSessionAuthoringSeed(args: {
  project: Pick<Project, 'id' | 'name'>;
  plan: { id: string; title: string; target_url: string };
  environment: Pick<QaEnvironmentView, 'name' | 'baseUrl'>;
  environments: readonly QaEnvironmentView[];
  context: SessionContext;
}): string {
  const { project, plan, environment, context } = args;
  const lines = [
    `[QA plan] ${plan.title}`,
    '',
    `Draft test cases for QA plan \`${plan.id}\` in project \`${project.id}\`. It checks the work of session \`${context.session.id}\` ("${context.session.name}") on the **${environment.name}** environment.`,
    '',
    `- **Target URL:** ${plan.target_url}`,
    '',
    'This plan was requested from the session with **Run QA Tests**. Nobody is reading this conversation: do not ask questions. Work out what changed from the context below.',
  ];
  if (context.card) {
    const ref = context.card.shortId != null ? `#${context.card.shortId}` : context.card.id;
    lines.push(
      '',
      `### Card ${ref}: ${context.card.title}`,
      '',
      clip(context.card.description) || '_No description._',
    );
  }
  if (context.pr) {
    lines.push(
      '',
      `### Pull request #${context.pr.number}: ${context.pr.title}`,
      '',
      clip(context.pr.body) || '_No description._',
    );
  }
  if (context.task) lines.push('', '### What the session was asked to do', '', clip(context.task));
  if (context.outcome) {
    lines.push('', "### The session's last report", '', clip(context.outcome));
  }
  const envBlock = buildQaEnvironmentsBlock(args.environments, plan.target_url);
  if (envBlock) lines.push('', envBlock);
  lines.push(
    '',
    '### What to do',
    '',
    `1. Add cases with \`qa.sh case add ${plan.id}\` in run order. Cover the behavior a user can see change after this work, plus one check that the surrounding feature still works. One behavior per case, numbered steps, an observable expected result. When a step logs in, name the test account by its label from Environments.`,
    '2. Skip anything a browser cannot observe on the target (internal refactors, tests, docs). If nothing user-visible changed, add one smoke case for the area the session touched.',
    '3. End your turn with one line listing the cases. When your turn ends the server approves the plan and runs it; do not approve it or start a run yourself.',
    '',
    'Do not edit code or commit.',
  );
  return lines.join('\n');
}

function planTitle(session: SessionRow, card: SessionContext['card']): string {
  const base = card?.title || session.name || 'Session';
  return `QA: ${base}`.slice(0, 200);
}

/**
 * Create the plan and open the drafting session for a request. Leaves the
 * request `authoring`, or `failed` with the reason. Never throws.
 */
async function startAuthoring(deps: QaSessionRunDeps, sessionId: string): Promise<void> {
  const row = getQaSessionRequest(sessionId);
  if (!row) return;
  const s = getStmts();
  const session = s.getSession.get(sessionId) as SessionRow | undefined;
  const project = deps.findProject(row.project_id);
  const fail = (error: string) => {
    update(sessionId, { status: 'failed', error });
    emit(deps, row);
  };
  if (!session || session.deleted_at || !project) return fail('The session or project is gone.');
  let environment: QaEnvironmentView;
  try {
    environment = preflight(project);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const agent = findProjectQaAgent(project)!;
  if (!deps.handleChat) return fail('Chat is unavailable on this server.');

  // QA tests the deployed work, so it never starts before the merge. Every
  // caller checks this; refusing here keeps an unmerged request from drafting.
  const mergedAt = sessionMergedAt(session, project);
  if (mergedAt === null) return fail('The session has not merged yet.');
  const delayMs = getQaProjectSettings(project.id).autoQaDelayMinutes * 60_000;
  const dueAt = Math.max(Date.now(), mergedAt + delayMs);

  const context = await loadSessionContext(deps, session, project);
  const planId = randomUUID();
  const title = planTitle(session, context.card);
  s.insertQaPlan.run(
    planId,
    project.id,
    title,
    `Check the work of session "${session.name}" on ${environment.name}.`,
    environment.baseUrl,
    null,
    context.card?.id ?? null,
    null,
    0,
    5,
    row.requested_by,
  );
  deps.broadcast({ type: 'qa_update', projectId: project.id, planId, action: 'plan_created' });

  const authoringId = randomUUID();
  update(sessionId, {
    status: 'authoring',
    plan_id: planId,
    authoring_session_id: authoringId,
    due_at: dueAt,
    run_id: null,
    error: null,
  });
  emit(deps, row);
  try {
    const { engine, model } = resolveAgentSpawnEngineAndModel(deps.config, agent, row.requested_by);
    s.createSession.run(
      authoringId,
      agent.id,
      `[QA plan] ${title}`.slice(0, 100),
      engine,
      model,
      0,
      0,
      1,
    );
    // Hidden like run sessions: it is read from the plan page, not the sidebar.
    s.markSessionHidden.run(authoringId);
    setSessionOwner(authoringId, row.requested_by);
    s.updateSessionMode.run('qa', authoringId);
    s.setQaPlanAuthoringSession.run(authoringId, planId);
    await kickoffSeededTurn({
      handleChat: deps.handleChat,
      agentId: agent.id,
      sessionId: authoringId,
      content: buildQaSessionAuthoringSeed({
        project,
        plan: { id: planId, title, target_url: environment.baseUrl },
        environment,
        environments: listQaEnvironments(project.id),
        context,
      }),
    });
  } catch (e) {
    console.error('[qa] session-requested authoring failed to start:', e);
    s.setQaPlanAuthoringSession.run(null, planId);
    abandonUnseededSession(s, authoringId);
    if (getQaSessionRequest(sessionId)?.status === 'authoring') {
      update(sessionId, { status: 'failed', error: 'The QA agent session failed to start.' });
      emit(deps, row);
    }
  }
}

/**
 * Every transition of a session's request runs under this per-session lock, so
 * a launch, a turn end, a sweep, a timer, and a /run or checkbox call can never
 * interleave: each sees the row the previous one left. Callers inside the lock
 * use the unlocked `advance` / `finishAuthoring` helpers.
 */
const locks = new Map<string, Promise<void>>();

function withRequestLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(sessionId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(sessionId, tail);
  void tail.then(() => {
    if (locks.get(sessionId) === tail) locks.delete(sessionId);
  });
  return run;
}

const PLAN_DELETED = 'The QA plan was deleted. Run QA Tests again to draft a new one.';

/** A drafting or waiting request whose plan was deleted (the FK nulls plan_id). */
function planGone(row: QaSessionRequestRow): boolean {
  return !row.plan_id || !getStmts().getQaPlan.get(row.plan_id);
}

async function finishAuthoring(
  deps: QaSessionRunDeps,
  authoringSessionId: string,
  outcome: 'turn_ended' | 'spawn_failed',
): Promise<void> {
  const row = getDb()
    .prepare(
      `SELECT * FROM qa_session_requests WHERE authoring_session_id = ? AND status = 'authoring'`,
    )
    .get(authoringSessionId) as QaSessionRequestRow | undefined;
  if (!row) return;
  const fail = (error: string) => {
    update(row.session_id, { status: 'failed', error });
    emit(deps, row);
  };
  if (planGone(row)) return fail(PLAN_DELETED);
  if (outcome === 'spawn_failed') return fail('The QA agent turn failed before drafting cases.');
  const planId = row.plan_id!;
  const cases = getStmts().countQaCasesByPlan.get(planId)?.n ?? 0;
  if (cases === 0) return fail('The QA agent did not draft any cases. Open the plan to add some.');
  try {
    approveQaPlan(planId, row.requested_by);
  } catch (e) {
    return fail(`Could not approve the plan: ${e instanceof Error ? e.message : String(e)}`);
  }
  deps.broadcast({
    type: 'qa_update',
    projectId: row.project_id,
    planId,
    action: 'plan_approved',
  });
  update(row.session_id, { status: 'waiting' });
  emit(deps, row);
  await advance(deps, row.session_id);
}

/** The drafting turn ended: approve the plan and wait for `due_at`. Never throws. */
export async function finishQaSessionAuthoring(
  deps: QaSessionRunDeps,
  authoringSessionId: string,
  outcome: 'turn_ended' | 'spawn_failed',
): Promise<void> {
  const owner = getDb()
    .prepare('SELECT session_id FROM qa_session_requests WHERE authoring_session_id = ?')
    .get(authoringSessionId) as { session_id: string } | undefined;
  if (!owner) return;
  try {
    await withRequestLock(owner.session_id, () =>
      finishAuthoring(deps, authoringSessionId, outcome),
    );
  } catch (e) {
    console.error(`[qa] finishing session-requested authoring failed:`, e);
  }
}

const dueTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleDue(deps: QaSessionRunDeps, sessionId: string, dueAt: number): void {
  const existing = dueTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(
    () => {
      dueTimers.delete(sessionId);
      void processQaSessionRequest(deps, sessionId);
    },
    Math.max(0, dueAt - Date.now()) + 500,
  );
  timer.unref?.();
  dueTimers.set(sessionId, timer);
}

/** How soon a request tracking another launch looks again if no broadcast arrives. */
const IN_FLIGHT_RECHECK_MS = 60_000;

/**
 * Whether a QA run ever reached an agent: it finished with a verdict
 * (passed / failed), has results, or its QA session holds the seed turn.
 * Status alone is not proof: `launchQaRun` marks a run running before the
 * seed persists, and a run cancelled before it was seeded (a failed spawn, or
 * recovery discarding an interrupted launch) never executed anything.
 */
export function qaRunReachedAgent(run: Pick<QaRunRow, 'id' | 'status' | 'session_id'>): boolean {
  if (run.status === 'passed' || run.status === 'failed') return true;
  const db = getDb();
  if (db.prepare('SELECT 1 FROM qa_results WHERE run_id = ? LIMIT 1').get(run.id)) return true;
  if (!run.session_id) return false;
  return !!db
    .prepare(`SELECT 1 FROM messages WHERE session_id = ? AND role = 'user' LIMIT 1`)
    .get(run.session_id);
}

/**
 * What a request due to run does about the latest run on its plan. The plan
 * is the request's own, so that run came from the request's launch or from a
 * person, and the request is satisfied by any run that reached an agent.
 *   link     it reached an agent, or `launchQaRun` in this process is still
 *            launching it (`isQaRunLaunchInFlight`): use it.
 *   discard  queued / running, never seeded, and no live launcher: the launch
 *            that created it died with its process. Cancel it, then launch.
 *   launch   cancelled before it reached an agent: launch a new one.
 * Liveness comes from the launcher's own in-memory registry, never from
 * timestamps, so the rule holds whatever the request's status and wherever a
 * restart cut the previous attempt off, and recovery never needs to remember it.
 */
export function existingRunAction(
  run: Pick<QaRunRow, 'id' | 'status' | 'session_id'>,
): 'link' | 'discard' | 'launch' {
  if (qaRunReachedAgent(run)) return 'link';
  if (run.status === 'queued' || run.status === 'running') {
    return isQaRunLaunchInFlight(run.id) ? 'link' : 'discard';
  }
  return 'launch';
}

/** Cancel a run an interrupted launch left behind, and drop its empty session. */
function discardUnstartedRun(deps: QaSessionRunDeps, run: QaRunRow): void {
  const s = getStmts();
  try {
    cancelQaRun(run.id);
  } catch (e) {
    console.warn(`[qa] could not cancel interrupted run ${run.id}:`, e);
  }
  if (run.session_id) {
    s.setQaRunSession.run(null, run.id);
    abandonUnseededSession(s, run.session_id);
  }
  const plan = s.getQaPlan.get(run.plan_id);
  deps.broadcast({
    type: 'qa_update',
    projectId: plan?.project_id ?? null,
    planId: run.plan_id,
    action: 'run_cancelled',
    runId: run.id,
  });
}

/** Advance one request as far as it can go right now. Call under the lock. */
async function advance(
  deps: QaSessionRunDeps,
  sessionId: string,
  now = Date.now(),
  retried = false,
): Promise<QaSessionRequestStatus | null> {
  const row = getQaSessionRequest(sessionId);
  if (!row) return null;
  if (row.status === 'armed') {
    const session = getStmts().getSession.get(sessionId) as SessionRow | undefined;
    const project = deps.findProject(row.project_id);
    if (!session || !project) return 'armed';
    await reconcileSessionMerge(deps, session, project);
    if (sessionMergedAt(session, project) === null) return 'armed';
    await startAuthoring(deps, sessionId);
    return getQaSessionRequest(sessionId)?.status ?? null;
  }
  if ((row.status === 'authoring' || row.status === 'waiting') && planGone(row)) {
    // Nothing can finish this request: fail it so the control stops being busy
    // and "Run QA Tests" can start over.
    update(sessionId, { status: 'failed', error: PLAN_DELETED });
    emit(deps, row);
    return 'failed';
  }
  if (row.status === 'authoring' && !row.authoring_session_id) {
    update(sessionId, { status: 'failed', error: 'The QA agent session is gone.' });
    emit(deps, row);
    return 'failed';
  }
  if (row.status !== 'waiting' && row.status !== 'launching') return row.status;
  if (row.status === 'waiting' && row.due_at != null && now < row.due_at) {
    scheduleDue(deps, sessionId, row.due_at);
    return 'waiting';
  }
  // A `launching` row seen here means a restart cut a launch off (every
  // in-process launch leaves that state before releasing the lock), but the
  // decision does not depend on it: see `existingRunAction`.
  const existingRun = row.plan_id ? getStmts().getLatestQaRun.get(row.plan_id) : undefined;
  const action = existingRun ? existingRunAction(existingRun) : 'launch';
  if (existingRun && action === 'link') {
    if (!qaRunReachedAgent(existingRun)) {
      // Someone else's launch is still in flight. Track its run but stay
      // `launching`: its run_started / run_cancelled broadcast (or the
      // fallback timer) re-checks, and a launch that fails is replaced.
      update(sessionId, { status: 'launching', run_id: existingRun.id, error: null });
      emit(deps, row);
      scheduleDue(deps, sessionId, now + IN_FLIGHT_RECHECK_MS);
      return 'launching';
    }
    update(sessionId, { status: 'started', run_id: existingRun.id, error: null });
    emit(deps, row);
    return 'started';
  }
  if (existingRun && action === 'discard') discardUnstartedRun(deps, existingRun);
  update(sessionId, { status: 'launching' });
  emit(deps, row);
  const plan = row.plan_id ? getStmts().getQaPlan.get(row.plan_id) : undefined;
  let error: string;
  if (!plan) {
    error = PLAN_DELETED;
  } else {
    try {
      const result = await launchQaRun(deps, plan, {
        scope: 'full',
        startedBy: row.requested_by,
        ownerUserId: row.requested_by,
      });
      if (result.ok) {
        update(sessionId, { status: 'started', run_id: result.run.id, error: null });
        emit(deps, row);
        return 'started';
      }
      error = result.error;
    } catch (e) {
      if (e instanceof QaStatusError && e.code === 'run_active' && !retried) {
        // Someone started the plan first. Their run goes through the same
        // rule as any other (linked once it reaches an agent, tracked while
        // its launch is live), never assumed to have executed.
        return advance(deps, sessionId, now, true);
      }
      error = e instanceof Error ? e.message : String(e);
    }
  }
  update(sessionId, { status: 'failed', error: `The QA run could not start: ${error}` });
  emit(deps, row);
  return 'failed';
}

/** Advance one request as far as it can go right now. Never throws. */
export async function processQaSessionRequest(
  deps: QaSessionRunDeps,
  sessionId: string,
  now = Date.now(),
): Promise<QaSessionRequestStatus | null> {
  try {
    return await withRequestLock(sessionId, () => advance(deps, sessionId, now));
  } catch (e) {
    console.error(`[qa] session request failed session=${sessionId}:`, e);
    return null;
  }
}

/** Whether a request can be replaced by a fresh one (nothing in progress). */
function isReplaceable(row: QaSessionRequestRow | null): boolean {
  return !row || row.status === 'failed' || row.status === 'started';
}

function resetToArmed(sessionId: string, projectId: string, userId: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO qa_session_requests (session_id, project_id, status, requested_by)
       VALUES (?, ?, 'armed', ?)
       ON CONFLICT(session_id) DO UPDATE SET status = 'armed', requested_by = excluded.requested_by,
         project_id = excluded.project_id, plan_id = NULL, authoring_session_id = NULL,
         run_id = NULL, due_at = NULL, error = NULL, updated_at = datetime('now')`,
    )
    .run(sessionId, projectId, userId);
}

/**
 * Tick or untick the session's "Run QA Tests" checkbox. Ticking arms the
 * request (it fires when the session merges, or at once if it already has);
 * unticking removes an armed request. A request past `armed` is left alone.
 */
export function setQaSessionRequestArmed(
  deps: QaSessionRunDeps,
  session: SessionRow,
  project: Project,
  armed: boolean,
  userId: string | null,
): Promise<QaSessionRequestRow | null> {
  return withRequestLock(session.id, async () => {
    const existing = getQaSessionRequest(session.id);
    if (!armed) {
      if (existing?.status === 'armed') {
        getDb().prepare('DELETE FROM qa_session_requests WHERE session_id = ?').run(session.id);
        emit(deps, { session_id: session.id, project_id: project.id });
      }
      return getQaSessionRequest(session.id);
    }
    if (existing && !isReplaceable(existing)) return existing;
    preflight(project);
    resetToArmed(session.id, project.id, userId);
    emit(deps, { session_id: session.id, project_id: project.id });
    await advance(deps, session.id);
    return getQaSessionRequest(session.id);
  });
}

/**
 * The "Run QA Tests" button: start drafting now. Refused with 409
 * `not_merged` until the session's PR merged. The run still waits for the
 * project's delay after the merge when that has not passed yet. A call that
 * arrives while another transition (a launch included) is running waits for
 * it, then sees its result: a request still drafting or waiting is returned
 * as is, a finished one is replaced by a fresh plan.
 */
export function runQaSessionRequestNow(
  deps: QaSessionRunDeps,
  session: SessionRow,
  project: Project,
  userId: string | null,
): Promise<QaSessionRequestRow> {
  return withRequestLock(session.id, async () => {
    const existing = getQaSessionRequest(session.id);
    if (existing && !isReplaceable(existing) && existing.status !== 'armed') return existing;
    preflight(project);
    await reconcileSessionMerge(deps, session, project);
    if (sessionMergedAt(session, project) === null) {
      throw new QaSessionRequestError(
        'This session has not merged yet. Tick "Run QA Tests" to run QA once it merges.',
        409,
        'not_merged',
      );
    }
    resetToArmed(session.id, project.id, userId);
    await startAuthoring(deps, session.id);
    return getQaSessionRequest(session.id)!;
  });
}

/** Re-check every open request of a project (armed ones wait on the merge). */
export async function sweepProjectQaSessionRequests(
  deps: QaSessionRunDeps,
  projectId: string,
): Promise<void> {
  const ids = (
    getDb()
      .prepare(
        `SELECT session_id FROM qa_session_requests WHERE project_id = ? AND status IN ('armed', 'authoring', 'waiting', 'launching')`,
      )
      .all(projectId) as Array<{ session_id: string }>
  ).map((r) => r.session_id);
  for (const id of ids) await processQaSessionRequest(deps, id);
}

let sessionDeps: QaSessionRunDeps | null = null;
let unsubscribeTurnEnds: (() => void) | null = null;
const pendingSweeps = new Map<string, ReturnType<typeof setTimeout>>();
const SWEEP_DEBOUNCE_MS = 2000;
/** A github.com merge made outside the Hub sends no event, so armed requests are polled. */
export const ARMED_POLL_MS = 5 * 60_000;
let armedPoll: ReturnType<typeof setInterval> | null = null;

/** Re-check every armed request (each reconciles its github.com merge state). */
export async function sweepArmedQaSessionRequests(deps: QaSessionRunDeps): Promise<void> {
  const ids = (
    getDb()
      .prepare(`SELECT session_id FROM qa_session_requests WHERE status = 'armed'`)
      .all() as Array<{
      session_id: string;
    }>
  ).map((r) => r.session_id);
  for (const id of ids) await processQaSessionRequest(deps, id);
}

/** Wire the trigger to the server's deps and the turn-end bus. */
export function initQaSessionRuns(deps: QaSessionRunDeps): void {
  sessionDeps = deps;
  unsubscribeTurnEnds?.();
  unsubscribeTurnEnds = subscribeAllTurnEnds((sid, outcome) => {
    if (sessionDeps) void finishQaSessionAuthoring(sessionDeps, sid, outcome);
  });
  if (armedPoll) clearInterval(armedPoll);
  armedPoll = setInterval(() => {
    if (sessionDeps) void sweepArmedQaSessionRequests(sessionDeps);
  }, ARMED_POLL_MS);
  armedPoll.unref?.();
}

/** Broadcasts that can mean a session's work merged. */
export function qaSessionRequestProjectFor(data: Record<string, unknown>): string | null {
  const projectId = typeof data.projectId === 'string' ? data.projectId : null;
  if (!projectId) return null;
  if (data.type === 'native_pr_update' && data.action === 'merged') return projectId;
  // Emitted by handleGithubCardOnMerge after it records a github.com merge.
  if (data.type === 'webhook_pr_merged') return projectId;
  // A deleted plan fails the request drafting or waiting on it; a run starting
  // or being cancelled settles a request tracking someone else's launch.
  if (
    data.type === 'qa_update' &&
    (data.action === 'plan_deleted' ||
      data.action === 'run_started' ||
      data.action === 'run_cancelled')
  )
    return projectId;
  return null;
}

export function observeBroadcastForQaSessionRuns(data: Record<string, unknown>): void {
  if (!sessionDeps) return;
  const projectId = qaSessionRequestProjectFor(data);
  if (!projectId) return;
  const existing = pendingSweeps.get(projectId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingSweeps.delete(projectId);
    if (sessionDeps) void sweepProjectQaSessionRequests(sessionDeps, projectId);
  }, SWEEP_DEBOUNCE_MS);
  timer.unref?.();
  pendingSweeps.set(projectId, timer);
}

/**
 * Boot catch-up. A drafting turn that ended while the server was down never
 * reaches the turn-end bus, so an `authoring` request whose session is idle is
 * finished here; a `launching` request is linked to its run or relaunched.
 */
export async function sweepAllQaSessionRequests(deps: QaSessionRunDeps): Promise<void> {
  const rows = getDb()
    .prepare(
      `SELECT * FROM qa_session_requests WHERE status IN (${OPEN_STATUSES.map(() => '?').join(', ')})`,
    )
    .all(...OPEN_STATUSES) as QaSessionRequestRow[];
  const s = getStmts();
  for (const row of rows) {
    if (row.status === 'authoring') {
      if (planGone(row) || !row.authoring_session_id) {
        await processQaSessionRequest(deps, row.session_id);
        continue;
      }
      const task = s.getActiveTask.get(row.authoring_session_id) as { status?: string } | undefined;
      if (task?.status === 'running') continue;
      await finishQaSessionAuthoring(deps, row.authoring_session_id, 'turn_ended');
      continue;
    }
    await processQaSessionRequest(deps, row.session_id);
  }
}

/** Test-only reset of timers and wiring. */
export function __testResetQaSessionRuns(): void {
  for (const t of dueTimers.values()) clearTimeout(t);
  dueTimers.clear();
  for (const t of pendingSweeps.values()) clearTimeout(t);
  pendingSweeps.clear();
  locks.clear();
  if (armedPoll) clearInterval(armedPoll);
  armedPoll = null;
  unsubscribeTurnEnds?.();
  unsubscribeTurnEnds = null;
  sessionDeps = null;
}
