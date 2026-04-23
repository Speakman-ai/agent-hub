import { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api.js';
import { Loader2, Play, Ban, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';

const WORKFLOW_WS = 'agenthub-workflow-ws';

function isActiveRunStatus(s) {
  return s === 'pending' || s === 'running';
}

export default function WorkflowRunsSection({ projectId }) {
  const [open, setOpen] = useState(false);
  const [workflows, setWorkflows] = useState([]);
  const [wfId, setWfId] = useState('');
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadWorkflows = useCallback(async () => {
    const list = await api.getProjectWorkflows(projectId);
    setWorkflows(Array.isArray(list) ? list : []);
    return list;
  }, [projectId]);

  const loadRuns = useCallback(async () => {
    if (!wfId) return;
    const r = await api.getWorkflowRuns(projectId, wfId, { limit: 50 });
    setRuns(Array.isArray(r) ? r : []);
  }, [projectId, wfId]);

  const loadDetail = useCallback(
    async (runId) => {
      if (!runId || !wfId) return;
      const d = await api.getWorkflowRunDetail(projectId, wfId, runId);
      setDetail(d);
    },
    [projectId, wfId],
  );

  useEffect(() => {
    if (!open) return undefined;
    setError('');
    loadWorkflows()
      .then((list) => {
        const arr = Array.isArray(list) ? list : [];
        setWfId((cur) => {
          if (cur && arr.some((w) => w.id === cur)) return cur;
          return arr[0]?.id || '';
        });
      })
      .catch((e) => setError(String(e.message || e)));
    return undefined;
  }, [open, loadWorkflows]);

  useEffect(() => {
    if (!open || !wfId) return undefined;
    loadRuns().catch((e) => setError(String(e.message || e)));
    const id = setInterval(() => {
      loadRuns().catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, [open, wfId, loadRuns]);

  useEffect(() => {
    if (!selectedRunId || !open || !wfId) {
      setDetail(null);
      return undefined;
    }
    loadDetail(selectedRunId).catch((e) => setError(String(e.message || e)));
    const id = setInterval(() => {
      loadDetail(selectedRunId).catch(() => {});
    }, 4000);
    return () => clearInterval(id);
  }, [selectedRunId, open, wfId, loadDetail]);

  useEffect(() => {
    if (!open) return undefined;
    const fn = (ev) => {
      const d = ev.detail;
      if (!d || d.projectId !== projectId) return;
      if (wfId && d.workflowId && d.workflowId !== wfId) return;
      loadRuns().catch(() => {});
      if (selectedRunId && d.runId === selectedRunId) {
        loadDetail(selectedRunId).catch(() => {});
      }
    };
    window.addEventListener(WORKFLOW_WS, fn);
    return () => window.removeEventListener(WORKFLOW_WS, fn);
  }, [open, projectId, wfId, selectedRunId, loadRuns, loadDetail]);

  const startRun = async () => {
    if (!wfId) return;
    setLoading(true);
    setError('');
    try {
      await api.startWorkflowRun(projectId, wfId);
      await loadRuns();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  };

  const cancelRun = async (runId) => {
    if (!wfId) return;
    setLoading(true);
    setError('');
    try {
      await api.cancelWorkflowRun(projectId, wfId, runId);
      await loadRuns();
      if (selectedRunId === runId) await loadDetail(runId);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    'w-full max-w-md bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100';

  return (
    <div className="pt-2 border-t border-gray-800 space-y-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 text-sm text-gray-200 hover:text-white"
      >
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        Hub workflow runs (manual)
      </button>
      {open && (
        <div className="space-y-3 pl-1">
          {error && <p className="text-xs text-red-400">{error}</p>}
          {workflows.length === 0 ? (
            <p className="text-xs text-gray-500">
              No workflows defined for this project. Create one via the API or a future editor.
            </p>
          ) : (
            <>
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-400">Workflow</label>
                <select
                  value={wfId}
                  onChange={(e) => {
                    setWfId(e.target.value);
                    setSelectedRunId(null);
                  }}
                  className={inputClass}
                >
                  {workflows.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>
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
                  {runs.map((r) => (
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
                        {isActiveRunStatus(r.status) && (
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
                <div className="max-w-2xl rounded-lg border border-gray-800 bg-gray-950/60 p-3 space-y-2">
                  <div className="text-xs text-gray-400 flex flex-wrap gap-2 items-center">
                    <span className="font-mono text-gray-200">{detail.run.id}</span>
                    <span
                      className={`px-1.5 py-0.5 rounded ${
                        detail.run.status === 'success'
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : detail.run.status === 'error'
                            ? 'bg-red-500/15 text-red-300'
                            : detail.run.status === 'cancelled'
                              ? 'bg-amber-500/15 text-amber-200'
                              : 'bg-gray-700 text-gray-200'
                      }`}
                    >
                      {detail.run.status}
                    </span>
                    {isActiveRunStatus(detail.run.status) && (
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => cancelRun(detail.run.id)}
                        className="inline-flex items-center gap-1 text-xs text-amber-300 hover:text-amber-200"
                      >
                        <Ban size={12} />
                        Cancel run
                      </button>
                    )}
                  </div>
                  {detail.run.error && (
                    <p className="text-xs text-red-400 whitespace-pre-wrap">{detail.run.error}</p>
                  )}
                  <div className="text-xs font-medium text-gray-400">Step runs</div>
                  <ul className="space-y-2 max-h-64 overflow-y-auto">
                    {(detail.step_runs || []).map((sr) => (
                      <li
                        key={sr.id}
                        className="border border-gray-800 rounded-md p-2 text-xs space-y-1"
                      >
                        <div className="flex flex-wrap gap-2 text-gray-300">
                          <span>{sr.step_title || sr.workflow_step_id?.slice(0, 8) || 'step'}</span>
                          <span className="text-gray-500">{sr.status}</span>
                        </div>
                        {sr.output && (
                          <pre className="text-[11px] text-gray-400 whitespace-pre-wrap max-h-32 overflow-y-auto">
                            {String(sr.output).slice(0, 4000)}
                            {String(sr.output).length > 4000 ? '…' : ''}
                          </pre>
                        )}
                        {sr.error && <p className="text-red-400">{sr.error}</p>}
                      </li>
                    ))}
                  </ul>
                  {(detail.step_runs || []).length === 0 && (
                    <p className="text-xs text-gray-600">
                      No step rows yet (run pending or no steps).
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
