/**
 * CiRunsSection — GHA-style run history + "CI on push" config, rendered
 * inside the Runners page (FinalizeSettingsSection).
 *
 * Shows every past CI execution for the project (Finalize runs and
 * report-only push-CI runs share the same tables) with per-job results,
 * expandable step lists, and step logs via the existing finalize
 * step-output endpoint. The "CI on push" toggle (Agent Hub-hosted
 * projects only) makes pushes/merges to the default branch run the
 * repo's `.agent-hub/ci.yaml` jobs automatically.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  XCircle,
  CircleDashed,
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  History,
  Zap,
} from 'lucide-react';
import { api } from '../utils/api.js';
import { relativePrTime } from '../utils/prFormatting.js';

const TERMINAL_STATUSES = new Set([
  'ready_to_push',
  'pushed',
  'succeeded',
  'failed',
  'timed_out',
  'infra_error',
  'cancelled',
]);

function triggerBadge(trigger) {
  if (trigger === 'git_push')
    return { label: 'push', cls: 'border-sky-500/25 bg-sky-500/10 text-sky-300' };
  if (trigger === 'pr_push')
    return { label: 'pr ci', cls: 'border-amber-500/25 bg-amber-500/10 text-amber-300' };
  if (trigger === 'agent_block')
    return { label: 'auto', cls: 'border-purple-500/25 bg-purple-500/10 text-purple-300' };
  return { label: 'finalize', cls: 'border-gray-600/40 bg-gray-700/30 text-gray-300' };
}

function statusVisual(status) {
  if (status === 'succeeded' || status === 'ready_to_push' || status === 'pushed') {
    return {
      Icon: CheckCircle2,
      cls: 'text-emerald-400',
      label: status === 'succeeded' ? 'passed' : status,
    };
  }
  if (status === 'failed' || status === 'timed_out' || status === 'infra_error') {
    return { Icon: XCircle, cls: 'text-red-400', label: status };
  }
  if (status === 'cancelled') {
    return { Icon: CircleDashed, cls: 'text-gray-500', label: 'cancelled' };
  }
  return { Icon: Loader2, cls: 'text-amber-400 animate-spin', label: status };
}

function durationLabel(run) {
  if (!run.started_at || !run.ended_at) return '';
  const sec = Math.max(0, Math.round((run.ended_at - run.started_at) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function jobStateIcon(state) {
  if (state === 'success') return <CheckCircle2 size={12} className="text-emerald-400" />;
  if (state === 'failure' || state === 'timeout')
    return <XCircle size={12} className="text-red-400" />;
  if (state === 'running') return <Loader2 size={12} className="text-amber-400 animate-spin" />;
  return <CircleDashed size={12} className="text-gray-500" />;
}

function StepLog({ projectId, runId, step }) {
  const [lines, setLines] = useState(null);
  useEffect(() => {
    api
      .getFinalizeStepOutput(projectId, runId, step.step_index)
      .then((d) => setLines(Array.isArray(d?.lines) ? d.lines : []))
      .catch(() => setLines([]));
  }, [projectId, runId, step.step_index]);
  if (lines === null) {
    return <p className="text-[11px] text-gray-500 py-1 pl-6">Loading log…</p>;
  }
  if (lines.length === 0) {
    return <p className="text-[11px] text-gray-600 italic py-1 pl-6">No output captured.</p>;
  }
  return (
    <pre className="text-[11px] font-mono text-gray-400 bg-gray-950/60 rounded-lg p-2 ml-6 max-h-72 overflow-auto">
      {lines.join('\n')}
    </pre>
  );
}

function RunRow({ projectId, run, onRerun = null }) {
  const [expanded, setExpanded] = useState(false);
  const [steps, setSteps] = useState(null);
  const [openStep, setOpenStep] = useState(null);
  const { Icon, cls, label } = statusVisual(run.status);
  const trig = triggerBadge(run.trigger_source);
  const rerunnable =
    typeof onRerun === 'function' &&
    (run.trigger_source === 'git_push' || run.trigger_source === 'pr_push') &&
    run.status !== 'queued' &&
    run.status !== 'running';

  useEffect(() => {
    if (!expanded || steps) return;
    api
      .getCiRunDetail(projectId, run.id)
      .then((d) => setSteps(Array.isArray(d?.steps) ? d.steps : []))
      .catch(() => setSteps([]));
  }, [expanded, steps, projectId, run.id]);

  return (
    <div className="border border-gray-700/60 rounded-lg bg-gray-900/40">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-gray-900/70 transition-colors rounded-lg"
        data-testid={`ci-run-${run.id}`}
      >
        {expanded ? (
          <ChevronDown size={13} className="text-gray-500 flex-shrink-0" />
        ) : (
          <ChevronRight size={13} className="text-gray-500 flex-shrink-0" />
        )}
        <Icon size={15} className={`${cls} flex-shrink-0`} />
        <span className={`text-[10px] px-1.5 py-0.5 rounded border flex-shrink-0 ${trig.cls}`}>
          {trig.label}
        </span>
        <span className="text-sm text-gray-200 truncate">
          {run.branch}
          <code className="text-[11px] text-gray-500 font-mono ml-2">
            {(run.head_sha || '').slice(0, 8)}
          </code>
        </span>
        {run.failure_reason && (
          <span className="text-[11px] text-red-400/80 truncate">{run.failure_reason}</span>
        )}
        <span className="ml-auto flex items-center gap-3 flex-shrink-0 text-xs text-gray-600 tabular-nums">
          <span className={cls.replace(' animate-spin', '')}>{label}</span>
          <span>{durationLabel(run)}</span>
          <span>{relativePrTime(new Date(run.started_at).toISOString())}</span>
          {rerunnable && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onRerun(run);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  onRerun(run);
                }
              }}
              title="Re-run all jobs against this commit"
              data-testid={`ci-run-rerun-${run.id}`}
              className="p-1 rounded text-gray-500 hover:text-gray-200 transition-colors cursor-pointer"
            >
              <RefreshCw size={12} />
            </span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-gray-700/60 px-3 py-2 space-y-1.5">
          {(run.jobs || []).map((job) => (
            <div
              key={`${job.job_id}-${job.matrix_key}`}
              className="flex items-center gap-2 text-xs text-gray-300"
            >
              {jobStateIcon(job.state)}
              <code className="font-mono">{job.job_id}</code>
              {job.matrix_key && job.matrix_key !== 'default' && (
                <span className="text-gray-500">{job.matrix_key}</span>
              )}
              <span className="text-gray-600 ml-auto tabular-nums">
                {job.exit_code !== null && job.exit_code !== 0 ? `exit ${job.exit_code}` : ''}
              </span>
            </div>
          ))}
          {steps === null && (
            <p className="text-[11px] text-gray-500 flex items-center gap-1.5">
              <Loader2 size={11} className="animate-spin" /> Loading steps…
            </p>
          )}
          {steps && steps.length > 0 && (
            <div className="pt-1 space-y-1">
              {steps.map((s) => (
                <div key={s.step_index}>
                  <button
                    type="button"
                    onClick={() => setOpenStep(openStep === s.step_index ? null : s.step_index)}
                    className="w-full flex items-center gap-2 text-[11px] text-gray-400 hover:text-gray-200 transition-colors text-left"
                    data-testid={`ci-run-step-${run.id}-${s.step_index}`}
                  >
                    {jobStateIcon(s.state)}
                    <span className="truncate">{s.name}</span>
                  </button>
                  {openStep === s.step_index && (
                    <StepLog projectId={projectId} runId={run.id} step={s} />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function CiRunsSection({ project, onProjectsChange, showToast }) {
  const [runs, setRuns] = useState(null);
  const [loading, setLoading] = useState(false);
  const [savingToggle, setSavingToggle] = useState(false);
  const pollRef = useRef(null);

  const projectId = project?.id;
  const hosted = project?.gitHost === 'agenthub';
  const ciOnPush = project?.ciOnPush?.enabled === true;

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const d = await api.getCiRuns(projectId, { limit: 30 });
      setRuns(Array.isArray(d?.runs) ? d.runs : []);
    } catch {
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setRuns(null);
    refresh();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  // Poll while any run is still in flight so live runs settle without a
  // manual refresh; stop as soon as everything is terminal.
  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    const hasLive = (runs || []).some((r) => !TERMINAL_STATUSES.has(r.status));
    if (hasLive) {
      pollRef.current = setInterval(refresh, 10_000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [runs, refresh]);

  const toggleCiOnPush = async () => {
    if (!projectId) return;
    setSavingToggle(true);
    try {
      await api.updateProject(projectId, { ciOnPush: { enabled: !ciOnPush } });
      if (onProjectsChange) onProjectsChange();
    } catch (err) {
      if (showToast) showToast(String(err?.message || err || 'Failed to update'), 'error');
    } finally {
      setSavingToggle(false);
    }
  };

  if (!projectId) return null;

  return (
    <div className="bg-gray-800 rounded-xl p-4 space-y-4" data-testid="ci-runs-section">
      {hosted && (
        <div className="flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <span className="text-sm text-gray-200 flex items-center gap-1.5">
              <Zap size={14} className="text-gray-400" />
              CI on push
            </span>
            <p className="text-xs text-gray-500">
              Run <code className="font-mono">.agent-hub/ci.yaml</code> jobs whenever the default
              branch moves (a push or a merged pull request). Results appear below — report-only,
              like GitHub Actions on master.
            </p>
          </div>
          <button
            onClick={toggleCiOnPush}
            disabled={savingToggle}
            data-testid="ci-on-push-toggle"
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 disabled:opacity-50 ${
              ciOnPush ? 'bg-emerald-600' : 'bg-gray-600'
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                ciOnPush ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      )}

      <div className="flex items-center gap-2">
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-1.5">
          <History size={14} className="text-gray-500" />
          Recent runs
        </h4>
        <button
          type="button"
          onClick={refresh}
          className="ml-auto p-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
          title="Refresh"
          data-testid="ci-runs-refresh"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {loading && runs === null && (
        <p className="text-xs text-gray-500 flex items-center gap-1.5 py-2">
          <Loader2 size={12} className="animate-spin" /> Loading runs…
        </p>
      )}
      {runs && runs.length === 0 && (
        <p className="text-xs text-gray-600 italic py-2">
          No runs yet. Finalize a session{hosted ? ' or enable CI on push' : ''} to see history
          here.
        </p>
      )}
      <div className="space-y-1.5">
        {(runs || []).map((run) => (
          <RunRow
            key={run.id}
            projectId={projectId}
            run={run}
            onRerun={async (r) => {
              try {
                await api.rerunCiRun(projectId, r.id);
                if (showToast) showToast('Re-run queued.', 'success', 4000);
                setTimeout(() => refresh(), 1500);
              } catch (err) {
                if (showToast) showToast(String(err?.message || err), 'error', 6000);
              }
            }}
          />
        ))}
      </div>
    </div>
  );
}
