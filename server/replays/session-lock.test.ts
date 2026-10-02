import { describe, it, expect } from 'vitest';
import { withSessionLock } from './session-lock.js';

describe('withSessionLock', () => {
  it('runs work for one session in order and lets other sessions run alongside', async () => {
    const log: string[] = [];
    let release!: () => void;
    const blocker = new Promise<void>((r) => (release = r));

    const a1 = withSessionLock('a', async () => {
      log.push('a1 start');
      await blocker;
      log.push('a1 end');
    });
    const a2 = withSessionLock('a', async () => {
      log.push('a2');
    });
    await withSessionLock('b', async () => {
      log.push('b');
    });
    release();
    await Promise.all([a1, a2]);

    expect(log).toEqual(['a1 start', 'b', 'a1 end', 'a2']);
  });

  it('keeps the queue moving after a failure', async () => {
    const failed = withSessionLock('c', async () => {
      throw new Error('boom');
    });
    const next = withSessionLock('c', async () => 'ran');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ran');
  });
});
