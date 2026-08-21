import { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock, Plus, RefreshCw, ScrollText, Trash2 } from 'lucide-react';
import {
  api,
  type DailySummaryReportWire,
  type DailySummaryScheduleWire,
  type DailySummaryWire,
} from '../utils/api';
import { MarkdownContent, markdownComponentsCompact } from './MarkdownRenderer';
import { dispatchDailySummaryHref } from '@shared/utils/dailySummaryLinks';

function localTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function formatGeneratedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export interface DailySummaryPageProps {
  onOpenCard?: (projectId: string, cardId: string) => void;
  onOpenSession?: (agentId: string | null, sessionId: string) => void;
  onOpenTodos?: () => void;
  onOpenProject?: (projectId: string) => void;
}

/**
 * Hub Daily Summary — today / yesterday, generated on demand.
 * Visiting the tab only reads; Generate / Regenerate is the spawn.
 */
export default function DailySummaryPage({
  onOpenCard,
  onOpenSession,
  onOpenTodos,
  onOpenProject,
}: DailySummaryPageProps = {}) {
  const [data, setData] = useState<DailySummaryWire | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await api.getDailySummary({ tz: localTimeZone() });
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const body = await api.generateDailySummary({ tz: localTimeZone() });
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }, []);

  const markdownComponents = useMemo(
    () => ({
      ...markdownComponentsCompact,
      a({ href, children, ...props }: any) {
        const handled = dispatchDailySummaryHref(href, {});
        return (
          <a
            {...props}
            href={href}
            data-testid="daily-summary-link"
            className="text-cyan-300 hover:text-cyan-200 underline underline-offset-2"
            target={handled ? undefined : '_blank'}
            rel={handled ? undefined : 'noopener noreferrer'}
            onClick={(e: { preventDefault: () => void }) => {
              const ok = dispatchDailySummaryHref(href, {
                onCard: onOpenCard,
                onSession: (sessionId, agentId) => onOpenSession?.(agentId, sessionId),
                onTodo: onOpenTodos,
                onProject: onOpenProject,
              });
              if (ok) e.preventDefault();
            }}
          >
            {children}
          </a>
        );
      },
    }),
    [onOpenCard, onOpenSession, onOpenTodos, onOpenProject],
  );

  const report: DailySummaryReportWire | null = data?.report ?? null;
  const hasToday = !!report;
  const actionLabel = hasToday ? 'Regenerate' : 'Generate';

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 bg-gray-950" data-testid="daily-summary-page">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mb-5">
          <ScrollText size={18} className="text-cyan-400 shrink-0" />
          <h1 className="text-lg font-semibold text-white flex-1">Daily Summary</h1>
          <button
            type="button"
            onClick={() => void generate()}
            disabled={generating || loading}
            data-testid="daily-summary-generate"
            className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-800 bg-cyan-950/60 px-2.5 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-900/60 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={13} className={generating ? 'animate-spin' : ''} />
            {generating ? 'Generating…' : actionLabel}
          </button>
        </div>

        {error && (
          <p className="text-sm text-red-400 mb-4" data-testid="daily-summary-error">
            {error}
          </p>
        )}

        {loading && !generating ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : hasToday && report ? (
          <div className="rounded-xl border border-gray-800 bg-gray-900 px-4 py-4">
            <p className="text-xs text-gray-500 mb-3">
              Generated {formatGeneratedAt(report.generatedAt)}
              {report.engine ? ` · ${report.engine}` : ''}
              {report.model ? ` / ${report.model}` : ''}
            </p>
            <div className="prose prose-invert prose-sm max-w-none text-gray-200">
              <MarkdownContent content={report.markdown} components={markdownComponents} />
            </div>
          </div>
        ) : (
          <div
            className="rounded-xl border border-dashed border-gray-800 bg-gray-900/40 px-6 py-12 text-center"
            data-testid="daily-summary-empty"
          >
            <p className="text-sm text-gray-300 mb-1">No summary for today yet.</p>
            <p className="text-xs text-gray-500">
              Generate a report of what you did today, what is running now, and what happened
              yesterday.
            </p>
          </div>
        )}

        <DailySummaryScheduleEditor />
      </div>
    </div>
  );
}

const DEFAULT_TIME = '09:00';

/**
 * Auto-refresh schedule editor: pick one or more local times of day at which the
 * Hub regenerates this summary, using your own Claude credentials.
 */
function DailySummaryScheduleEditor() {
  const [enabled, setEnabled] = useState(false);
  const [times, setTimes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const timeZone = useMemo(() => localTimeZone() ?? 'UTC', []);

  const apply = useCallback((schedule: DailySummaryScheduleWire | null) => {
    setEnabled(schedule?.enabled ?? false);
    setTimes(schedule?.times ?? []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await api.getDailySummarySchedule();
        if (!cancelled) apply(body.schedule);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const save = useCallback(
    async (nextEnabled: boolean, nextTimes: string[]) => {
      setSaving(true);
      setError(null);
      try {
        const body = await api.setDailySummarySchedule({
          enabled: nextEnabled,
          timeZone,
          times: nextTimes,
        });
        apply(body.schedule);
        setSavedAt(Date.now());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [apply, timeZone],
  );

  const addTime = () => setTimes((prev) => [...prev, DEFAULT_TIME]);
  const removeTime = (idx: number) => setTimes((prev) => prev.filter((_, i) => i !== idx));
  const changeTime = (idx: number, value: string) =>
    setTimes((prev) => prev.map((t, i) => (i === idx ? value : t)));

  const sortedTimes = useMemo(() => Array.from(new Set(times.filter(Boolean))).sort(), [times]);

  return (
    <div
      className="mt-4 rounded-xl border border-gray-800 bg-gray-900 px-4 py-4"
      data-testid="daily-summary-schedule"
    >
      <div className="flex items-center gap-2 mb-3">
        <Clock size={15} className="text-cyan-400 shrink-0" />
        <h2 className="text-sm font-semibold text-white flex-1">Auto-refresh schedule</h2>
        <label className="inline-flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            disabled={loading || saving}
            data-testid="daily-summary-schedule-enabled"
            onChange={(e) => {
              const next = e.target.checked;
              setEnabled(next);
              void save(next, times);
            }}
            className="h-3.5 w-3.5 rounded border-gray-600 bg-gray-800 text-cyan-500 focus:ring-cyan-500"
          />
          Enabled
        </label>
      </div>

      <p className="text-xs text-gray-500 mb-3">
        The summary regenerates at each time below (in{' '}
        <span className="text-gray-400">{timeZone}</span>) using your Claude credentials.
      </p>

      {loading ? (
        <p className="text-xs text-gray-500">Loading…</p>
      ) : (
        <>
          <div className="space-y-2 mb-3">
            {times.length === 0 ? (
              <p className="text-xs text-gray-500">No times yet. Add one below.</p>
            ) : (
              times.map((time, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input
                    type="time"
                    value={time}
                    disabled={saving}
                    data-testid="daily-summary-schedule-time"
                    onChange={(e) => changeTime(idx, e.target.value)}
                    className="rounded-lg border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100 focus:border-cyan-600 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => removeTime(idx)}
                    disabled={saving}
                    aria-label="Remove time"
                    className="rounded-lg border border-gray-700 p-1.5 text-gray-400 hover:text-red-300 hover:border-red-800 disabled:opacity-50"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={addTime}
              disabled={saving}
              data-testid="daily-summary-schedule-add"
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-xs font-medium text-gray-200 hover:bg-gray-700 disabled:opacity-50"
            >
              <Plus size={13} />
              Add time
            </button>
            <button
              type="button"
              onClick={() => void save(enabled, sortedTimes)}
              disabled={saving}
              data-testid="daily-summary-schedule-save"
              className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-800 bg-cyan-950/60 px-2.5 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-900/60 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {savedAt && !saving && <span className="text-xs text-gray-500">Saved</span>}
          </div>

          {error && (
            <p className="text-xs text-red-400 mt-2" data-testid="daily-summary-schedule-error">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
