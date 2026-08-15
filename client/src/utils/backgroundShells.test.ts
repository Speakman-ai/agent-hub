/**
 * Tests for the background-shell client state and watch-loop indicator.
 *
 * The indicator is the human-facing half of the "session went silent" fix, so
 * the cases that matter most are the ones where it must *not* lie: a stale pill
 * after a reconnect, or no pill at all while a session sits idle waiting on a
 * build.
 */
import { describe, it, expect } from 'vitest';
import {
  applyBackgroundShellSnapshot,
  applyBackgroundShellUpdate,
  applyBackgroundShellLog,
  applyBackgroundShellLogSnapshot,
  applyTerminalJobSnapshot,
  applyTerminalJobUpdate,
  dismissTerminalJob,
  deriveWatchIndicator,
  mergeLogSnapshot,
  MAX_FINISHED_TERMINAL_JOBS,
  PTY_TAB_ID,
  shouldFocusTerminalJob,
  terminalJobLabel,
  terminalTabsFromJobs,
  watchIndicatorLabel,
  watchIndicatorTitle,
  type BackgroundShellsBySession,
  type BackgroundShellView,
} from './backgroundShells';

function shell(over: Partial<BackgroundShellView> = {}): BackgroundShellView {
  return {
    id: 'shell-1',
    session_id: 'sess-1',
    command: 'npm run build',
    label: 'build',
    status: 'running',
    exit_code: null,
    watch: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('applyBackgroundShellSnapshot', () => {
  it('indexes shells by session', () => {
    const next = applyBackgroundShellSnapshot([
      { sessionId: 'sess-1', shells: [shell()] },
      { sessionId: 'sess-2', shells: [shell({ id: 'b', session_id: 'sess-2' })] },
    ]);
    expect(Object.keys(next).sort()).toEqual(['sess-1', 'sess-2']);
  });

  it('replaces prior state wholesale, clearing sessions absent from the snapshot', () => {
    // This is the reconnect case: whatever the client believed before the
    // socket dropped is discarded in favour of the server's truth.
    expect(applyBackgroundShellSnapshot([])).toEqual({});
  });

  it('orders shells by launch time', () => {
    const next = applyBackgroundShellSnapshot([
      {
        sessionId: 'sess-1',
        shells: [
          shell({ id: 'second', created_at: '2026-01-01T00:00:02.000Z' }),
          shell({ id: 'first', created_at: '2026-01-01T00:00:01.000Z' }),
        ],
      },
    ]);
    expect(next['sess-1'].map((s) => s.id)).toEqual(['first', 'second']);
  });

  it('omits sessions with no shells rather than storing empty arrays', () => {
    expect(applyBackgroundShellSnapshot([{ sessionId: 'sess-1', shells: [] }])).toEqual({});
  });

  it('tolerates a malformed payload instead of blanking the UI with a throw', () => {
    expect(applyBackgroundShellSnapshot(undefined)).toEqual({});
    expect(applyBackgroundShellSnapshot('nope')).toEqual({});
    expect(applyBackgroundShellSnapshot([null, { sessionId: 5 }, {}])).toEqual({});
  });

  it('skips entries that are not shell rows', () => {
    const next = applyBackgroundShellSnapshot([
      { sessionId: 'sess-1', shells: [shell(), { nope: true }] },
    ]);
    expect(next['sess-1']).toHaveLength(1);
  });
});

describe('applyBackgroundShellUpdate', () => {
  it('adds a newly started shell', () => {
    const next = applyBackgroundShellUpdate({}, shell());
    expect(next['sess-1']).toHaveLength(1);
  });

  it('replaces an existing shell rather than duplicating it', () => {
    const first = applyBackgroundShellUpdate({}, shell());
    const next = applyBackgroundShellUpdate(first, shell({ label: 'renamed' }));
    expect(next['sess-1']).toHaveLength(1);
    expect(next['sess-1'][0].label).toBe('renamed');
  });

  it('removes a shell that reached a terminal status', () => {
    const first = applyBackgroundShellUpdate({}, shell());
    const next = applyBackgroundShellUpdate(first, shell({ status: 'exited', exit_code: 0 }));
    expect(next['sess-1']).toBeUndefined();
  });

  it('keeps siblings when one of several finishes', () => {
    let state = applyBackgroundShellUpdate({}, shell({ id: 'a' }));
    state = applyBackgroundShellUpdate(state, shell({ id: 'b' }));
    state = applyBackgroundShellUpdate(state, shell({ id: 'a', status: 'failed', exit_code: 1 }));
    expect(state['sess-1'].map((s) => s.id)).toEqual(['b']);
  });

  it('is a no-op for a terminal shell it never knew about', () => {
    const prev = {};
    expect(applyBackgroundShellUpdate(prev, shell({ status: 'stopped' }))).toBe(prev);
  });

  it('ignores a malformed payload', () => {
    const prev = { 'sess-1': [shell()] };
    expect(applyBackgroundShellUpdate(prev, null)).toBe(prev);
    expect(applyBackgroundShellUpdate(prev, { id: 'x' })).toBe(prev);
  });

  it('does not touch other sessions', () => {
    const prev = { 'sess-2': [shell({ id: 'other', session_id: 'sess-2' })] };
    const next = applyBackgroundShellUpdate(prev, shell());
    expect(next['sess-2']).toBe(prev['sess-2']);
  });
});

describe('terminal job tabs', () => {
  it('lists Shell first, then one tab per background shell labeled from --label', () => {
    const tabs = terminalTabsFromJobs([
      shell({ id: 'a', label: 'build' }),
      shell({ id: 'b', label: null, command: 'pytest -q very-long-name-that-truncates' }),
    ]);
    expect(tabs[0]).toEqual({ id: PTY_TAB_ID, kind: 'pty', label: 'Shell' });
    expect(tabs[1]).toMatchObject({ id: 'a', kind: 'job', label: 'build', status: 'running' });
    expect(tabs[2]).toMatchObject({
      id: 'b',
      kind: 'job',
      label: terminalJobLabel(
        shell({ id: 'b', label: null, command: 'pytest -q very-long-name-that-truncates' }),
      ),
    });
    expect(tabs).toHaveLength(3);
  });

  it('falls back to a truncated command when the shell has no label', () => {
    expect(terminalJobLabel(shell({ label: null, command: 'ls' }))).toBe('ls');
    expect(terminalJobLabel(shell({ label: '  ', command: 'npm run very-long-script-name' }))).toBe(
      'npm run very-long-scrip…',
    );
  });

  it('keeps a finished shell as a job tab instead of dropping it', () => {
    const first = applyTerminalJobUpdate({}, shell());
    const next = applyTerminalJobUpdate(first, shell({ status: 'exited', exit_code: 0 }));
    expect(next['sess-1']).toHaveLength(1);
    expect(next['sess-1'][0].status).toBe('exited');
  });

  it('caps finished job tabs so a long session does not accumulate dozens', () => {
    let state: BackgroundShellsBySession = {};
    for (let i = 0; i < MAX_FINISHED_TERMINAL_JOBS + 3; i += 1) {
      state = applyTerminalJobUpdate(
        state,
        shell({
          id: `done-${i}`,
          status: 'exited',
          created_at: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        }),
      );
    }
    expect(state['sess-1']).toHaveLength(MAX_FINISHED_TERMINAL_JOBS);
    expect(state['sess-1'][0].id).toBe('done-3');
  });

  it('preserves finished tabs across a running-only reconnect snapshot', () => {
    let state = applyTerminalJobUpdate({}, shell({ id: 'live' }));
    state = applyTerminalJobUpdate(state, shell({ id: 'done', status: 'exited' }));
    const next = applyTerminalJobSnapshot(state, [
      { sessionId: 'sess-1', shells: [shell({ id: 'live' })] },
    ]);
    expect(next['sess-1'].map((s) => s.id).sort()).toEqual(['done', 'live']);
  });

  it('dismisses a finished job tab without touching siblings', () => {
    let state = applyTerminalJobUpdate({}, shell({ id: 'a' }));
    state = applyTerminalJobUpdate(state, shell({ id: 'b', status: 'exited' }));
    const next = dismissTerminalJob(state, 'sess-1', 'b');
    expect(next['sess-1'].map((s) => s.id)).toEqual(['a']);
  });

  it('focuses Terminal only for a watched running shell', () => {
    expect(shouldFocusTerminalJob(shell({ status: 'running', watch: 1 }))).toBe(true);
    expect(shouldFocusTerminalJob(shell({ status: 'running', watch: 0 }))).toBe(false);
    expect(shouldFocusTerminalJob(shell({ status: 'exited', watch: 1 }))).toBe(false);
    expect(shouldFocusTerminalJob(null)).toBe(false);
  });
});

describe('background shell log stream', () => {
  it('concatenates live chunks per session and shell', () => {
    let logs = applyBackgroundShellLog({}, { sessionId: 'sess-1', shellId: 'a', chunk: 'hel' });
    logs = applyBackgroundShellLog(logs, { sessionId: 'sess-1', shellId: 'a', chunk: 'lo\n' });
    expect(logs['sess-1']['a']).toBe('hello\n');
  });

  it('ignores malformed or empty chunks', () => {
    const prev = {};
    expect(applyBackgroundShellLog(prev, { sessionId: 'sess-1', shellId: 'a', chunk: '' })).toBe(
      prev,
    );
    expect(applyBackgroundShellLog(prev, { sessionId: 'sess-1', chunk: 'x' })).toBe(prev);
  });

  it('keeps live data that already extends a REST snapshot', () => {
    expect(mergeLogSnapshot('hello\nworld\nmore\n', 'hello\nworld\n')).toBe('hello\nworld\nmore\n');
    expect(mergeLogSnapshot('hel', 'hello\n')).toBe('hello\n');
    expect(mergeLogSnapshot('', 'snap\n')).toBe('snap\n');
  });

  it('applies a snapshot only when it adds history', () => {
    const withLive = applyBackgroundShellLog(
      {},
      { sessionId: 'sess-1', shellId: 'a', chunk: 'hello\nworld\n' },
    );
    expect(applyBackgroundShellLogSnapshot(withLive, 'sess-1', 'a', 'hello\n')).toBe(withLive);
    const fromEmpty = applyBackgroundShellLogSnapshot({}, 'sess-1', 'a', 'hello\n');
    expect(fromEmpty['sess-1']['a']).toBe('hello\n');
  });
});

describe('deriveWatchIndicator', () => {
  it('returns null when there is nothing to show, so no pill renders', () => {
    expect(deriveWatchIndicator(undefined)).toBeNull();
    expect(deriveWatchIndicator([])).toBeNull();
  });

  it('returns null when every shell has finished', () => {
    expect(deriveWatchIndicator([shell({ status: 'exited' })])).toBeNull();
  });

  it('counts running and watched separately', () => {
    const indicator = deriveWatchIndicator([
      shell({ id: 'a', watch: 1 }),
      shell({ id: 'b', watch: 0 }),
      shell({ id: 'c', status: 'exited', watch: 1 }),
    ]);
    expect(indicator).toEqual({ running: 2, watching: 1 });
  });

  it('reports running-but-unwatched work, which will NOT resume the session', () => {
    expect(deriveWatchIndicator([shell({ watch: 0 })])).toEqual({ running: 1, watching: 0 });
  });
});

describe('watch indicator copy', () => {
  it('leads with the watched count when there is one', () => {
    expect(watchIndicatorLabel({ running: 3, watching: 2 })).toBe('2 watching');
  });

  it('falls back to the running count', () => {
    expect(watchIndicatorLabel({ running: 1, watching: 0 })).toBe('1 running');
  });

  it('promises automatic resume only when something is watched', () => {
    expect(watchIndicatorTitle({ running: 1, watching: 1 })).toContain('resumes automatically');
    expect(watchIndicatorTitle({ running: 1, watching: 0 })).toContain('will not resume');
  });

  it('agrees in number', () => {
    expect(watchIndicatorTitle({ running: 1, watching: 1 })).toContain('1 background shell');
    expect(watchIndicatorTitle({ running: 2, watching: 2 })).toContain('2 background shells');
  });
});
