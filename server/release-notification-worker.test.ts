import { describe, expect, it, vi } from 'vitest';
import { runReleaseNotificationOutboxWorker } from './release-notification-worker.js';
import type { ReleaseNotificationOutboxRow } from './types.js';

describe('release notification outbox worker', () => {
  it('drains the outbox through the delivery batch helper', async () => {
    const deliver = vi.fn(
      async () => [{ id: 'row-1' }, { id: 'row-2' }] as ReleaseNotificationOutboxRow[],
    );

    await expect(runReleaseNotificationOutboxWorker({ deliver })).resolves.toBe(2);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('logs delivery failures without throwing out of the scheduler tick', async () => {
    const warn = vi.fn();
    const deliver = vi.fn(async () => {
      throw new Error('smtp exploded');
    });

    await expect(runReleaseNotificationOutboxWorker({ deliver, warn })).resolves.toBe(0);
    expect(warn).toHaveBeenCalledWith(
      '[release-notification-outbox] worker tick failed: smtp exploded',
    );
  });
});
