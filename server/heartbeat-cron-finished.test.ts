/**
 * `runCronJob` announces every finished run as a `cron_finished` broadcast so
 * project chat triggers can post it. The engine run itself is mocked.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

const runOneShot = vi.fn();

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
  formatFailoverSummary: () => '',
}));
vi.mock('./project-model.js', async (orig) => ({
  ...(await orig<typeof import('./project-model.js')>()),
  getProjects: () => [{ id: 'cron-proj', name: 'Cron', cwd: '/tmp', agents: [] }],
}));

const { getStmts } = await import('./db.js');
const { runCronJob, setBroadcast } = await import('./heartbeat.js');

function makeCron(shared: 0 | 1) {
  const stmts = getStmts();
  const id = Number(
    stmts.createCron.run(
      'Nightly',
      '0 0 * * *',
      null,
      'do it',
      '/tmp',
      1,
      'cron-proj',
      null,
      0,
      null,
      null,
      null,
      'owner-1',
      shared,
    ).lastInsertRowid,
  );
  return stmts.getCron.get(id) as Parameters<typeof runCronJob>[0];
}

describe('runCronJob cron_finished broadcast', () => {
  const broadcast = vi.fn();
  beforeEach(() => {
    broadcast.mockReset();
    runOneShot.mockReset();
    setBroadcast(broadcast);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  function finished() {
    return broadcast.mock.calls.map((c) => c[0]).filter((d) => d.type === 'cron_finished');
  }

  it('broadcasts success with the run output', async () => {
    runOneShot.mockResolvedValue({
      detailed: { stdout: 'all good', stderr: '' },
      engine: 'claude-code',
      model: null,
      output: 'all good',
      failovers: [],
    });
    const cron = makeCron(1);
    const result = await runCronJob(cron);
    expect(finished()).toEqual([
      expect.objectContaining({
        projectId: 'cron-proj',
        cronId: cron.id,
        cronName: 'Nightly',
        logId: Number(result.id),
        status: 'success',
        preview: 'all good',
        ownerUserId: 'owner-1',
        cronShared: true,
        suppressWebSocket: true,
        suppressPush: true,
      }),
    ]);
  });

  it('broadcasts errors too', async () => {
    runOneShot.mockRejectedValue(new Error('engine exploded'));
    await runCronJob(makeCron(0));
    expect(finished()).toEqual([
      expect.objectContaining({ status: 'error', preview: 'engine exploded', cronShared: false }),
    ]);
  });

  it('stores stdout and stderr in the cron log when a run fails', async () => {
    runOneShot.mockRejectedValue(
      Object.assign(new Error('Timed out after 5 minutes'), {
        stdout: 'checked 3 PRs',
        stderr: 'rate limited',
      }),
    );
    const cron = makeCron(1);
    const result = await runCronJob(cron);
    expect(result.status).toBe('error');
    const [log] = getStmts().getCronLogs.all(cron.id, 1) as { result: string; status: string }[];
    expect(log.status).toBe('error');
    expect(log.result).toBe(
      'ERROR: Timed out after 5 minutes\n\n--- stdout ---\nchecked 3 PRs\n\n--- stderr ---\nrate limited',
    );
  });

  it('writes no thread or thread_entry_created broadcast for success or error runs', async () => {
    runOneShot.mockResolvedValueOnce({
      detailed: { stdout: 'ok', stderr: '' },
      engine: 'claude-code',
      model: null,
      output: 'ok',
      failovers: [],
    });
    const cron = makeCron(1);
    await runCronJob(cron);
    runOneShot.mockRejectedValueOnce(new Error('boom'));
    await runCronJob(cron);
    expect(getStmts().getThreadBySource.get('cron-proj', 'cron', String(cron.id))).toBeUndefined();
    expect(broadcast.mock.calls.map((c) => c[0].type)).not.toContain('thread_entry_created');
  });
});
