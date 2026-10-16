/**
 * Cron wiring for routines: a cron with `routine_skill` runs as a consult chat
 * session for its owner (session dispatch mocked, no CLI) instead of the
 * headless one-shot, and the session's terminal turn settles the real cron log.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

const runOneShot = vi.fn();
const dispatchSession = vi.fn();

vi.mock('./worktree.js', async (orig) => ({
  ...(await orig<typeof import('./worktree.js')>()),
  getOrCreateProcessWorktree: vi.fn(async () => '/tmp'),
}));
vi.mock('./engine-resolver.js', async (orig) => ({
  ...(await orig<typeof import('./engine-resolver.js')>()),
  resolveOneShotEngine: vi.fn(async () => ({
    engine: 'claude-code',
    model: null,
    fallbackUsed: false,
  })),
}));
vi.mock('./one-shot-failover.js', async (orig) => ({
  ...(await orig<typeof import('./one-shot-failover.js')>()),
  runOneShotPromptWithFailover: (...args: unknown[]) => runOneShot(...args),
}));
vi.mock('./background-agent-session.js', async (orig) => ({
  ...(await orig<typeof import('./background-agent-session.js')>()),
  dispatchBackgroundAgentSession: (...args: unknown[]) => dispatchSession(...args),
}));
vi.mock('./project-model.js', async (orig) => ({
  ...(await orig<typeof import('./project-model.js')>()),
  getProjects: () => [
    {
      id: 'routine-proj',
      name: 'Routine',
      cwd: '/tmp',
      agents: [{ id: 'dev' }, { id: 'ops' }],
    },
  ],
}));

const { getStmts } = await import('./db.js');
const { runCronJob, setBroadcast } = await import('./heartbeat.js');
const { finishRoutineRun, reconcileRoutineRunsOnBoot } = await import('./routine-runs.js');
const { getDb } = await import('./db.js');

function makeRoutineCron(skill: string | null) {
  const stmts = getStmts();
  const id = Number(
    stmts.createCron.run(
      'Export',
      '0 9 * * *',
      null,
      'only EU',
      '/tmp',
      1,
      'routine-proj',
      null,
      0,
      null,
      'ops',
      null,
      'owner-1',
      0,
    ).lastInsertRowid,
  );
  stmts.updateCronRoutineSkill.run(skill, id);
  return stmts.getCron.get(id) as Parameters<typeof runCronJob>[0];
}

function dispatchedSessionId(): string {
  return (dispatchSession.mock.calls[0]![2] as { sessionId: string }).sessionId;
}

describe('runCronJob with routine_skill', () => {
  const broadcast = vi.fn();
  beforeEach(() => {
    getDb().exec('DELETE FROM routine_runs');
    broadcast.mockReset();
    runOneShot.mockReset();
    dispatchSession.mockReset();
    dispatchSession.mockImplementation((_p: unknown, _c: unknown, opts: { sessionId: string }) => ({
      sessionId: opts.sessionId,
      agentId: 'ops',
      skippedSkills: [],
    }));
    setBroadcast(broadcast);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('dispatches a consult session as the owner and leaves the log running', async () => {
    const cron = makeRoutineCron('weekly-export');
    expect(cron.routine_skill).toBe('weekly-export');

    const result = await runCronJob(cron);

    expect(runOneShot).not.toHaveBeenCalled();
    expect(dispatchSession).toHaveBeenCalledTimes(1);
    const [project, cfg] = dispatchSession.mock.calls[0] as [
      { id: string },
      Record<string, unknown>,
    ];
    expect(project.id).toBe('routine-proj');
    expect(cfg).toMatchObject({
      ownerUserId: 'owner-1',
      sessionAgentId: 'ops',
      sessionMode: 'consult',
      skills: ['weekly-export'],
    });
    expect(result.status).toBe('success');
    const [log] = getStmts().getCronLogs.all(cron.id, 1) as { status: string }[];
    expect(log.status).toBe('running');
  });

  it('writes the terminal turn report to the cron log and announces it', async () => {
    const cron = makeRoutineCron('weekly-export');
    const result = await runCronJob(cron);

    finishRoutineRun(
      { stmts: getStmts(), broadcast },
      { sessionId: dispatchedSessionId(), finalContent: 'Exported 12 rows.' },
    );

    const [log] = getStmts().getCronLogs.all(cron.id, 1) as {
      id: number;
      status: string;
      result: string;
    }[];
    expect(log).toMatchObject({
      id: Number(result.id),
      status: 'success',
      result: 'Exported 12 rows.',
    });
    const types = broadcast.mock.calls.map((c) => c[0].type);
    expect(types).toContain('routine_run_finished');
    expect(types).toContain('cron_finished');
  });

  it('keeps classic crons on the one-shot path', async () => {
    runOneShot.mockRejectedValue(new Error('engine exploded'));
    await runCronJob(makeRoutineCron(null));
    expect(dispatchSession).not.toHaveBeenCalled();
    expect(runOneShot).toHaveBeenCalledTimes(1);
  });

  it('after a restart, an unresumed run leaves running and its owner is told', async () => {
    const cron = makeRoutineCron('weekly-export');
    const result = await runCronJob(cron);
    broadcast.mockReset();

    // A fresh boot: nothing in memory, the stored link is all that is left.
    expect(reconcileRoutineRunsOnBoot({ stmts: getStmts(), broadcast }, [])).toBe(1);

    const [log] = getStmts().getCronLogs.all(cron.id, 1) as { id: number; status: string }[];
    expect(log).toMatchObject({ id: Number(result.id), status: 'error' });
    const finished = broadcast.mock.calls
      .map((c) => c[0])
      .find((e) => e.type === 'routine_run_finished');
    expect(finished).toMatchObject({ cronId: cron.id, status: 'error', ownerUserId: 'owner-1' });
    expect(getStmts().getRoutineRun.get(dispatchedSessionId())).toBeUndefined();
  });

  it('a dispatched routine is always tracked, and the next tick does not overlap it', async () => {
    const cron = makeRoutineCron('weekly-export');
    await runCronJob(cron);
    const sessionId = dispatchedSessionId();
    expect(getStmts().getRoutineRun.get(sessionId)).toMatchObject({ cron_id: cron.id });
    // The real dispatcher creates the session row; the mock does not.
    getStmts().createSession.run(sessionId, 'ops', 'x', 'claude-code', 'opus', 0, 0, 1);

    const second = await runCronJob(cron);
    expect(second.status).toBe('error');
    expect(dispatchSession).toHaveBeenCalledTimes(1);
  });

  it('never dispatches when the tracking row cannot be written', async () => {
    const cron = makeRoutineCron('weekly-export');
    const stmts = getStmts();
    const original = stmts.insertRoutineRun;
    stmts.insertRoutineRun = {
      run: () => {
        throw new Error('disk I/O error');
      },
    } as unknown as typeof original;
    try {
      const result = await runCronJob(cron);
      expect(result.status).toBe('error');
      expect(result.result).toContain('disk I/O error');
    } finally {
      stmts.insertRoutineRun = original;
    }
    expect(dispatchSession).not.toHaveBeenCalled();
    expect(stmts.getRoutineRunByCron.get(cron.id)).toBeUndefined();
    const [log] = stmts.getCronLogs.all(cron.id, 1) as { status: string }[];
    expect(log.status).toBe('error');
  });
});
