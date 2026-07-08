import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Link2, Unlink, RefreshCw, X, AlertCircle } from 'lucide-react';
import { api } from '../utils/api';
import ReplayPlayerModal from './ReplayPlayerModal';
import { formatReplayDuration, formatBytes, formatPageUrl } from '../utils/replayFormat';

// Capture-grain replay table: one row per rrweb blob (session_replays). Surfaces
// attributed captures AND (for privileged callers) global orphaned captures so
// an operator can link a stranded replay to a support ticket — the inverse of
// the ticket-first attribution flow. Reuses the existing rrweb player modal.
// This is the "Replays" tab of ReplaysDashboardPage; the session-grain Datadog
// Explorer lives in RumSessionsExplorer.

const FILTERS: { id: string; label: string; orphanOnly?: boolean }[] = [
  { id: 'all', label: 'All' },
  { id: 'linked', label: 'Linked' },
  { id: 'unlinked', label: 'Unlinked' },
  { id: 'orphans', label: 'Orphaned', orphanOnly: true },
];

// Capture-kind facet, orthogonal to the ticket-link FILTERS above.
const KIND_FILTERS: { id: string; label: string }[] = [
  { id: 'all', label: 'All kinds' },
  { id: 'continuous', label: 'Continuous' },
  { id: 'on-error', label: 'On-error' },
];

const PAGE_SIZE = 50;

// Poll cadence while at least one live (still-streaming) continuous capture is
// on screen, so the in-progress indicator stays fresh without a manual refresh.
const LIVE_REFRESH_MS = 30_000;

function absDate(ts: any): string {
  if (!ts) return '';
  const d = ts.includes?.('T') ? new Date(ts) : new Date(ts + 'Z');
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString();
}

export default function ReplayCaptureTable({ projectId, onNotify }: any) {
  const [filter, setFilter] = useState('all');
  const [kind, setKind] = useState('all');
  const [page, setPage] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [linkFor, setLinkFor] = useState<any>(null); // replay row currently being linked
  const reqSeq = useRef(0);

  const notify = useCallback(
    (msg: string, type: string = 'info') => onNotify?.(msg, type),
    [onNotify],
  );

  const load = useCallback(
    async (opts: { filter?: string; kind?: string; offset?: number; silent?: boolean } = {}) => {
      const f = opts.filter ?? filter;
      const k = opts.kind ?? kind;
      const o = opts.offset ?? offset;
      const params = { filter: f, kind: k, limit: PAGE_SIZE, offset: o };

      // Silent live-refresh: it must NOT participate in the visible-load
      // lifecycle. It never touches loading/error, never bumps `reqSeq` (so it
      // can't make a concurrent visible load look superseded and strand the
      // spinner), and only applies its result when no visible load has been
      // issued since — a fresher visible load always wins.
      if (opts.silent) {
        const seqAtIssue = reqSeq.current;
        try {
          const res = await api.listReplays(projectId, params);
          if (reqSeq.current === seqAtIssue) setPage(res);
        } catch {
          // A transient poll failure shouldn't disrupt the visible page.
        }
        return;
      }

      const seq = ++reqSeq.current;
      setLoading(true);
      setError(null);
      try {
        const res = await api.listReplays(projectId, params);
        if (seq !== reqSeq.current) return; // a newer request superseded this one
        setPage(res);
      } catch (e: any) {
        if (seq !== reqSeq.current) return;
        setError(e?.message || 'Failed to load replays');
        setPage(null);
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    },
    [projectId, filter, kind, offset],
  );

  // Reset to the first page whenever the project, link filter, or kind changes.
  useEffect(() => {
    setOffset(0);
    load({ offset: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, filter, kind]);

  const replays = page?.replays ?? [];
  const hasLive = replays.some((r: any) => r?.live);

  // Keep the live indicator fresh: while any still-streaming capture is on the
  // current page, silently re-poll so its event/duration counters and the
  // eventual transition out of "live" stay current without a manual refresh.
  useEffect(() => {
    if (!hasLive) return;
    const t = setInterval(() => {
      load({ silent: true });
    }, LIVE_REFRESH_MS);
    return () => clearInterval(t);
  }, [hasLive, load]);

  const total = page?.total ?? 0;
  const hasMore = Boolean(page?.hasMore);
  const canViewOrphans = page?.canViewOrphans ?? false;

  const visibleFilters = useMemo(
    () => FILTERS.filter((f) => !f.orphanOnly || canViewOrphans),
    [canViewOrphans],
  );

  const changePage = (nextOffset: number) => {
    setOffset(nextOffset);
    load({ offset: nextOffset });
  };

  const handleUnlink = async (replay: any) => {
    try {
      await api.unlinkReplay(projectId, replay.id);
      notify('Replay unlinked from ticket', 'success');
      load();
    } catch (e: any) {
      notify(e?.message || 'Failed to unlink replay', 'error');
    }
  };

  return (
    <>
      <p className="text-xs text-gray-500 mb-4">
        Individual captures from the in-app recorder. Link a capture to a support ticket to attach
        it for triage.
      </p>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 mb-3">
        {visibleFilters.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              filter === f.id
                ? 'bg-indigo-500/20 text-indigo-200 border border-indigo-500/40'
                : 'text-gray-400 border border-transparent hover:bg-gray-800'
            }`}
          >
            {f.label}
          </button>
        ))}
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
          {total} replay{total === 1 ? '' : 's'}
        </span>
      </div>

      {/* Capture-kind facet (continuous vs on-error) */}
      <div className="flex items-center gap-1 mb-3">
        <span className="text-[11px] uppercase tracking-wide text-gray-600 mr-1">Kind</span>
        {KIND_FILTERS.map((k) => (
          <button
            key={k.id}
            type="button"
            onClick={() => setKind(k.id)}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
              kind === k.id
                ? 'bg-emerald-500/15 text-emerald-200 border border-emerald-500/40'
                : 'text-gray-400 border border-transparent hover:bg-gray-800'
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>

      {/* Body */}
      {error ? (
        <div className="flex items-center gap-2 p-4 rounded-lg border border-red-500/40 bg-red-500/10 text-red-300 text-sm">
          <AlertCircle size={16} />
          {error}
        </div>
      ) : loading && replays.length === 0 ? (
        <div className="p-8 text-center text-gray-500 text-sm">Loading replays…</div>
      ) : replays.length === 0 ? (
        <div className="p-12 text-center text-gray-500 text-sm border border-dashed border-gray-800 rounded-lg">
          {filter === 'orphans'
            ? 'No orphaned replays. Captures attributed to a project appear under the other filters.'
            : kind === 'continuous'
              ? 'No continuous (whole-session) replays match. They appear once a project opts into continuous capture.'
              : kind === 'on-error'
                ? 'No on-error replays match this view.'
                : 'No replays yet. They show up here when the in-app recorder captures a session.'}
        </div>
      ) : (
        <div className="overflow-x-auto border border-gray-800 rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 border-b border-gray-800">
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Page</th>
                <th className="px-3 py-2 font-medium text-right">Time Spent</th>
                <th className="px-3 py-2 font-medium text-right">Events</th>
                <th className="px-3 py-2 font-medium text-right">Size</th>
                <th className="px-3 py-2 font-medium">Linked ticket</th>
                <th className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {replays.map((r: any) => (
                <tr key={r.id} className="border-b border-gray-800/60 hover:bg-gray-900/60">
                  <td className="px-3 py-2 text-gray-300 whitespace-nowrap" title={r.createdAt}>
                    {absDate(r.createdAt)}
                    {r.live && (
                      <span
                        className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-rose-500/20 text-rose-300 border border-rose-500/40"
                        title="Still streaming — captured within the last few minutes"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse" />
                        LIVE
                      </span>
                    )}
                    {r.captureKind === 'continuous' && !r.live && (
                      <span
                        className="ml-2 px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                        title="Continuous (whole-session) capture"
                      >
                        continuous
                      </span>
                    )}
                    {r.orphaned && (
                      <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/40">
                        orphaned
                      </span>
                    )}
                  </td>
                  <td
                    className="px-3 py-2 text-gray-400 max-w-[220px] truncate"
                    title={r.pageUrl || ''}
                  >
                    {formatPageUrl(r.pageUrl)}
                    {r.errorMessage && (
                      <span
                        className="block text-[11px] text-rose-400/80 truncate"
                        title={r.errorMessage}
                      >
                        {r.errorMessage}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-300 text-right whitespace-nowrap">
                    {formatReplayDuration(r.durationMs)}
                  </td>
                  <td className="px-3 py-2 text-gray-400 text-right">{r.eventCount}</td>
                  <td className="px-3 py-2 text-gray-400 text-right whitespace-nowrap">
                    {formatBytes(r.size)}
                  </td>
                  <td className="px-3 py-2">
                    {r.ticket ? (
                      <span
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-sky-500/15 text-sky-300 border border-sky-500/30 max-w-[180px] truncate"
                        title={r.ticket.subject || r.ticket.id}
                      >
                        <Link2 size={11} />
                        {r.ticket.subject || r.ticket.id}
                      </span>
                    ) : (
                      <span className="text-gray-600 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => setPlayingId(r.id)}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-200 border border-gray-700 hover:bg-gray-800"
                        title="Watch replay"
                      >
                        <Play size={12} />
                        Watch
                      </button>
                      {r.ticket ? (
                        <button
                          type="button"
                          onClick={() => handleUnlink(r)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-300 border border-gray-700 hover:bg-gray-800"
                          title="Unlink from ticket"
                        >
                          <Unlink size={12} />
                          Unlink
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setLinkFor(r)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-indigo-200 border border-indigo-500/40 hover:bg-indigo-500/10"
                          title="Link to a support ticket"
                        >
                          <Link2 size={12} />
                          Link
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {replays.length > 0 && (
        <div className="flex items-center justify-between mt-3 text-xs text-gray-400">
          <span>
            {offset + 1}–{offset + replays.length} of {total}
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

      {playingId && <ReplayPlayerModal replayId={playingId} onClose={() => setPlayingId(null)} />}

      {linkFor && (
        <LinkToTicketModal
          projectId={projectId}
          replay={linkFor}
          onClose={() => setLinkFor(null)}
          onLinked={() => {
            setLinkFor(null);
            notify('Replay linked to ticket', 'success');
            load();
          }}
          onError={(msg: string) => notify(msg, 'error')}
        />
      )}
    </>
  );
}

// ── Link-to-ticket picker ───────────────────────────────────────────
function LinkToTicketModal({ projectId, replay, onClose, onLinked, onError }: any) {
  const [tickets, setTickets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // Pull the open queue plus already-resolved tickets so an operator can
        // attach a replay to any ticket, not just live ones.
        const rows = await api.getSupportTickets(
          projectId,
          'new,investigating,converted,closed',
          undefined,
        );
        if (alive) setTickets(Array.isArray(rows) ? rows : []);
      } catch (e: any) {
        if (alive) onError?.(e?.message || 'Failed to load tickets');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId, onError]);

  const submit = async () => {
    if (!selected) return;
    setSubmitting(true);
    try {
      await api.linkReplayToTicket(projectId, replay.id, selected);
      onLinked();
    } catch (e: any) {
      onError?.(e?.message || 'Failed to link replay');
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-gray-800 bg-gray-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-gray-100">Link replay to a support ticket</h2>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-gray-300">
            <X size={16} />
          </button>
        </div>
        <div className="p-4 space-y-3">
          {loading ? (
            <p className="text-sm text-gray-500">Loading tickets…</p>
          ) : tickets.length === 0 ? (
            <p className="text-sm text-gray-500">
              This project has no support tickets yet. Create one from the Support page, then link
              this replay to it.
            </p>
          ) : (
            <>
              <label className="block text-xs text-gray-400">Support ticket</label>
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
              >
                <option value="">Select a ticket…</option>
                {tickets.map((t) => (
                  <option key={t.id} value={t.id}>
                    [{t.severity}] {t.subject || t.id}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-800">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs text-gray-300 border border-gray-700 hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!selected || submitting}
            onClick={submit}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40"
          >
            {submitting ? 'Linking…' : 'Link replay'}
          </button>
        </div>
      </div>
    </div>
  );
}
