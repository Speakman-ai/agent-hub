import { deliverReleaseNotificationOutboxBatch } from './release-notification-outbox.js';
import type { BroadcastFn } from './types.js';

export const RELEASE_NOTIFICATION_OUTBOX_WORKER_CRON = '* * * * *';

export interface ReleaseNotificationOutboxWorkerDeps {
  deliver?: typeof deliverReleaseNotificationOutboxBatch;
  warn?: (message: string) => void;
  /** Threaded into the delivery batch so sent/failed transitions fan out over WS. */
  broadcast?: BroadcastFn;
}

export async function runReleaseNotificationOutboxWorker(
  deps: ReleaseNotificationOutboxWorkerDeps = {},
): Promise<number> {
  try {
    const rows = await (deps.deliver ?? deliverReleaseNotificationOutboxBatch)(undefined, {
      broadcast: deps.broadcast,
    });
    return rows.length;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    (deps.warn ?? console.warn)(`[release-notification-outbox] worker tick failed: ${detail}`);
    return 0;
  }
}
