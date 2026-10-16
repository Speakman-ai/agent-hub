import { describe, it, expect } from 'vitest';
import {
  applyReminderUpdate,
  formatReminderTime,
  groupReminders,
  isoToLocalInput,
  localInputToIso,
  parseLocalDateTime,
  REMINDER_PRESETS,
  tomorrowAt,
  reminderCalendarLabel,
  ReminderListState,
  type ReminderWire,
} from './reminders';

function r(over: Partial<ReminderWire>): ReminderWire {
  return {
    id: 'r',
    userId: 'u',
    title: 't',
    notes: '',
    remindAt: '2026-10-16T12:00:00.000Z',
    status: 'pending',
    createdBy: 'user',
    sessionId: null,
    agentId: null,
    projectId: null,
    calendar: { status: 'none', calendarId: null, eventId: null, eventUrl: null, error: null },
    firedAt: null,
    dismissedAt: null,
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
    revision: 1,
    ...over,
  };
}

describe('reminders helpers', () => {
  it('groups by status with the right order', () => {
    const g = groupReminders([
      r({ id: 'p2', remindAt: '2026-10-18T00:00:00Z' }),
      r({ id: 'f1', status: 'fired', remindAt: '2026-10-15T00:00:00Z' }),
      r({ id: 'p1', remindAt: '2026-10-17T00:00:00Z' }),
      r({ id: 'f2', status: 'fired', remindAt: '2026-10-16T00:00:00Z' }),
      r({ id: 'd1', status: 'dismissed', dismissedAt: '2026-10-16T00:00:00Z' }),
    ]);
    expect(g.upcoming.map((x) => x.id)).toEqual(['p1', 'p2']);
    expect(g.due.map((x) => x.id)).toEqual(['f2', 'f1']);
    expect(g.dismissed.map((x) => x.id)).toEqual(['d1']);
  });

  it('applies create, update and delete events', () => {
    const list = [r({ id: 'a' }), r({ id: 'b' })];
    expect(
      applyReminderUpdate(list, { action: 'deleted', reminderId: 'a' }).map((x) => x.id),
    ).toEqual(['b']);
    const updated = applyReminderUpdate(list, {
      action: 'updated',
      reminderId: 'a',
      reminder: r({ id: 'a', title: 'new' }),
    });
    expect(updated.find((x) => x.id === 'a')?.title).toBe('new');
    expect(updated).toHaveLength(2);
    expect(
      applyReminderUpdate(list, { action: 'created', reminderId: 'c', reminder: r({ id: 'c' }) }),
    ).toHaveLength(3);
  });

  it('labels times relative to now', () => {
    const now = new Date(2026, 9, 16, 14, 0);
    expect(formatReminderTime(new Date(2026, 9, 16, 14, 25).toISOString(), now)).toBe('in 25 min');
    expect(formatReminderTime(new Date(2026, 9, 16, 18, 0).toISOString(), now)).toMatch(/^Today /);
    expect(formatReminderTime(new Date(2026, 9, 17, 9, 0).toISOString(), now)).toMatch(
      /^Tomorrow /,
    );
    expect(formatReminderTime(new Date(2026, 9, 15, 9, 0).toISOString(), now)).toMatch(
      /^Yesterday /,
    );
  });

  it('resolves presets to absolute moments at the time they are picked', () => {
    const pickedAt = new Date(2026, 9, 16, 12, 0);
    const byId = Object.fromEntries(REMINDER_PRESETS.map((p) => [p.id, p]));
    expect(byId['10m'].at(pickedAt).getTime()).toBe(pickedAt.getTime() + 10 * 60 * 1000);
    expect(byId['tomorrow-9am'].at(pickedAt)).toEqual(new Date(2026, 9, 17, 9, 0));
    // Picked late in the evening still means 9 AM the next day, not a fixed offset.
    expect(byId['tomorrow-9am'].at(new Date(2026, 9, 16, 23, 50))).toEqual(
      new Date(2026, 9, 17, 9, 0),
    );
    expect(tomorrowAt(9, new Date(2026, 11, 31, 8, 0))).toEqual(new Date(2027, 0, 1, 9, 0));
  });

  it('rejects typed times that are not real moments instead of rolling them over', () => {
    for (const bad of [
      '2026-10-17 25:00', // hour
      '2026-10-17 24:00',
      '2026-10-17 09:60', // minute
      '2027-02-30 09:00', // day past month end
      '2027-02-29 09:00', // not a leap year
      '2026-04-31 09:00',
      '2026-13-01 09:00', // month
      '2026-00-10 09:00',
      '2026-10-00 09:00',
      '2026-10-17 9', // incomplete
      '2026-10-17',
      'tomorrow',
    ]) {
      expect(parseLocalDateTime(bad), bad).toBeNull();
    }
    const leap = parseLocalDateTime('2028-02-29 09:00');
    expect(leap && new Date(leap)).toEqual(new Date(2028, 1, 29, 9, 0));
    const short = parseLocalDateTime('2026-10-17 9:05');
    expect(short && new Date(short)).toEqual(new Date(2026, 9, 17, 9, 5));
  });

  it('round-trips datetime-local values', () => {
    const iso = localInputToIso('2026-10-17T09:30');
    expect(iso).not.toBeNull();
    expect(isoToLocalInput(iso as string)).toBe('2026-10-17T09:30');
    expect(localInputToIso('tomorrow')).toBeNull();
  });

  it('describes the calendar mirror', () => {
    expect(reminderCalendarLabel(r({}))).toBeNull();
    expect(
      reminderCalendarLabel(
        r({
          calendar: {
            ...r({}).calendar,
            status: 'skipped',
            error: 'Google account is not connected',
          },
        }),
      ),
    ).toBe('Not on calendar: Google account is not connected');
    expect(
      reminderCalendarLabel(
        r({ calendar: { ...r({}).calendar, status: 'removing', error: null } }),
      ),
    ).toBe('Removing from your calendar');
    expect(
      reminderCalendarLabel(
        r({ calendar: { ...r({}).calendar, status: 'removing', error: 'backend error' } }),
      ),
    ).toBe('Removing from your calendar (will retry: backend error)');
    expect(reminderCalendarLabel(r({ calendar: { ...r({}).calendar, status: 'synced' } }))).toBe(
      'On your calendar',
    );
  });

  it('ignores an update older than the row already held', () => {
    const list = [r({ id: 'a', status: 'fired', revision: 3 })];
    const stale = applyReminderUpdate(list, {
      action: 'updated',
      reminderId: 'a',
      reminder: r({ id: 'a', status: 'pending', revision: 2 }),
    });
    expect(stale[0].status).toBe('fired');
  });
});

describe('ReminderListState', () => {
  it('keeps a reminder that fired while the list request was in flight', () => {
    const sync = new ReminderListState();
    const token = sync.beginLoad();
    // The server read the list (pending, rev 1), then the reminder fired.
    let current = sync.apply([], {
      action: 'fired',
      reminderId: 'a',
      reminder: r({ id: 'a', status: 'fired', revision: 2 }),
    });
    current = sync.finishLoad(token, [r({ id: 'a', status: 'pending', revision: 1 })], current)!;
    expect(current.map((x) => [x.id, x.status])).toEqual([['a', 'fired']]);
  });

  it('does not resurrect a reminder deleted while the list request was in flight', () => {
    const sync = new ReminderListState();
    let current = [r({ id: 'a' }), r({ id: 'b' })];
    const token = sync.beginLoad();
    current = sync.apply(current, { action: 'deleted', reminderId: 'a' });
    current = sync.finishLoad(token, [r({ id: 'a' }), r({ id: 'b' })], current)!;
    expect(current.map((x) => x.id)).toEqual(['b']);
    // Nor can a late update for it.
    current = sync.apply(current, {
      action: 'updated',
      reminderId: 'a',
      reminder: r({ id: 'a', revision: 9 }),
    });
    expect(current.map((x) => x.id)).toEqual(['b']);
  });

  it('keeps a reminder created while the list request was in flight', () => {
    const sync = new ReminderListState();
    const token = sync.beginLoad();
    let current = sync.apply([], {
      action: 'created',
      reminderId: 'new',
      reminder: r({ id: 'new' }),
    });
    current = sync.finishLoad(token, [r({ id: 'old' })], current)!;
    expect(current.map((x) => x.id).sort()).toEqual(['new', 'old']);
  });

  it('takes the response when it is newer than the live row, and drops rows the server no longer has', () => {
    const sync = new ReminderListState();
    let current = [r({ id: 'a', revision: 1 }), r({ id: 'gone' })];
    const token = sync.beginLoad();
    current = sync.apply(current, {
      action: 'updated',
      reminderId: 'a',
      reminder: r({ id: 'a', title: 'live', revision: 2 }),
    });
    current = sync.finishLoad(token, [r({ id: 'a', title: 'list', revision: 3 })], current)!;
    expect(current).toEqual([expect.objectContaining({ id: 'a', title: 'list' })]);
  });

  it('ignores the response of a superseded load', () => {
    const sync = new ReminderListState();
    const first = sync.beginLoad();
    sync.beginLoad();
    expect(sync.finishLoad(first, [r({ id: 'a' })], [])).toBeNull();
  });
});
