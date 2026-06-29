import { deliverReleaseNotificationOutboxBatch } from './release-notification-outbox.js';

export const RELEASE_NOTIFICATION_OUTBOX_WORKER_CRON = '* * * * *';

export interface ReleaseNotificationOutboxWorkerDeps {
  deliver?: typeof deliverReleaseNotificationOutboxBatch;
  warn?: (message: string) => void;
}

export async function runReleaseNotificationOutboxWorker(
  deps: ReleaseNotificationOutboxWorkerDeps = {},
): Promise<number> {
  try {
    const rows = await (deps.deliver ?? deliverReleaseNotificationOutboxBatch)();
    return rows.length;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    (deps.warn ?? console.warn)(`[release-notification-outbox] worker tick failed: ${detail}`);
    return 0;
  }
}
