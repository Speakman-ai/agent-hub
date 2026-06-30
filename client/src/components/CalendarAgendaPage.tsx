import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CalendarDays,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import { api } from '../utils/api';

export const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

type GoogleStatus = {
  connected: boolean;
  email?: string | null;
  grantedScopes?: string[];
  serverConfigured?: boolean;
};

type CalendarEventTime = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

type CalendarEvent = {
  id: string | null;
  summary: string | null;
  description: string | null;
  location: string | null;
  htmlLink: string | null;
  start: CalendarEventTime | null;
  end: CalendarEventTime | null;
};

type EventFormState = {
  summary: string;
  location: string;
  description: string;
  allDay: boolean;
  startDate: string;
  endDate: string;
  startDateTime: string;
  endDateTime: string;
  timeZone: string;
};

function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function localDate(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localDateTime(date: Date) {
  return `${localDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseEventDateTime(value: string | undefined | null) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && !/(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return value.slice(0, 16);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  return localDateTime(date);
}

export function defaultCalendarRange(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = addDays(start, 7);
  return {
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
  };
}

function defaultFormState(): EventFormState {
  const now = new Date();
  const start = new Date(now);
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  const end = new Date(start);
  end.setHours(end.getHours() + 1);
  const tomorrow = addDays(now, 1);
  return {
    summary: '',
    location: '',
    description: '',
    allDay: false,
    startDate: localDate(now),
    endDate: localDate(tomorrow),
    startDateTime: localDateTime(start),
    endDateTime: localDateTime(end),
    timeZone: localTimeZone(),
  };
}

function formFromEvent(event: CalendarEvent): EventFormState {
  const base = defaultFormState();
  const allDay = !!event.start?.date;
  return {
    ...base,
    summary: event.summary || '',
    location: event.location || '',
    description: event.description || '',
    allDay,
    startDate: event.start?.date || base.startDate,
    endDate: event.end?.date || base.endDate,
    startDateTime: parseEventDateTime(event.start?.dateTime) || base.startDateTime,
    endDateTime: parseEventDateTime(event.end?.dateTime) || base.endDateTime,
    timeZone: event.start?.timeZone || event.end?.timeZone || base.timeZone,
  };
}

function withSeconds(value: string) {
  return value.length === 16 ? `${value}:00` : value;
}

export function buildCalendarEventInput(form: EventFormState) {
  return {
    summary: form.summary.trim(),
    location: form.location.trim() || undefined,
    description: form.description.trim() || undefined,
    start: form.allDay
      ? { date: form.startDate }
      : { dateTime: withSeconds(form.startDateTime), timeZone: form.timeZone.trim() || 'UTC' },
    end: form.allDay
      ? { date: form.endDate }
      : { dateTime: withSeconds(form.endDateTime), timeZone: form.timeZone.trim() || 'UTC' },
  };
}

function eventStartMillis(event: CalendarEvent) {
  const raw = event.start?.dateTime || event.start?.date;
  if (!raw) return 0;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function eventTimeLabel(event: CalendarEvent) {
  if (event.start?.date) {
    const start = new Date(`${event.start.date}T00:00:00`);
    return Number.isNaN(start.getTime()) ? event.start.date : start.toLocaleDateString();
  }
  const start = event.start?.dateTime ? new Date(event.start.dateTime) : null;
  const end = event.end?.dateTime ? new Date(event.end.dateTime) : null;
  if (!start || Number.isNaN(start.getTime())) return 'Time not set';
  const date = start.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const startTime = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const endTime =
    end && !Number.isNaN(end.getTime())
      ? end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : '';
  return `${date}, ${startTime}${endTime ? ` to ${endTime}` : ''}`;
}

function hasCalendarScope(status: GoogleStatus | null) {
  const scopes = status?.grantedScopes || [];
  return (
    scopes.includes(CALENDAR_EVENTS_SCOPE) ||
    scopes.includes('https://www.googleapis.com/auth/calendar')
  );
}

function CalendarEventModal({
  event,
  saving,
  error,
  onCancel,
  onSubmit,
}: {
  event: CalendarEvent | null;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (form: EventFormState) => void;
}) {
  const [form, setForm] = useState<EventFormState>(() =>
    event ? formFromEvent(event) : defaultFormState(),
  );

  const setField = (field: keyof EventFormState, value: string | boolean) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const valid =
    form.summary.trim() &&
    (form.allDay ? form.startDate && form.endDate : form.startDateTime && form.endDateTime);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-xl rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-white">
              {event ? 'Edit event' : 'Create event'}
            </h3>
            <p className="text-xs text-gray-500">Primary calendar</p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-2 text-gray-400 hover:bg-gray-800 hover:text-white"
            aria-label="Close event modal"
          >
            <X size={16} />
          </button>
        </div>
        <form
          className="space-y-4 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) onSubmit(form);
          }}
        >
          <label className="block">
            <span className="text-xs text-gray-400">Title</span>
            <input
              value={form.summary}
              onChange={(e) => setField('summary', e.target.value)}
              className="mt-1 w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
              autoFocus
            />
          </label>
          <div className="flex items-center gap-2">
            <input
              id="calendar-all-day"
              type="checkbox"
              checked={form.allDay}
              onChange={(e) => setField('allDay', e.target.checked)}
              className="h-4 w-4 rounded border-gray-700 bg-gray-950"
            />
            <label htmlFor="calendar-all-day" className="text-sm text-gray-300">
              All day
            </label>
          </div>
          {form.allDay ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs text-gray-400">Start date</span>
                <input
                  type="date"
                  value={form.startDate}
                  onChange={(e) => setField('startDate', e.target.value)}
                  className="mt-1 w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
                />
              </label>
              <label className="block">
                <span className="text-xs text-gray-400">End date</span>
                <input
                  type="date"
                  value={form.endDate}
                  onChange={(e) => setField('endDate', e.target.value)}
                  className="mt-1 w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
                />
              </label>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs text-gray-400">Starts</span>
                <input
                  type="datetime-local"
                  value={form.startDateTime}
                  onChange={(e) => setField('startDateTime', e.target.value)}
                  className="mt-1 w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
                />
              </label>
              <label className="block">
                <span className="text-xs text-gray-400">Ends</span>
                <input
                  type="datetime-local"
                  value={form.endDateTime}
                  onChange={(e) => setField('endDateTime', e.target.value)}
                  className="mt-1 w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="text-xs text-gray-400">Time zone</span>
                <input
                  value={form.timeZone}
                  onChange={(e) => setField('timeZone', e.target.value)}
                  className="mt-1 w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
                />
              </label>
            </div>
          )}
          <label className="block">
            <span className="text-xs text-gray-400">Location</span>
            <input
              value={form.location}
              onChange={(e) => setField('location', e.target.value)}
              className="mt-1 w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
            />
          </label>
          <label className="block">
            <span className="text-xs text-gray-400">Description</span>
            <textarea
              value={form.description}
              onChange={(e) => setField('description', e.target.value)}
              rows={4}
              className="mt-1 w-full resize-none rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
            />
          </label>
          {error && (
            <div className="rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!valid || saving}
              className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : null}
              {event ? 'Save changes' : 'Create event'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function CalendarAgendaPage({
  projectId: _projectId,
  onOpenAccountSettings,
}: {
  projectId: string;
  onOpenAccountSettings?: () => void;
}) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [modalEvent, setModalEvent] = useState<CalendarEvent | null | undefined>(undefined);
  const [modalError, setModalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const range = useMemo(() => defaultCalendarRange(), []);

  const load = useCallback(async () => {
    setError(null);
    setEventsLoading(true);
    try {
      const nextStatus = await api.getGoogleStatus();
      setStatus(nextStatus);
      if (nextStatus.connected && hasCalendarScope(nextStatus)) {
        const body = await api.listGoogleCalendarEvents({
          ...range,
          timeZone: localTimeZone(),
          maxResults: 100,
        });
        setEvents(
          [...(body.events || [])].sort((a, b) => eventStartMillis(a) - eventStartMillis(b)),
        );
      } else {
        setEvents([]);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load Calendar');
      setEvents([]);
    } finally {
      setLoading(false);
      setEventsLoading(false);
    }
  }, [range]);

  useEffect(() => {
    load();
  }, [load]);

  const startOAuth = async () => {
    setOauthBusy(true);
    setError(null);
    try {
      const returnTo = window.location.pathname + window.location.search + window.location.hash;
      const body = await api.startGoogleOAuth({ returnTo, scopes: [CALENDAR_EVENTS_SCOPE] });
      window.location.href = body.authorizeUrl;
    } catch (err: any) {
      setError(err.message || 'Failed to start Google consent');
      setOauthBusy(false);
    }
  };

  const saveEvent = async (form: EventFormState) => {
    setSaving(true);
    setModalError(null);
    try {
      const event = buildCalendarEventInput(form);
      if (modalEvent?.id) {
        await api.updateGoogleCalendarEvent(modalEvent.id, { calendarId: 'primary', event });
      } else {
        await api.createGoogleCalendarEvent({ calendarId: 'primary', event });
      }
      setModalEvent(undefined);
      await load();
    } catch (err: any) {
      setModalError(err.message || 'Failed to save event');
    } finally {
      setSaving(false);
    }
  };

  const connected = !!status?.connected;
  const configured = status?.serverConfigured !== false;
  const calendarEnabled = hasCalendarScope(status);

  let emptyState = null;
  if (!configured && !connected) {
    emptyState = {
      title: 'Google is not configured',
      body: 'An Admin needs to add the Google OAuth app before Calendar can connect.',
      action: onOpenAccountSettings ? 'Open Account settings' : null,
      onAction: onOpenAccountSettings,
    };
  } else if (!connected) {
    emptyState = {
      title: 'Connect Google to use Calendar',
      body: 'Calendar events stay server-side through the Google proxy. Connect your account to continue.',
      action: 'Connect Google',
      onAction: startOAuth,
    };
  } else if (!calendarEnabled) {
    emptyState = {
      title: 'Enable Calendar access',
      body: `Connected as ${status?.email || 'Google account'}, but Calendar access has not been granted yet.`,
      action: 'Enable Calendar',
      onAction: startOAuth,
    };
  } else if (!events.length && !eventsLoading) {
    emptyState = {
      title: 'No events this week',
      body: 'Create an event or refresh after adding one in Google Calendar.',
      action: 'Create event',
      onAction: () => setModalEvent(null),
    };
  }

  return (
    <div className="flex-1 overflow-y-auto bg-gray-950 p-4 md:p-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-blue-300">
              <CalendarDays size={14} />
              Calendar
            </div>
            <h2 className="mt-1 text-2xl font-semibold text-white">Agenda</h2>
            <p className="mt-1 text-sm text-gray-400">
              Upcoming events from your primary Google Calendar.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={load}
              disabled={eventsLoading}
              className="inline-flex items-center gap-2 rounded border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-50"
            >
              <RefreshCw size={14} className={eventsLoading ? 'animate-spin' : ''} />
              Refresh
            </button>
            {connected && calendarEnabled && (
              <button
                type="button"
                onClick={() => setModalEvent(null)}
                className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500"
              >
                <Plus size={14} />
                Create event
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm text-gray-400">
            <Loader2 size={16} className="animate-spin" />
            Loading Calendar...
          </div>
        ) : emptyState ? (
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
            <h3 className="text-lg font-semibold text-white">{emptyState.title}</h3>
            <p className="mt-2 max-w-2xl text-sm text-gray-400">{emptyState.body}</p>
            {emptyState.action && (
              <button
                type="button"
                onClick={emptyState.onAction}
                disabled={oauthBusy}
                className="mt-4 inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {oauthBusy ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <ExternalLink size={14} />
                )}
                {emptyState.action}
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-gray-800 bg-gray-900">
            {events.map((event) => (
              <div
                key={event.id || `${event.summary}-${eventTimeLabel(event)}`}
                className="flex gap-4 border-b border-gray-800 p-4 last:border-b-0"
              >
                <div className="w-36 flex-shrink-0 text-sm text-gray-400">
                  {eventTimeLabel(event)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-white">
                        {event.summary || '(no title)'}
                      </h3>
                      {event.location && (
                        <p className="mt-1 text-xs text-gray-400">{event.location}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setModalEvent(event)}
                      className="inline-flex flex-shrink-0 items-center gap-1 rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
                    >
                      <Pencil size={12} />
                      Edit
                    </button>
                  </div>
                  {event.description && (
                    <p className="mt-2 whitespace-pre-wrap text-sm text-gray-300">
                      {event.description}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {modalEvent !== undefined && (
        <CalendarEventModal
          event={modalEvent}
          saving={saving}
          error={modalError}
          onCancel={() => setModalEvent(undefined)}
          onSubmit={saveEvent}
        />
      )}
    </div>
  );
}
