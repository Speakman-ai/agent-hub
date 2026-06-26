import {
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  PauseCircle,
  AlertTriangle,
  ChevronRight,
  GitMerge,
  ExternalLink,
} from 'lucide-react';
import { useState } from 'react';
import { useFinalizeRun, describeRunPhase, formatDuration } from '../../hooks/useFinalizeRun';
import ReviewerThreadsPanel from './ReviewerThreadsPanel';
import FinalizeStepLogModal from './FinalizeStepLogModal';
import FinalizeResourceUsage from './FinalizeResourceUsage';

/**
 * GitHub-Actions-style checks panel for a Finalize Code Changes run.
 *
 * Mounted in the session view next to the existing reviewer-threads
 * sidecar. Bound to a single session — the hook resolves the current
 * (latest) run for that session and live-updates from the WebSocket
 * bridge in `App.jsx`.
 *
 * Layout:
 *
 *   ┌─ header ─────────────────────────────────────────────┐
 *   │ ● phase pill   status   active 4m · wall 6m          │
 *   │ trigger: ui_button · started from: <session link>    │
 *   └──────────────────────────────────────────────────────┘
 *   ┌─ steps ──────────────────────────────────────────────┐
 *   │ ▣ lint                 passed   12s     exit 0   →   │
 *   │ ▶ test                 running  …                    │
 *   │ □ build                queued                        │
 *   └──────────────────────────────────────────────────────┘
 *   ┌─ reviewer panel (read-only, diff-anchored) ─────────┐
 *   │ … grouped per-file findings + verdict pill           │
 *   └──────────────────────────────────────────────────────┘
 *
 * Renders nothing when the session has no Finalize run yet — same rule
 * as <ReviewerThreadsPanel /> so the chat view stays clean for every
 * session that has never been finalized.
 */
export default function ChecksPanel({
  sessionId,
  projectId,
  onJumpToSession,
  variant = 'standalone',
}: any) {
  const { run, steps, phase, status, isPaused, isTerminal, activeSeconds, wallSeconds } =
    useFinalizeRun({ sessionId });
  const [logStep, setLogStep] = useState<any>(null);

  if (!run) {
    if (variant === 'embedded') return null;
    return <ReviewerThreadsPanel sessionId={sessionId} prefetchedRun={null} />;
  }

  const sectionClass =
    variant === 'embedded'
      ? 'rounded-lg border border-gray-800/80 bg-gray-900/40 text-xs min-w-[14rem] shrink-0'
      : 'border-t border-slate-700 bg-slate-900/60';

  return (
    <section
      data-testid="finalize-checks-panel"
      data-variant={variant}
      data-run-id={run.id}
      data-status={status || undefined}
      data-phase={phase || undefined}
      data-paused={isPaused ? 'true' : undefined}
      className={sectionClass}
    >
      <RunHeader
        run={run}
        status={status}
        phase={phase}
        isPaused={isPaused}
        isTerminal={isTerminal}
        activeSeconds={activeSeconds}
        wallSeconds={wallSeconds}
        onJumpToSession={onJumpToSession}
      />
      <StepsList
        runId={run.id}
        projectId={projectId ?? run.project_id}
        steps={steps}
        run={run}
        isTerminal={isTerminal}
        phase={phase}
        onOpenLog={setLogStep}
      />
      <FinalizeResourceUsage projectId={projectId ?? run.project_id} runId={run.id} />
      <ReviewerThreadsPanel sessionId={sessionId} prefetchedRun={run} />
      <FinalizeStepLogModal
        open={Boolean(logStep)}
        projectId={projectId ?? run.project_id}
        runId={run.id}
        stepIndex={logStep?.index}
        stepName={logStep?.name}
        stepState={logStep?.state}
        onClose={() => setLogStep(null)}
      />
    </section>
  );
}

function RunHeader({
  run,
  status,
  phase,
  isPaused,
  isTerminal,
  activeSeconds,
  wallSeconds,
  onJumpToSession,
}: any) {
  const label = describeRunPhase(status, phase);
  const tone = headerToneFor(status, isPaused);
  const Icon = headerIconFor(status, isPaused);
  // Map the two known trigger sources to a friendly label; pass anything
  // else through verbatim so a future / unknown source is visible rather
  // than silently mislabelled as "UI button" (PR #1169 review NB4).
  const trigger = describeTriggerSource(run.trigger_source);
  return (
    <header className="flex flex-col gap-1 px-4 py-2 text-sm">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          data-testid="finalize-run-phase-pill"
          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${tone}`}
        >
          <Icon size={12} className={status === 'rebasing' ? 'animate-spin' : ''} />
          {label}
        </span>

        {isPaused ? (
          <span
            data-testid="finalize-run-pause-indicator"
            className="inline-flex items-center gap-1 rounded bg-amber-900/40 px-1.5 py-0.5 text-[11px] font-medium text-amber-300"
            title="Run is paused — waiting on the originating session to end its current turn before continuing."
          >
            <PauseCircle size={12} />
            paused — waiting on session
          </span>
        ) : null}

        {isTerminal && run.failure_reason ? (
          <span
            data-testid="finalize-run-failure-code"
            className="inline-flex items-center gap-1 rounded bg-red-900/40 px-1.5 py-0.5 text-[10px] font-mono text-red-300"
          >
            {run.failure_reason}
          </span>
        ) : null}

        {run.pr_url ? (
          <a
            href={run.pr_url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200"
            data-testid="finalize-run-pr-link"
          >
            <ExternalLink size={12} /> PR
          </a>
        ) : null}
      </div>

      {/*
        Active vs. wall — both visible and distinctly labelled. Active is
        the clock that fires the 4-hour cap; wall is the human-elapsed
        time. Splitting them is the acceptance criterion that lets the
        user see a paused run sitting (wall ticking, active flat) without
        opening any drawer.
      */}
      <div
        className="flex items-center gap-3 text-xs text-slate-400"
        data-testid="finalize-run-clocks"
      >
        <span
          className="inline-flex items-center gap-1"
          data-testid="finalize-run-active"
          title="Active seconds consumed — counts only time the orchestrator is actively working. The 4-hour cap fires off this number, not wall-clock."
        >
          <Clock size={12} className="text-slate-500" />
          <span className="text-slate-500">active</span>
          <span className="font-mono text-slate-200">{formatDuration(activeSeconds ?? 0)}</span>
        </span>
        <span
          className="inline-flex items-center gap-1"
          data-testid="finalize-run-wall"
          title="Wall-clock elapsed since the run started. Includes time spent waiting on humans / sessions; not capped."
        >
          <Clock size={12} className="text-slate-500" />
          <span className="text-slate-500">wall</span>
          <span className="font-mono text-slate-200">{formatDuration(wallSeconds ?? 0)}</span>
        </span>
        <span className="text-slate-500" data-testid="finalize-run-trigger">
          trigger: <span className="text-slate-300">{trigger}</span>
        </span>
        {run.session_id ? (
          <button
            type="button"
            onClick={() => onJumpToSession?.(run.session_id)}
            className="inline-flex items-center gap-1 text-slate-400 hover:text-slate-200"
            data-testid="finalize-run-origin-session"
            title="Open the originating session"
          >
            <GitMerge size={12} />
            origin session
            <ChevronRight size={10} />
          </button>
        ) : null}
      </div>
    </header>
  );
}

function StepsList({ runId, projectId, steps, run, isTerminal, phase, onOpenLog }: any) {
  if (steps.length === 0) {
    const hint = describeEmptySteps(run, isTerminal, phase);
    return (
      <div className="px-4 pb-3 text-xs text-slate-500" data-testid="finalize-steps-empty">
        {hint}
      </div>
    );
  }
  return (
    <div className="border-t border-slate-700/60">
      <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wide text-slate-500">
        Checks
      </div>
      <ol data-testid="finalize-steps-list" className="divide-y divide-slate-700/60">
        {steps.map((s: any, index: number) => (
          <StepRow
            key={s.index}
            step={s}
            dependencyName={dependencyNameForQueuedStep(s, steps, index)}
            runId={runId}
            projectId={projectId}
            onOpenLog={onOpenLog}
          />
        ))}
      </ol>
    </div>
  );
}

function StepRow({ step, dependencyName, runId, projectId, onOpenLog }: any) {
  const duration = computeStepDuration(step);
  const tone = stepToneFor(step.state);
  const Icon = stepIconFor(step.state);
  const canOpenLog = Boolean(projectId && runId);
  const openLog = () => {
    if (!canOpenLog) return;
    onOpenLog?.({ index: step.index, name: step.name, state: step.state });
  };
  const isFailed = step.state === 'failed';
  return (
    <li
      data-testid="finalize-step-row"
      data-step-index={step.index}
      data-step-state={step.state}
      className={`flex items-center gap-2 px-4 py-1.5 text-xs ${
        canOpenLog ? 'cursor-pointer hover:bg-slate-800/40' : ''
      } ${isFailed ? 'bg-red-950/20' : ''}`}
      onClick={canOpenLog ? openLog : undefined}
      onKeyDown={
        canOpenLog
          ? (e: any) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openLog();
              }
            }
          : undefined
      }
      role={canOpenLog ? 'button' : undefined}
      tabIndex={canOpenLog ? 0 : undefined}
    >
      <span className={`inline-flex h-5 w-5 items-center justify-center rounded ${tone}`}>
        <Icon size={12} className={step.state === 'running' ? 'animate-spin' : ''} />
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="truncate font-mono text-slate-200">{step.name}</span>
        <span className="shrink-0 text-slate-500">{labelForState(step.state)}</span>
        {dependencyName ? (
          <span
            className="min-w-0 truncate text-slate-500"
            data-testid="finalize-step-dependency"
            title={`Depends on ${dependencyName}`}
          >
            (depends on {dependencyName})
          </span>
        ) : null}
      </span>
      <span className="ml-auto flex items-center gap-3">
        {duration != null ? (
          <span className="font-mono text-slate-400" data-testid="finalize-step-duration">
            {formatDuration(duration)}
          </span>
        ) : null}
        {step.exitCode != null ? (
          <span
            className="font-mono text-slate-500"
            data-testid="finalize-step-exit-code"
            title="Exit code"
          >
            exit {step.exitCode}
          </span>
        ) : null}
        {canOpenLog ? (
          <button
            type="button"
            onClick={(e: any) => {
              e.stopPropagation();
              openLog();
            }}
            className={`inline-flex items-center gap-1 ${
              isFailed ? 'text-red-300 hover:text-red-100' : 'text-slate-500 hover:text-slate-200'
            }`}
            data-testid="finalize-step-jump"
            title="View step logs"
          >
            view logs
            <ChevronRight size={10} />
          </button>
        ) : null}
      </span>
    </li>
  );
}

const TERMINAL_STEP_STATES = new Set(['passed', 'failed', 'skipped']);

function dependencyNameForQueuedStep(step: any, steps: any[], index: number) {
  if (step.state !== 'queued') return null;
  const previous = findPreviousSameJobStep(step, steps, index);
  if (!previous || TERMINAL_STEP_STATES.has(previous.state)) return null;
  return compactStepName(previous.name);
}

function findPreviousSameJobStep(step: any, steps: any[], index: number) {
  if (!step.jobId) return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = steps[i];
    if (candidate?.jobId === step.jobId && (candidate.matrixKey ?? '') === (step.matrixKey ?? '')) {
      return candidate;
    }
  }
  return null;
}

function compactStepName(name: any) {
  if (typeof name !== 'string') return '';
  const parts = name
    .split(' / ')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.at(-1) || name;
}

function computeStepDuration(step: any) {
  if (step.startedAt == null) return null;
  const end = step.endedAt ?? (step.state === 'running' ? Date.now() : null);
  if (end == null) return null;
  return Math.max(0, Math.floor((end - step.startedAt) / 1000));
}

function labelForState(state: any) {
  switch (state) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return state;
  }
}

function stepIconFor(state: any) {
  switch (state) {
    case 'passed':
      return CheckCircle2;
    case 'failed':
      return XCircle;
    case 'running':
      return Loader2;
    case 'skipped':
      return ChevronRight;
    case 'queued':
    default:
      return Clock;
  }
}

function stepToneFor(state: any) {
  switch (state) {
    case 'passed':
      return 'bg-emerald-900/40 text-emerald-300';
    case 'failed':
      return 'bg-red-900/40 text-red-300';
    case 'running':
      return 'bg-indigo-900/40 text-indigo-300';
    case 'skipped':
      return 'bg-slate-700/60 text-slate-400';
    case 'queued':
    default:
      return 'bg-slate-700/60 text-slate-400';
  }
}

/**
 * Render `finalize_runs.trigger_source` as a short label. The two known
 * values in v0 are `ui_button` and `agent_block`; anything else (a
 * future source the server learns about ahead of the client) renders
 * verbatim with underscores swapped for spaces so the user still sees
 * the real value instead of "UI button" by accident (PR #1169 NB4).
 */
function describeTriggerSource(source: any) {
  switch (source) {
    case 'ui_button':
      return 'UI button';
    case 'agent_block':
      return 'agent block';
    default:
      return source ? String(source).replace(/_/g, ' ') : 'unknown';
  }
}

function describeEmptySteps(run: any, isTerminal: any, phase: any) {
  if (!isTerminal) return 'No steps reported yet.';
  if (run?.failure_reason === 'review_failed' && (phase === 'review' || run?.phase === 'review')) {
    return 'Review failed before CI steps ran — the reviewer message may be missing a parseable verdict block. Check the reviewer turn in chat (expected <agenthub:review-verdict> or trailing {"verdict":...} JSON).';
  }
  if (run?.failure_reason) {
    return `Run ended with ${run.failure_reason} before any CI steps completed.`;
  }
  return 'No steps reported yet.';
}

function headerToneFor(status: any, isPaused: any) {
  if (isPaused) return 'bg-amber-900/40 text-amber-300';
  switch (status) {
    case 'pushed':
      return 'bg-emerald-900/40 text-emerald-300';
    case 'failed':
    case 'timed_out':
    case 'infra_error':
    case 'cancelled':
      return 'bg-red-900/40 text-red-300';
    case 'stalled_no_response':
      return 'bg-amber-900/40 text-amber-300';
    case 'rebasing':
    case 'reviewing':
    case 'running':
    case 'pushing':
      return 'bg-indigo-900/40 text-indigo-300';
    default:
      return 'bg-slate-700/60 text-slate-300';
  }
}

function headerIconFor(status: any, isPaused: any) {
  if (isPaused) return PauseCircle;
  switch (status) {
    case 'pushed':
      return CheckCircle2;
    case 'failed':
    case 'timed_out':
    case 'infra_error':
    case 'cancelled':
      return XCircle;
    case 'stalled_no_response':
      return AlertTriangle;
    case 'rebasing':
    case 'reviewing':
    case 'running':
    case 'pushing':
    case 'queued':
      return Loader2;
    default:
      return GitMerge;
  }
}
