/**
 * Tests for `server/finalize/budget.ts` — the §13 active-time budget
 * accounting module.
 *
 * Coverage:
 *   - `resolveBudgetSeconds`: ci.yaml lowers the cap; never raises;
 *     hard-ceiling clamp; nullish / invalid inputs default safely.
 *   - `billActiveSeconds`: DB write + broadcast; sub-second flooring;
 *     swallow on failure.
 *   - `broadcastActiveSeconds`: emits the running total.
 *   - `getRunFamilyActiveSeconds` / `isBudgetExhausted`: includes the
 *     retry parent's consumed seconds — the cap is shared.
 *   - `getActiveFinalizeRunForSession`: NULL-safe, exception-safe.
 *   - `billSessionTurnDurationIfTaggedToFinalize`: no-op when no run /
 *     bad duration; bills floored seconds when tagged.
 *   - `composeTimeoutMessageBody`: header + budget summary + output tail.
 *   - `postTimeoutDispatchMessage`: insert + touch + broadcast.
 */
import { describe, it, expect, vi } from 'vitest';

import type { BroadcastFn, FinalizeRunRow, Stmts } from '../types.js';
import {
  billActiveSeconds,
  billSessionTurnDurationIfTaggedToFinalize,
  broadcastActiveSeconds,
  composeTimeoutMessageBody,
  FINALIZE_BUDGET_DEFAULT_SECONDS,
  FINALIZE_BUDGET_HARD_CEILING_SECONDS,
  FINALIZE_TERMINAL_STATUSES,
  getActiveFinalizeRunForSession,
  getRunFamilyActiveSeconds,
  isBudgetExhausted,
  postTimeoutDispatchMessage,
  resolveBudgetSeconds,
  TIMEOUT_DISPATCH_HEADER,
} from './budget.js';

type BudgetStmts = Pick<
  Stmts,
  | 'getFinalizeRun'
  | 'updateFinalizeRunActiveSeconds'
  | 'getActiveFinalizeRunForSession'
  | 'addMessage'
  | 'touchSession'
  | 'getMessageById'
>;

function makeStmts(rows: Record<string, Partial<FinalizeRunRow>> = {}): {
  stmts: BudgetStmts;
  rowMap: Map<string, Partial<FinalizeRunRow>>;
  activeBySession: Map<string, Partial<FinalizeRunRow>>;
  inserted: Array<{ id: string; sessionId: string; body: string; metadata: string | null }>;
} {
  const rowMap = new Map(Object.entries(rows));
  const activeBySession = new Map<string, Partial<FinalizeRunRow>>();
  for (const row of rowMap.values()) {
    if (row.session_id && row.status && !FINALIZE_TERMINAL_STATUSES.includes(row.status)) {
      activeBySession.set(row.session_id, row);
    }
  }
  const inserted: Array<{
    id: string;
    sessionId: string;
    body: string;
    metadata: string | null;
  }> = [];
  const stmts = {
    getFinalizeRun: {
      get: vi.fn((id: string) => rowMap.get(id)),
    },
    updateFinalizeRunActiveSeconds: {
      run: vi.fn((seconds: number, id: string) => {
        const row = rowMap.get(id);
        if (row) row.active_seconds_consumed = (row.active_seconds_consumed ?? 0) + seconds;
      }),
    },
    getActiveFinalizeRunForSession: {
      get: vi.fn((sessionId: string) => activeBySession.get(sessionId)),
    },
    addMessage: {
      run: vi.fn(
        (
          id: string,
          sessionId: string,
          _role: string,
          body: string,
          _engine: unknown,
          _model: unknown,
          _toolCalls: unknown,
          metadata: string | null,
        ) => {
          inserted.push({ id, sessionId, body, metadata });
        },
      ),
    },
    touchSession: { run: vi.fn() },
    getMessageById: {
      get: vi.fn((id: string) => {
        const m = inserted.find((x) => x.id === id);
        if (!m) return undefined;
        return { id: m.id, session_id: m.sessionId };
      }),
    },
  } as unknown as BudgetStmts;
  return { stmts, rowMap, activeBySession, inserted };
}

function makeBroadcast(): { broadcast: BroadcastFn; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const broadcast: BroadcastFn = (data) => {
    calls.push(data);
  };
  return { broadcast, calls };
}

describe('resolveBudgetSeconds', () => {
  it('returns the default when ciTimeoutMinutes is null/undefined', () => {
    expect(resolveBudgetSeconds({})).toBe(FINALIZE_BUDGET_DEFAULT_SECONDS);
    expect(resolveBudgetSeconds({ ciTimeoutMinutes: null })).toBe(FINALIZE_BUDGET_DEFAULT_SECONDS);
    expect(resolveBudgetSeconds({ ciTimeoutMinutes: undefined })).toBe(
      FINALIZE_BUDGET_DEFAULT_SECONDS,
    );
  });

  it('converts a positive minutes value to seconds', () => {
    expect(resolveBudgetSeconds({ ciTimeoutMinutes: 10 })).toBe(600);
    expect(resolveBudgetSeconds({ ciTimeoutMinutes: 30 })).toBe(1800);
    expect(resolveBudgetSeconds({ ciTimeoutMinutes: 1 })).toBe(60);
  });

  it('clamps any value ABOVE the hard ceiling — ci.yaml may lower, never raise', () => {
    expect(resolveBudgetSeconds({ ciTimeoutMinutes: 61 })).toBe(
      FINALIZE_BUDGET_HARD_CEILING_SECONDS,
    );
    expect(resolveBudgetSeconds({ ciTimeoutMinutes: 9999 })).toBe(
      FINALIZE_BUDGET_HARD_CEILING_SECONDS,
    );
  });

  it('falls back to default for non-positive / non-finite inputs', () => {
    expect(resolveBudgetSeconds({ ciTimeoutMinutes: 0 })).toBe(FINALIZE_BUDGET_DEFAULT_SECONDS);
    expect(resolveBudgetSeconds({ ciTimeoutMinutes: -5 })).toBe(FINALIZE_BUDGET_DEFAULT_SECONDS);
    expect(resolveBudgetSeconds({ ciTimeoutMinutes: Number.NaN })).toBe(
      FINALIZE_BUDGET_DEFAULT_SECONDS,
    );
    expect(resolveBudgetSeconds({ ciTimeoutMinutes: Number.POSITIVE_INFINITY })).toBe(
      FINALIZE_BUDGET_DEFAULT_SECONDS,
    );
  });

  it('floors fractional minutes (defensive — parser already enforces integers)', () => {
    expect(resolveBudgetSeconds({ ciTimeoutMinutes: 10.7 })).toBe(600);
  });

  it('hard ceiling is exactly 60 minutes', () => {
    expect(FINALIZE_BUDGET_HARD_CEILING_SECONDS).toBe(3600);
  });
});

describe('billActiveSeconds', () => {
  it('increments and broadcasts the running total', () => {
    const { stmts, rowMap } = makeStmts({
      'run-1': { id: 'run-1', active_seconds_consumed: 100 } as Partial<FinalizeRunRow>,
    });
    const { broadcast, calls } = makeBroadcast();
    billActiveSeconds({ stmts, broadcast }, 'run-1', 50);
    expect(rowMap.get('run-1')?.active_seconds_consumed).toBe(150);
    const evt = calls.find((c) => c.type === 'finalize_run_active_seconds');
    expect(evt).toEqual({
      type: 'finalize_run_active_seconds',
      run_id: 'run-1',
      active_seconds_consumed: 150,
    });
  });

  it('no-ops on non-positive seconds', () => {
    const { stmts } = makeStmts({ 'run-1': { id: 'run-1', active_seconds_consumed: 100 } });
    const { broadcast, calls } = makeBroadcast();
    billActiveSeconds({ stmts, broadcast }, 'run-1', 0);
    billActiveSeconds({ stmts, broadcast }, 'run-1', -5);
    billActiveSeconds({ stmts, broadcast }, 'run-1', Number.NaN);
    expect(stmts.updateFinalizeRunActiveSeconds.run).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('floors sub-second durations to at least 1 second', () => {
    const { stmts, rowMap } = makeStmts({ 'run-1': { id: 'run-1', active_seconds_consumed: 0 } });
    const { broadcast } = makeBroadcast();
    billActiveSeconds({ stmts, broadcast }, 'run-1', 0.4);
    expect(rowMap.get('run-1')?.active_seconds_consumed).toBe(1);
  });

  it('swallows DB write errors and does NOT broadcast', () => {
    const { stmts } = makeStmts({});
    (stmts.updateFinalizeRunActiveSeconds as unknown as { run: ReturnType<typeof vi.fn> }).run =
      vi.fn(() => {
        throw new Error('disk full');
      });
    const { broadcast, calls } = makeBroadcast();
    const log = vi.fn();
    expect(() => billActiveSeconds({ stmts, broadcast, log }, 'run-1', 5)).not.toThrow();
    expect(calls).toHaveLength(0);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('broadcastActiveSeconds', () => {
  it('reads the current row and broadcasts the total', () => {
    const { stmts } = makeStmts({
      'run-1': { id: 'run-1', active_seconds_consumed: 270 },
    });
    const { broadcast, calls } = makeBroadcast();
    broadcastActiveSeconds({ stmts, broadcast }, 'run-1');
    expect(calls[0]).toEqual({
      type: 'finalize_run_active_seconds',
      run_id: 'run-1',
      active_seconds_consumed: 270,
    });
  });

  it('no-ops when the row is missing', () => {
    const { stmts } = makeStmts({});
    const { broadcast, calls } = makeBroadcast();
    broadcastActiveSeconds({ stmts, broadcast }, 'unknown');
    expect(calls).toHaveLength(0);
  });
});

describe('getRunFamilyActiveSeconds / isBudgetExhausted — shared cap with retry parent', () => {
  it('sums run + retry parent — the retry does NOT get a fresh budget', () => {
    const { stmts } = makeStmts({
      'parent-run': {
        id: 'parent-run',
        active_seconds_consumed: 3300, // 55 min
        retry_of_run_id: null,
      } as Partial<FinalizeRunRow>,
      'retry-run': {
        id: 'retry-run',
        active_seconds_consumed: 100, // 1.6 min on the retry itself
        retry_of_run_id: 'parent-run',
      } as Partial<FinalizeRunRow>,
    });
    expect(getRunFamilyActiveSeconds(stmts, 'parent-run')).toBe(3300);
    // Family total: parent 3300 + retry 100 = 3400.
    expect(getRunFamilyActiveSeconds(stmts, 'retry-run')).toBe(3400);
  });

  it('isBudgetExhausted uses the family total against the cap', () => {
    const { stmts } = makeStmts({
      'parent-run': { id: 'parent-run', active_seconds_consumed: 3500 },
      'retry-run': {
        id: 'retry-run',
        active_seconds_consumed: 200,
        retry_of_run_id: 'parent-run',
      } as Partial<FinalizeRunRow>,
    });
    // Parent alone (3500) is under the 3600 cap.
    expect(isBudgetExhausted(stmts, 'parent-run', 3600)).toBe(false);
    // Retry's family total (3500 + 200 = 3700) is over.
    expect(isBudgetExhausted(stmts, 'retry-run', 3600)).toBe(true);
    // A lower cap (10 min = 600s) is exhausted by even the parent.
    expect(isBudgetExhausted(stmts, 'parent-run', 600)).toBe(true);
  });

  it('returns 0 when the run is missing', () => {
    const { stmts } = makeStmts({});
    expect(getRunFamilyActiveSeconds(stmts, 'unknown')).toBe(0);
    expect(isBudgetExhausted(stmts, 'unknown', 3600)).toBe(false);
  });

  it('tolerates a dangling retry_of_run_id', () => {
    const { stmts } = makeStmts({
      'retry-run': {
        id: 'retry-run',
        active_seconds_consumed: 50,
        retry_of_run_id: 'gone',
      } as Partial<FinalizeRunRow>,
    });
    expect(getRunFamilyActiveSeconds(stmts, 'retry-run')).toBe(50);
  });
});

describe('getActiveFinalizeRunForSession', () => {
  it('returns the in-flight row when one exists', () => {
    const { stmts } = makeStmts({
      'run-1': {
        id: 'run-1',
        session_id: 'sess-1',
        status: 'rebasing',
      } as Partial<FinalizeRunRow>,
    });
    const row = getActiveFinalizeRunForSession(stmts, 'sess-1');
    expect(row?.id).toBe('run-1');
  });

  it('returns null when no row exists', () => {
    const { stmts } = makeStmts({});
    expect(getActiveFinalizeRunForSession(stmts, 'sess-x')).toBe(null);
  });

  it('returns null when the row is in a terminal status', () => {
    const { stmts } = makeStmts({
      'run-1': {
        id: 'run-1',
        session_id: 'sess-1',
        status: 'pushed',
      } as Partial<FinalizeRunRow>,
    });
    expect(getActiveFinalizeRunForSession(stmts, 'sess-1')).toBe(null);
  });

  it('never throws — broken stmts return null', () => {
    const stmts = {
      getActiveFinalizeRunForSession: {
        get: () => {
          throw new Error('no such table');
        },
      },
    } as unknown as Pick<BudgetStmts, 'getActiveFinalizeRunForSession'>;
    expect(getActiveFinalizeRunForSession(stmts, 'sess-1')).toBe(null);
  });
});

describe('billSessionTurnDurationIfTaggedToFinalize', () => {
  it('bills the floored turn duration to the active run', () => {
    const { stmts, rowMap } = makeStmts({
      'run-1': {
        id: 'run-1',
        session_id: 'sess-1',
        status: 'dispatching',
        active_seconds_consumed: 100,
      } as Partial<FinalizeRunRow>,
    });
    const { broadcast, calls } = makeBroadcast();
    const result = billSessionTurnDurationIfTaggedToFinalize(
      { stmts, broadcast },
      'sess-1',
      45_300, // 45.3s
    );
    expect(result).toEqual({ runId: 'run-1', secondsBilled: 45 });
    expect(rowMap.get('run-1')?.active_seconds_consumed).toBe(145);
    expect(calls[0]).toMatchObject({ type: 'finalize_run_active_seconds', run_id: 'run-1' });
  });

  it('returns null when the session has no active run', () => {
    const { stmts } = makeStmts({});
    const { broadcast } = makeBroadcast();
    const result = billSessionTurnDurationIfTaggedToFinalize({ stmts, broadcast }, 'sess-x', 5_000);
    expect(result).toBe(null);
  });

  it('returns null for non-positive or non-finite durations', () => {
    const { stmts } = makeStmts({
      'run-1': {
        id: 'run-1',
        session_id: 'sess-1',
        status: 'rebasing',
      } as Partial<FinalizeRunRow>,
    });
    const { broadcast } = makeBroadcast();
    expect(billSessionTurnDurationIfTaggedToFinalize({ stmts, broadcast }, 'sess-1', 0)).toBe(null);
    expect(billSessionTurnDurationIfTaggedToFinalize({ stmts, broadcast }, 'sess-1', -5)).toBe(
      null,
    );
    expect(
      billSessionTurnDurationIfTaggedToFinalize({ stmts, broadcast }, 'sess-1', Number.NaN),
    ).toBe(null);
  });

  it('floors sub-second turns to at least 1 second', () => {
    const { stmts, rowMap } = makeStmts({
      'run-1': {
        id: 'run-1',
        session_id: 'sess-1',
        status: 'rebasing',
        active_seconds_consumed: 0,
      } as Partial<FinalizeRunRow>,
    });
    const { broadcast } = makeBroadcast();
    const result = billSessionTurnDurationIfTaggedToFinalize({ stmts, broadcast }, 'sess-1', 250);
    expect(result?.secondsBilled).toBe(1);
    expect(rowMap.get('run-1')?.active_seconds_consumed).toBe(1);
  });

  it('does not throw when sessionId is empty', () => {
    const { stmts } = makeStmts({});
    const { broadcast } = makeBroadcast();
    expect(billSessionTurnDurationIfTaggedToFinalize({ stmts, broadcast }, '', 10_000)).toBe(null);
  });
});

describe('composeTimeoutMessageBody', () => {
  it('renders the locked header + budget summary', () => {
    const body = composeTimeoutMessageBody({
      budgetSeconds: 3600,
      activeSecondsConsumed: 3700,
    });
    expect(body).toContain(TIMEOUT_DISPATCH_HEADER);
    expect(body).toContain('Budget: 3600s (active time). Consumed: 3700s.');
  });

  it('includes the last step name + exit code when provided', () => {
    const body = composeTimeoutMessageBody({
      budgetSeconds: 600,
      activeSecondsConsumed: 605,
      lastStepName: 'npm test',
      lastStepExitCode: 1,
    });
    expect(body).toContain('Last attempted step: "npm test" (exit 1).');
  });

  it('emits the last-output tail block when provided', () => {
    const body = composeTimeoutMessageBody({
      budgetSeconds: 600,
      activeSecondsConsumed: 600,
      lastOutputTail: ['line1', 'line2', 'line3'],
    });
    expect(body).toContain('Last output (3 lines):');
    expect(body).toContain('line1');
    expect(body).toContain('line3');
  });

  it('omits the output tail block when the tail is empty', () => {
    const body = composeTimeoutMessageBody({
      budgetSeconds: 600,
      activeSecondsConsumed: 600,
      lastOutputTail: [],
    });
    expect(body).not.toContain('Last output');
  });
});

describe('postTimeoutDispatchMessage', () => {
  it('inserts the system message, touches the session, and broadcasts', () => {
    const { stmts, inserted } = makeStmts({});
    const { broadcast, calls } = makeBroadcast();
    const result = postTimeoutDispatchMessage(
      { stmts, broadcast, newId: () => 'msg-tt' },
      {
        runId: 'run-1',
        sessionId: 'sess-1',
        cardId: 'card-1',
        projectId: 'proj-1',
        budgetSeconds: 3600,
        activeSecondsConsumed: 3700,
        lastOutputTail: ['boom'],
        lastStepName: 'lint',
        lastStepExitCode: 2,
      },
    );
    expect(result).toEqual({ messageId: 'msg-tt' });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].id).toBe('msg-tt');
    expect(inserted[0].sessionId).toBe('sess-1');
    expect(inserted[0].body).toContain(TIMEOUT_DISPATCH_HEADER);
    expect(inserted[0].body).toContain('boom');
    expect(JSON.parse(inserted[0].metadata as string)).toMatchObject({
      kind: 'finalize_timeout_dispatch',
      runId: 'run-1',
      cardId: 'card-1',
      projectId: 'proj-1',
      lastStepName: 'lint',
      lastStepExitCode: 2,
    });
    expect(stmts.touchSession.run).toHaveBeenCalledWith('sess-1');
    expect(calls.find((c) => c.type === 'message')).toBeDefined();
  });

  it('returns null when addMessage throws — terminal path still proceeds', () => {
    const { stmts } = makeStmts({});
    (stmts.addMessage as unknown as { run: ReturnType<typeof vi.fn> }).run = vi.fn(() => {
      throw new Error('locked');
    });
    const { broadcast } = makeBroadcast();
    const result = postTimeoutDispatchMessage(
      { stmts, broadcast, log: vi.fn(), newId: () => 'msg-tt' },
      {
        runId: 'run-1',
        sessionId: 'sess-1',
        cardId: 'card-1',
        projectId: 'proj-1',
        budgetSeconds: 3600,
        activeSecondsConsumed: 3700,
      },
    );
    expect(result).toBe(null);
  });

  it('tolerates touchSession / broadcast failures (best-effort)', () => {
    const { stmts } = makeStmts({});
    (stmts.touchSession as unknown as { run: ReturnType<typeof vi.fn> }).run = vi.fn(() => {
      throw new Error('lock');
    });
    const broadcast = vi.fn(() => {
      throw new Error('socket gone');
    });
    const result = postTimeoutDispatchMessage(
      { stmts, broadcast, log: vi.fn(), newId: () => 'msg-tt' },
      {
        runId: 'run-1',
        sessionId: 'sess-1',
        cardId: 'card-1',
        projectId: 'proj-1',
        budgetSeconds: 3600,
        activeSecondsConsumed: 3700,
      },
    );
    expect(result).toEqual({ messageId: 'msg-tt' });
  });
});

describe('FINALIZE_TERMINAL_STATUSES — invariant with db.ts SQL literal', () => {
  it('lists exactly the statuses the SQL NOT IN clause excludes', () => {
    // db.ts uses: status NOT IN
    //   ('pushed', 'failed', 'timed_out', 'infra_error', 'cancelled', 'stalled_no_response')
    // The two MUST agree — keep this assertion locked to the SQL string.
    expect([...FINALIZE_TERMINAL_STATUSES].sort()).toEqual(
      ['cancelled', 'failed', 'infra_error', 'pushed', 'stalled_no_response', 'timed_out'].sort(),
    );
  });
});
