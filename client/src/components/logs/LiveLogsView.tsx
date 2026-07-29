/**
 * Live application-log tail (LOG-QUERY). Streams committed records over the
 * `logs_subscribe` WebSocket via `useLogTail`, with client-side facet filters,
 * pause/resume, a reconnect-status badge, a dropped-count warning, and
 * cursor-paginated "load older" history.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, AlertTriangle, Loader2, RadioTower, Plug, X, Trash2 } from 'lucide-react';
import { api } from '../../utils/api';
import {
  filterLogRecords,
  distinctValues,
  mergeTailRecords,
  newestRecordCursor,
  toNewestFirst,
  buildOlderPageParams,
  resolveSinceUnixNano,
  isNearTop,
  nextScrollTop,
  SEVERITY_BUCKETS,
  TIME_RANGES,
  DEFAULT_TIME_RANGE_MS,
  type LogRecord,
  type LogFilter,
  type LogCursor,
} from '../../utils/logStream';
import { useLogTail, type UseLogTailOptions, type LogTailStatus } from '../../hooks/useLogTail';
import LogRecordRow from './LogRecordRow';

interface LiveLogsViewProps {
  projectId: string;
  /** Forwarded to `useLogTail` — tests inject a fake socket factory here. */
  tailOptions?: UseLogTailOptions;
  showToast?: (message: string, kind?: string) => void;
}

const OLDER_PAGE_LIMIT = 100;

function StatusBadge({ status }: { status: LogTailStatus }): React.ReactElement {
  if (status === 'open') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
        <RadioTower size={13} /> Live
      </span>
    );
  }
  if (status === 'reconnecting' || status === 'connecting') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-amber-400">
        <Loader2 size={13} className="animate-spin" />
        {status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-gray-500">
      <Plug size={13} /> Disconnected
    </span>
  );
}

export default function LiveLogsView({
  projectId,
  tailOptions,
  showToast,
}: LiveLogsViewProps): React.ReactElement {
  const [rangeMs, setRangeMs] = useState(DEFAULT_TIME_RANGE_MS);
  // Anchor the window's lower bound to when the range was last chosen. Recomputes
  // only when `rangeMs` changes, so live re-renders don't churn the subscription.
  const sinceUnixNano = useMemo(() => resolveSinceUnixNano(rangeMs, Date.now()), [rangeMs]);

  const {
    records,
    status,
    dropped,
    clearDropped,
    paused,
    setPaused,
    pendingCount,
    resume,
    reset,
    error,
  } = useLogTail(projectId, { ...tailOptions, sinceUnixNano });

  const [minSeverityNumber, setMinSeverityNumber] = useState(0);
  const [sourceId, setSourceId] = useState('');
  const [environment, setEnvironment] = useState('');
  const [text, setText] = useState('');
  const [older, setOlder] = useState<LogRecord[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderExhausted, setOlderExhausted] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const filter: LogFilter = useMemo(
    () => ({ minSeverityNumber, sourceId, environment, text }),
    [minSeverityNumber, sourceId, environment, text],
  );

  // Older-history paging is scoped to the active filter: the server query sends
  // the filter facets and the cursor is derived from the current result set.
  // Changing any facet must discard prior pages and clear the "exhausted" flag,
  // otherwise `Load older` would stay hidden for a new filter and a stale
  // cursor (from the old combined result) could skip valid matching records.
  // The generation counter also fences an in-flight `loadOlder`: a response for
  // the previous filter is dropped rather than injected into the new filter's
  // pages (which would pollute facet menus and mis-mark it exhausted).
  const filterGenRef = useRef(0);
  useEffect(() => {
    filterGenRef.current += 1;
    setOlder([]);
    setOlderExhausted(false);
    setOlderError(null);
    setLoadingOlder(false);
  }, [minSeverityNumber, sourceId, environment, text, sinceUnixNano]);

  // Live tail + any explicitly loaded older pages, deduped, ascending event
  // time. `visible` stays ascending because the "Load older" keyset and the cap
  // are defined on that order; only the render flips (see `rendered`).
  const combined = useMemo(
    () => mergeTailRecords(older, records, records.length + older.length + 1),
    [older, records],
  );
  const visible = useMemo(() => filterLogRecords(combined, filter), [combined, filter]);
  // One flat list, strictly newest-first: the record that just arrived is the
  // first row, and reading downwards walks steadily back in time.
  const rendered = useMemo(() => toNewestFirst(visible), [visible]);

  // Auto-scroll stickiness: keep the newest record in view while the user is
  // pinned to the top, but never yank the viewport when they've scrolled down
  // to read history.
  const streamRef = useRef<HTMLDivElement>(null);
  const stickToTopRef = useRef(true);
  const prevScrollRef = useRef({
    newest: null as LogCursor | null,
    scrollHeight: 0,
    scrollTop: 0,
  });

  const onStreamScroll = useCallback(() => {
    const el = streamRef.current;
    if (el) stickToTopRef.current = isNearTop(el);
  }, []);

  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    const newest = newestRecordCursor(visible);
    const target = nextScrollTop(
      prevScrollRef.current,
      { newest, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
      stickToTopRef.current,
    );
    if (target != null) el.scrollTop = target;
    prevScrollRef.current = { newest, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
  }, [visible]);

  const sources = useMemo(() => distinctValues(combined, 'sourceId'), [combined]);
  const environments = useMemo(() => distinctValues(combined, 'environment'), [combined]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || olderExhausted) return;
    const gen = filterGenRef.current;
    setLoadingOlder(true);
    setOlderError(null);
    // Keyset + facets come from the same place, so the pager walks the filtered
    // stream it is querying. `visible`, never `combined`: see the helper.
    try {
      const params = buildOlderPageParams({
        visible,
        filter,
        limit: OLDER_PAGE_LIMIT,
        sinceUnixNano,
      });
      const page = (await api.queryLogs(projectId, params)) as {
        records: LogRecord[];
        nextCursor: number | null;
      };
      if (gen !== filterGenRef.current) return; // filter changed mid-flight — drop
      const fetched = Array.isArray(page.records) ? page.records : [];
      if (fetched.length === 0 || page.nextCursor == null) setOlderExhausted(true);
      setOlder((prev) => mergeTailRecords(prev, fetched, prev.length + fetched.length + 1));
    } catch (err) {
      if (gen !== filterGenRef.current) return;
      setOlderError(err instanceof Error ? err.message : 'Failed to load older logs');
    } finally {
      if (gen === filterGenRef.current) setLoadingOlder(false);
    }
  }, [loadingOlder, olderExhausted, visible, filter, projectId, sinceUnixNano]);

  const clearLogs = useCallback(async () => {
    setClearing(true);
    try {
      const res = (await api.clearLogs(projectId)) as { purged?: number };
      // Drop the live tail buffer and any loaded history so the view reflects
      // the purge immediately, without waiting for a reconnect.
      reset();
      setOlder([]);
      setOlderExhausted(true);
      setOlderError(null);
      setConfirmingClear(false);
      const n = typeof res?.purged === 'number' ? res.purged : 0;
      showToast?.(
        n === 0
          ? 'No logs to clear.'
          : `Cleared ${n.toLocaleString()} ${n === 1 ? 'log' : 'logs'}.`,
        'success',
      );
    } catch (err) {
      showToast?.(err instanceof Error ? err.message : 'Failed to clear logs', 'error');
    } finally {
      setClearing(false);
    }
  }, [projectId, reset, showToast]);

  return (
    <div className="flex h-full flex-col">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-800 pb-3">
        <StatusBadge status={status} />
        <button
          type="button"
          onClick={() => (paused ? resume() : setPaused(true))}
          className="inline-flex items-center gap-1 rounded border border-gray-700 px-2 py-1 text-xs text-gray-200 hover:bg-gray-800"
        >
          {paused ? <Play size={13} /> : <Pause size={13} />}
          {paused ? 'Resume' : 'Pause'}
        </button>
        {paused && pendingCount > 0 ? (
          <button
            type="button"
            onClick={resume}
            className="rounded bg-sky-600/80 px-2 py-1 text-xs text-white hover:bg-sky-600"
          >
            {pendingCount} new {pendingCount === 1 ? 'log' : 'logs'}
          </button>
        ) : null}

        {confirmingClear ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="text-xs text-gray-400">Clear all logs?</span>
            <button
              type="button"
              onClick={clearLogs}
              disabled={clearing}
              className="inline-flex items-center gap-1 rounded bg-red-600/90 px-2 py-1 text-xs text-white hover:bg-red-600 disabled:opacity-50"
            >
              {clearing ? <Loader2 size={13} className="animate-spin" /> : null}
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirmingClear(false)}
              disabled={clearing}
              className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingClear(true)}
            aria-label="Clear all logs"
            className="inline-flex items-center gap-1 rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:border-red-500/60 hover:bg-red-500/10 hover:text-red-300"
          >
            <Trash2 size={13} />
            Clear logs
          </button>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            aria-label="Time range"
            value={rangeMs}
            onChange={(e) => setRangeMs(Number(e.target.value))}
            className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200"
          >
            {TIME_RANGES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Minimum severity"
            value={minSeverityNumber}
            onChange={(e) => setMinSeverityNumber(Number(e.target.value))}
            className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200"
          >
            {SEVERITY_BUCKETS.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Source"
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200"
          >
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            aria-label="Environment"
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
            className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200"
          >
            <option value="">All environments</option>
            {environments.map((e2) => (
              <option key={e2} value={e2}>
                {e2}
              </option>
            ))}
          </select>
          <input
            aria-label="Search log text"
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Filter text…"
            className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200"
          />
        </div>
      </div>

      {/* Warnings — a one-time notice the user can dismiss once acknowledged. */}
      {dropped > 0 ? (
        <div
          role="alert"
          className="mt-2 flex items-center gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-300"
        >
          <AlertTriangle size={13} className="shrink-0" />
          <span className="min-w-0 flex-1">
            {dropped} {dropped === 1 ? 'record was' : 'records were'} dropped during a live-tail
            burst. Reconnected and backfilled; use “Load older” to inspect the gap.
          </span>
          <button
            type="button"
            onClick={clearDropped}
            aria-label="Dismiss dropped-records notice"
            className="shrink-0 rounded p-0.5 text-amber-300/70 hover:bg-amber-500/20 hover:text-amber-200"
          >
            <X size={13} />
          </button>
        </div>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="mt-2 flex items-center gap-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-300"
        >
          <AlertTriangle size={13} /> {error}
        </div>
      ) : null}

      {/* Stream — newest first; older history is paged in below it. */}
      <div
        ref={streamRef}
        onScroll={onStreamScroll}
        className="mt-2 min-h-0 flex-1 overflow-y-auto rounded border border-gray-800 bg-gray-950/40"
      >
        {rendered.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">
            {combined.length === 0
              ? 'No logs yet. Records appear here as your sources ingest them.'
              : 'No logs match the current filters.'}
          </div>
        ) : (
          rendered.map((r) => <LogRecordRow key={r.id} record={r} />)
        )}
      </div>

      {/* Older-history pager — sits at the foot of the stream, where the oldest
          rows are, so paging in history extends the list downwards. */}
      <div className="mt-2">
        {olderExhausted ? (
          <span className="text-xs text-gray-600">Beginning of retained history.</span>
        ) : (
          <button
            type="button"
            onClick={loadOlder}
            disabled={loadingOlder}
            className="inline-flex items-center gap-1 rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50"
          >
            {loadingOlder ? <Loader2 size={13} className="animate-spin" /> : null}
            Load older
          </button>
        )}
        {olderError ? <span className="ml-2 text-xs text-red-400">{olderError}</span> : null}
      </div>
    </div>
  );
}
