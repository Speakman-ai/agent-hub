import { deliverReleaseNotificationOutboxBatch } from './release-notification-outbox.js';
import type { ReleaseDigestRunner } from './release-digest.js';
import type { AppConfig, BroadcastFn } from './types.js';

export const RELEASE_NOTIFICATION_OUTBOX_WORKER_CRON = '* * * * *';

export interface ReleaseNotificationOutboxWorkerDeps {
  deliver?: typeof deliverReleaseNotificationOutboxBatch;
  warn?: (message: string) => void;
  /** Threaded into the delivery batch so sent/failed transitions fan out over WS. */
  broadcast?: BroadcastFn;
  /** Lets the worker regenerate digests held after a failed generation. */
  cfg?: AppConfig;
  releaseDigestRunner?: ReleaseDigestRunner;
}

export async function runReleaseNotificationOutboxWorker(
  deps: ReleaseNotificationOutboxWorkerDeps = {},
): Promise<number> {
  try {
    const rows = await (deps.deliver ?? deliverReleaseNotificationOutboxBatch)(undefined, {
      broadcast: deps.broadcast,
      cfg: deps.cfg,
      releaseDigestRunner: deps.releaseDigestRunner,
    });
    return rows.length;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    (deps.warn ?? console.warn)(`[release-notification-outbox] worker tick failed: ${detail}`);
    return 0;
  }
}
