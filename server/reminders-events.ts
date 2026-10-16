/**
 * Event names and the owner-scoped `reminder_update` broadcast for personal
 * reminders. Separate module so the notification fan-out, the scheduler and
 * the calendar sweep can share them without an import cycle.
 */
import type { Reminder } from './reminders-store.js';
import type { BroadcastFn } from './types.js';

export const REMINDER_DUE_EVENT = 'reminder_due';
export const REMINDER_UPDATE_EVENT = 'reminder_update';

export type ReminderUpdateAction = 'created' | 'updated' | 'deleted' | 'fired';

/**
 * Tell the owner's open clients a reminder changed. Every path that changes
 * what a client shows must call this, including background ones (the
 * calendar sweep, the retention prune): clients only reload on mount.
 */
export function broadcastReminderUpdate(
  broadcast: BroadcastFn,
  action: ReminderUpdateAction,
  reminder: Pick<Reminder, 'id' | 'userId'> & Partial<Reminder>,
): void {
  broadcast({
    type: REMINDER_UPDATE_EVENT,
    ownerUserId: reminder.userId,
    action,
    reminderId: reminder.id,
    reminder: action === 'deleted' ? null : reminder,
  });
}
