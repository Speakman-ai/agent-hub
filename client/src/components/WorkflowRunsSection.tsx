import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api } from '../utils/api';
import {
  Loader2,
  Play,
  Ban,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Circle,
  CircleDashed,
  Loader,
  Minus,
  Terminal,
} from 'lucide-react';
import { buildWorkflowRunTimeline, isWorkflowRunActive } from '@shared/utils/workflowRunTimeline';

const WORKFLOW_WS = 'agenthub-workflow-ws';

const ACTIVE_RUN_POLL_MS = 1600;
const IDLE_RUN_POLL_MS = 5000;
const ACTIVE_DETAIL_POLL_MS = 1200;
const IDLE_DETAIL_POLL_MS = 4500;

function stepPillClass(status: any) {
  const s = String(status || '').toLowerCase();
  if (s === 'success') return 'bg-emerald-500/15 text-emerald-300';
  if (s === 'error') return 'bg-red-500/15 text-red-300';
  if (s === 'cancelled') return 'bg-amber-500/15 text-amber-200';
  if (s === 'skipped') return 'bg-slate-600/30 text-slate-300';
  if (s === 'running') return 'bg-blue-500/15 text-blue-200';
  if (s === 'queued') return 'bg-gray-700/80 text-gray-300';
  if (s === 'not_run') return 'bg-gray-800 text-gray-500';
  return 'bg-gray-700 text-gray-200';
}

function TimelineNode({ status }: any) {
  const s = String(status || '').toLowerCase();
  const wrap =
    'absolute -left-[25px] top-0.5 flex h-5 w-5 items-center justify-center rounded-full border bg-gray-950';
  if (s === 'success') {
    return (
      <span className={`${wrap} border-emerald-600/60 text-emerald-400`} aria-hidden="true">
        <CheckCircle2 size={14} strokeWidth={2} />
      </span>
    );
  }
  if (s === 'error') {
    return (
      <span className={`${wrap} border-red-600/60 text-red-400`} aria-hidden="true">
        <XCircle size={14} strokeWidth={2} />
      </span>
    );
  }
  if (s === 'cancelled') {
    return (
      <span className={`${wrap} border-amber-600/50 text-amber-300`} aria-hidden="true">
        <Ban size={12} strokeWidth={2} />
      </span>
    );
  }
  if (s === 'skipped') {
    return (
      <span className={`${wrap} border-slate-600 text-slate-400`} aria-hidden="true">
        <CircleDashed size={12} strokeWidth={2} />
      </span>
    );
  }
  if (s === 'running') {
    return (
      <span className={`${wrap} border-blue-500/70 text-blue-300`} aria-hidden="true">
        <Loader size={12} className="animate-spin" strokeWidth={2} />
      </span>
    );
  }
  if (s === 'not_run') {
    return (
      <span className={`${wrap} border-gray-700 text-gray-600`} aria-hidden="true">
        <Minus size={12} strokeWidth={2} />
      </span>
    );
  }
  if (s === 'queued') {
    return (
      <span className={`${wrap} border-gray-700 text-gray-500`} aria-hidden="true">
        <Circle size={10} strokeWidth={2} />
      </span>
    );
  }
  return (
    <span className={`${wrap} border-gray-700 text-gray-500`} aria-hidden="true">
      <Circle size={10} strokeWidth={2} />
    </span>
  );
}

const OUTPUT_CAP = 48_000;

function pickLiveOutput(timeline: any, run: any) {
  if (timeline.runningRow) {
    const { step, stepRun } = timeline.runningRow;
    const out = stepRun?.output ? String(stepRun.output) : '';
    return {
      title: `Active · ${String(step.title || 'Step')}`,
      body: out || null,
      hint: out ? null : 'Output is written when this step completes.',
      tone: 'active',
    };
  }
  const st = String(run?.status || '').toLowerCase();
  if (st === 'error') {
    const failed = [...timeline.rows]
      .reverse()
      .find((r: any) => r.stepRun && r.displayStatus === 'error');
    const body = failed?.stepRun?.output ? String(failed.stepRun.output) : null;
    return {
      title: failed ? `Failed · ${String(failed.step.title || 'Step')}` : 'Run failed',
      body,
      // Step-level errors render on the timeline row; avoid duplicating them here.
      hint: body
        ? null
        : failed
          ? 'No stdout captured for this step.'
          : run?.error
            ? String(run.error)
            : null,
      tone: 'error',
    };
  }
  if (!isWorkflowRunActive(run)) {
    for (let i = timeline.rows.length - 1; i >= 0; i -= 1) {
      const r = timeline.rows[i];
      if (r.stepRun?.output) {
        return {
          title: `Last output · ${String(r.step.title || 'Step')}`,
          body: String(r.stepRun.output),
          hint: null,
          tone: 'done',
        };
      }
    }
  }
  return {
    title: 'Live output',
    body: null,
    hint: isWorkflowRunActive(run)
      ? 'Waiting for the first step…'
      : 'No captured output for this run.',
    tone: 'idle',
  };
}

export default function WorkflowRunsSection({ projectId, embedWorkflowId = null }: any) {
  const isEmbed = Boolean(embedWorkflowId);
  const [open, setOpen] = useState(isEmbed);
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [wfId, setWfId] = useState(embedWorkflowId || '');
  const [runs, setRuns] = useState<any[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const outputScrollRef = useRef<any>(null);
  /** Monotonic counter so slower `getWorkflowRunDetail` responses cannot overwrite newer selection. */
  const detailFetchGenRef = useRef(0);
  /** Bumped when `wfId` changes so in-flight `getWorkflowRuns` cannot repopulate the prior workflow's list. */
  const runsListGenRef = useRef(0);
  const projectIdRef = useRef(projectId);
  const wfIdRef = useRef(wfId);
  const selectedRunIdRef = useRef(selectedRunId);
  /** Last `wfId:runId` we fetched detail for — when it changes, clear `detail` so the UI never shows run A while run B is selected. */
  const detailPanelKeyRef = useRef('');
  projectIdRef.current = projectId;
  wfIdRef.current = wfId;
  selectedRunIdRef.current = selectedRunId;

  const loadWorkflows = useCallback(async () => {
    const list = await api.getProjectWorkflows(projectId);
    setWorkflows(Array.isArray(list) ? list : []);
    return list;
  }, [projectId]);

  const loadRuns = useCallback(async () => {
    const w = wfIdRef.current;
    const p = projectIdRef.current;
    if (!w) return;
    const listGen = runsListGenRef.current;
    try {
      const r = await api.getWorkflowRuns(p, w, { limit: 50 });
      if (listGen !== runsListGenRef.current) return;
      if (wfIdRef.current !== w || projectIdRef.current !== p) return;
      setError('');
      setRuns(Array.isArray(r) ? r : []);
    } catch (e: any) {
      if (listGen !== runsListGenRef.current) return;
      if (wfIdRef.current !== w || projectIdRef.current !== p) return;
      setError(String(e.message || e));
    }
  }, []);

  const loadDetail = useCallback(async (runId: any) => {
    const w = wfIdRef.current;
    const p = projectIdRef.current;
    if (!runId || !w) return;
    const myGen = ++detailFetchGenRef.current;
    try {
      const d = await api.getWorkflowRunDetail(p, w, runId);
      if (myGen !== detailFetchGenRef.current) return;
      if (
        projectIdRef.current !== p ||
        wfIdRef.current !== w ||
        selectedRunIdRef.current !== runId
      ) {
        return;
      }
      setError('');
      setDetail(d);
    } catch (e: any) {
      if (myGen !== detailFetchGenRef.current) return;
      if (
        projectIdRef.current !== p ||
        wfIdRef.current !== w ||
        selectedRunIdRef.current !== runId
      ) {
        return;
      }
      setError(String(e.message || e));
    }
  }, []);

  useEffect(() => {
    if (embedWorkflowId) {
      setOpen(true);
      setWfId(embedWorkflowId);
    }
  }, [embedWorkflowId]);

  useEffect(() => {
    if (!open && !isEmbed) return undefined;
    setError('');
    loadWorkflows()
      .then((list: any) => {
        const arr = Array.isArray(list) ? list : [];
        setWfId((cur: any) => {
          if (embedWorkflowId) return embedWorkflowId;
          if (cur && arr.some((w: any) => w.id === cur)) return cur;
          return arr[0]?.id || '';
        });
      })
      .catch((e: any) => setError(String(e.message || e)));
    return undefined;
  }, [open, loadWorkflows, embedWorkflowId, isEmbed]);

  useEffect(() => {
    // `runsListGenRef` is also bumped in `<select onChange>` when switching workflows; this effect still
    // runs on every `wfId` change (embed, initial hydrate) so both paths invalidate in-flight list fetches.
    runsListGenRef.current += 1;
    setRuns([]);
    setDetail(null);
    setSelectedRunId(null);
  }, [wfId]);

  const hasActiveRunInList = runs.some((r: any) => isWorkflowRunActive(r));

  useEffect(() => {
    if ((!open && !isEmbed) || !wfId) return undefined;
    loadRuns().catch((e: any) => setError(String(e.message || e)));
    const pollMs = hasActiveRunInList ? ACTIVE_RUN_POLL_MS : IDLE_RUN_POLL_MS;
    const id = setInterval(() => {
      loadRuns().catch(() => {});
    }, pollMs);
    return () => clearInterval(id);
  }, [open, wfId, loadRuns, isEmbed, hasActiveRunInList]);

  useEffect(() => {
    if (!wfId) return;
    if (runs.length === 0) {
      setSelectedRunId(null);
      setDetail(null);
      return;
    }
    setSelectedRunId((cur: any) => {
      if (cur && runs.some((r: any) => r.id === cur)) return cur;
      return runs[0]?.id || null;
    });
  }, [wfId, runs]);

  const detailActive = Boolean(detail?.run && isWorkflowRunActive(detail.run));

  useEffect(() => {
    if (!selectedRunId || (!open && !isEmbed) || !wfId) {
      setDetail(null);
      detailPanelKeyRef.current = '';
      return undefined;
    }
    const panelKey = `${wfId}:${selectedRunId}`;
    if (detailPanelKeyRef.current !== panelKey) {
      setDetail(null);
      detailPanelKeyRef.current = panelKey;
    }
    void loadDetail(selectedRunId);
    const pollMs = detailActive ? ACTIVE_DETAIL_POLL_MS : IDLE_DETAIL_POLL_MS;
    const id = setInterval(() => {
      void loadDetail(selectedRunId);
    }, pollMs);
    return () => clearInterval(id);
  }, [selectedRunId, open, wfId, loadDetail, isEmbed, detailActive]);

  useEffect(() => {
    if (!open && !isEmbed) return undefined;
    const fn = (ev: any) => {
      const d = ev.detail;
      if (!d || d.projectId !== projectId) return;
      if (wfId && d.workflowId && d.workflowId !== wfId) return;
      loadRuns().catch(() => {});
      // Refresh detail when the event is global/ambiguous (no runId) or targets the open run.
      if (selectedRunId && (!d.runId || d.runId === selectedRunId)) {
        void loadDetail(selectedRunId);
      }
    };
    window.addEventListener(WORKFLOW_WS, fn);
    return () => window.removeEventListener(WORKFLOW_WS, fn);
  }, [open, isEmbed, projectId, wfId, selectedRunId, loadRuns, loadDetail]);

  const currentWorkflow = useMemo(
    () => workflows.find((w: any) => w.id === wfId) || null,
    [workflows, wfId],
  );

  const timeline = useMemo(
    () => buildWorkflowRunTimeline(currentWorkflow, detail?.step_runs, detail?.run),
    [currentWorkflow, detail?.step_runs, detail?.run],
  );

  const progressStepTotal = timeline.totalSteps || 0;
  const progressStepDone = timeline.completedSteps;

  const liveOutput = useMemo(() => pickLiveOutput(timeline, detail?.run), [timeline, detail?.run]);

  useEffect(() => {
    const el = outputScrollRef.current;
    if (!el || !liveOutput.body) return;
    el.scrollTop = el.scrollHeight;
  }, [liveOutput.body, detail?.run?.updated_at]);

  const startRun = async () => {
    if (!wfId) return;
    setLoading(true);
    setError('');
    try {
      await api.startWorkflowRun(projectId, wfId);
      await loadRuns();
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  };

  const cancelRun = async (runId: any) => {
    if (!wfId) return;
    setLoading(true);
    setError('');
    try {
      await api.cancelWorkflowRun(projectId, wfId, runId);
      await loadRuns();
      if (selectedRunId === runId) await loadDetail(runId);
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    'w-full max-w-md bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100';

  const runStatusBadge = (status: any) => {
    const s = String(status || '').toLowerCase();
    if (s === 'success') return 'bg-emerald-500/15 text-emerald-300';
    if (s === 'error') return 'bg-red-500/15 text-red-300';
    if (s === 'cancelled') return 'bg-amber-500/15 text-amber-200';
    if (s === 'running') return 'bg-blue-500/15 text-blue-200';
    if (s === 'pending') return 'bg-gray-700 text-gray-200';
    return 'bg-gray-700 text-gray-200';
  };

  return (
    <div className={isEmbed ? 'space-y-3' : 'pt-2 border-t border-gray-800 space-y-2'}>
      {!isEmbed && (
        <button
          type="button"
          onClick={() => setOpen((o: any) => !o)}
          className="flex items-center gap-2 text-sm text-gray-200 hover:text-white"
        >
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          Hub workflow runs (manual)
        </button>
      )}
      {(open || isEmbed) && (
        <div className={`space-y-3 ${isEmbed ? '' : 'pl-1'}`}>
          {error && <p className="text-xs text-red-400">{error}</p>}
          {workflows.length === 0 ? (
            <p className="text-xs text-gray-500">
              No workflows defined for this project. Create one via the API or a future editor.
            </p>
          ) : (
            <>
              {!isEmbed && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-gray-400">Workflow</label>
                  <select
                    value={wfId}
                    onChange={(e: any) => {
                      // Clear in the same handler as `wfId` so the next commit never pairs a new
                      // workflow id with the previous `runs` array (avoids auto-picking a stale run id).
                      // Bumps `runsListGenRef` here and again in the `[wfId]` effect — intentional double
                      // invalidate so any in-flight `getWorkflowRuns` for the old workflow cannot apply late.
                      runsListGenRef.current += 1;
                      setRuns([]);
                      setDetail(null);
                      setSelectedRunId(null);
                      setWfId(e.target.value);
                    }}
                    className={inputClass}
                  >
                    {workflows.map((w: any) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={loading || !wfId}
                  onClick={startRun}
                  className="inline-flex items-center gap-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg"
                >
                  {loading ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                  Start manual run
                </button>
                <button
                  type="button"
                  disabled={!wfId}
                  onClick={() => loadRuns()}
                  className="inline-flex items-center gap-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg"
                >
                  <RefreshCw size={12} />
                  Refresh
                </button>
              </div>
              <div className="space-y-1">
                <span className="text-xs font-medium text-gray-400">Recent runs</span>
                <ul className="max-w-xl space-y-1">
                  {runs.map((r: any) => (
                    <li key={r.id}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          type="button"
                          onClick={() => setSelectedRunId(r.id)}
                          className={`text-left text-xs font-mono rounded px-2 py-1 border ${
                            selectedRunId === r.id
                              ? 'border-blue-500/60 bg-blue-500/10 text-blue-100'
                              : 'border-gray-700 bg-gray-900/80 text-gray-300 hover:border-gray-600'
                          }`}
                        >
                          {r.id.slice(0, 8)}… · {r.status}
                        </button>
                        {isWorkflowRunActive(r) && (
                          <button
                            type="button"
                            disabled={loading}
                            onClick={() => cancelRun(r.id)}
                            className="inline-flex items-center gap-1 text-xs text-amber-300 hover:text-amber-200 disabled:opacity-50"
                          >
                            <Ban size={12} />
                            Cancel
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                {runs.length === 0 && (
                  <p className="text-xs text-gray-600">No runs yet — start one above.</p>
                )}
              </div>
              {detail && selectedRunId && (
                <div className="rounded-xl border border-gray-800 bg-gray-950/70 overflow-hidden">
                  <div className="border-b border-gray-800 px-3 py-2.5 flex flex-wrap items-center gap-2 gap-y-1">
                    <span className="text-[11px] font-mono text-gray-200 truncate max-w-[min(100%,14rem)]">
                      {detail.run.id}
                    </span>
                    <span
                      className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${runStatusBadge(detail.run.status)}`}
                    >
                      {detail.run.status}
                    </span>
                    {isWorkflowRunActive(detail.run) && (
                      <span
                        className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"
                        title="Live updates"
                        aria-label="Live updates"
                      />
                    )}
                    <span className="flex-1" />
                    {isWorkflowRunActive(detail.run) && (
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => cancelRun(detail.run.id)}
                        className="inline-flex items-center gap-1 text-[11px] text-amber-300 hover:text-amber-200"
                      >
                        <Ban size={12} />
                        Cancel run
                      </button>
                    )}
                  </div>

                  {detail.run.error && (
                    <div className="mx-3 mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-100 whitespace-pre-wrap">
                      {detail.run.error}
                    </div>
                  )}

                  <div className="p-3 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-start">
                    <div className="space-y-3 min-w-0">
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
                            Progress
                          </span>
                          <span className="text-[11px] text-gray-400">
                            {progressStepDone}/{progressStepTotal} steps · {timeline.progressPct}%
                          </span>
                        </div>
                        <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
                          {progressStepTotal > 0 ? (
                            <div
                              className="h-full rounded-full bg-violet-500 transition-[width] duration-300 ease-out"
                              style={{ width: `${timeline.progressPct}%` }}
                              role="progressbar"
                              aria-label={`Workflow run progress: ${progressStepDone} of ${progressStepTotal} steps complete`}
                              aria-valuenow={progressStepDone}
                              aria-valuemin={0}
                              aria-valuemax={progressStepTotal}
                            />
                          ) : (
                            <div
                              className="h-full w-0 rounded-full bg-violet-500/0"
                              aria-hidden="true"
                            />
                          )}
                        </div>
                      </div>

                      <div>
                        <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500 mb-2">
                          Steps
                        </div>
                        {timeline.rows.length === 0 ? (
                          <p className="text-xs text-gray-600">
                            No steps defined for this workflow.
                          </p>
                        ) : (
                          <ul className="relative ml-2 border-l border-gray-800 pl-5 space-y-4 pb-1">
                            {timeline.rows.map((row: any) => (
                              <li key={row.key} className="relative">
                                <TimelineNode status={row.displayStatus} />
                                <div className="flex flex-wrap items-center gap-2 gap-y-1">
                                  <span className="text-sm text-gray-100 font-medium">
                                    {String(row.step.title || 'Step')}
                                  </span>
                                  <span
                                    className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${stepPillClass(row.displayStatus)}`}
                                  >
                                    {row.displayStatus}
                                  </span>
                                  {row.orphan && (
                                    <span className="text-[10px] text-gray-500">(historical)</span>
                                  )}
                                </div>
                                {row.stepRun?.error && row.displayStatus === 'error' && (
                                  <p className="mt-1 text-xs text-red-400 whitespace-pre-wrap">
                                    {row.stepRun.error}
                                  </p>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>

                    <div className="min-w-0 flex flex-col rounded-lg border border-gray-800/80 bg-gray-950/80">
                      <div className="flex items-center gap-2 border-b border-gray-800/80 px-3 py-2">
                        <Terminal size={14} className="text-violet-400 flex-shrink-0" />
                        <span className="text-xs font-medium text-gray-200 truncate">
                          {liveOutput.title}
                        </span>
                      </div>
                      <div
                        ref={outputScrollRef}
                        className="min-h-[8rem] max-h-72 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed"
                      >
                        {liveOutput.body ? (
                          <pre className="whitespace-pre-wrap text-gray-300">
                            {liveOutput.body.length > OUTPUT_CAP
                              ? `${liveOutput.body.slice(0, OUTPUT_CAP)}\n… (truncated)`
                              : liveOutput.body}
                          </pre>
                        ) : (
                          <p
                            className={
                              liveOutput.tone === 'error'
                                ? 'text-red-300/90 whitespace-pre-wrap'
                                : 'text-gray-500'
                            }
                          >
                            {liveOutput.hint || '—'}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
