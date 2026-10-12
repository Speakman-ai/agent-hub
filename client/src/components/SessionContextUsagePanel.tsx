import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../utils/api';
import {
  CONTEXT_CATEGORY_COLORS,
  contextBarSegments,
  formatTokenCount,
  startLatestOnlyPolling,
  type SessionContextUsage,
} from '@shared/utils/contextUsage';

const POLL_MS = 5000;

/**
 * Floating "Context Usage" window toggled from the session Actions menu.
 * Polls while open so the numbers follow a running turn.
 */
export default function SessionContextUsagePanel({
  sessionId,
  onClose,
  pollMs = POLL_MS,
}: {
  sessionId: string;
  onClose: () => void;
  pollMs?: number;
}) {
  const [usage, setUsage] = useState<SessionContextUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUsage(null);
    setError(null);
    return startLatestOnlyPolling({
      fetchUsage: () => api.getSessionContextUsage(sessionId),
      onData: (next) => {
        setUsage(next);
        setError(null);
      },
      onError: (err) =>
        setError(err instanceof Error ? err.message : 'Failed to load context usage'),
      intervalMs: pollMs,
    });
  }, [sessionId, pollMs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const segments = usage ? contextBarSegments(usage.categories, usage.contextWindow) : [];
  const visibleCategories = usage?.categories.filter((c) => c.tokens > 0) ?? [];

  return (
    <div
      role="dialog"
      aria-label="Context usage"
      data-testid="session-context-usage-panel"
      className="w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border border-sky-700/60 bg-gray-950/95 shadow-2xl backdrop-blur p-3 text-xs text-gray-200"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-gray-100">Context Usage</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close context usage"
          className="p-0.5 rounded text-gray-400 hover:text-gray-100 hover:bg-gray-800"
        >
          <X size={14} />
        </button>
      </div>

      {error && !usage ? <p className="text-red-300">{error}</p> : null}
      {!usage && !error ? <p className="text-gray-500">Loading…</p> : null}

      {usage ? (
        <>
          <div className="flex items-baseline justify-between text-gray-300">
            <span data-testid="context-usage-percent">
              {usage.percent != null ? `${Math.round(usage.percent)}% Full` : 'Window size unknown'}
            </span>
            <span className="tabular-nums" data-testid="context-usage-total">
              {usage.source === 'estimated' ? '~' : ''}
              {formatTokenCount(usage.totalTokens)}
              {usage.contextWindow ? ` / ${formatTokenCount(usage.contextWindow)}` : ''} Tokens
            </span>
          </div>
          <div
            className="mt-2 mb-3 flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-gray-800"
            aria-hidden
          >
            {segments.map((s) => (
              <div
                key={s.key}
                style={{ width: `${s.widthPct}%`, backgroundColor: CONTEXT_CATEGORY_COLORS[s.key] }}
              />
            ))}
          </div>
          {usage.source === 'none' ? (
            <p className="text-gray-500">No turns yet. Send a message to measure context.</p>
          ) : (
            <ul className="space-y-1.5">
              {visibleCategories.map((c) => (
                <li
                  key={c.key}
                  className="flex items-center gap-2"
                  data-testid={`context-usage-row-${c.key}`}
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: CONTEXT_CATEGORY_COLORS[c.key] }}
                  />
                  <span className="flex-1 truncate">{c.label}</span>
                  <span className="tabular-nums text-gray-400">{formatTokenCount(c.tokens)}</span>
                </li>
              ))}
            </ul>
          )}
          {usage.source === 'estimated' ? (
            <p className="mt-2 text-[10px] text-gray-500">
              Estimated from message size. This engine does not report per-step token counts.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
