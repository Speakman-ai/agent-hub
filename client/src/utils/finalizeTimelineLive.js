import { parseFinalizeTimelineMetadata } from './finalizeTimeline.js';

/**
 * When a finalize timeline system message lands over WS, nudge
 * `useFinalizeRun` subscribers so button/badge state stays in sync even
 * if an earlier phase/completed event was missed or lacked session_id.
 */
export function notifyFinalizeRunFromTimelineMessage(message) {
  if (message?.role !== 'system' || !message.session_id) return;

  const parsed = parseFinalizeTimelineMetadata(message.metadata);
  if (!parsed) return;

  const runId = parsed.runId ?? parsed.run_id;
  if (!runId) return;

  const base = { run_id: runId, session_id: message.session_id };

  if (parsed.kind === 'finalize_ready_to_push') {
    window.dispatchEvent(
      new CustomEvent('finalize_run_phase_changed', {
        detail: { ...base, phase: null, status: 'ready_to_push' },
      }),
    );
    window.dispatchEvent(
      new CustomEvent('finalize_run_completed', {
        detail: { ...base, status: 'ready_to_push' },
      }),
    );
    return;
  }

  if (parsed.kind === 'finalize_run_terminal') {
    const status = typeof parsed.status === 'string' ? parsed.status : 'failed';
    const failureReason = typeof parsed.failureReason === 'string' ? parsed.failureReason : null;
    window.dispatchEvent(
      new CustomEvent('finalize_run_phase_changed', {
        detail: { ...base, phase: null, status, failure_reason: failureReason },
      }),
    );
    window.dispatchEvent(
      new CustomEvent('finalize_run_completed', {
        detail: { ...base, status, failure_reason: failureReason },
      }),
    );
  }
}
