import { getEventListeners } from 'events';
import { describe, expect, it } from 'vitest';
import { sleepUnlessAborted } from './abortable-sleep.js';

describe('sleepUnlessAborted', () => {
  it('leaves no abort listener behind after many timeouts on one signal', async () => {
    const ac = new AbortController();
    for (let i = 0; i < 50; i++) await sleepUnlessAborted(0, ac.signal);
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });

  it('wakes early on abort and clears its listener', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const sleeping = sleepUnlessAborted(60_000, ac.signal);
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(1);
    ac.abort();
    await sleeping;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });

  it('returns at once on an already aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await sleepUnlessAborted(60_000, ac.signal);
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });
});
