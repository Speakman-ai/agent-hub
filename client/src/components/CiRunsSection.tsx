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
  Square,
} from 'lucide-react';
import { api } from '../utils/api';
import { relativePrTime } from '../utils/prFormatting';
import { resourceBadgeText, jobResourceKey } from '../utils/formatResources';
import { describeFinalizeFailureReason } from '../utils/finalizeFailureReason';

const TERMINAL_STATUSES = new Set([
  'ready_to_push',
  'pushed',
  'succeeded',
  'failed',
  'timed_out',
  'infra_error',
  'cancelled',
]);

// Job states that mean the job hasn't finished yet. The runner writes states
// as `queued | running | passed | failed | skipped` (job-runner.ts); anything
// not yet settled keeps the run "alive" for stop/poll purposes.
const IN_FLIGHT_JOB_STATES = new Set(['queued', 'running']);

// A run is still doing work if its own status is non-terminal OR any of its
// jobs/shards is still queued/running. The run-level status can flip to a
// terminal `failed` the moment one shard goes red while the rest keep running
// (the runner picks the genuine failure early — see the multi-shard failure
// selection), so we cannot rely on run.status alone to know nothing is live.
export function runHasWorkInFlight(run: any) {
  if (!TERMINAL_STATUSES.has(run?.status)) return true;
  return (run?.jobs || []).some((j: any) => IN_FLIGHT_JOB_STATES.has(j?.state));
}

function triggerBadge(trigger: any) {
  if (trigger === 'git_push')
    return { label: 'push', cls: 'border-sky-500/25 bg-sky-500/10 text-sky-300' };
  if (trigger === 'pr_push')
    return { label: 'pr ci', cls: 'border-amber-500/25 bg-amber-500/10 text-amber-300' };
  if (trigger === 'agent_block')
    return { label: 'auto', cls: 'border-purple-500/25 bg-purple-500/10 text-purple-300' };
  return { label: 'finalize', cls: 'border-gray-600/40 bg-gray-700/30 text-gray-300' };
}

function statusVisual(status: any) {
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

function durationFromTimes(started: any, ended: any) {
  if (!started || !ended) return '';
  const sec = Math.max(0, Math.round((ended - started) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function durationLabel(run: any) {
  return durationFromTimes(run.started_at, run.ended_at);
}

// Step names are often emitted fully-qualified ("unit / default / test").
// Inside a job's block the job + shard are already the header, so strip that
// leading context to leave just the step ("test").
function shortStepName(name: any, job: any) {
  if (!name || !job) return name || '';
  // Try the most-specific prefix first so "job / matrix / step" collapses to
  // "step" (names embed the matrix key even when it's "default").
  const prefixes = [];
  if (job.matrix_key) prefixes.push(`${job.job_id} / ${job.matrix_key} / `);
  prefixes.push(`${job.job_id} / `);
  for (const p of prefixes) {
    if (name.startsWith(p)) return name.slice(p.length);
  }
  return name;
}

// Reassemble the real Run -> Job -> Steps hierarchy. Steps carry job_id +
// matrix_key; we bucket them under their parent job so a matrix run reads as
// "job (shard) -> its steps" instead of one flat repeated step pile. Steps
// whose job_id matches no job row (legacy / null job_id) come back as
// `orphan`; when there's exactly one job we fold them into it.
export function groupStepsByJob(jobs: any, steps: any) {
  const key = (jid: any, mk: any) => `${jid ?? ''}::${mk ?? ''}`;
  const byKey = new Map<string, any[]>();
  for (const s of steps || []) {
    const k = key(s.job_id, s.matrix_key);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(s);
  }
  const used = new Set<string>();
  const groups = (jobs || []).map((job: any) => {
    const k = key(job.job_id, job.matrix_key);
    used.add(k);
    return { job, steps: byKey.get(k) || [] };
  });
  const orphan: any[] = [];
  for (const [k, list] of byKey) {
    if (!used.has(k)) orphan.push(...list);
  }
  // Single-job run with unkeyed steps: attach them to the one job.
  if (orphan.length > 0 && groups.length === 1 && groups[0].steps.length === 0) {
    groups[0].steps = orphan.splice(0, orphan.length);
  }
  return { groups, orphan };
}

// Map a job/step `state` to its status glyph. The runner writes states as
// `queued | running | passed | failed | skipped` (see job-runner.ts /
// step-runner.ts); `success`/`failure`/`timeout` are accepted as legacy
// aliases so older rows still render correctly. A passed step shows a green
// check and a failed one a red X — without this mapping both fell through to
// the gray dashed circle, making finished jobs look like they never ran.
function jobStateIcon(state: any) {
  if (state === 'passed' || state === 'success')
    return <CheckCircle2 size={12} className="text-emerald-400" aria-label="passed" />;
  if (state === 'failed' || state === 'failure' || state === 'timeout')
    return <XCircle size={12} className="text-red-400" aria-label="failed" />;
  if (state === 'running')
    return <Loader2 size={12} className="text-amber-400 animate-spin" aria-label="running" />;
  if (state === 'skipped')
    return <CircleDashed size={12} className="text-gray-500" aria-label="skipped" />;
  return <CircleDashed size={12} className="text-gray-500" aria-label="pending" />;
}

function StepLog({ projectId, runId, step }: any) {
  const [lines, setLines] = useState<any>(null);
  useEffect(() => {
    api
      .getFinalizeStepOutput(projectId, runId, step.step_index)
      .then((d: any) => setLines(Array.isArray(d?.lines) ? d.lines : []))
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

function RunRow({ projectId, run, onRerun = null, onStop = null }: any) {
  const [expanded, setExpanded] = useState(false);
  const [steps, setSteps] = useState<any>(null);
  const [openStep, setOpenStep] = useState<any>(null);
  const [stopping, setStopping] = useState(false);
  // Per-job resource high-water marks (peak mem / CPU), keyed by job+matrix.
  const [resources, setResources] = useState<any>(null);
  const { Icon, cls, label } = statusVisual(run.status);
  const trig = triggerBadge(run.trigger_source);
  // A run is re-runnable only once it has fully settled. Gating on
  // !runHasWorkInFlight(run) (not just run.status) closes the same
  // partial-failure window the stop button addresses: a shard failure flips a
  // push run's status to `failed` while other shards are still queued/running,
  // and exposing rerun then would let a duplicate CI run start before the
  // current one actually stops or settles.
  const rerunnable =
    typeof onRerun === 'function' &&
    (run.trigger_source === 'git_push' || run.trigger_source === 'pr_push') &&
    !runHasWorkInFlight(run);
  // A run is stoppable while it is still doing work — either its own status is
  // non-terminal, or the run-level status already flipped to a terminal value
  // (e.g. `failed` from one red shard) but other jobs are still running. As
  // long as tests are running there must be a way to terminate them.
  const stoppable = typeof onStop === 'function' && runHasWorkInFlight(run);

  useEffect(() => {
    if (!expanded || steps) return;
    api
      .getCiRunDetail(projectId, run.id)
      .then((d: any) => setSteps(Array.isArray(d?.steps) ? d.steps : []))
      .catch(() => setSteps([]));
  }, [expanded, steps, projectId, run.id]);

  // Nest steps under their parent job (Run -> Job -> Steps). Until steps load
  // we still show the job headers from run.jobs so the run isn't blank.
  const { groups, orphan } = groupStepsByJob(run.jobs, steps || []);

  useEffect(() => {
    if (!expanded || resources) return;
    api
      .getFinalizeRunResources(projectId, run.id)
      .then((d: any) => {
        const map: Record<string, any> = {};
        for (const j of d?.jobs || []) map[jobResourceKey(j.job_name, j.matrix_key)] = j;
        setResources(map);
      })
      .catch(() => setResources({}));
  }, [expanded, resources, projectId, run.id]);

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
          {run.session_title ? (
            <>
              <span title={run.branch}>{run.session_title}</span>
              <code className="text-[11px] text-gray-500 font-mono ml-2">
                {(run.head_sha || '').slice(0, 8)}
              </code>
            </>
          ) : (
            <>
              {run.branch}
              <code className="text-[11px] text-gray-500 font-mono ml-2">
                {(run.head_sha || '').slice(0, 8)}
              </code>
            </>
          )}
        </span>
        {run.failure_reason && (
          <span
            className="text-[11px] text-red-400/80 truncate"
            title={describeFinalizeFailureReason(run.failure_reason) || undefined}
          >
            {run.failure_reason}
          </span>
        )}
        <span className="ml-auto flex items-center gap-3 flex-shrink-0 text-xs text-gray-600 tabular-nums">
          <span className={cls.replace(' animate-spin', '')}>{label}</span>
          <span>{durationLabel(run)}</span>
          <span>{relativePrTime(new Date(run.started_at).toISOString())}</span>
          {stoppable && (
            <span
              role="button"
              tabIndex={stopping ? -1 : 0}
              aria-disabled={stopping}
              onClick={(e: any) => {
                e.stopPropagation();
                if (stopping) return;
                setStopping(true);
                Promise.resolve(onStop(run)).finally(() => setStopping(false));
              }}
              onKeyDown={(e: any) => {
                if ((e.key === 'Enter' || e.key === ' ') && !stopping) {
                  e.stopPropagation();
                  setStopping(true);
                  Promise.resolve(onStop(run)).finally(() => setStopping(false));
                }
              }}
              title="Stop all — terminate every job in this run"
              data-testid={`ci-run-stop-${run.id}`}
              className={`p-1 rounded text-gray-500 transition-colors ${
                stopping ? 'opacity-50 cursor-default' : 'hover:text-red-400 cursor-pointer'
              }`}
            >
              {stopping ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Square size={12} className="fill-current" />
              )}
            </span>
          )}
          {rerunnable && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e: any) => {
                e.stopPropagation();
                onRerun(run);
              }}
              onKeyDown={(e: any) => {
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
        <div className="border-t border-gray-700/60 px-3 py-2 space-y-2">
          {groups.length === 0 && steps === null && (
            <p className="text-[11px] text-gray-500 flex items-center gap-1.5">
              <Loader2 size={11} className="animate-spin" /> Loading jobs…
            </p>
          )}
          {groups.map(({ job, steps: jobSteps }: any) => {
            const resBadge = resourceBadgeText(
              resources?.[jobResourceKey(job.job_id, job.matrix_key)],
            );
            const jobDur = durationFromTimes(job.started_at, job.ended_at);
            return (
              <div
                key={`${job.job_id}-${job.matrix_key}`}
                className="rounded-lg border border-gray-800/70 bg-gray-900/30"
              >
                <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-gray-200">
                  {jobStateIcon(job.state)}
                  <code className="font-mono">{job.job_id}</code>
                  {job.matrix_key && job.matrix_key !== 'default' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded border border-gray-700 bg-gray-800/60 text-gray-400">
                      {job.matrix_key}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-2.5 tabular-nums text-gray-500">
                    {resBadge && <span title="Peak host memory · CPU">{resBadge}</span>}
                    {job.exit_code !== null && job.exit_code !== 0 && (
                      <span className="text-red-400/80">exit {job.exit_code}</span>
                    )}
                    {jobDur && <span>{jobDur}</span>}
                  </span>
                </div>
                {jobSteps.length > 0 && (
                  <div className="border-t border-gray-800/70 px-2.5 py-1 space-y-0.5">
                    {jobSteps.map((s: any) => {
                      const stepDur = durationFromTimes(s.started_at, s.ended_at);
                      return (
                        <div key={s.step_index}>
                          <button
                            type="button"
                            onClick={() =>
                              setOpenStep(openStep === s.step_index ? null : s.step_index)
                            }
                            className="w-full flex items-center gap-2 py-0.5 text-[11px] text-gray-400 hover:text-gray-200 transition-colors text-left"
                            data-testid={`ci-run-step-${run.id}-${s.step_index}`}
                          >
                            {jobStateIcon(s.state)}
                            <span className="truncate">{shortStepName(s.name, job)}</span>
                            {stepDur && (
                              <span className="ml-auto tabular-nums text-gray-600">{stepDur}</span>
                            )}
                          </button>
                          {openStep === s.step_index && (
                            <StepLog projectId={projectId} runId={run.id} step={s} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {steps !== null && orphan.length > 0 && (
            <div className="rounded-lg border border-gray-800/70 bg-gray-900/30">
              <div className="px-2.5 py-1.5 text-[11px] text-gray-500">Other steps</div>
              <div className="border-t border-gray-800/70 px-2.5 py-1 space-y-0.5">
                {orphan.map((s: any) => {
                  const stepDur = durationFromTimes(s.started_at, s.ended_at);
                  return (
                    <div key={s.step_index}>
                      <button
                        type="button"
                        onClick={() => setOpenStep(openStep === s.step_index ? null : s.step_index)}
                        className="w-full flex items-center gap-2 py-0.5 text-[11px] text-gray-400 hover:text-gray-200 transition-colors text-left"
                        data-testid={`ci-run-step-${run.id}-${s.step_index}`}
                      >
                        {jobStateIcon(s.state)}
                        <span className="truncate">{s.name}</span>
                        {stepDur && (
                          <span className="ml-auto tabular-nums text-gray-600">{stepDur}</span>
                        )}
                      </button>
                      {openStep === s.step_index && (
                        <StepLog projectId={projectId} runId={run.id} step={s} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {steps !== null && groups.length === 0 && orphan.length === 0 && (
            <p className="text-[11px] text-gray-600 italic">No jobs recorded for this run.</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function CiRunsSection({ project, onProjectsChange, showToast }: any) {
  const [runs, setRuns] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [savingToggle, setSavingToggle] = useState(false);
  const pollRef = useRef<any>(null);

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
    const hasLive = (runs || []).some((r: any) => runHasWorkInFlight(r));
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
    } catch (err: any) {
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
        {(runs || []).map((run: any) => (
          <RunRow
            key={run.id}
            projectId={projectId}
            run={run}
            onRerun={async (r: any) => {
              try {
                await api.rerunCiRun(projectId, r.id);
                if (showToast) showToast('Re-run queued.', 'success', 4000);
                setTimeout(() => refresh(), 1500);
              } catch (err: any) {
                if (showToast) showToast(String(err?.message || err), 'error', 6000);
              }
            }}
            onStop={async (r: any) => {
              try {
                await api.cancelFinalizeRun(projectId, r.id);
                if (showToast) showToast('Stopping all jobs…', 'success', 4000);
                setTimeout(() => refresh(), 1500);
              } catch (err: any) {
                if (showToast) showToast(String(err?.message || err), 'error', 6000);
              }
            }}
          />
        ))}
      </div>
    </div>
  );
}
