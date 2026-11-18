import { describe, expect, it, vi } from 'vitest';
import {
  createNavigationIntent,
  loadSpawnedSessionRow,
  openSpawnedSessionWhenCurrent,
} from './spawnedSessionRow';

describe('loadSpawnedSessionRow', () => {
  it('uses the full server row over the rail summary', async () => {
    const fetchFull = vi.fn().mockResolvedValue({
      id: 'w1',
      agent_id: 'dev',
      session_mode: 'consult',
      engine: 'codex',
      model: 'gpt-5',
      finalize_automation: 'push',
      use_worktree: 1,
    });
    const row = await loadSpawnedSessionRow(
      { id: 'w1', agent_id: 'dev', name: 'Fix login', state: 'working' },
      null,
      fetchFull,
    );
    expect(fetchFull).toHaveBeenCalledWith('w1');
    expect(row).toMatchObject({
      session_mode: 'consult',
      engine: 'codex',
      finalize_automation: 'push',
      use_worktree: 1,
      name: 'Fix login',
    });
  });

  it('does not invent a session mode when the fetch fails', async () => {
    const row = await loadSpawnedSessionRow(
      { id: 'w1', agent_id: 'dev', name: 'Fix login' },
      null,
      vi.fn().mockRejectedValue(new Error('offline')),
    );
    expect(row).toEqual({ id: 'w1', agent_id: 'dev', name: 'Fix login' });
    expect(row.session_mode).toBeUndefined();
  });

  it('keeps cached fields the summary does not carry when the fetch fails', async () => {
    const row = await loadSpawnedSessionRow(
      { id: 'w1', agent_id: 'dev', state: 'idle' },
      { id: 'w1', agent_id: 'dev', session_mode: 'review', state: 'working' },
      vi.fn().mockResolvedValue(null),
    );
    expect(row).toMatchObject({ session_mode: 'review', state: 'idle' });
  });
});

describe('loadSpawnedSessionRow mode', () => {
  it("keeps a cached worker's mode when the fetch fails and the summary says otherwise", async () => {
    for (const mode of ['consult', 'orchestrate']) {
      const row = await loadSpawnedSessionRow(
        { id: 'w1', agent_id: 'dev', name: 'Worker', session_mode: 'chat' },
        { id: 'w1', agent_id: 'dev', session_mode: mode, engine: 'codex' },
        vi.fn().mockRejectedValue(new Error('offline')),
      );
      expect(row.session_mode).toBe(mode);
      expect(row.engine).toBe('codex');
    }
  });

  it('still takes the mode from a successful fetch', async () => {
    const row = await loadSpawnedSessionRow(
      { id: 'w1', agent_id: 'dev' },
      { id: 'w1', agent_id: 'dev', session_mode: 'consult' },
      vi.fn().mockResolvedValue({ id: 'w1', agent_id: 'dev', session_mode: 'orchestrate' }),
    );
    expect(row.session_mode).toBe('orchestrate');
  });
});

describe('openSpawnedSessionWhenCurrent', () => {
  it('activates only the latest of two overlapping opens', async () => {
    const intent = createNavigationIntent();
    const pending = new Map<string, (row: Record<string, unknown>) => void>();
    const fetchFull = (id: string) =>
      new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve));
    const activate = vi.fn();
    const openA = openSpawnedSessionWhenCurrent({
      summary: { id: 'a', agent_id: 'dev' },
      cached: null,
      fetchFull,
      isCurrent: intent.begin(),
      activate,
    });
    const openB = openSpawnedSessionWhenCurrent({
      summary: { id: 'b', agent_id: 'dev' },
      cached: null,
      fetchFull,
      isCurrent: intent.begin(),
      activate,
    });
    pending.get('b')!({ id: 'b', agent_id: 'dev' });
    expect(await openB).toBe(true);
    pending.get('a')!({ id: 'a', agent_id: 'dev' });
    expect(await openA).toBe(false);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate.mock.calls[0]![0]).toMatchObject({ id: 'b' });
  });

  it('does not activate after the user navigated elsewhere', async () => {
    let active = 'parent';
    const activate = vi.fn();
    const opened = openSpawnedSessionWhenCurrent({
      summary: { id: 'a', agent_id: 'dev' },
      cached: null,
      fetchFull: async () => {
        active = 'other';
        return { id: 'a', agent_id: 'dev' };
      },
      isCurrent: () => active === 'parent',
      activate,
    });
    expect(await opened).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });
});
