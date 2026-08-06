import { deliverInfraAlertOutboxBatch } from './alert-outbox.js';

export const INFRA_ALERT_OUTBOX_WORKER_CRON = '* * * * *';

export interface InfraAlertOutboxWorkerDeps {
  deliver?: typeof deliverInfraAlertOutboxBatch;
  warn?: (message: string) => void;
}

export async function runInfraAlertOutboxWorker(
  deps: InfraAlertOutboxWorkerDeps = {},
): Promise<number> {
  try {
    const rows = await (deps.deliver ?? deliverInfraAlertOutboxBatch)();
    return rows.length;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    (deps.warn ?? console.warn)(`[infra-alert-outbox] worker tick failed: ${detail}`);
    return 0;
  }
}
