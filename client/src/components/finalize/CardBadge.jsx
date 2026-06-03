import { GitMerge, Loader2, Check, XCircle, PauseCircle, AlertTriangle } from 'lucide-react';
import {
  useFinalizeRun,
  describeRunPhase,
  formatDuration,
  isFinalizeBlocked,
} from '../../hooks/useFinalizeRun.js';

/**
 * Compact Finalize-run status badge for a kanban card row.
 *
 * Renders nothing when the card has no `sessionId`, or the session has
 * never triggered a Finalize run — boards with hundreds of cards stay
 * clean.
 *
 * **No per-card REST fan-out.** The kanban view calls
 * `api.getLatestFinalizeRunsForSessions(projectId, [sessionIds])` ONCE
 * after `getBoard` and passes the per-session result down here as
 * `prefetchedRun` (the row, or `null` when the session has no run).
 * {@link useFinalizeRun} treats a defined `prefetchedRun` as the
 * authoritative starting state and skips its initial REST call entirely,
 * so the badge does NOT fan out one GET per session-linked card. Live
 * updates still arrive through the WebSocket bridge in `App.jsx`.
 *
 * Pass `prefetchedRun={undefined}` (the default) to fall back to the
 * self-fetch path — used by surfaces that don't have a batch loader,
 * e.g. preview / debug pages.
 *
 * **Active vs wall.** Active time is the primary number ("4m active")
 * and wall-clock elapsed sits in the tooltip — the user needs to be
 * able to eyeball "is this progressing?" without opening the card. For
 * paused runs (status = `dispatching` / `stalled_no_response`) the
 * pause icon makes the lack of active ticking visually distinct from a
 * stuck run. Until the server-side `finalize_run_active_seconds` emitter
 * lands (see `useFinalizeRun.js` design notes), the active number only
 * advances on phase-change refetches; wall ticks every second. That's
 * intentional fail-soft for v0 — the wall counter is the live indicator,
 * the active number is the budget consumed.
 *
 * The hook also exposes `isFinalizeBlocked(status)` so the caller's
 * "Finalize" button can be disabled while the run is in flight — see
 * the test file for the canonical check.
 */
export default function CardBadge({ sessionId, prefetchedRun }) {
  const { run, status, phase, isPaused, isTerminal, activeSeconds, wallSeconds } = useFinalizeRun({
    sessionId,
    prefetchedRun,
    // When the badge has no sessionId, the hook is a no-op anyway, but
    // we still set `enabled: false` so the very first render doesn't
    // queue a fetch for a non-session in the rare race where sessionId
    // changes from `null` to a real id mid-mount.
    enabled: !!sessionId,
  });

  // Hide the badge when there's no run, or when the run is so old it's
  // effectively just history (we only suppress for `cancelled` to avoid
  // a stale ghost; other terminal states are interesting at-a-glance).
  if (!run || status === 'cancelled') return null;

  // A single-phase run ("Run Tests" / "Reviewer") parks at `ready_to_push`
  // internally, but the branch isn't actually ready to push until BOTH gates
  // pass. Surface the phase that passed instead of the misleading "ready to
  // push" so the board doesn't over-promise on a partial validation.
  const label =
    status === 'ready_to_push' && run.mode && run.mode !== 'full'
      ? run.mode === 'checks'
        ? 'checks passed'
        : 'review approved'
      : describeRunPhase(status, phase);
  const Icon = pickIcon(status, isPaused);
  const tone = pickTone(status, isPaused);

  // Primary metric is active time. Wall-clock is the tooltip secondary.
  const activeLabel = formatDuration(activeSeconds ?? 0);
  const wallLabel = formatDuration(wallSeconds ?? 0);
  const tooltip = isTerminal
    ? `Runner ${label} · active ${activeLabel} · wall ${wallLabel}`
    : `Runner ${label} · active ${activeLabel} · wall ${wallLabel} (still running)`;

  return (
    <span
      data-testid="finalize-card-badge"
      data-run-id={run.id}
      data-status={status || undefined}
      data-phase={phase || undefined}
      data-paused={isPaused ? 'true' : undefined}
      data-active-seconds={activeSeconds ?? undefined}
      data-wall-seconds={wallSeconds ?? undefined}
      data-finalize-blocked={isFinalizeBlocked(status) ? 'true' : undefined}
      title={tooltip}
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${tone}`}
    >
      <Icon size={10} className={status === 'rebasing' ? 'animate-spin' : ''} />
      <span data-testid="finalize-card-badge-label">{label}</span>
      <span className="opacity-80" data-testid="finalize-card-badge-active">
        · {activeLabel} active
      </span>
    </span>
  );
}

function pickIcon(status, isPaused) {
  if (isPaused) return PauseCircle;
  switch (status) {
    case 'pushed':
      return Check;
    case 'failed':
    case 'timed_out':
    case 'infra_error':
      return XCircle;
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

function pickTone(status, isPaused) {
  if (isPaused) return 'bg-amber-900/40 text-amber-300';
  switch (status) {
    case 'pushed':
      return 'bg-emerald-900/40 text-emerald-300';
    case 'failed':
    case 'timed_out':
    case 'infra_error':
      return 'bg-red-900/40 text-red-300';
    case 'cancelled':
      return 'bg-slate-700/60 text-slate-300';
    case 'stalled_no_response':
      return 'bg-amber-900/40 text-amber-300';
    case 'queued':
      return 'bg-slate-700/60 text-slate-300';
    case 'rebasing':
    case 'reviewing':
    case 'running':
    case 'pushing':
      return 'bg-indigo-900/40 text-indigo-300';
    default:
      return 'bg-slate-700/60 text-slate-300';
  }
}

// Re-export helpers so callers can mirror the disabled-button rule without
// pulling the hook directly.
export { isFinalizeBlocked };
