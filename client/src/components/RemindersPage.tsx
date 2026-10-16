import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BellRing,
  Bot,
  CalendarCheck,
  CalendarX,
  Check,
  Clock,
  ExternalLink,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { api } from '../utils/api';
import {
  REMINDER_UPDATE_EVENT,
  ReminderListState,
  formatReminderTime,
  groupReminders,
  isoToLocalInput,
  localInputToIso,
  reminderCalendarLabel,
  REMINDER_PRESETS,
  type ReminderWire,
} from '@shared/utils/reminders';

export interface RemindersPageProps {
  onOpenSession?: (target: { sessionId: string; agentId: string | null }) => void;
  onOpenAccountSettings?: () => void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Personal reminders pane in Hub. Reminders come from the user or from agents
 * in their sessions; when due they fire into the notification inbox. Live
 * updates arrive as `reminder_update` (bridged to a window event by App.tsx).
 */
export default function RemindersPage({
  onOpenSession,
  onOpenAccountSettings,
}: RemindersPageProps) {
  const [reminders, setReminders] = useState<ReminderWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState('');
  const [notes, setNotes] = useState('');
  const [toCalendar, setToCalendar] = useState(true);
  const [adding, setAdding] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // Orders list responses against live events and our own writes, so an
  // older list snapshot can't undo a reminder firing or being deleted.
  const listState = useRef(new ReminderListState()).current;

  const load = useCallback(async () => {
    setLoading(true);
    const token = listState.beginLoad();
    try {
      const res = await api.listReminders('all');
      setReminders((cur) => listState.finishLoad(token, res.reminders, cur) ?? cur);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [listState]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      setReminders((prev) => listState.apply(prev, detail));
    };
    window.addEventListener(REMINDER_UPDATE_EVENT, onUpdate);
    return () => window.removeEventListener(REMINDER_UPDATE_EVENT, onUpdate);
  }, [listState]);

  // Keep "in 5 min" style labels fresh.
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 30 * 1000);
    return () => window.clearInterval(t);
  }, []);

  const groups = useMemo(() => groupReminders(reminders), [reminders]);

  const upsert = (r: ReminderWire) =>
    setReminders((prev) => listState.apply(prev, { reminderId: r.id, reminder: r }));

  const add = async () => {
    const remindAt = localInputToIso(when);
    if (!title.trim() || !remindAt) return;
    setAdding(true);
    try {
      const res = await api.createReminder({
        title: title.trim(),
        notes: notes.trim() || undefined,
        remindAt,
        calendar: toCalendar ? 'auto' : 'none',
      });
      upsert(res.reminder);
      setTitle('');
      setWhen('');
      setNotes('');
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setAdding(false);
    }
  };

  const mutate = async (fn: () => Promise<{ reminder: ReminderWire }>) => {
    try {
      upsert((await fn()).reminder);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const remove = async (r: ReminderWire) => {
    try {
      await api.deleteReminder(r.id);
      setReminders((prev) => listState.apply(prev, { action: 'deleted', reminderId: r.id }));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const renderRow = (r: ReminderWire) => {
    const calendarLabel = reminderCalendarLabel(r);
    const due = r.status === 'fired';
    return (
      <li
        key={r.id}
        data-testid={`reminder-row-${r.id}`}
        className={`rounded-lg border px-3 py-2.5 ${
          due ? 'border-amber-700 bg-amber-950/30' : 'border-gray-800 bg-gray-900'
        }`}
      >
        <div className="flex items-start gap-3">
          <Clock
            size={16}
            className={`mt-0.5 shrink-0 ${due ? 'text-amber-400' : 'text-gray-500'}`}
          />
          <div className="flex-1 min-w-0">
            <div
              className={`text-sm ${r.status === 'dismissed' ? 'text-gray-500 line-through' : 'text-white'}`}
            >
              {r.title}
            </div>
            {r.notes && (
              <div className="mt-0.5 text-xs text-gray-400 whitespace-pre-wrap">{r.notes}</div>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500">
              <span data-testid={`reminder-time-${r.id}`}>
                {formatReminderTime(r.remindAt, now)}
              </span>
              {r.createdBy === 'agent' && (
                <span className="inline-flex items-center gap-1 text-cyan-400">
                  <Bot size={11} />
                  Set by an agent
                </span>
              )}
              {r.sessionId && onOpenSession && (
                <button
                  type="button"
                  onClick={() =>
                    onOpenSession({ sessionId: r.sessionId as string, agentId: r.agentId })
                  }
                  className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"
                >
                  <ExternalLink size={11} />
                  Open session
                </button>
              )}
              {calendarLabel &&
                (r.calendar.status === 'synced' && r.calendar.eventUrl ? (
                  <a
                    href={r.calendar.eventUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-emerald-400 hover:text-emerald-300"
                  >
                    <CalendarCheck size={11} />
                    {calendarLabel}
                  </a>
                ) : (
                  <span
                    className={`inline-flex items-center gap-1 ${
                      r.calendar.status === 'synced' ? 'text-emerald-400' : 'text-gray-500'
                    }`}
                  >
                    {r.calendar.status === 'synced' ? (
                      <CalendarCheck size={11} />
                    ) : (
                      <CalendarX size={11} />
                    )}
                    {calendarLabel}
                  </span>
                ))}
            </div>
            {due && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-gray-400 mr-1">Snooze</span>
                {REMINDER_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    data-testid={`reminder-snooze-${r.id}-${p.id}`}
                    onClick={() =>
                      void mutate(() =>
                        api.updateReminder(r.id, { remindAt: p.at(new Date()).toISOString() }),
                      )
                    }
                    className="rounded-md bg-gray-800 px-2 py-0.5 text-[11px] text-gray-200 hover:bg-gray-700"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {due && (
              <button
                type="button"
                data-testid={`reminder-dismiss-${r.id}`}
                onClick={() => void mutate(() => api.updateReminder(r.id, { status: 'dismissed' }))}
                className="inline-flex items-center gap-1 rounded-md bg-amber-700 px-2 py-1 text-xs text-white hover:bg-amber-600"
              >
                <Check size={12} />
                Done
              </button>
            )}
            <button
              type="button"
              aria-label={`Delete reminder ${r.title}`}
              data-testid={`reminder-delete-${r.id}`}
              onClick={() => void remove(r)}
              className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-red-400"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      </li>
    );
  };

  const empty =
    !loading && groups.due.length === 0 && groups.upcoming.length === 0 && !showDismissed;
  const calendarIssue = reminders.find(
    (r) =>
      r.calendar.status === 'skipped' &&
      /not connected|not been granted|reconnect/i.test(r.calendar.error ?? ''),
  );

  return (
    <div className="flex-1 overflow-y-auto bg-gray-950">
      <div className="max-w-3xl mx-auto p-4 md:p-8" data-testid="reminders-page">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <BellRing size={28} className="text-amber-400" />
            <div>
              <h1 className="text-2xl font-semibold text-white">Reminders</h1>
              <p className="text-sm text-gray-500">
                Set by you or your agents. Due reminders show up in notifications.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh reminders"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

        <form
          className="mb-6 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Remind me to…"
              aria-label="Reminder title"
              data-testid="reminder-new-title"
              className="flex-1 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <input
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              aria-label="Reminder time"
              data-testid="reminder-new-when"
              className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={adding || !title.trim() || !localInputToIso(when)}
              data-testid="reminder-add"
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-50"
            >
              <Plus size={16} />
              Add
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {REMINDER_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                data-testid={`reminder-preset-${p.id}`}
                onClick={() => setWhen(isoToLocalInput(p.at(new Date()).toISOString()))}
                className="rounded-md bg-gray-800 px-2 py-0.5 text-[11px] text-gray-300 hover:bg-gray-700"
              >
                {p.label}
              </button>
            ))}
            <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-gray-400">
              <input
                type="checkbox"
                checked={toCalendar}
                onChange={(e) => setToCalendar(e.target.checked)}
                data-testid="reminder-new-calendar"
              />
              Add to Google Calendar
            </label>
          </div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes (optional)…"
            aria-label="Reminder notes"
            rows={2}
            className="w-full resize-y bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </form>

        {error && (
          <div
            role="alert"
            className="mb-4 px-4 py-3 rounded-lg bg-red-900/30 border border-red-800 text-red-300 text-sm"
          >
            {error}
          </div>
        )}

        {calendarIssue && onOpenAccountSettings && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-900 px-4 py-2.5 text-xs text-gray-400">
            <span>Connect Google Calendar to also put reminders on your calendar.</span>
            <button
              type="button"
              onClick={onOpenAccountSettings}
              className="shrink-0 text-blue-400 hover:text-blue-300"
            >
              Account settings
            </button>
          </div>
        )}

        {loading && reminders.length === 0 ? (
          <div className="text-gray-500 text-sm px-1">Loading reminders…</div>
        ) : empty ? (
          <div data-testid="reminders-empty" className="text-center text-gray-500 text-sm py-12">
            No reminders. Add one above, or ask an agent to remind you.
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {groups.due.length > 0 && (
              <section>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-400">
                  Due ({groups.due.length})
                </h2>
                <ul className="flex flex-col gap-2">{groups.due.map(renderRow)}</ul>
              </section>
            )}
            {groups.upcoming.length > 0 && (
              <section>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
                  Upcoming ({groups.upcoming.length})
                </h2>
                <ul className="flex flex-col gap-2">{groups.upcoming.map(renderRow)}</ul>
              </section>
            )}
            {showDismissed && groups.dismissed.length > 0 && (
              <section>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Done ({groups.dismissed.length})
                </h2>
                <ul className="flex flex-col gap-2">{groups.dismissed.map(renderRow)}</ul>
              </section>
            )}
          </div>
        )}

        {groups.dismissed.length > 0 && (
          <button
            type="button"
            data-testid="reminders-toggle-dismissed"
            onClick={() => setShowDismissed((v) => !v)}
            className="mt-6 text-xs text-gray-500 hover:text-gray-300"
          >
            {showDismissed ? 'Hide done' : `Show done (${groups.dismissed.length})`}
          </button>
        )}
      </div>
    </div>
  );
}
