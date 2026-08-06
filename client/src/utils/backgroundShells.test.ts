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
  deriveWatchIndicator,
  watchIndicatorLabel,
  watchIndicatorTitle,
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
