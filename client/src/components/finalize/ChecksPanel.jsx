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
import { useFinalizeRun, describeRunPhase, formatDuration } from '../../hooks/useFinalizeRun.js';
import ReviewerThreadsPanel from './ReviewerThreadsPanel.jsx';

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
export default function ChecksPanel({ sessionId, onJumpToSession }) {
  const { run, steps, phase, status, isPaused, isTerminal, activeSeconds, wallSeconds } =
    useFinalizeRun({ sessionId });

  if (!run) {
    // We already resolved "there is no run for this session" via the
    // hook above. Hand that down to the sidecar so it doesn't repeat
    // the same `getLatestFinalizeRunForSession` call (PR #1169 reviewer
    // feedback NB1). The sidecar will render nothing in this case but
    // will still attach to `reviewer_thread_added` events for any later
    // run that lands on this session.
    return <ReviewerThreadsPanel sessionId={sessionId} prefetchedRun={null} />;
  }

  return (
    <section
      data-testid="finalize-checks-panel"
      data-run-id={run.id}
      data-status={status || undefined}
      data-phase={phase || undefined}
      data-paused={isPaused ? 'true' : undefined}
      className="border-t border-slate-700 bg-slate-900/60"
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
      <StepsList runId={run.id} sessionId={run.session_id} steps={steps} />
      {/*
        Pass the resolved run down so the sidecar reuses our latest-run
        lookup instead of firing a second identical GET on every session-
        view open (PR #1169 reviewer feedback NB1). The sidecar still
        fetches `reviewer-threads` for the run id; only the latest-run
        discovery is shared.
      */}
      <ReviewerThreadsPanel sessionId={sessionId} prefetchedRun={run} />
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
}) {
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
        the clock that fires the 60-minute cap; wall is the human-elapsed
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
          title="Active seconds consumed — counts only time the orchestrator is actively working. The 60-minute cap fires off this number, not wall-clock."
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

function StepsList({ runId, sessionId, steps }) {
  if (steps.length === 0) {
    return (
      <div className="px-4 pb-3 text-xs text-slate-500" data-testid="finalize-steps-empty">
        No steps reported yet.
      </div>
    );
  }
  return (
    <ol
      data-testid="finalize-steps-list"
      className="border-t border-slate-700/60 divide-y divide-slate-700/60"
    >
      {steps.map((s) => (
        <StepRow key={s.index} step={s} runId={runId} sessionId={sessionId} />
      ))}
    </ol>
  );
}

function StepRow({ step, runId, sessionId }) {
  const duration = computeStepDuration(step);
  const tone = stepToneFor(step.state);
  const Icon = stepIconFor(step.state);
  const onJump = () => {
    // The session message holding this step's output tail lives inside
    // the chat log; surface a CustomEvent so SessionTail (or any other
    // listener) can scroll to the matching `metadata.kind ===
    // 'finalize_step_output'` row. The event is fire-and-forget — even
    // when nothing's wired the click still produces a usable hash that
    // the operator can copy.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('finalize:jump-to-step-output', {
          detail: {
            run_id: runId,
            session_id: sessionId,
            step_index: step.index,
            step_name: step.name,
          },
        }),
      );
      try {
        // Best-effort native scroll for the (already-implemented) data
        // attribute on step-output messages. Failing silently when the
        // target isn't on screen yet is fine — the WS event will paint
        // it shortly.
        const target = document.querySelector(
          `[data-finalize-step-output="${runId}-${step.index}"]`,
        );
        if (target?.scrollIntoView) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } catch {
        /* defensive */
      }
    }
  };
  const deepLinkHash = `#finalize-step-${runId}-${step.index}`;
  return (
    <li
      data-testid="finalize-step-row"
      data-step-index={step.index}
      data-step-state={step.state}
      className="flex items-center gap-2 px-4 py-1.5 text-xs hover:bg-slate-800/40"
    >
      <span className={`inline-flex h-5 w-5 items-center justify-center rounded ${tone}`}>
        <Icon size={12} className={step.state === 'running' ? 'animate-spin' : ''} />
      </span>
      <span className="font-mono text-slate-200">{step.name}</span>
      <span className="text-slate-500">{labelForState(step.state)}</span>
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
        <a
          href={deepLinkHash}
          onClick={(e) => {
            e.preventDefault();
            onJump();
            // Update the URL hash so the user can copy the deep link.
            try {
              if (window.history?.replaceState) {
                window.history.replaceState(null, '', deepLinkHash);
              }
            } catch {
              /* ignore */
            }
          }}
          className="text-slate-500 hover:text-slate-200 inline-flex items-center gap-1"
          data-testid="finalize-step-jump"
          title="Jump to this step's output in the session log"
        >
          view output
          <ChevronRight size={10} />
        </a>
      </span>
    </li>
  );
}

function computeStepDuration(step) {
  if (step.startedAt == null) return null;
  const end = step.endedAt ?? (step.state === 'running' ? Date.now() : null);
  if (end == null) return null;
  return Math.max(0, Math.floor((end - step.startedAt) / 1000));
}

function labelForState(state) {
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

function stepIconFor(state) {
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

function stepToneFor(state) {
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
function describeTriggerSource(source) {
  switch (source) {
    case 'ui_button':
      return 'UI button';
    case 'agent_block':
      return 'agent block';
    default:
      return source ? String(source).replace(/_/g, ' ') : 'unknown';
  }
}

function headerToneFor(status, isPaused) {
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

function headerIconFor(status, isPaused) {
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
