import { useState, useEffect, useCallback, useRef } from 'react';
import { ArrowLeft, Loader2, Play, Pencil, Activity, RefreshCw, ListOrdered } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { api } from '../utils/api.js';
import { buildWorkflowStepDots } from '../utils/workflowProgressDots.js';
import WorkflowRunsSection from './WorkflowRunsSection.jsx';

const WORKFLOW_WS = 'agenthub-workflow-ws';

/** Coalesce bursty `workflow_run` / `workflow_update` window events into one reload. */
const WORKFLOW_WS_DEBOUNCE_MS = 450;

/** Cap parallel per-workflow fetches so large orgs do not open N×2 simultaneous HTTP calls. */
const WORKFLOW_ENRICH_CONCURRENCY = 4;

async function mapPool(items, concurrency, mapper) {
  const n = items.length;
  const out = new Array(n);
  if (n === 0) return out;
  let i = 0;
  const pool = Math.min(Math.max(1, concurrency), n);
  async function worker() {
    while (true) {
      const cur = i;
      i += 1;
      if (cur >= n) break;
      out[cur] = await mapper(items[cur], cur);
    }
  }
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return out;
}

function parseDbDate(dateStr) {
  if (!dateStr) return null;
  return dateStr.includes('T') ? new Date(dateStr) : new Date(`${dateStr}Z`);
}

function formatLastRun(run) {
  if (!run) return '—';
  const started = parseDbDate(run.started_at);
  if (!started || Number.isNaN(started.getTime())) return '—';
  try {
    return formatDistanceToNow(started, { addSuffix: true });
  } catch {
    return '—';
  }
}

function runStatusBadgeClass(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'success') return 'bg-emerald-500/15 text-emerald-300';
  if (s === 'error') return 'bg-red-500/15 text-red-300';
  if (s === 'cancelled') return 'bg-amber-500/15 text-amber-200';
  if (s === 'running') return 'bg-blue-500/15 text-blue-200';
  if (s === 'pending') return 'bg-gray-700 text-gray-200';
  return 'bg-gray-700 text-gray-200';
}

function StepDot({ title, kind }) {
  const base = 'w-2 h-2 rounded-full flex-shrink-0 border border-transparent transition-colors';
  const cls = {
    inactive: `${base} bg-gray-800 border-gray-700`,
    pending: `${base} bg-gray-600`,
    running: `${base} bg-blue-500 animate-pulse`,
    success: `${base} bg-emerald-500`,
    error: `${base} bg-red-500`,
    cancelled: `${base} bg-amber-600`,
    skipped: `${base} bg-slate-600 border-dashed border-slate-500`,
  }[kind];
  return <span title={`${title} (${kind})`} className={cls} aria-hidden="true" />;
}

export default function ProjectWorkflowsPage({
  projectId,
  project,
  onNavigate,
  onSelectAgent,
  showToast,
}) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [monitorWorkflowId, setMonitorWorkflowId] = useState(null);
  const [rowActionId, setRowActionId] = useState(null);
  const lastEditToastAtRef = useRef(0);
  const latestProjectIdRef = useRef(projectId);
  latestProjectIdRef.current = projectId;
  const loadRef = useRef(async () => {});
  const wsDebounceTimerRef = useRef(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    const token = projectId;
    setError('');
    try {
      const list = await api.getProjectWorkflows(token);
      if (latestProjectIdRef.current !== token) return;
      const wfList = Array.isArray(list) ? list : [];
      const enriched = await mapPool(wfList, WORKFLOW_ENRICH_CONCURRENCY, async (w) => {
        let lastRun = null;
        let stepRuns = [];
        try {
          const runs = await api.getWorkflowRuns(token, w.id, { limit: 1 });
          if (latestProjectIdRef.current !== token)
            return { workflow: w, lastRun: null, stepRuns: [] };
          lastRun = runs[0] || null;
          if (lastRun) {
            const det = await api.getWorkflowRunDetail(token, w.id, lastRun.id);
            if (latestProjectIdRef.current !== token)
              return { workflow: w, lastRun: null, stepRuns: [] };
            stepRuns = det.step_runs || [];
          }
        } catch {
          /* keep row without run detail */
        }
        return { workflow: w, lastRun, stepRuns };
      });
      if (latestProjectIdRef.current !== token) return;
      setRows(enriched);
    } catch (e) {
      if (latestProjectIdRef.current !== token) return;
      setError(String(e.message || e));
      setRows([]);
    } finally {
      if (latestProjectIdRef.current === token) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [projectId]);

  loadRef.current = load;

  const scheduleWsReload = useCallback(() => {
    if (wsDebounceTimerRef.current) clearTimeout(wsDebounceTimerRef.current);
    wsDebounceTimerRef.current = setTimeout(() => {
      wsDebounceTimerRef.current = null;
      void loadRef.current();
    }, WORKFLOW_WS_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  useEffect(() => {
    const fn = (ev) => {
      const d = ev.detail;
      if (!d || d.projectId !== projectId) return;
      scheduleWsReload();
    };
    window.addEventListener(WORKFLOW_WS, fn);
    return () => {
      window.removeEventListener(WORKFLOW_WS, fn);
      if (wsDebounceTimerRef.current) {
        clearTimeout(wsDebounceTimerRef.current);
        wsDebounceTimerRef.current = null;
      }
    };
  }, [projectId, scheduleWsReload]);

  const handleRefresh = () => {
    setRefreshing(true);
    load();
  };

  const goChat = () => {
    const agents = project?.agents?.filter((a) => a.active !== false) || [];
    const first = agents[0];
    if (first && onSelectAgent) onSelectAgent(first.id);
    onNavigate('chat');
  };

  const startRun = async (wfId) => {
    const token = projectId;
    setRowActionId(wfId);
    try {
      await api.startWorkflowRun(token, wfId);
      if (latestProjectIdRef.current !== token) return;
      if (showToast) showToast('Workflow run started', 'success', 3000);
      await load();
    } catch (e) {
      if (latestProjectIdRef.current === token && showToast) {
        showToast(String(e.message || e), 'error', 6000);
      }
    } finally {
      if (latestProjectIdRef.current === token) {
        setRowActionId(null);
      }
    }
  };

  const openSettingsEdit = () => {
    onNavigate('settings:github', { expandProjectId: projectId });
    if (showToast) {
      const now = Date.now();
      if (now - lastEditToastAtRef.current > 10_000) {
        lastEditToastAtRef.current = now;
        showToast('Opening Settings → GitHub with this project expanded.', 'info', 4000);
      }
    }
  };

  const projectName = project?.name || 'Project';
  const projectColor = project?.color || '#6366f1';

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-gray-950 text-gray-100">
      <div className="flex-shrink-0 border-b border-gray-800 px-4 py-3 md:px-6 flex items-center gap-3">
        <button
          type="button"
          onClick={goChat}
          className="flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 transition-colors"
        >
          <ArrowLeft size={16} />
          Chat
        </button>
        <span
          className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
          style={{ backgroundColor: projectColor }}
        />
        <h1 className="text-lg font-semibold text-white truncate flex items-center gap-2">
          <ListOrdered size={18} className="text-violet-400 flex-shrink-0" />
          <span className="truncate">{projectName}</span>
          <span className="text-gray-500 font-normal text-sm">· Workflows</span>
        </h1>
        <span className="flex-1" />
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing || loading}
          className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 disabled:opacity-50"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="max-w-4xl mx-auto space-y-4">
          {error && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center gap-2 text-gray-400 text-sm py-12 justify-center">
              <Loader2 size={18} className="animate-spin" />
              Loading workflows…
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-6 text-center text-gray-400 text-sm">
              No Hub workflows for this project yet. Create one via the API, or open Settings →
              GitHub for manual runs when workflow mode is enabled.
            </div>
          ) : (
            <ul className="space-y-2">
              {rows.map(({ workflow: w, lastRun, stepRuns }) => {
                const dots = buildWorkflowStepDots(w, stepRuns, Boolean(lastRun));
                const isMonitoring = monitorWorkflowId === w.id;
                return (
                  <li
                    key={w.id}
                    className="rounded-xl border border-gray-800 bg-gray-900/50 overflow-hidden"
                  >
                    <div className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-white truncate">{w.name}</span>
                          {lastRun && (
                            <span
                              className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${runStatusBadgeClass(lastRun.status)}`}
                            >
                              {lastRun.status}
                            </span>
                          )}
                          {(lastRun?.status === 'pending' || lastRun?.status === 'running') && (
                            <span
                              className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0"
                              title="Active run"
                            />
                          )}
                        </div>
                        <div className="text-xs text-gray-500">
                          Last run: <span className="text-gray-300">{formatLastRun(lastRun)}</span>
                          {dots.length > 0 && (
                            <span
                              className="ml-3 inline-flex items-center gap-1.5 align-middle"
                              role="group"
                              aria-label="Last run progress by step"
                            >
                              {dots.map((d) => (
                                <StepDot key={d.id} title={d.title} kind={d.kind} />
                              ))}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 sm:flex-shrink-0">
                        <button
                          type="button"
                          disabled={rowActionId === w.id}
                          onClick={() => startRun(w.id)}
                          className="inline-flex items-center gap-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg"
                        >
                          {rowActionId === w.id ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Play size={12} />
                          )}
                          Run
                        </button>
                        <button
                          type="button"
                          onClick={openSettingsEdit}
                          className="inline-flex items-center gap-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs px-3 py-1.5 rounded-lg"
                        >
                          <Pencil size={12} />
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => setMonitorWorkflowId(isMonitoring ? null : w.id)}
                          className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border ${
                            isMonitoring
                              ? 'border-violet-500/60 bg-violet-500/15 text-violet-100'
                              : 'border-gray-700 bg-gray-800/80 text-gray-200 hover:border-gray-600'
                          }`}
                        >
                          <Activity size={12} />
                          {isMonitoring ? 'Hide monitor' : 'Monitor'}
                        </button>
                      </div>
                    </div>
                    {isMonitoring && (
                      <div className="border-t border-gray-800 bg-gray-950/60 p-4">
                        <WorkflowRunsSection projectId={projectId} embedWorkflowId={w.id} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
