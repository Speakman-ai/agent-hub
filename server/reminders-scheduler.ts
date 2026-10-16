/**
 * Fires due reminders and delivers their notifications.
 *
 * A once-a-minute cron (index.ts) calls `runRemindersTick`. Delivery is an
 * outbox: `claimDueReminder` flips the row to `fired` and records the owed
 * notification (`delivered_at` NULL) in one write. The tick then runs the
 * notification fan-out for it and marks it delivered only when the inbox
 * write succeeded. Anything still owed (a crash after the claim, a failed
 * insert) is claimed again by a later tick once its lease lapses, one reminder at a
 * time right before it is sent.
 *
 * The inbox row is exactly-once: its source key `reminder:<id>:<remindAt>`
 * dedupes a retried delivery. A retry after a crash in the middle of a
 * delivery can repeat the desktop notice or push (at-least-once), which beats
 * silently dropping a reminder.
 */
import { handleBroadcastForNotifications, defaultGetPrefs } from './notification-fanout.js';
import { insertNotification } from './notifications-store.js';
import {
  REMINDER_DUE_EVENT,
  REMINDER_UPDATE_EVENT,
  broadcastReminderUpdate,
  type ReminderUpdateAction,
} from './reminders-events.js';
import {
  claimDueReminder,
  claimReminderDelivery,
  listDueReminders,
  listUndeliveredReminders,
  markReminderDelivered,
  type Reminder,
} from './reminders-store.js';
import type { BroadcastFn } from './types.js';

export { REMINDER_DUE_EVENT, REMINDER_UPDATE_EVENT };
export const REMINDERS_TICK_CRON = '* * * * *';

export { broadcastReminderUpdate, type ReminderUpdateAction };

/** Resolves true when the notification reached the owner's inbox step. */
export type DeliverReminderFn = (reminder: Reminder, broadcast: BroadcastFn) => Promise<boolean>;

/**
 * Run the notification fan-out for a due reminder. Reports failure when the
 * inbox insert or the prefs read failed, since the fan-out logs and swallows
 * those; a user who turned in-app off for reminders counts as delivered.
 */
export const deliverReminderNotification: DeliverReminderFn = async (reminder, broadcast) => {
  let failed = false;
  await handleBroadcastForNotifications(
    { type: REMINDER_DUE_EVENT, ownerUserId: reminder.userId, reminder },
    {
      broadcast,
      insert: (input) => {
        try {
          return insertNotification(input);
        } catch (err) {
          failed = true;
          throw err;
        }
      },
      getPrefs: (userId, category) => {
        try {
          return defaultGetPrefs(userId, category);
        } catch (err) {
          failed = true;
          throw err;
        }
      },
    },
  );
  return !failed;
};

export interface ReminderTickDeps {
  broadcast: BroadcastFn;
  deliver?: DeliverReminderFn;
}

async function deliverOne(reminder: Reminder, deps: ReminderTickDeps, now: Date): Promise<boolean> {
  const deliver = deps.deliver ?? deliverReminderNotification;
  try {
    if (!(await deliver(reminder, deps.broadcast))) return false;
  } catch (err) {
    console.warn(
      `[reminders] delivery failed for ${reminder.id}:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
  if (reminder.firedAt) markReminderDelivered(reminder.id, reminder.firedAt, now);
  return true;
}

export interface ReminderTickResult {
  fired: Reminder[];
  delivered: number;
}

/**
 * Claim reminders that just came due, then deliver every owed notification:
 * the new ones and any left over from an earlier tick.
 */
export async function fireDueReminders(
  deps: ReminderTickDeps,
  now: Date = new Date(),
): Promise<ReminderTickResult> {
  const fired: Reminder[] = [];
  let delivered = 0;
  for (const due of listDueReminders(now)) {
    const reminder = claimDueReminder(due.id, now);
    if (!reminder) continue;
    fired.push(reminder);
    broadcastReminderUpdate(deps.broadcast, 'fired', reminder);
    if (await deliverOne(reminder, deps, now)) delivered += 1;
  }
  // Deliveries are awaited one by one, so each owed one is (re)claimed just
  // before it is sent: a reminder dismissed, snoozed or re-fired while an
  // earlier delivery was pending is no longer sent from a stale snapshot.
  for (const candidate of listUndeliveredReminders(now)) {
    const owed = claimReminderDelivery(candidate.id, candidate.firedAt, now);
    if (!owed) continue;
    if (await deliverOne(owed, deps, now)) delivered += 1;
  }
  return { fired, delivered };
}

/** Cron entry point: never throws. */
export async function runRemindersTick(
  broadcast: BroadcastFn,
  now: Date = new Date(),
): Promise<number> {
  try {
    return (await fireDueReminders({ broadcast }, now)).fired.length;
  } catch (err) {
    console.warn('[reminders] tick failed:', err instanceof Error ? err.message : String(err));
    return 0;
  }
}
