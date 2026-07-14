/**
 * Live application-log tail (LOG-QUERY). Streams committed records over the
 * `logs_subscribe` WebSocket via `useLogTail`, with client-side facet filters,
 * pause/resume, a reconnect-status badge, a dropped-count warning, and
 * cursor-paginated "load older" history.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, AlertTriangle, Loader2, RadioTower, Plug, X } from 'lucide-react';
import { api } from '../../utils/api';
import {
  filterLogRecords,
  distinctValues,
  mergeTailRecords,
  SEVERITY_BUCKETS,
  type LogRecord,
  type LogFilter,
} from '../../utils/logStream';
import { useLogTail, type UseLogTailOptions, type LogTailStatus } from '../../hooks/useLogTail';
import LogRecordRow from './LogRecordRow';

interface LiveLogsViewProps {
  projectId: string;
  /** Forwarded to `useLogTail` — tests inject a fake socket factory here. */
  tailOptions?: UseLogTailOptions;
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
}: LiveLogsViewProps): React.ReactElement {
  const { records, status, dropped, clearDropped, paused, setPaused, pendingCount, resume, error } =
    useLogTail(projectId, tailOptions);

  const [minSeverityNumber, setMinSeverityNumber] = useState(0);
  const [sourceId, setSourceId] = useState('');
  const [environment, setEnvironment] = useState('');
  const [text, setText] = useState('');
  const [older, setOlder] = useState<LogRecord[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderExhausted, setOlderExhausted] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);

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
  }, [minSeverityNumber, sourceId, environment, text]);

  // Live tail + any explicitly loaded older pages, deduped, newest-first.
  const combined = useMemo(
    () => mergeTailRecords(older, records, records.length + older.length + 1),
    [older, records],
  );
  const visible = useMemo(
    () => filterLogRecords(combined, filter).slice().reverse(),
    [combined, filter],
  );

  const sources = useMemo(() => distinctValues(combined, 'sourceId'), [combined]);
  const environments = useMemo(() => distinctValues(combined, 'environment'), [combined]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || olderExhausted) return;
    const gen = filterGenRef.current;
    setLoadingOlder(true);
    setOlderError(null);
    const oldestId = combined.length > 0 ? combined[0].id : undefined;
    try {
      const params: Record<string, unknown> = { limit: OLDER_PAGE_LIMIT };
      if (oldestId != null) params.cursor = oldestId;
      if (minSeverityNumber > 0) params.minSeverityNumber = minSeverityNumber;
      if (sourceId) params.sourceId = sourceId;
      if (environment) params.environment = environment;
      if (text.trim()) params.text = text.trim();
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
  }, [
    loadingOlder,
    olderExhausted,
    combined,
    projectId,
    minSeverityNumber,
    sourceId,
    environment,
    text,
  ]);

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

        <div className="ml-auto flex flex-wrap items-center gap-2">
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

      {/* Older-history pager */}
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

      {/* Stream */}
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto rounded border border-gray-800 bg-gray-950/40">
        {visible.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">
            {combined.length === 0
              ? 'No logs yet. Records appear here as your sources ingest them.'
              : 'No logs match the current filters.'}
          </div>
        ) : (
          visible.map((r) => <LogRecordRow key={r.id} record={r} />)
        )}
      </div>
    </div>
  );
}
