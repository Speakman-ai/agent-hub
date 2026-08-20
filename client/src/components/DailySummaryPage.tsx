import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, ScrollText } from 'lucide-react';
import { api, type DailySummaryReportWire, type DailySummaryWire } from '../utils/api';
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
 * Hub Daily Summary — today / right now / yesterday, generated on demand.
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
      </div>
    </div>
  );
}
