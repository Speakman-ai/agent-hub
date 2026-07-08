import { useCallback, useEffect, useState } from 'react';
import {
  ListTodo,
  CalendarDays,
  Mail,
  Briefcase,
  RefreshCw,
  ExternalLink,
  Circle,
  Link2,
} from 'lucide-react';
import {
  api,
  type MeDashboardWire,
  type DashboardWorkCardWire,
  type DashboardCalendarEventWire,
  type DashboardCardPriority,
  type UserTodoWire,
} from '../utils/api';
import { calendarPaneState, mailPaneState, type GooglePaneState } from '../utils/dashboardPanes';
import { dueLabel, dueState, todoDoDate } from '../utils/todos';

/**
 * Personal Dashboard home — the User Module's global (non-project) landing page
 * (spec NAV-PLACEMENT). Four panes over ONE per-user aggregation call
 * (`GET /api/me/dashboard`, spec AGGREGATION): My Work (assigned cards across
 * every visible board), Todos (cross-project capture list), Calendar, and
 * Gmail. The Google panes render the Workspace surfaces in place from the
 * aggregation payload and fall back to a connect-Google affordance when the
 * account isn't linked; Todos and My Work never depend on Google.
 */

interface PersonalDashboardProps {
  onNavigate: (view: string) => void;
  onOpenAccountSettings: () => void;
  onOpenKanban: (projectId: string) => void;
}

const PRIORITY_BADGE: Record<DashboardCardPriority, string> = {
  urgent: 'bg-red-900/40 text-red-300 border-red-800',
  high: 'bg-amber-900/40 text-amber-300 border-amber-800',
  medium: 'bg-gray-800 text-gray-400 border-gray-700',
  low: 'bg-gray-800/60 text-gray-500 border-gray-700',
};

const DUE_BADGE_CLASS: Record<string, string> = {
  overdue: 'bg-red-900/40 text-red-300 border-red-800',
  today: 'bg-amber-900/40 text-amber-300 border-amber-800',
  tomorrow: 'bg-blue-900/40 text-blue-300 border-blue-800',
  upcoming: 'bg-gray-800 text-gray-400 border-gray-700',
};

function localDateString(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function localTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function formatEventTime(ev: DashboardCalendarEventWire): string {
  if (ev.allDay) return 'All day';
  if (!ev.start) return '';
  const d = new Date(ev.start);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function Pane({
  title,
  icon,
  count,
  action,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col rounded-xl border border-gray-800 bg-gray-900 overflow-hidden">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
        <span className="text-gray-400">{icon}</span>
        <h2 className="text-sm font-semibold text-gray-200 flex-1 truncate">{title}</h2>
        {typeof count === 'number' && (
          <span className="text-xs font-medium text-gray-500 tabular-nums">{count}</span>
        )}
        {action}
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto p-3">{children}</div>
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="text-sm text-gray-500 px-1 py-4 text-center">{text}</p>;
}

function GoogleGate({
  state,
  surface,
  onConnect,
  onOpenSurface,
}: {
  state: GooglePaneState;
  surface: 'Calendar' | 'Gmail';
  onConnect: () => void;
  onOpenSurface: () => void;
}) {
  if (state === 'not-configured') {
    return (
      <EmptyState
        text={`Google Workspace isn't configured on this server, so ${surface} is unavailable.`}
      />
    );
  }
  const label =
    state === 'reconnect'
      ? 'Reconnect Google'
      : state === 'scope-required'
        ? `Enable ${surface}`
        : 'Connect Google';
  const blurb =
    state === 'reconnect'
      ? `Your Google connection needs to be refreshed to show ${surface}.`
      : state === 'scope-required'
        ? `Grant ${surface} access to see it here.`
        : `Connect your Google account to see ${surface} here.`;
  // A missing scope is granted inside the full surface page (incremental
  // consent); connect/reconnect happen in Settings -> Account.
  const onClick = state === 'scope-required' ? onOpenSurface : onConnect;
  return (
    <div className="flex flex-col items-center gap-3 px-3 py-6 text-center">
      <p className="text-sm text-gray-400">{blurb}</p>
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-200 hover:bg-gray-700 transition-colors"
      >
        {label}
      </button>
    </div>
  );
}

export default function PersonalDashboard({
  onNavigate,
  onOpenAccountSettings,
  onOpenKanban,
}: PersonalDashboardProps) {
  const [data, setData] = useState<MeDashboardWire | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (fresh: boolean) => {
    if (fresh) setRefreshing(true);
    setError(null);
    try {
      const next = await api.getMeDashboard({
        fresh,
        date: localDateString(),
        tz: localTimeZone(),
      });
      setData(next);
    } catch (err: any) {
      setError(err?.message || 'Failed to load dashboard');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  // A todo created/updated elsewhere (promote path, another tab) broadcasts a
  // window CustomEvent that App bridges from the `user_todo_update` WS event.
  useEffect(() => {
    const handler = () => load(true);
    window.addEventListener('user_todo_update', handler);
    return () => window.removeEventListener('user_todo_update', handler);
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        Loading your dashboard…
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-4">
        <p className="text-sm text-red-400">{error}</p>
        <button
          type="button"
          onClick={() => load(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700"
        >
          <RefreshCw size={14} /> Retry
        </button>
      </div>
    );
  }

  const work = data?.work;
  const todos = data?.todos.open ?? [];
  const google = data?.google;
  const calState = calendarPaneState(google);
  const mailState = mailPaneState(google);
  const openCards = (work?.cards ?? []).filter((c) => !c.isDone);

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 bg-gray-950">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center gap-3 mb-5">
          <h1 className="text-lg font-semibold text-white flex-1">Home</h1>
          <button
            type="button"
            onClick={() => load(true)}
            disabled={refreshing}
            data-testid="dashboard-refresh"
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-800 bg-gray-900 px-2.5 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 auto-rows-[minmax(0,20rem)]">
          {/* My Work — assigned cards across every visible project */}
          <Pane title="My Work" icon={<Briefcase size={15} />} count={work?.counts.open}>
            {openCards.length === 0 ? (
              <EmptyState text="No open cards assigned to you." />
            ) : (
              <ul className="space-y-1.5">
                {openCards.map((card) => (
                  <WorkCardRow
                    key={card.id}
                    card={card}
                    onOpen={() => onOpenKanban(card.projectId)}
                  />
                ))}
              </ul>
            )}
          </Pane>

          {/* Todos — cross-project personal capture list */}
          <Pane
            title="Todos"
            icon={<ListTodo size={15} />}
            count={data?.todos.openCount}
            action={
              <button
                type="button"
                onClick={() => onNavigate('todos')}
                className="text-xs text-gray-500 hover:text-gray-300 inline-flex items-center gap-1"
              >
                Open <ExternalLink size={11} />
              </button>
            }
          >
            {todos.length === 0 ? (
              <EmptyState text="No open todos. Nice." />
            ) : (
              <ul className="space-y-1.5">
                {todos.map((todo) => (
                  <TodoRow key={todo.id} todo={todo} />
                ))}
              </ul>
            )}
          </Pane>

          {/* Calendar — Google surface, gated */}
          <Pane
            title="Calendar"
            icon={<CalendarDays size={15} />}
            count={calState === 'ready' ? (google?.calendar.events.length ?? 0) : undefined}
            action={
              <button
                type="button"
                onClick={() => onNavigate('calendar')}
                className="text-xs text-gray-500 hover:text-gray-300 inline-flex items-center gap-1"
              >
                Open <ExternalLink size={11} />
              </button>
            }
          >
            {calState !== 'ready' ? (
              <GoogleGate
                state={calState}
                surface="Calendar"
                onConnect={onOpenAccountSettings}
                onOpenSurface={() => onNavigate('calendar')}
              />
            ) : google?.calendar.error ? (
              <EmptyState text={`Calendar unavailable: ${google.calendar.error}`} />
            ) : (google?.calendar.events.length ?? 0) === 0 ? (
              <EmptyState text="Nothing on your calendar today." />
            ) : (
              <ul className="space-y-1.5">
                {google!.calendar.events.map((ev, i) => (
                  <CalendarRow key={ev.id ?? i} ev={ev} />
                ))}
              </ul>
            )}
          </Pane>

          {/* Gmail — Google surface, gated */}
          <Pane
            title="Gmail"
            icon={<Mail size={15} />}
            count={mailState === 'ready' ? (google?.mail.unread ?? undefined) : undefined}
            action={
              <button
                type="button"
                onClick={() => onNavigate('gmail')}
                className="text-xs text-gray-500 hover:text-gray-300 inline-flex items-center gap-1"
              >
                Open <ExternalLink size={11} />
              </button>
            }
          >
            {mailState !== 'ready' ? (
              <GoogleGate
                state={mailState}
                surface="Gmail"
                onConnect={onOpenAccountSettings}
                onOpenSurface={() => onNavigate('gmail')}
              />
            ) : google?.mail.error ? (
              <EmptyState text={`Gmail unavailable: ${google.mail.error}`} />
            ) : (
              <MailSummary
                unread={google?.mail.unread ?? 0}
                starred={google?.mail.starred ?? 0}
                important={google?.mail.important ?? 0}
                onOpen={() => onNavigate('gmail')}
              />
            )}
          </Pane>
        </div>
      </div>
    </div>
  );
}

function WorkCardRow({ card, onOpen }: { card: DashboardWorkCardWire; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="w-full text-left rounded-lg border border-gray-800 bg-gray-900/60 hover:bg-gray-800/70 px-3 py-2 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span
            className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${PRIORITY_BADGE[card.priority]}`}
          >
            {card.priority}
          </span>
          <span className="text-sm text-gray-200 flex-1 truncate">{card.title}</span>
          {card.prUrl && <Link2 size={12} className="text-gray-500 flex-shrink-0" />}
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
          <span className="truncate">{card.projectName}</span>
          <span className="text-gray-700">·</span>
          <span className="truncate">{card.columnName}</span>
        </div>
      </button>
    </li>
  );
}

function TodoRow({ todo }: { todo: UserTodoWire }) {
  const doDate = todoDoDate(todo);
  const state = dueState(doDate);
  return (
    <li className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2">
      <Circle size={12} className="text-gray-600 flex-shrink-0" />
      <span className="text-sm text-gray-200 flex-1 truncate">{todo.title}</span>
      {doDate && (
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded border ${DUE_BADGE_CLASS[state] || DUE_BADGE_CLASS.upcoming}`}
        >
          {dueLabel(doDate)}
        </span>
      )}
    </li>
  );
}

function CalendarRow({ ev }: { ev: DashboardCalendarEventWire }) {
  const time = formatEventTime(ev);
  return (
    <li className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2">
      <span className="text-xs text-gray-400 w-16 flex-shrink-0 tabular-nums">{time}</span>
      <span className="text-sm text-gray-200 flex-1 truncate">{ev.summary || '(no title)'}</span>
      {ev.hangoutLink && (
        <a
          href={ev.hangoutLink}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-400 hover:text-blue-300 flex-shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          Join
        </a>
      )}
    </li>
  );
}

function MailSummary({
  unread,
  starred,
  important,
  onOpen,
}: {
  unread: number;
  starred: number;
  important: number;
  onOpen: () => void;
}) {
  const stats = [
    { label: 'Unread', value: unread },
    { label: 'Starred', value: starred },
    { label: 'Important', value: important },
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {stats.map((s) => (
        <button
          key={s.label}
          type="button"
          onClick={onOpen}
          className="flex flex-col items-center gap-1 rounded-lg border border-gray-800 bg-gray-900/60 hover:bg-gray-800/70 px-2 py-4 transition-colors"
        >
          <span className="text-2xl font-semibold text-gray-100 tabular-nums">{s.value}</span>
          <span className="text-xs text-gray-500">{s.label}</span>
        </button>
      ))}
    </div>
  );
}
