/**
 * Crash-recovery sweep for AWS Health event notifications.
 *
 * The ingest route commits the event, answers EventBridge (which times out an
 * API-destination request after 5 seconds), and only then fans the notification
 * out. If the process dies in that window — or the email outbox was briefly
 * unavailable — the row is committed with `notification_delivered_at_ms` still
 * NULL and nobody has been told about it.
 *
 * This sweep is what makes that window recoverable, and it is why the column
 * exists at all. Same shape as `recoverPendingInfraAlertNotifications` in
 * `alert-runner.ts`: re-run the fan-out for pending rows, and only mark them
 * delivered once it succeeds.
 *
 * It is deliberately NOT a redelivery guard. A duplicate arriving from
 * EventBridge never inserts (the unique constraint suppresses it), so it never
 * becomes pending and can never be swept — the dedupe and the recovery are
 * independent mechanisms that happen to reinforce each other.
 */
import { isInfraDbInitialized } from './infra-db.js';
import {
  listPendingInfraHealthEventNotifications,
  markInfraHealthEventNotified,
} from './health-event-store.js';
import { buildHealthEventBroadcast, notifyInfraHealthEvent } from './health-event-notifications.js';
import type { BroadcastFn } from '../react-loop-observability.js';

/** Cron cadence, matching the infra alert outbox worker it runs alongside. */
export const INFRA_HEALTH_RECOVERY_CRON = '*/5 * * * *';

/**
 * Pending rows swept per project per tick.
 *
 * Bounded so a long outage cannot turn one tick into an unbounded burst of
 * broadcasts and outbox writes; the next tick picks up the remainder.
 */
const RECOVERY_BATCH = 50;

export interface InfraHealthRecoveryResult {
  scanned: number;
  recovered: number;
  failed: number;
}

export interface InfraHealthRecoveryOptions {
  projectIds: readonly string[];
  broadcast?: BroadcastFn;
}

export function recoverPendingInfraHealthNotifications(
  opts: InfraHealthRecoveryOptions,
): InfraHealthRecoveryResult {
  const result: InfraHealthRecoveryResult = { scanned: 0, recovered: 0, failed: 0 };
  if (!isInfraDbInitialized()) return result;

  for (const projectId of opts.projectIds) {
    let pending;
    try {
      pending = listPendingInfraHealthEventNotifications(projectId, RECOVERY_BATCH);
    } catch (err) {
      console.error('[infra-health] recovery scan failed:', err);
      continue;
    }

    for (const row of pending) {
      result.scanned += 1;
      try {
        const payload = buildHealthEventBroadcast(row);
        const notification = notifyInfraHealthEvent(row, payload);
        if (notification.broadcast && opts.broadcast) opts.broadcast(payload);
        if (notification.emailEnqueueFailures === 0) {
          // Only retire the row once every configured path was attempted
          // cleanly. Otherwise it stays pending for the next tick.
          markInfraHealthEventNotified(row.id);
          result.recovered += 1;
        } else {
          result.failed += 1;
        }
      } catch (err) {
        result.failed += 1;
        console.error('[infra-health] recovery fan-out failed:', err);
      }
    }
  }

  return result;
}
