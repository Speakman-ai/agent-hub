import { describe, expect, it, vi } from 'vitest';
import {
  lockSessionAfterFinalizePush,
  sessionAllowsRepeatFinalizePush,
  sessionIsLockedAfterFinalizePush,
} from './post-push-session-lock.js';

describe('post-push session lock', () => {
  it('lets Autopilot sessions push again', () => {
    expect(sessionAllowsRepeatFinalizePush({ session_mode: 'autopilot' })).toBe(true);
    expect(sessionAllowsRepeatFinalizePush({ session_mode: 'chat' })).toBe(false);
  });

  it('does not lock Autopilot after a successful Finalize push', () => {
    const stmts = {
      getPushedFinalizeRunForSession: {
        get: vi.fn(() => ({ status: 'pushed' })),
      },
      updateSessionAskMode: { run: vi.fn() },
      updateSessionFinalizeAutomation: { run: vi.fn() },
    };
    expect(sessionIsLockedAfterFinalizePush(stmts, { id: 's1', session_mode: 'autopilot' })).toBe(
      false,
    );
    lockSessionAfterFinalizePush(stmts, 's1', { session_mode: 'autopilot' });
    expect(stmts.updateSessionAskMode.run).not.toHaveBeenCalled();
    expect(stmts.updateSessionFinalizeAutomation.run).not.toHaveBeenCalled();
  });

  it('still locks a normal chat session after push', () => {
    const stmts = {
      getPushedFinalizeRunForSession: {
        get: vi.fn(() => ({ status: 'pushed' })),
      },
      updateSessionAskMode: { run: vi.fn() },
      updateSessionFinalizeAutomation: { run: vi.fn() },
    };
    expect(sessionIsLockedAfterFinalizePush(stmts, { id: 's1', session_mode: 'chat' })).toBe(true);
    lockSessionAfterFinalizePush(stmts, 's1', { session_mode: 'chat' });
    expect(stmts.updateSessionAskMode.run).toHaveBeenCalledWith(1, 's1');
    expect(stmts.updateSessionFinalizeAutomation.run).toHaveBeenCalledWith('manual', 's1');
  });
});
