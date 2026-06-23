import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, FileText, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../../utils/api';

/**
 * Diff-anchored sidecar that renders every cold-eye-reviewer finding tied
 * to the most-recent Finalize run for a session.
 *
 * Read-only at v0: the panel shows file-grouped findings + the run-level
 * verdict pill, and that's it — no reply input, no resolve button, no
 * mutation surface. Replies happen in the originating session, where the
 * reviewer's notes are also dispatched verbatim as part of the fix-
 * dispatch message body.
 *
 * Discovery flow:
 *
 *   1. Resolve the latest finalize run id via
 *      `GET /api/sessions/:sessionId/finalize-runs/latest` — returns
 *      `{ run: null }` for sessions that have never triggered Finalize,
 *      in which case this component renders nothing.
 *   2. Load threads for that run via
 *      `GET /api/projects/:projectId/finalize/:runId/reviewer-threads`.
 *   3. Subscribe to the `reviewer_thread_added` WebSocket event (bridged
 *      to a window `CustomEvent` in `App.jsx`) and refetch when one fires
 *      for our current run id.
 *
 * The panel returns `null` when there's no run, when the run has no
 * threads AND no verdict yet, or when the fetch fails — we never show
 * empty/error chrome that would clutter the session view for the vast
 * majority of sessions that have never been finalized.
 */
export default function ReviewerThreadsPanel({ sessionId, prefetchedRun }: any) {
  // When the parent (e.g. <ChecksPanel />) has already discovered the
  // latest finalize run for this session, it can pass it in via
  // `prefetchedRun` (a `FinalizeRunRow` for "the run" or `null` for
  // "the parent already checked and there is no run"). The panel then
  // skips the first REST call entirely and starts straight at the
  // threads-load step. Avoids the duplicate `getLatestFinalizeRunForSession`
  // round trip when the session view also mounts <ChecksPanel /> above
  // us (PR #1169 reviewer feedback, non-blocking item 1).
  const [latestRun, setLatestRun] = useState(prefetchedRun ?? null);
  const [threadsResp, setThreadsResp] = useState<any>(null);
  const [loadError, setLoadError] = useState<any>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<any>>(() => new Set());

  // One AbortController per mount; we abort it in cleanup (unmount or
  // sessionId change) so in-flight fetches don't race React state setters
  // after teardown. Refetch paths (the WS-bridged `reviewer_thread_added`
  // event) reuse the same controller — if the user switches sessions
  // mid-refetch, the request is aborted at the next reset.
  const abortRef = useRef<any>(null);
  const isAbortError = (e: any) =>
    e?.name === 'AbortError' || (typeof e?.message === 'string' && /aborted/i.test(e.message));

  // Step 1 — resolve the latest finalize_runs row for this session.
  const loadLatestRun = useCallback(
    (signal: any) => {
      if (!sessionId) {
        setLatestRun(null);
        return Promise.resolve(null);
      }
      return api
        .getLatestFinalizeRunForSession(sessionId, { signal })
        .then((data: any) => {
          if (signal?.aborted) return null;
          setLatestRun(data?.run ?? null);
          return data?.run ?? null;
        })
        .catch((e: any) => {
          if (isAbortError(e) || signal?.aborted) return null;
          // A 4xx here just means "no finalize for this session yet" — we
          // don't surface that as an error; the panel just stays hidden.
          setLatestRun(null);
          setLoadError(e?.message || null);
          return null;
        });
    },
    [sessionId],
  );

  // Step 2 — load threads for the resolved run.
  const loadThreads = useCallback((run: any, signal: any) => {
    if (!run || !run.id || !run.project_id) {
      setThreadsResp(null);
      return Promise.resolve();
    }
    return api
      .getReviewerThreads(run.project_id, run.id, { signal })
      .then((data: any) => {
        if (signal?.aborted) return;
        setThreadsResp(data);
        setLoadError(null);
      })
      .catch((e: any) => {
        if (isAbortError(e) || signal?.aborted) return;
        setThreadsResp(null);
        setLoadError(e?.message || 'Failed to load reviewer threads');
      });
  }, []);

  useEffect(() => {
    // Abort any prior in-flight fetch before kicking off a fresh pair.
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setThreadsResp(null);
    setLoadError(null);
    setCollapsedFiles(new Set());
    if (!sessionId) {
      setLatestRun(null);
      return () => controller.abort();
    }
    // When the parent already handed us a resolved run for this session,
    // skip step 1 and go straight to the threads fetch — the parent
    // (e.g. <ChecksPanel />) called the same endpoint and was about to
    // hand the result down. `prefetchedRun === null` is a valid value:
    // it means "parent already checked, there is no run for this
    // session", in which case we render nothing without ever fetching.
    if (
      prefetchedRun !== undefined &&
      (prefetchedRun === null || prefetchedRun?.session_id === sessionId)
    ) {
      setLatestRun(prefetchedRun);
      if (prefetchedRun) {
        loadThreads(prefetchedRun, controller.signal);
      }
      return () => controller.abort();
    }
    loadLatestRun(controller.signal).then((run: any) => {
      if (controller.signal.aborted) return;
      loadThreads(run, controller.signal);
    });
    return () => controller.abort();
    // `prefetchedRun` intentionally NOT in deps — callers pass a
    // snapshot, not a stream; a remount via React's normal commit is the
    // right way to react to a changed prefetched value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, loadLatestRun, loadThreads]);

  // Step 3 — live updates. The reviewer-dispatch helper fires one
  // `reviewer_thread_added` event per row after the COMMIT, so refetching
  // on the first event picks up the rest in the same tick. Refetches
  // piggy-back on the mount-scoped AbortController so a unmount mid-refetch
  // cancels cleanly.
  useEffect(() => {
    if (!latestRun?.id) return undefined;
    const handler = (event: any) => {
      const detail = event?.detail || {};
      if (detail.run_id !== latestRun.id) return;
      const signal = abortRef.current?.signal;
      loadThreads(latestRun, signal);
    };
    window.addEventListener('reviewer_thread_added', handler);
    return () => window.removeEventListener('reviewer_thread_added', handler);
  }, [latestRun, loadThreads]);

  // Group threads by file_path. The server already returns rows sorted
  // by `file_path ASC, line_start ASC, created_at ASC`, so a single pass
  // produces a stable grouping the UI can render as collapsible sections.
  const grouped = useMemo(() => {
    const threads = threadsResp?.threads || [];
    const out = new Map();
    for (const t of threads) {
      const list = out.get(t.file_path) || [];
      list.push(t);
      out.set(t.file_path, list);
    }
    return out;
  }, [threadsResp]);

  const verdict = threadsResp?.reviewer_verdict ?? null;
  const totalThreads = threadsResp?.threads?.length ?? 0;

  // Don't render anything if there's no finalize run for this session,
  // or if the run has neither a verdict nor any threads yet. Avoids
  // littering every session view with an empty card.
  if (!latestRun) return null;
  if (loadError && totalThreads === 0 && !verdict) return null;
  if (totalThreads === 0 && !verdict) return null;

  const toggleFile = (filePath: any) => {
    setCollapsedFiles((prev: any) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  return (
    <aside
      data-testid="reviewer-threads-panel"
      data-run-id={latestRun.id}
      className="border-t border-slate-700 bg-slate-900/60"
    >
      <header className="flex items-center justify-between px-4 py-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="font-medium text-slate-200">Reviewer notes</span>
          <span className="text-slate-500">
            {totalThreads} {totalThreads === 1 ? 'finding' : 'findings'}
          </span>
        </div>
        {verdict ? <VerdictPill verdict={verdict} /> : null}
      </header>

      {totalThreads === 0 ? (
        <div className="px-4 pb-3 text-xs text-slate-500">No findings on this pass.</div>
      ) : (
        <div className="space-y-2 px-4 pb-3">
          {Array.from(grouped.entries()).map(([filePath, threads]: any) => {
            const collapsed = collapsedFiles.has(filePath);
            return (
              <section
                key={filePath}
                data-testid="reviewer-threads-file-group"
                data-file-path={filePath}
                className="rounded border border-slate-700 bg-slate-800/60"
              >
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-slate-200 hover:bg-slate-800"
                  onClick={() => toggleFile(filePath)}
                  aria-expanded={!collapsed}
                >
                  {collapsed ? (
                    <ChevronRight size={14} className="text-slate-500" />
                  ) : (
                    <ChevronDown size={14} className="text-slate-500" />
                  )}
                  <FileText size={14} className="text-slate-500" />
                  <span className="truncate">{filePath}</span>
                  <span className="ml-auto text-[10px] text-slate-500">
                    {threads.length} {threads.length === 1 ? 'note' : 'notes'}
                  </span>
                </button>
                {!collapsed ? (
                  <ol className="divide-y divide-slate-700/60 border-t border-slate-700/60">
                    {threads.map((t: any) => (
                      <li
                        key={t.id}
                        data-testid="reviewer-thread"
                        className="px-3 py-2 text-xs text-slate-300"
                      >
                        <div className="mb-0.5 font-mono text-[10px] text-slate-500">
                          {formatAnchor(t)}
                        </div>
                        <div className="whitespace-pre-wrap break-words">{t.body}</div>
                      </li>
                    ))}
                  </ol>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </aside>
  );
}

function VerdictPill({ verdict }: any) {
  if (verdict === 'approved') {
    return (
      <span
        data-testid="reviewer-verdict"
        data-verdict="approved"
        className="inline-flex items-center gap-1 rounded bg-emerald-900/40 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300"
      >
        <CheckCircle2 size={12} />
        Approved
      </span>
    );
  }
  return (
    <span
      data-testid="reviewer-verdict"
      data-verdict="changes_requested"
      className="inline-flex items-center gap-1 rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
    >
      <AlertTriangle size={12} />
      Changes requested
    </span>
  );
}

function formatAnchor(t: any) {
  if (t.line_start === null || t.line_start === undefined) return '(file-level note)';
  if (t.line_end === null || t.line_end === undefined || t.line_end === t.line_start) {
    return `:${t.line_start}`;
  }
  return `:${t.line_start}-${t.line_end}`;
}
