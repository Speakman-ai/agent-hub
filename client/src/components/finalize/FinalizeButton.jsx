import { useCallback, useEffect, useRef, useState } from 'react';
import { GitPullRequest, Loader2, X } from 'lucide-react';
import {
  useFinalizeRun,
  isFinalizeBlocked,
  describeRunPhase,
  formatDuration,
} from '../../hooks/useFinalizeRun.js';
import { api } from '../../utils/api.js';

/**
 * Floor for the optimistic-disable timer, in milliseconds. Sized large
 * enough to cover both the usual `finalize_run_phase_changed` WS arrival
 * window and the reused/terminal short-circuit case where the POST
 * returns but the run-row stays idle (so the button would otherwise
 * snap back to enabled in the same tick the click handler resolved).
 */
const OPTIMISTIC_BLOCK_MS = 1500;

/**
 * "Finalize Code Changes" call-to-action — replaces the legacy
 * `<ChangesReadyBox />` ship affordance. Subscribes to the active
 * Finalize run for the bound session via {@link useFinalizeRun} and
 * exposes a single button that toggles between three observable states:
 *
 *   idle      → "Finalize Code Changes" (GitPullRequest icon)
 *   in-flight → "Finalize: {phase}" + spinner + inline ✕ cancel
 *   terminal  → enabled "Finalize Code Changes" again
 *
 * Visual identity mirrors the prior ChangesReadyBox button so the swap
 * is continuous to the eye (purple border, purple text). The component
 * is also rendered on kanban card rows with `variant="compact"`, which
 * tightens padding and drops the tooltip wrapper so the badge slots
 * neatly into a one-row card footer.
 *
 * Cancellation is UI-only in v0 — the server's `runFinalize`
 * orchestrator polls its in-process `CancelSignal` at await boundaries,
 * so the click flips the DB row to `cancelled` and broadcasts the
 * phase-change WS event but does not interrupt an already-running
 * subprocess. See contract §12 / `finalize-code-changes-architecture-v0`.
 *
 * Optimistic disable: after a successful POST we hold the button
 * disabled for {@link OPTIMISTIC_BLOCK_MS} as a floor so the user sees
 * an immediate response even if the `finalize_run_phase_changed`
 * WebSocket event takes a beat to land. The hook's real `status` takes
 * over as soon as it arrives. The floor is also what covers the
 * reused/terminal short-circuit case where the POST returns but the
 * hook stays idle — without it, the button would visibly snap back to
 * enabled in the same tick.
 */
export default function FinalizeButton({
  projectId,
  cardId,
  sessionId = null,
  prefetchedRun,
  branchLabel = '',
  onError,
  variant = 'default',
}) {
  const { run, status, phase, activeSeconds } = useFinalizeRun({
    sessionId,
    prefetchedRun,
    enabled: !!sessionId,
  });

  // Brief optimistic disable so the click feels responsive — the WS
  // event that flips `status` into a blocked state usually arrives
  // within a few hundred ms but we don't want a "click does nothing"
  // gap. The floor (OPTIMISTIC_BLOCK_MS) is sized to cover both the
  // usual WS-arrival window AND the reused/terminal short-circuit case
  // where the POST returns but the hook never transitions.
  const [optimisticBlock, setOptimisticBlock] = useState(false);
  const optimisticTimerRef = useRef(null);
  useEffect(
    () => () => {
      if (optimisticTimerRef.current) clearTimeout(optimisticTimerRef.current);
    },
    [],
  );

  const blocked = isFinalizeBlocked(status) || optimisticBlock;
  const runId = run?.id ?? null;

  const handleStart = useCallback(async () => {
    if (blocked) return;
    if (!projectId || !cardId) return;
    setOptimisticBlock(true);
    if (optimisticTimerRef.current) clearTimeout(optimisticTimerRef.current);
    // Hold the optimistic disable for `OPTIMISTIC_BLOCK_MS` as a floor —
    // the WS event typically arrives in a few hundred ms, but the floor
    // avoids a flicker when the POST returns reused/terminal and the
    // hook stays idle.
    optimisticTimerRef.current = setTimeout(() => {
      setOptimisticBlock(false);
    }, OPTIMISTIC_BLOCK_MS);
    try {
      await api.startFinalizeRun(projectId, cardId);
    } catch (err) {
      // Failed to start — let the user retry; clear the optimistic
      // block immediately so the button re-enables.
      if (optimisticTimerRef.current) {
        clearTimeout(optimisticTimerRef.current);
        optimisticTimerRef.current = null;
      }
      setOptimisticBlock(false);
      const message = err?.message || 'Failed to start Finalize Code Changes';
      onError?.(message);
    }
  }, [blocked, projectId, cardId, onError]);

  const handleCancel = useCallback(async () => {
    if (!projectId || !runId) return;
    try {
      await api.cancelFinalizeRun(projectId, runId);
    } catch (err) {
      const message = err?.message || 'Failed to cancel Finalize Code Changes';
      onError?.(message);
    }
  }, [projectId, runId, onError]);

  const compact = variant === 'compact';
  const phaseLabel = blocked
    ? optimisticBlock && !isFinalizeBlocked(status)
      ? 'queued'
      : describeRunPhase(status, phase)
    : null;

  const label = blocked ? `Finalizing: ${phaseLabel}` : 'Finalize Code Changes';
  const baseBtnClasses = compact
    ? 'inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md border border-purple-700/60 bg-purple-950/40 transition-colors'
    : 'inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-purple-700/60 bg-purple-950/40 transition-colors';
  const stateClasses = blocked
    ? 'text-purple-200/80 cursor-wait opacity-90'
    : 'text-purple-100 hover:bg-purple-900/50 hover:text-white';

  const tooltipParts = [];
  if (blocked) {
    tooltipParts.push(`Finalizing: ${phaseLabel}`);
    if (typeof activeSeconds === 'number') {
      tooltipParts.push(`${formatDuration(activeSeconds)} active`);
    }
  } else {
    tooltipParts.push('Finalize Code Changes');
    if (branchLabel) tooltipParts.push(branchLabel);
  }
  const titleText = tooltipParts.join(' · ');

  return (
    <div className="relative inline-flex items-center gap-1">
      <button
        type="button"
        onClick={handleStart}
        disabled={blocked}
        title={compact ? undefined : titleText}
        aria-label={label}
        aria-busy={blocked}
        data-testid="finalize-code-changes-button"
        className={`${baseBtnClasses} ${stateClasses}`}
      >
        {blocked ? (
          <Loader2 size={compact ? 12 : 14} className="animate-spin shrink-0" />
        ) : (
          <GitPullRequest size={compact ? 12 : 14} />
        )}
        {label}
      </button>
      {blocked && runId ? (
        <button
          type="button"
          onClick={handleCancel}
          className="text-[11px] text-gray-400 hover:text-gray-200 px-1"
          title="Cancel"
          aria-label="Cancel"
          data-testid="finalize-code-changes-cancel"
        >
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}
