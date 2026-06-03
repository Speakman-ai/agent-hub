import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notifyFinalizeRunFromTimelineMessage } from './finalizeTimelineLive.js';

describe('notifyFinalizeRunFromTimelineMessage', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      dispatchEvent: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('dispatches phase + completed events for ready_to_push timeline messages', () => {
    notifyFinalizeRunFromTimelineMessage({
      role: 'system',
      session_id: 'sess-1',
      metadata: JSON.stringify({
        kind: 'finalize_ready_to_push',
        runId: 'run-1',
        round: 1,
      }),
    });

    expect(window.dispatchEvent).toHaveBeenCalledTimes(2);
    const phaseEvent = window.dispatchEvent.mock.calls[0][0];
    expect(phaseEvent.type).toBe('finalize_run_phase_changed');
    expect(phaseEvent.detail).toEqual({
      run_id: 'run-1',
      session_id: 'sess-1',
      phase: null,
      status: 'ready_to_push',
    });
    const completedEvent = window.dispatchEvent.mock.calls[1][0];
    expect(completedEvent.type).toBe('finalize_run_completed');
    expect(completedEvent.detail.status).toBe('ready_to_push');
  });

  it('ignores non-finalize system messages', () => {
    notifyFinalizeRunFromTimelineMessage({
      role: 'system',
      session_id: 'sess-1',
      metadata: JSON.stringify({ kind: 'pr_created' }),
    });
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });
});
