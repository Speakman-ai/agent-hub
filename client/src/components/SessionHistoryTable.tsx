import { useCallback, useEffect, useState } from 'react';
import { History, RefreshCw } from 'lucide-react';
import { api } from '../utils/api';
import { cardShortLabel } from '../utils/kanbanCard';

export interface SessionHistoryRow {
  session_id: string;
  agent_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  card: { id: string; short_id: number | null; card_prefix: string | null; title: string } | null;
  pr: { number: number | null; url: string; title: string | null; status: string | null } | null;
  review_rounds: number;
  finalize_review_rounds: number;
  pr_reviews: number;
  ci_rounds: number;
}

const PR_STATUS_CLASS: Record<string, string> = {
  merged: 'text-violet-300',
  open: 'text-emerald-300',
  closed: 'text-gray-400',
};

function isExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export default function SessionHistoryTable({
  projectId,
  onOpenSession,
  onOpenPr,
  onOpenCard,
}: {
  projectId: string;
  onOpenSession?: (agentId: string, sessionId: string) => void;
  onOpenPr?: (projectId: string, prNumber: number) => void;
  onOpenCard?: (projectId: string, cardId: string) => void;
}) {
  const [rows, setRows] = useState<SessionHistoryRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = (await api.getProjectSessionHistory(projectId)) as {
        sessions: SessionHistoryRow[];
      };
      setRows(data?.sessions ?? []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load session history');
      setRows(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mb-6 rounded-xl border border-gray-800 bg-gray-900/40 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm text-gray-300">
          <History size={16} className="text-indigo-400" />
          Session history
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="p-1.5 rounded-md text-gray-400 hover:bg-gray-800 disabled:opacity-50"
          title="Refresh session history"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && <div className="text-xs text-red-300">{error}</div>}
      {!rows && loading && <div className="text-xs text-gray-500">Loading sessions…</div>}
      {rows && rows.length === 0 && (
        <div className="text-xs text-gray-500">
          No sessions with a linked ticket, PR, or Finalize run yet.
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="overflow-x-auto max-h-96 overflow-y-auto">
          <table className="w-full text-xs" data-testid="session-history-table">
            <thead className="sticky top-0 bg-gray-900 text-gray-500">
              <tr className="text-left">
                <th className="py-1.5 pr-3 font-medium">Session</th>
                <th className="py-1.5 pr-3 font-medium">Ticket</th>
                <th className="py-1.5 pr-3 font-medium">PR</th>
                <th className="py-1.5 pr-3 font-medium text-right">Review rounds</th>
                <th className="py-1.5 font-medium text-right">CI rounds</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const cardLabel = row.card
                  ? cardShortLabel(row.card.card_prefix, row.card.short_id) || 'Card'
                  : null;
                const prLabel = row.pr
                  ? row.pr.number != null
                    ? `#${row.pr.number}`
                    : 'PR'
                  : null;
                return (
                  <tr key={row.session_id} className="border-t border-gray-800 align-top">
                    <td className="py-1.5 pr-3 max-w-[18rem]">
                      {onOpenSession ? (
                        <button
                          type="button"
                          className="text-left text-gray-200 hover:text-indigo-300 truncate max-w-full block"
                          title={row.title}
                          onClick={() => onOpenSession(row.agent_id, row.session_id)}
                        >
                          {row.title}
                        </button>
                      ) : (
                        <span className="text-gray-200 truncate block" title={row.title}>
                          {row.title}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 max-w-[14rem]">
                      {row.card ? (
                        <button
                          type="button"
                          className="text-left text-sky-300 hover:underline truncate max-w-full block disabled:no-underline"
                          title={row.card.title}
                          disabled={!onOpenCard}
                          onClick={() => onOpenCard?.(projectId, row.card!.id)}
                        >
                          {cardLabel} <span className="text-gray-400">{row.card.title}</span>
                        </button>
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {row.pr ? (
                        row.pr.number != null && !isExternalUrl(row.pr.url) && onOpenPr ? (
                          <button
                            type="button"
                            className="text-sky-300 hover:underline"
                            title={row.pr.title ?? undefined}
                            onClick={() => onOpenPr(projectId, row.pr!.number as number)}
                          >
                            {prLabel}
                          </button>
                        ) : !isExternalUrl(row.pr.url) ? (
                          <span className="text-gray-300" title={row.pr.url}>
                            {prLabel}
                          </span>
                        ) : (
                          <a
                            href={row.pr.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sky-300 hover:underline"
                            title={row.pr.title ?? undefined}
                          >
                            {prLabel}
                          </a>
                        )
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                      {row.pr?.status && (
                        <span
                          className={`ml-1.5 ${PR_STATUS_CLASS[row.pr.status] ?? 'text-gray-400'}`}
                        >
                          {row.pr.status}
                        </span>
                      )}
                    </td>
                    <td
                      className="py-1.5 pr-3 text-right text-gray-200 tabular-nums"
                      title={`${row.finalize_review_rounds} Finalize review round(s), ${row.pr_reviews} PR review(s)`}
                    >
                      {row.review_rounds}
                    </td>
                    <td className="py-1.5 text-right text-gray-200 tabular-nums">
                      {row.ci_rounds}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
