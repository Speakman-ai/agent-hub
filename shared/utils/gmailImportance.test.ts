import { describe, it, expect, vi } from 'vitest';
import {
  createGmailImportanceSync,
  GMAIL_IMPORTANCE_IDLE_POLL_MS,
  GMAIL_IMPORTANCE_POLL_MS,
  importanceStatusLine,
  senderName,
  withoutImportantThreads,
  type GmailImportanceState,
} from './gmailImportance';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');

function state(overrides: Partial<GmailImportanceState['settings']> = {}, running = false) {
  return {
    running,
    threads: [],
    settings: {
      enabled: true,
      windowDays: 7,
      autoScan: 'off',
      lastScanAt: null,
      lastScanStatus: 'idle',
      lastScanError: null,
      lastScanEngine: null,
      lastScanModel: null,
      lastScanFailover: null,
      ...overrides,
    },
  } as GmailImportanceState;
}

describe('gmailImportance helpers', () => {
  it('drops pinned threads from the regular list', () => {
    const threads = [{ id: 'a' }, { id: 'b' }, { id: null }];
    const pinned = [{ threadId: 'b' }] as GmailImportanceState['threads'];
    expect(withoutImportantThreads(threads, pinned)).toEqual([{ id: 'a' }, { id: null }]);
  });

  it('extracts a display name from a From header', () => {
    expect(senderName('"Alice Smith" <alice@example.com>')).toBe('Alice Smith');
    expect(senderName('Bob <bob@example.com>')).toBe('Bob');
    expect(senderName('carol@example.com')).toBe('carol@example.com');
    expect(senderName(null)).toBe('(unknown sender)');
  });

  it('describes running, error, never-scanned, and scanned states', () => {
    expect(importanceStatusLine(state({}, true), NOW)).toBe('Scanning your inbox…');
    expect(importanceStatusLine(state(), NOW)).toBe('Not scanned yet.');
    expect(
      importanceStatusLine(
        state({
          lastScanStatus: 'error',
          lastScanAt: new Date(NOW - 5 * 60_000).toISOString(),
          lastScanError: 'No engines available',
        }),
        NOW,
      ),
    ).toBe('Last scan failed 5m ago: No engines available');
    expect(
      importanceStatusLine(
        state({
          lastScanStatus: 'ok',
          lastScanAt: new Date(NOW - 2 * 3_600_000).toISOString(),
          lastScanEngine: 'claude-code',
          lastScanModel: 'sonnet',
        }),
        NOW,
      ),
    ).toBe('Scanned 2h ago with claude-code (sonnet).');
  });
});

describe('createGmailImportanceSync', () => {
  function harness(loads: Array<GmailImportanceState | Error>) {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const states: GmailImportanceState[] = [];
    const errors: string[] = [];
    const load = vi.fn(async () => {
      const next = loads.shift();
      if (!next) throw new Error('no more loads');
      if (next instanceof Error) throw next;
      return next;
    });
    const sync = createGmailImportanceSync({
      load,
      onState: (s) => states.push(s),
      onError: (m) => errors.push(m),
      setTimer: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimer: (h) => {
        const i = timers.indexOf(h as (typeof timers)[number]);
        if (i >= 0) timers.splice(i, 1);
      },
    });
    const fire = async () => {
      expect(timers).toHaveLength(1);
      const t = timers.shift()!;
      t.fn();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      return t.ms;
    };
    return { sync, timers, states, errors, load, fire };
  }

  const flush = async () => {
    for (let i = 0; i < 3; i++) await Promise.resolve();
  };

  it('keeps polling an idle pane so a server-started scan shows up', async () => {
    const h = harness([state(), state({}, true), state({ lastScanStatus: 'ok' })]);
    h.sync.start();
    await flush();
    expect(h.timers[0].ms).toBe(GMAIL_IMPORTANCE_IDLE_POLL_MS);
    // Idle poll sees the automated scan running, then switches to fast polling.
    expect(await h.fire()).toBe(GMAIL_IMPORTANCE_IDLE_POLL_MS);
    expect(h.states[1].running).toBe(true);
    expect(h.timers[0].ms).toBe(GMAIL_IMPORTANCE_POLL_MS);
    await h.fire();
    expect(h.states[2].settings.lastScanStatus).toBe('ok');
    expect(h.timers[0].ms).toBe(GMAIL_IMPORTANCE_IDLE_POLL_MS);
  });

  it('reschedules after a failed load at the last known cadence', async () => {
    const h = harness([state({}, true), new Error('network blip'), state()]);
    h.sync.start();
    await flush();
    expect(await h.fire()).toBe(GMAIL_IMPORTANCE_POLL_MS);
    expect(h.errors).toEqual(['network blip']);
    expect(h.timers[0].ms).toBe(GMAIL_IMPORTANCE_POLL_MS);
    await h.fire();
    expect(h.states.at(-1)?.running).toBe(false);
  });

  it('switches to fast polling when a scan response is handed over, and stops cleanly', async () => {
    const h = harness([state()]);
    h.sync.start();
    await flush();
    h.sync.accept(state({}, true));
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBe(GMAIL_IMPORTANCE_POLL_MS);
    h.sync.stop();
    expect(h.timers).toHaveLength(0);
    h.sync.accept(state());
    expect(h.timers).toHaveLength(0);
  });

  it('drops a load that resolves after a newer scan response was accepted', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const states: GmailImportanceState[] = [];
    let resolveStale: (s: GmailImportanceState) => void = () => {};
    const stale = new Promise<GmailImportanceState>((r) => (resolveStale = r));
    const load = vi
      .fn<() => Promise<GmailImportanceState>>()
      .mockReturnValueOnce(stale)
      .mockResolvedValueOnce(state({}, true));
    const sync = createGmailImportanceSync({
      load,
      onState: (s) => states.push(s),
      onError: () => undefined,
      setTimer: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimer: (h) => {
        const i = timers.indexOf(h as (typeof timers)[number]);
        if (i >= 0) timers.splice(i, 1);
      },
    });
    sync.start();
    // The scan POST lands while the first GET is still in flight.
    sync.accept(state({}, true));
    expect(timers.map((t) => t.ms)).toEqual([GMAIL_IMPORTANCE_POLL_MS]);

    // A refresh now must not join the stale load.
    const fresh = sync.refresh();
    expect(load).toHaveBeenCalledTimes(2);

    resolveStale(state());
    await flush();
    await fresh;
    expect(states.map((s) => s.running)).toEqual([true, true]);
    expect(timers.map((t) => t.ms)).toEqual([GMAIL_IMPORTANCE_POLL_MS]);
    sync.stop();
  });

  it('drops a stale load failure after a newer response was accepted', async () => {
    let rejectStale: (e: Error) => void = () => {};
    const errors: string[] = [];
    const sync = createGmailImportanceSync({
      load: () => new Promise((_r, reject) => (rejectStale = reject)),
      onState: () => undefined,
      onError: (m) => errors.push(m),
      setTimer: () => ({}),
      clearTimer: () => undefined,
    });
    sync.start();
    sync.accept(state());
    rejectStale(new Error('late failure'));
    await flush();
    expect(errors).toEqual([]);
    sync.stop();
  });
});
