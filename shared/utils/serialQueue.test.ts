import { describe, it, expect } from 'vitest';
import { createSerialQueue } from './serialQueue';

describe('createSerialQueue', () => {
  it('starts each operation only after the previous one settled, even if it failed', async () => {
    const q = createSerialQueue();
    const events: string[] = [];
    let finishWrite!: () => void;
    const write = q.run(async () => {
      events.push('write:start');
      await new Promise<void>((r) => (finishWrite = r));
      events.push('write:end');
      throw new Error('boom');
    });
    const read = q.run(async () => {
      events.push('read:start');
      return 'ok';
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual(['write:start']);
    finishWrite();
    await expect(write).rejects.toThrow('boom');
    await expect(read).resolves.toBe('ok');
    expect(events).toEqual(['write:start', 'write:end', 'read:start']);
  });
});
