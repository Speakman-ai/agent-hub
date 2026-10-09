import { describe, it, expect } from 'vitest';
import { createKeyedQueue } from './keyedQueue';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createKeyedQueue', () => {
  it('runs tasks for one key in issue order even when the first is slower', async () => {
    const run = createKeyedQueue();
    const log: string[] = [];
    await Promise.all([
      run('a', async () => {
        log.push('a1 start');
        await wait(30);
        log.push('a1 end');
      }),
      run('a', async () => {
        log.push('a2 start');
        log.push('a2 end');
      }),
    ]);
    expect(log).toEqual(['a1 start', 'a1 end', 'a2 start', 'a2 end']);
  });

  it('lets different keys run concurrently and survives a failed task', async () => {
    const run = createKeyedQueue();
    const log: string[] = [];
    const slow = run('a', async () => {
      await wait(30);
      log.push('a');
    });
    await run('b', async () => {
      log.push('b');
    });
    expect(log).toEqual(['b']);
    await slow;
    await expect(run('a', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(run('a', async () => 'next')).resolves.toBe('next');
  });
});
