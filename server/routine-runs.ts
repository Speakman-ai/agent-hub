/**
 * Scheduled routine runs (SPEC-7).
 *
 * A cron with `routine_skill` set does not run a headless one-shot prompt.
 * Each run opens a consult chat session for the cron owner under the cron's
 * agent, with the routine skill preloaded, so the run gets what an interactive
 * turn gets: the `browser` ReAct tool, the owner's browser profile (keyed on
 * owner + agent + project), sign-in handoff and the approval gates. Consult
 * mode keeps code edits and Finalize out of a scheduled run.
 *
 * The run is tracked from dispatch until the session's terminal turn (no
 * ReAct continuation pending), then the cron log gets the result and a
 * `routine_run_finished` broadcast puts it in the owner's notification inbox.
 * A turn waiting on an approval or a sign-in stays open, so a run can span
 * hours. The session-to-run link lives in the `routine_runs` table, so a turn
 * that crash-resumes after a Hub restart still settles its run. At boot,
 * `reconcileRoutineRunsOnBoot` settles every stored run whose session is not
 * being resumed as interrupted, so no log row stays `running` and the owner
 * still hears about it.
 */
import type { BackgroundCustomAgentConfig, BroadcastFn, CronRow, Project, Stmts } from './types.js';
import { randomUUID } from 'crypto';
import {
  dispatchBackgroundAgentSession,
  pickBackgroundSessionAgent,
  type BackgroundSessionDispatchResult,
} from './background-agent-session.js';
import { resolveCronSkillPrincipalAgentId } from './cron-skill-principal.js';

export const ROUTINE_RUN_FINISHED_EVENT = 'routine_run_finished';
export const ROUTINE_SESSION_PREFIX = '[Routine]';

const RESULT_MAX_CHARS = 8_000;
const PREVIEW_MAX_CHARS = 300;

export interface RoutineRunRecord {
  cronId: number;
  cronName: string;
  logId: number;
  skill: string;
  projectId: string;
  agentId: string;
  ownerUserId: string | null;
  cronShared: boolean;
  startedAt: number;
}

export const ROUTINE_SESSION_GONE_MESSAGE = 'The run session was deleted before it finished.';

export const ROUTINE_INTERRUPTED_MESSAGE =
  'Interrupted by a Hub restart before it finished. The next scheduled run starts fresh.';

interface RoutineRunRow {
  session_id: string;
  cron_id: number;
  cron_name: string;
  log_id: number;
  skill: string;
  project_id: string;
  agent_id: string;
  owner_user_id: string | null;
  cron_shared: number;
  started_at: number;
}

type RoutineRunStmts = Pick<
  Stmts,
  | 'addCronLog'
  | 'updateCronLog'
  | 'updateCronResult'
  | 'insertRoutineRun'
  | 'getRoutineRun'
  | 'getRoutineRunByCron'
  | 'getAllRoutineRuns'
  | 'deleteRoutineRun'
  | 'getSession'
>;

function fromRow(row: RoutineRunRow): RoutineRunRecord {
  return {
    cronId: row.cron_id,
    cronName: row.cron_name,
    logId: row.log_id,
    skill: row.skill,
    projectId: row.project_id,
    agentId: row.agent_id,
    ownerUserId: row.owner_user_id,
    cronShared: Boolean(row.cron_shared),
    startedAt: row.started_at,
  };
}

export interface RoutineRunDeps {
  stmts: RoutineRunStmts;
  broadcast: BroadcastFn | null;
  dispatch?: (
    project: Project,
    cfg: BackgroundCustomAgentConfig,
    opts: Parameters<typeof dispatchBackgroundAgentSession>[2],
  ) => BackgroundSessionDispatchResult;
  now?: () => number;
  /** Session id generator; injectable so tests can name sessions. */
  newSessionId?: () => string;
}

export interface RoutineRunStart {
  logId: number;
  status: 'success' | 'error';
  result: string;
  sessionId: string | null;
}

export function routineSessionName(cronName: string): string {
  return `${ROUTINE_SESSION_PREFIX} ${cronName}`;
}

/** Kickoff for a scheduled run. The skill itself carries the steps. */
export function buildRoutineRunPrompt(cron: Pick<CronRow, 'prompt' | 'routine_skill'>): string {
  const skill = cron.routine_skill ?? '';
  const extra = (cron.prompt ?? '').trim();
  return [
    `Scheduled run of the \`${skill}\` routine. The skill is loaded above; follow its steps now using the \`browser\` tool.`,
    'Nobody is watching this turn live. If a page needs sign-in, use `request_login` and wait. Ask for approval before anything irreversible.',
    'If the skill failed to load, stop and say so.',
    "Finish with a short report: what you did, what you checked, and anything that didn't match the steps.",
    extra ? `\nNotes from the routine's owner:\n${extra}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The run a session belongs to, or undefined. */
export function getRoutineRunForSession(
  stmts: Pick<Stmts, 'getRoutineRun'>,
  sessionId: string,
): RoutineRunRecord | undefined {
  const row = stmts.getRoutineRun.get(sessionId) as RoutineRunRow | undefined;
  return row ? fromRow(row) : undefined;
}

function runningSessionForCron(stmts: Pick<Stmts, 'getRoutineRunByCron'>, cronId: number) {
  const row = stmts.getRoutineRunByCron.get(cronId) as RoutineRunRow | undefined;
  return row?.session_id ?? null;
}

function runSessionGone(stmts: Pick<Stmts, 'getSession'>, sessionId: string): boolean {
  try {
    const row = stmts.getSession.get(sessionId) as { deleted_at?: string | null } | undefined;
    return !row || Boolean(row.deleted_at);
  } catch {
    return false;
  }
}

/** Drop control blocks and collapse whitespace for a notification preview. */
export function routineResultPreview(text: string): string {
  const flat = text
    .replace(/<agenthub:[a-z-]+>[\s\S]*?<\/agenthub:[a-z-]+>/g, '')
    .replace(/```agenthub:[\s\S]*?```/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > PREVIEW_MAX_CHARS ? `${flat.slice(0, PREVIEW_MAX_CHARS - 1)}…` : flat;
}

/**
 * What a terminal routine outcome is reported against. `sessionId` is null
 * when the run never got a session (bad config, dispatch failure).
 */
interface SettleTarget {
  sessionId: string | null;
  cronId: number;
  cronName: string;
  logId: number;
  skill: string;
  projectId: string | null;
  agentId: string | null;
  ownerUserId: string | null;
  cronShared: boolean;
  startedAt: number;
}

type SettleDeps = Pick<RoutineRunDeps, 'broadcast' | 'now'> & {
  stmts: Pick<RoutineRunStmts, 'updateCronLog' | 'updateCronResult'>;
};

/**
 * The single place a routine run ends. Every terminal path (startup failure,
 * finished turn, errored turn, restart reconcile) comes through here, so each
 * one writes the cron log, emits `cron_finished` for chat triggers and emits
 * `routine_run_finished` for the owner's inbox. Never throws.
 */
function settleRoutineRun(
  deps: SettleDeps,
  run: SettleTarget,
  outcome: { finalContent?: string | null; error?: string | null },
): void {
  const now = deps.now ?? Date.now;
  const durationMs = Math.max(0, now() - run.startedAt);
  const ok = !outcome.error;
  const body = ok
    ? (outcome.finalContent ?? '').trim() || 'Routine finished with no report.'
    : `Routine failed: ${outcome.error}`;
  const result = body.length > RESULT_MAX_CHARS ? `${body.slice(0, RESULT_MAX_CHARS)}…` : body;
  const status = ok ? 'success' : 'error';
  try {
    deps.stmts.updateCronLog.run(result, status, durationMs, run.logId);
    deps.stmts.updateCronResult.run(result, run.cronId);
  } catch (err) {
    console.warn(
      `[Routine] failed to record result for "${run.cronName}": ${(err as Error).message}`,
    );
  }
  const preview = routineResultPreview(result);
  emitCronFinished(
    deps.broadcast,
    {
      id: run.cronId,
      name: run.cronName,
      owner_user_id: run.ownerUserId,
      shared: run.cronShared ? 1 : 0,
    },
    run.projectId,
    { logId: run.logId, status, durationMs, preview },
  );
  try {
    deps.broadcast?.({
      type: ROUTINE_RUN_FINISHED_EVENT,
      sessionId: run.sessionId,
      projectId: run.projectId,
      agentId: run.agentId,
      cronId: run.cronId,
      cronName: run.cronName,
      logId: run.logId,
      skill: run.skill,
      status,
      durationMs,
      preview,
      ownerUserId: run.ownerUserId,
    });
  } catch (err) {
    console.warn(
      `[Routine] finished broadcast failed for "${run.cronName}": ${(err as Error).message}`,
    );
  }
}

/**
 * Start a routine run for `cron`. Never throws: a failure before a session
 * exists is settled like any other run (cron log, chat triggers, inbox).
 */
export function startRoutineRun(
  cron: CronRow,
  project: Project | null,
  deps: RoutineRunDeps,
): RoutineRunStart {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const logId = Number(deps.stmts.addCronLog.run(cron.id, 'running').lastInsertRowid);
  const skill = (cron.routine_skill ?? '').trim();
  const fail = (message: string): RoutineRunStart => {
    settleRoutineRun(
      deps,
      {
        sessionId: null,
        cronId: cron.id,
        cronName: cron.name,
        logId,
        skill,
        projectId: project?.id ?? cron.project_id ?? null,
        agentId: null,
        ownerUserId: cron.owner_user_id ?? null,
        cronShared: Boolean(cron.shared),
        startedAt,
      },
      { error: message },
    );
    return { logId, status: 'error', result: `Routine failed: ${message}`, sessionId: null };
  };

  if (!project) return fail('Routine cron has no project');
  if (!skill) return fail('Routine has no skill configured');
  let busy: string | null;
  try {
    busy = runningSessionForCron(deps.stmts, cron.id);
  } catch (err) {
    return fail(`Could not check for a run in progress: ${(err as Error).message}`);
  }
  // A deleted session can never reach a turn end, so its run would hold the
  // cron forever. Settle it here and let this tick start fresh. A live session
  // with no CLI running may be waiting on an approval or sign-in, so that alone
  // is not treated as stale.
  if (busy && runSessionGone(deps.stmts, busy)) {
    finishRoutineRun(deps, { sessionId: busy, error: ROUTINE_SESSION_GONE_MESSAGE });
    busy = null;
  }
  if (busy) return fail(`Previous run is still in progress (session ${busy})`);

  const sessionAgentId = resolveCronSkillPrincipalAgentId(cron, project) ?? null;
  const agent = pickBackgroundSessionAgent(project, sessionAgentId);
  if (!agent) {
    return fail(
      sessionAgentId
        ? `Agent "${sessionAgentId}" cannot host a routine session`
        : 'This project has no agent that can host a routine session',
    );
  }

  // Track first, run second. The row is written under the session id the
  // dispatch will use, before any turn can start, so a run that can't be
  // tracked never executes, and the unique index on cron_id makes this insert
  // the overlap guard even if two ticks race.
  const sessionId = (deps.newSessionId ?? randomUUID)();
  try {
    deps.stmts.insertRoutineRun.run(
      sessionId,
      cron.id,
      cron.name,
      logId,
      skill,
      project.id,
      agent.id,
      cron.owner_user_id ?? null,
      cron.shared ? 1 : 0,
      startedAt,
    );
  } catch (err) {
    const message = (err as Error).message;
    return fail(
      /UNIQUE/i.test(message)
        ? 'Previous run is still in progress'
        : `Could not track the run, so it was not started: ${message}`,
    );
  }

  const dispatch = deps.dispatch ?? dispatchBackgroundAgentSession;
  let started: BackgroundSessionDispatchResult;
  try {
    started = dispatch(
      project,
      {
        id: `routine:${cron.id}`,
        name: cron.name,
        prompt: buildRoutineRunPrompt(cron),
        ownerUserId: cron.owner_user_id ?? null,
        engine: cron.engine ?? null,
        model: cron.model ?? null,
        runAsSession: true,
        sessionMode: 'consult',
        sessionAgentId: agent.id,
        skills: [skill],
      },
      {
        sessionId,
        sessionName: routineSessionName(cron.name),
        skillReason: `routine "${cron.name}"`,
        onKickoffError: (message) => finishRoutineRun(deps, { sessionId, error: message }),
      },
    );
  } catch (err) {
    // No session was created, so release the cron. If even the delete fails,
    // the row points at a session that does not exist and the next tick's
    // deleted-session check clears it.
    try {
      deps.stmts.deleteRoutineRun.run(sessionId);
    } catch (delErr) {
      console.warn(`[Routine] could not release run ${sessionId}: ${(delErr as Error).message}`);
    }
    return fail(`Routine session failed to start: ${(err as Error).message}`);
  }

  if (started.skippedSkills.includes(skill)) {
    console.warn(`[Routine] "${cron.name}": skill "${skill}" did not load`);
  }
  const result = `Routine started in session ${sessionId}`;
  deps.stmts.updateCronResult.run(result, cron.id);
  return { logId, status: 'success', result, sessionId };
}

/**
 * Settle the routine run that owns `sessionId`, if any. Called by chat.ts on a
 * terminal turn (`finalContent`) and on every errored turn end (`error`).
 * Returns true when a run was settled.
 */
export function finishRoutineRun(
  deps: SettleDeps & {
    stmts: Pick<RoutineRunStmts, 'getRoutineRun' | 'deleteRoutineRun'>;
  },
  args: { sessionId: string; finalContent?: string | null; error?: string | null },
): boolean {
  let run: RoutineRunRecord | undefined;
  try {
    run = getRoutineRunForSession(deps.stmts, args.sessionId);
    // The delete is the claim: two turn-end paths racing for one run settle it once.
    if (!run || deps.stmts.deleteRoutineRun.run(args.sessionId).changes !== 1) return false;
  } catch (err) {
    console.warn(`[Routine] run lookup failed for ${args.sessionId}: ${(err as Error).message}`);
    return false;
  }
  settleRoutineRun(deps, { ...run, sessionId: args.sessionId }, args);
  return true;
}

/** The server-only `cron_finished` event chat triggers listen for. */
export function emitCronFinished(
  broadcast: BroadcastFn | null,
  cron: Pick<CronRow, 'id' | 'name' | 'owner_user_id' | 'shared'>,
  projectId: string | null,
  run: { logId: number | bigint; status: 'success' | 'error'; durationMs: number; preview: string },
): void {
  if (!broadcast || !projectId) return;
  try {
    broadcast({
      type: 'cron_finished',
      projectId,
      cronId: cron.id,
      cronName: cron.name,
      logId: Number(run.logId),
      status: run.status,
      durationMs: run.durationMs,
      preview: run.preview.slice(0, 500),
      ownerUserId: cron.owner_user_id ?? null,
      cronShared: Boolean(cron.shared),
      suppressWebSocket: true,
      suppressPush: true,
    });
  } catch (err) {
    console.error(
      `[Cron] cron_finished broadcast failed for "${cron.name}":`,
      (err as Error).message,
    );
  }
}

/**
 * Boot pass, after `reconcileOrphanedTasks`. A stored run whose session is
 * being crash-resumed stays open (its resumed turn settles it). Any other run
 * lost its turn with the old process, so it is settled as failed: the cron log
 * leaves `running`, the overlap guard frees the cron, and the owner gets the
 * inbox notification. Returns the number of runs settled.
 */
export function reconcileRoutineRunsOnBoot(
  deps: Pick<RoutineRunDeps, 'stmts' | 'broadcast' | 'now'>,
  resumingSessionIds: Iterable<string>,
): number {
  const resuming = new Set(resumingSessionIds);
  let rows: RoutineRunRow[];
  try {
    rows = deps.stmts.getAllRoutineRuns.all() as RoutineRunRow[];
  } catch (err) {
    console.error('[Routine] boot reconcile failed to list runs:', (err as Error).message);
    return 0;
  }
  let settled = 0;
  for (const row of rows) {
    if (resuming.has(row.session_id)) continue;
    if (finishRoutineRun(deps, { sessionId: row.session_id, error: ROUTINE_INTERRUPTED_MESSAGE })) {
      settled += 1;
    }
  }
  if (settled > 0) console.log(`[Routine] settled ${settled} run(s) interrupted by the restart`);
  return settled;
}
