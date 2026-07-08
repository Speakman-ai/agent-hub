import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, AlertCircle, Search, X, Play } from 'lucide-react';
import { api } from '../utils/api';
import { formatReplayDuration } from '../utils/replayFormat';
import ReplayPlayerModal from './ReplayPlayerModal';

// RUM Session Explorer — the Datadog-parity, session-grain dashboard table. One
// row per client-minted session (the rum_sessions rollup), filterable by the
// indexed facets Datadog's Session Explorer exposes: user (email/name/id),
// device, browser, os, geo country, duration, view/action/error/frustration
// counts, plus a started-at time-range picker. This is the "Sessions" tab of
// ReplaysDashboardPage; the capture-grain table lives in ReplayCaptureTable.

const PAGE_SIZE = 50;

// Started-at time-range presets → lookback window in ms (null = all time).
const TIME_RANGES: { id: string; label: string; ms: number | null }[] = [
  { id: '15m', label: 'Last 15 min', ms: 15 * 60_000 },
  { id: '1h', label: 'Last hour', ms: 60 * 60_000 },
  { id: '4h', label: 'Last 4 hours', ms: 4 * 60 * 60_000 },
  { id: '1d', label: 'Last 24 hours', ms: 24 * 60 * 60_000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60_000 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 24 * 60 * 60_000 },
  { id: 'all', label: 'All time', ms: null },
];

// Free-text facet fields (exact-match on the server). Kept as a list so the
// filter form and the applied-filter payload stay in lockstep.
const TEXT_FACETS: { key: string; label: string; placeholder: string }[] = [
  { key: 'usrEmail', label: 'User email', placeholder: 'user@example.com' },
  { key: 'usrName', label: 'User name', placeholder: 'Ada Lovelace' },
  { key: 'usrId', label: 'User id', placeholder: 'usr_123' },
  { key: 'deviceType', label: 'Device', placeholder: 'Desktop' },
  { key: 'browser', label: 'Browser', placeholder: 'Chrome' },
  { key: 'os', label: 'OS', placeholder: 'macOS' },
  { key: 'geoCountry', label: 'Country', placeholder: 'US' },
];

// Numeric lower-bound facets (>= on the server).
const COUNT_FACETS: { key: string; label: string }[] = [
  { key: 'viewCountMin', label: 'Min views' },
  { key: 'actionCountMin', label: 'Min actions' },
  { key: 'errorCountMin', label: 'Min errors' },
  { key: 'frustrationCountMin', label: 'Min frustrations' },
];

const EMPTY_DRAFT: Record<string, string> = {};

function absMs(ms: number | null): string {
  if (ms == null) return '—';
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

/** Compare two filter drafts by their effective (trimmed, non-blank) entries, so
 *  blank inputs and missing keys are treated as equal — used to skip a reload
 *  when Apply is clicked with no real change. */
function sameFilters(a: Record<string, string>, b: Record<string, string>): boolean {
  const norm = (o: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(o)
        .filter(([, v]) => v?.trim())
        .map(([k, v]) => [k, v.trim()]),
    );
  const na = norm(a);
  const nb = norm(b);
  const keys = Object.keys(na);
  return keys.length === Object.keys(nb).length && keys.every((k) => na[k] === nb[k]);
}

/** Build the server filter payload from the applied draft + time range. Blank
 *  strings are dropped by the api helper, but we also convert the duration
 *  seconds inputs into the ms the server expects. */
function buildParams(
  applied: Record<string, string>,
  rangeMs: number | null,
  nowMs: number,
  limit: number,
  offset: number,
): Record<string, any> {
  const params: Record<string, any> = { limit, offset };
  for (const { key } of TEXT_FACETS) {
    if (applied[key]?.trim()) params[key] = applied[key].trim();
  }
  for (const { key } of COUNT_FACETS) {
    const n = Number(applied[key]);
    if (applied[key]?.trim() && Number.isFinite(n)) params[key] = Math.max(0, Math.floor(n));
  }
  // Duration inputs are entered in seconds for readability; send ms.
  const minS = Number(applied.durationMinS);
  if (applied.durationMinS?.trim() && Number.isFinite(minS)) {
    params.durationMinMs = Math.max(0, Math.floor(minS * 1000));
  }
  const maxS = Number(applied.durationMaxS);
  if (applied.durationMaxS?.trim() && Number.isFinite(maxS)) {
    params.durationMaxMs = Math.max(0, Math.floor(maxS * 1000));
  }
  if (rangeMs != null) params.from = nowMs - rangeMs;
  return params;
}

export default function RumSessionsExplorer({ projectId }: any) {
  const [draft, setDraft] = useState<Record<string, string>>(EMPTY_DRAFT);
  const [applied, setApplied] = useState<Record<string, string>>(EMPTY_DRAFT);
  const [rangeId, setRangeId] = useState('1d');
  const [page, setPage] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  // The session whose stitched multi-view replay is open in the player modal.
  const [playingSession, setPlayingSession] = useState<any>(null);
  const reqSeq = useRef(0);

  const rangeMs = useMemo(() => TIME_RANGES.find((r) => r.id === rangeId)?.ms ?? null, [rangeId]);

  const load = useCallback(
    async (opts: { offset?: number } = {}) => {
      const o = opts.offset ?? offset;
      // Stamp `now` once per load so the from-bound is stable for this request.
      const params = buildParams(applied, rangeMs, Date.now(), PAGE_SIZE, o);
      const seq = ++reqSeq.current;
      setLoading(true);
      setError(null);
      try {
        const res = await api.listRumSessions(projectId, params);
        if (seq !== reqSeq.current) return;
        setPage(res);
      } catch (e: any) {
        if (seq !== reqSeq.current) return;
        setError(e?.message || 'Failed to load sessions');
        setPage(null);
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    },
    [projectId, applied, rangeMs, offset],
  );

  // Reload from the first page whenever the project, applied filters, or time
  // range changes.
  useEffect(() => {
    setOffset(0);
    load({ offset: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, applied, rangeId]);

  const sessions = page?.sessions ?? [];
  const total = page?.total ?? 0;
  const hasMore = Boolean(page?.hasMore);

  const hasActiveFilters = Object.values(applied).some((v) => v?.trim());

  // Apply the draft only when its effective (non-blank) filter set differs from
  // what's already applied, so a redundant Apply click doesn't trigger a full
  // reload via the `applied`-keyed effect.
  const applyFilters = () => {
    if (!sameFilters(applied, draft)) setApplied({ ...draft });
  };
  // Reset to fresh empty objects (not a shared reference) and only touch
  // `applied` when there's something to clear, so Clear on an already-empty set
  // is a no-op rather than a spurious identity change.
  const clearFilters = () => {
    setDraft({});
    if (hasActiveFilters) setApplied({});
  };

  const changePage = (nextOffset: number) => {
    setOffset(nextOffset);
    load({ offset: nextOffset });
  };

  const setField = (key: string, value: string) => setDraft((d) => ({ ...d, [key]: value }));
  const onFilterKeyDown = (e: any) => {
    if (e.key === 'Enter') applyFilters();
  };

  return (
    <>
      {/* Time-range picker */}
      <div className="flex items-center gap-2 mb-3">
        <label className="text-[11px] uppercase tracking-wide text-gray-600">Time range</label>
        <select
          value={rangeId}
          onChange={(e) => setRangeId(e.target.value)}
          className="px-2.5 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-xs text-gray-200 focus:outline-none focus:border-indigo-500"
          aria-label="Time range"
        >
          {TIME_RANGES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => load()}
          className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-gray-300 border border-gray-700 hover:bg-gray-800"
          title="Refresh"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
        <span className="text-xs text-gray-500">
          {total} session{total === 1 ? '' : 's'}
        </span>
      </div>

      {/* Facet filters */}
      <div className="mb-4 p-3 rounded-lg border border-gray-800 bg-gray-900/40">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {TEXT_FACETS.map((f) => (
            <label key={f.key} className="block">
              <span className="block text-[11px] text-gray-500 mb-0.5">{f.label}</span>
              <input
                type="text"
                value={draft[f.key] ?? ''}
                placeholder={f.placeholder}
                onChange={(e) => setField(f.key, e.target.value)}
                onKeyDown={onFilterKeyDown}
                aria-label={f.label}
                className="w-full px-2 py-1 rounded bg-gray-800 border border-gray-700 text-xs text-gray-200 focus:outline-none focus:border-indigo-500"
              />
            </label>
          ))}
          {COUNT_FACETS.map((f) => (
            <label key={f.key} className="block">
              <span className="block text-[11px] text-gray-500 mb-0.5">{f.label}</span>
              <input
                type="number"
                min={0}
                value={draft[f.key] ?? ''}
                onChange={(e) => setField(f.key, e.target.value)}
                onKeyDown={onFilterKeyDown}
                aria-label={f.label}
                className="w-full px-2 py-1 rounded bg-gray-800 border border-gray-700 text-xs text-gray-200 focus:outline-none focus:border-indigo-500"
              />
            </label>
          ))}
          <label className="block">
            <span className="block text-[11px] text-gray-500 mb-0.5">Min duration (s)</span>
            <input
              type="number"
              min={0}
              value={draft.durationMinS ?? ''}
              onChange={(e) => setField('durationMinS', e.target.value)}
              onKeyDown={onFilterKeyDown}
              aria-label="Min duration (s)"
              className="w-full px-2 py-1 rounded bg-gray-800 border border-gray-700 text-xs text-gray-200 focus:outline-none focus:border-indigo-500"
            />
          </label>
          <label className="block">
            <span className="block text-[11px] text-gray-500 mb-0.5">Max duration (s)</span>
            <input
              type="number"
              min={0}
              value={draft.durationMaxS ?? ''}
              onChange={(e) => setField('durationMaxS', e.target.value)}
              onKeyDown={onFilterKeyDown}
              aria-label="Max duration (s)"
              className="w-full px-2 py-1 rounded bg-gray-800 border border-gray-700 text-xs text-gray-200 focus:outline-none focus:border-indigo-500"
            />
          </label>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <button
            type="button"
            onClick={applyFilters}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500"
          >
            <Search size={12} />
            Apply filters
          </button>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-gray-300 border border-gray-700 hover:bg-gray-800"
            >
              <X size={12} />
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      {error ? (
        <div className="flex items-center gap-2 p-4 rounded-lg border border-red-500/40 bg-red-500/10 text-red-300 text-sm">
          <AlertCircle size={16} />
          {error}
        </div>
      ) : loading && sessions.length === 0 ? (
        <div className="p-8 text-center text-gray-500 text-sm">Loading sessions…</div>
      ) : sessions.length === 0 ? (
        <div className="p-12 text-center text-gray-500 text-sm border border-dashed border-gray-800 rounded-lg">
          {hasActiveFilters
            ? 'No sessions match the current filters. Widen the time range or clear a facet.'
            : 'No sessions yet. They show up here once continuous (whole-session) capture is enabled and the recorder sends segments.'}
        </div>
      ) : (
        <div className="overflow-x-auto border border-gray-800 rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 border-b border-gray-800">
                <th className="px-2 py-2 font-medium w-8" aria-label="Play" />
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Session start</th>
                <th className="px-3 py-2 font-medium text-right">Duration</th>
                <th className="px-3 py-2 font-medium text-right">Views</th>
                <th className="px-3 py-2 font-medium text-right">Actions</th>
                <th className="px-3 py-2 font-medium text-right">Errors</th>
                <th className="px-3 py-2 font-medium text-right">Frustrations</th>
                <th className="px-3 py-2 font-medium">Device</th>
                <th className="px-3 py-2 font-medium">Browser</th>
                <th className="px-3 py-2 font-medium">OS</th>
                <th className="px-3 py-2 font-medium">Country</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s: any) => (
                <tr key={s.sessionId} className="border-b border-gray-800/60 hover:bg-gray-900/60">
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      onClick={() => setPlayingSession(s)}
                      title="Play session replay"
                      aria-label="Play session replay"
                      className="inline-flex items-center justify-center w-6 h-6 rounded text-gray-400 hover:text-indigo-300 hover:bg-gray-800"
                      data-testid="rum-session-play"
                    >
                      <Play size={13} />
                    </button>
                  </td>
                  <td
                    className="px-3 py-2 text-gray-300 max-w-[200px] truncate"
                    title={s.usrEmail || s.usrName || s.usrId || s.sessionId}
                  >
                    {s.usrEmail || s.usrName || s.usrId || (
                      <span className="text-gray-600">Anonymous</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-400 whitespace-nowrap">
                    {absMs(s.startedAt)}
                  </td>
                  <td className="px-3 py-2 text-gray-300 text-right whitespace-nowrap">
                    {formatReplayDuration(s.timeSpent)}
                  </td>
                  <td className="px-3 py-2 text-gray-400 text-right">{s.viewCount}</td>
                  <td className="px-3 py-2 text-gray-400 text-right">{s.actionCount}</td>
                  <td
                    className={`px-3 py-2 text-right ${s.errorCount > 0 ? 'text-rose-300' : 'text-gray-400'}`}
                  >
                    {s.errorCount}
                  </td>
                  <td
                    className={`px-3 py-2 text-right ${s.frustrationCount > 0 ? 'text-amber-300' : 'text-gray-400'}`}
                  >
                    {s.frustrationCount}
                  </td>
                  <td className="px-3 py-2 text-gray-400">{s.deviceType || '—'}</td>
                  <td className="px-3 py-2 text-gray-400">{s.browser || '—'}</td>
                  <td className="px-3 py-2 text-gray-400">{s.os || '—'}</td>
                  <td className="px-3 py-2 text-gray-400">{s.geoCountry || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {sessions.length > 0 && (
        <div className="flex items-center justify-between mt-3 text-xs text-gray-400">
          <span>
            {offset + 1}–{offset + sessions.length} of {total}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={offset === 0 || loading}
              onClick={() => changePage(Math.max(0, offset - PAGE_SIZE))}
              className="px-2.5 py-1 rounded border border-gray-700 disabled:opacity-40 hover:bg-gray-800"
            >
              Prev
            </button>
            <button
              type="button"
              disabled={!hasMore || loading}
              onClick={() => changePage(offset + PAGE_SIZE)}
              className="px-2.5 py-1 rounded border border-gray-700 disabled:opacity-40 hover:bg-gray-800"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {playingSession ? (
        <ReplayPlayerModal
          sessionId={playingSession.sessionId}
          title={
            playingSession.usrEmail ||
            playingSession.usrName ||
            playingSession.usrId ||
            `Session ${playingSession.sessionId}`
          }
          onClose={() => setPlayingSession(null)}
        />
      ) : null}
    </>
  );
}
