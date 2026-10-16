/**
 * Routine cron runs: dispatch opens a consult session for the cron owner with
 * the routine skill preloaded, and the terminal turn settles the cron log and
 * emits the inbox event. The session dispatcher is injected (no CLI, no chat).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronRow, Project } from './types.js';
import {
  ROUTINE_INTERRUPTED_MESSAGE,
  ROUTINE_SESSION_GONE_MESSAGE,
  buildRoutineRunPrompt,
  finishRoutineRun,
  getRoutineRunForSession as getRun,
  reconcileRoutineRunsOnBoot,
  routineResultPreview,
  startRoutineRun,
  type RoutineRunDeps,
} from './routine-runs.js';

function cron(overrides: Partial<CronRow> = {}): CronRow {
  return {
    id: 7,
    name: 'Weekly export',
    schedule: '0 9 * * 1',
    timezone: null,
    prompt: 'Only the EU account.',
    cwd: '/tmp',
    enabled: 1,
    last_run: null,
    last_result: null,
    next_run_at: null,
    project_id: 'p1',
    timeout_ms: null,
    notify_on_run: 0,
    model: null,
    skill_principal_agent_id: 'ops',
    engine: null,
    owner_user_id: 'user-1',
    shared: 0,
    routine_skill: 'weekly-export',
    created_at: '',
    ...overrides,
  };
}

const project = {
  id: 'p1',
  name: 'Acme',
  agents: [{ id: 'dev' }, { id: 'ops' }],
} as unknown as Project;

/**
 * Stand-in for the `routine_runs` table. It outlives any one `deps` object,
 * so building fresh deps over the same table models a Hub restart.
 */
let table = new Map<string, Record<string, unknown>>();
let deletedSessions = new Set<string>();
function routineStmts() {
  return {
    insertRoutineRun: {
      run: vi.fn((...a: unknown[]) => {
        const keys = ['session_id', 'cron_id', 'cron_name', 'log_id', 'skill', 'project_id'];
        const more = ['agent_id', 'owner_user_id', 'cron_shared', 'started_at'];
        if ([...table.values()].some((r) => r.cron_id === a[1])) {
          throw new Error('UNIQUE constraint failed: routine_runs.cron_id');
        }
        table.set(a[0] as string, Object.fromEntries([...keys, ...more].map((k, i) => [k, a[i]])));
        return { changes: 1 };
      }),
    },
    getRoutineRun: { get: vi.fn((id: string) => table.get(id)) },
    getRoutineRunByCron: {
      get: vi.fn((cronId: number) => [...table.values()].find((r) => r.cron_id === cronId)),
    },
    getAllRoutineRuns: { all: vi.fn(() => [...table.values()]) },
    deleteRoutineRun: { run: vi.fn((id: string) => ({ changes: table.delete(id) ? 1 : 0 })) },
    getSession: {
      get: vi.fn((id: string) => (deletedSessions.has(id) ? undefined : { id, deleted_at: null })),
    },
  };
}

let clock = 1_000;
let seq = 0;
/** Mirrors the real dispatcher: the session uses the id it was handed. */
const echoDispatch = () =>
  vi.fn((_p: Project, _c: unknown, opts: { sessionId?: string }) => ({
    sessionId: opts.sessionId ?? 'unset',
    agentId: 'ops',
    skippedSkills: [] as string[],
  }));
function makeDeps(dispatch: ReturnType<typeof vi.fn> = echoDispatch()) {
  const deps = {
    stmts: {
      addCronLog: { run: vi.fn(() => ({ lastInsertRowid: 42, changes: 1 })) },
      updateCronLog: { run: vi.fn() },
      updateCronResult: { run: vi.fn() },
      ...routineStmts(),
    },
    broadcast: vi.fn(),
    dispatch,
    now: () => clock,
    newSessionId: () => `sess-${++seq}`,
  };
  return deps as typeof deps & RoutineRunDeps;
}

beforeEach(() => {
  table = new Map();
  deletedSessions = new Set();
  seq = 0;
  clock = 1_000;
});

describe('startRoutineRun', () => {
  it('opens a consult session for the cron owner under the principal agent with the skill', () => {
    const deps = makeDeps();
    const out = startRoutineRun(cron(), project, deps);

    expect(out).toMatchObject({ logId: 42, status: 'success', sessionId: 'sess-1' });
    const [proj, cfg, opts] = deps.dispatch.mock.calls[0] as unknown as [
      Project,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(proj).toBe(project);
    expect(cfg).toMatchObject({
      ownerUserId: 'user-1',
      sessionAgentId: 'ops',
      sessionMode: 'consult',
      runAsSession: true,
      skills: ['weekly-export'],
    });
    expect(cfg.prompt).toContain('`weekly-export` routine');
    expect(cfg.prompt).toContain('Only the EU account.');
    expect(opts.sessionName).toBe('[Routine] Weekly export');
    expect(getRun(deps.stmts, 'sess-1')).toMatchObject({ cronId: 7, logId: 42 });
    // The log stays `running` until the session's terminal turn.
    expect(deps.stmts.updateCronLog.run).not.toHaveBeenCalled();
  });

  it('refuses to start a second run while the previous one is still open', () => {
    const deps = makeDeps();
    startRoutineRun(cron(), project, deps);
    const second = startRoutineRun(cron(), project, deps);
    expect(second.status).toBe('error');
    expect(second.result).toContain('still in progress');
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(deps.stmts.updateCronLog.run).toHaveBeenCalledWith(second.result, 'error', 0, 42);
  });

  it('records a dispatch failure on the cron log', () => {
    const deps = makeDeps(
      vi.fn(() => {
        throw new Error('This project has no agent that can host a background session');
      }),
    );
    const out = startRoutineRun(cron(), project, deps);
    expect(out.status).toBe('error');
    expect(out.result).toContain('no agent that can host');
    expect(getRun(deps.stmts, 'sess-1')).toBeUndefined();
  });

  describe('startup failures reach the owner inbox like any finished run', () => {
    function inboxEvent(deps: ReturnType<typeof makeDeps>) {
      return deps.broadcast.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .find((e) => e.type === 'routine_run_finished');
    }

    it.each([
      [
        'dispatch throws',
        () =>
          makeDeps(
            vi.fn(() => {
              throw new Error('no agent can host');
            }),
          ),
        cron(),
        project,
        'Routine session failed to start: no agent can host',
      ],
      ['no project', () => makeDeps(), cron(), null, 'Routine cron has no project'],
      [
        'no skill',
        () => makeDeps(),
        cron({ routine_skill: '  ' }),
        project,
        'Routine has no skill configured',
      ],
    ] as const)('%s', (_label, build, c, proj, message) => {
      const deps = build();
      const out = startRoutineRun(c, proj, deps);

      expect(out.status).toBe('error');
      expect(deps.stmts.updateCronLog.run).toHaveBeenCalledWith(
        `Routine failed: ${message}`,
        'error',
        0,
        42,
      );
      expect(inboxEvent(deps)).toMatchObject({
        sessionId: null,
        cronId: 7,
        logId: 42,
        projectId: 'p1',
        status: 'error',
        ownerUserId: 'user-1',
      });
    });

    it('a second run refused by the overlap guard is reported too', () => {
      const deps = makeDeps();
      startRoutineRun(cron(), project, deps);
      startRoutineRun(cron(), project, deps);
      expect(inboxEvent(deps)).toMatchObject({ sessionId: null, status: 'error' });
    });

    it('a run that cannot be tracked is never started', () => {
      const deps = makeDeps();
      deps.stmts.insertRoutineRun.run.mockImplementationOnce(() => {
        throw new Error('database is locked');
      });
      const out = startRoutineRun(cron(), project, deps);
      expect(out.status).toBe('error');
      expect(out.result).toContain('database is locked');
      expect(deps.dispatch).not.toHaveBeenCalled();
      expect(table.size).toBe(0);
      expect(inboxEvent(deps)).toMatchObject({ status: 'error', sessionId: null });
    });
  });

  it('stores the tracking row before the session is dispatched, under the same id', () => {
    let rowAtDispatch: unknown;
    const deps = makeDeps(
      vi.fn((_p: Project, _c: unknown, opts: { sessionId?: string }) => {
        rowAtDispatch = table.get(opts.sessionId!);
        return { sessionId: opts.sessionId!, agentId: 'ops', skippedSkills: [] };
      }),
    );
    const out = startRoutineRun(cron(), project, deps);
    expect(out.sessionId).toBe('sess-1');
    expect(rowAtDispatch).toMatchObject({ session_id: 'sess-1', cron_id: 7, agent_id: 'ops' });
  });

  it('a concurrent tick that passes the busy check still cannot start a second run', () => {
    const deps = makeDeps();
    startRoutineRun(cron(), project, deps);
    // Simulate the race: the busy lookup misses, the unique insert does not.
    deps.stmts.getRoutineRunByCron.get.mockReturnValueOnce(undefined);
    const second = startRoutineRun(cron(), project, deps);
    expect(second.status).toBe('error');
    expect(second.result).toContain('still in progress');
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(table.size).toBe(1);
  });

  it('releases the cron when dispatch throws, so the next tick can run', () => {
    const failing = makeDeps(
      vi.fn(() => {
        throw new Error('boom');
      }),
    );
    expect(startRoutineRun(cron(), project, failing).status).toBe('error');
    expect(table.size).toBe(0);
    expect(startRoutineRun(cron(), project, makeDeps()).status).toBe('success');
  });

  it('settles the run as failed when the kickoff rejects', () => {
    let kickoffError: ((m: string) => void) | undefined;
    const deps = makeDeps(
      vi.fn((_p: Project, _c: unknown, opts: { onKickoffError?: (m: string) => void }) => {
        kickoffError = opts.onKickoffError;
        return { sessionId: 'sess-1', agentId: 'ops', skippedSkills: [] };
      }) as never,
    );
    startRoutineRun(cron(), project, deps);
    kickoffError!('spawn ENOENT');
    expect(deps.stmts.updateCronLog.run).toHaveBeenCalledWith(
      'Routine failed: spawn ENOENT',
      'error',
      0,
      42,
    );
    expect(getRun(deps.stmts, 'sess-1')).toBeUndefined();
  });
});

describe('finishRoutineRun', () => {
  it('writes the final report to the cron log and broadcasts the inbox event once', () => {
    const deps = makeDeps();
    startRoutineRun(cron(), project, deps);
    clock = 61_000;

    const settled = finishRoutineRun(deps, {
      sessionId: 'sess-1',
      finalContent: 'Exported 12 rows.\n<agenthub:skill>{"name":"x"}</agenthub:skill>',
    });

    expect(settled).toBe(true);
    expect(deps.stmts.updateCronLog.run).toHaveBeenCalledWith(
      expect.stringContaining('Exported 12 rows.'),
      'success',
      60_000,
      42,
    );
    const finished = deps.broadcast.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((e) => e.type === 'routine_run_finished');
    expect(finished).toMatchObject({
      sessionId: 'sess-1',
      cronId: 7,
      logId: 42,
      status: 'success',
      ownerUserId: 'user-1',
      projectId: 'p1',
      preview: 'Exported 12 rows.',
    });
    expect(finished).not.toHaveProperty('suppressPush');
    expect(finishRoutineRun(deps, { sessionId: 'sess-1', finalContent: 'again' })).toBe(false);
  });

  it('marks an errored turn as a failed run', () => {
    const deps = makeDeps();
    startRoutineRun(cron(), project, deps);
    finishRoutineRun(deps, { sessionId: 'sess-1', finalContent: 'partial', error: 'exit 1' });
    expect(deps.stmts.updateCronLog.run).toHaveBeenCalledWith(
      'Routine failed: exit 1',
      'error',
      0,
      42,
    );
  });

  it('ignores sessions that are not routine runs', () => {
    const deps = makeDeps();
    expect(finishRoutineRun(deps, { sessionId: 'other', finalContent: 'hi' })).toBe(false);
    expect(deps.broadcast).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('builds a run prompt without owner notes when the cron prompt is blank', () => {
    const p = buildRoutineRunPrompt({ prompt: '  ', routine_skill: 's' });
    expect(p).not.toContain('Notes from');
  });

  it('strips control blocks from previews', () => {
    expect(routineResultPreview('Done.\n```agenthub:ask\n[]\n```')).toBe('Done.');
  });
});

describe('restart recovery', () => {
  function finishedEvents(deps: ReturnType<typeof makeDeps>) {
    return deps.broadcast.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.type === 'routine_run_finished');
  }

  it('settles a run after a restart through the stored link', () => {
    startRoutineRun(cron(), project, makeDeps());
    const afterRestart = makeDeps();

    expect(finishRoutineRun(afterRestart, { sessionId: 'sess-1', finalContent: 'Done.' })).toBe(
      true,
    );
    expect(afterRestart.stmts.updateCronLog.run).toHaveBeenCalledWith('Done.', 'success', 0, 42);
    expect(finishedEvents(afterRestart)).toHaveLength(1);
  });

  it('keeps the one-run-per-cron guard across a restart', () => {
    startRoutineRun(cron(), project, makeDeps());
    const afterRestart = makeDeps();
    const second = startRoutineRun(cron(), project, afterRestart);
    expect(second.status).toBe('error');
    expect(afterRestart.dispatch).not.toHaveBeenCalled();
  });

  it('settles runs whose session is not resuming as interrupted and notifies the owner', () => {
    startRoutineRun(cron(), project, makeDeps());
    const resumed = makeDeps(
      vi.fn(() => ({ sessionId: 'sess-2', agentId: 'ops', skippedSkills: [] })),
    );
    startRoutineRun(cron({ id: 8, name: 'Other' }), project, resumed);

    const boot = makeDeps();
    expect(reconcileRoutineRunsOnBoot(boot, ['sess-2'])).toBe(1);

    expect(boot.stmts.updateCronLog.run).toHaveBeenCalledWith(
      `Routine failed: ${ROUTINE_INTERRUPTED_MESSAGE}`,
      'error',
      0,
      42,
    );
    expect(finishedEvents(boot)).toEqual([
      expect.objectContaining({ sessionId: 'sess-1', status: 'error', ownerUserId: 'user-1' }),
    ]);
    expect(getRun(boot.stmts, 'sess-1')).toBeUndefined();
    // The resuming session keeps its run, and the cron is free for its next tick.
    expect(getRun(boot.stmts, 'sess-2')).toMatchObject({ cronId: 8 });
    expect(startRoutineRun(cron(), project, makeDeps()).status).toBe('success');
  });

  it('settles a run whose session was deleted and lets the next tick start', () => {
    startRoutineRun(cron(), project, makeDeps());
    deletedSessions.add('sess-1');
    const next = makeDeps(echoDispatch());

    expect(startRoutineRun(cron(), project, next).status).toBe('success');
    expect(next.stmts.updateCronLog.run).toHaveBeenCalledWith(
      `Routine failed: ${ROUTINE_SESSION_GONE_MESSAGE}`,
      'error',
      0,
      42,
    );
    expect(getRun(next.stmts, 'sess-1')).toBeUndefined();
    expect(getRun(next.stmts, 'sess-2')).toMatchObject({ cronId: 7 });
  });
});
