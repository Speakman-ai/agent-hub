import { beforeEach, describe, expect, it } from 'vitest';
import { getStmts } from './db.js';
import {
  type AutopilotRowStmts,
  casAutopilotConfig,
  stopAutopilotRun,
  transitionMainlineSlot,
} from './session-autopilot-slot.js';
import {
  type AutopilotSessionConfig,
  parseAutopilotSessionConfig,
} from '../shared/utils/sessionAutopilot.js';
import { idleMainlineSlot, type MainlineSlot } from '../shared/utils/autopilotMainlineSlot.js';

const SHA = 'c'.repeat(40);
const NOW = '2026-09-27T12:00:00.000Z';

function baseConfig(overrides: Partial<AutopilotSessionConfig> = {}): AutopilotSessionConfig {
  return {
    durationHours: 0,
    brief: 'Ship it',
    goal: 'Live and healthy',
    escalation: 'medium',
    branch: 'autopilot/mainline',
    startedAt: '2026-09-27T10:00:00.000Z',
    deadlineAt: null,
    status: 'running',
    cycle: 0,
    lastPushSha: null,
    target: 'mainline',
    mainline: { deployEnvironment: 'prod', landedCount: 0, slot: idleMainlineSlot() },
    ...overrides,
  };
}

let seq = 0;
function seedSession(cfg: AutopilotSessionConfig | null): string {
  const stmts = getStmts();
  const id = `ap-slot-${++seq}-${Date.now()}`;
  stmts.createSession.run(id, 'agent-1', 'Autopilot', 'claude-code', 'test', 1, 0, 1);
  stmts.updateSessionMode.run('autopilot', id);
  if (cfg) stmts.updateSessionAutopilotConfig.run(JSON.stringify(cfg), id);
  return id;
}

function stored(id: string): AutopilotSessionConfig | null {
  const row = getStmts().getSession.get(id) as { autopilot_session_config: string | null };
  return parseAutopilotSessionConfig(row.autopilot_session_config);
}

function storedSlot(id: string): MainlineSlot {
  return stored(id)!.mainline!.slot;
}

describe('transitionMainlineSlot (session row)', () => {
  let stmts: AutopilotRowStmts;
  beforeEach(() => {
    stmts = getStmts();
  });

  it('walks a full cycle, each step keyed on the stored (phase, attemptId)', () => {
    const id = seedSession(baseConfig());
    const step = (
      expect_: { phase: MainlineSlot['phase']; attemptId: string | null },
      event: Parameters<typeof transitionMainlineSlot>[0]['event'],
    ) => transitionMainlineSlot({ stmts, sessionId: id, expect: expect_, event, nowIso: NOW });

    expect(
      step({ phase: 'idle', attemptId: null }, { type: 'begin_push', attemptId: 'a1', sha: SHA }),
    ).toMatchObject({ wrote: true, slot: { phase: 'pushing', attemptId: 'a1' } });
    expect(step({ phase: 'pushing', attemptId: 'a1' }, { type: 'push_unknown' }).wrote).toBe(true);
    expect(step({ phase: 'uncertain', attemptId: 'a1' }, { type: 'remote_present' }).wrote).toBe(
      true,
    );
    expect(
      step({ phase: 'landed', attemptId: 'a1' }, { type: 'deploy_started', deploymentId: 'd1' })
        .wrote,
    ).toBe(true);
    expect(
      step(
        { phase: 'deploying', attemptId: 'a1' },
        { type: 'deploy_finished', status: 'succeeded' },
      ).wrote,
    ).toBe(true);
    expect(storedSlot(id)).toMatchObject({
      phase: 'reporting',
      deploymentId: 'd1',
      outcome: { status: 'succeeded' },
    });
    expect(step({ phase: 'reporting', attemptId: 'a1' }, { type: 'report_delivered' }).wrote).toBe(
      true,
    );
    expect(storedSlot(id)).toEqual(idleMainlineSlot(NOW));
    expect(stored(id)!.mainline!.landedCount).toBe(1);
  });

  it('refuses a writer acting on a stale read and leaves the row alone', () => {
    const id = seedSession(baseConfig());
    transitionMainlineSlot({
      stmts,
      sessionId: id,
      expect: { phase: 'idle', attemptId: null },
      event: { type: 'begin_push', attemptId: 'a1', sha: SHA },
    });
    // The boot sweep moves the in-flight push to uncertain...
    transitionMainlineSlot({
      stmts,
      sessionId: id,
      expect: { phase: 'pushing', attemptId: 'a1' },
      event: { type: 'push_unknown' },
    });
    const before = getStmts().getSession.get(id) as { autopilot_session_config: string };
    // ...then the original push reply arrives, still believing it is `pushing`.
    const late = transitionMainlineSlot({
      stmts,
      sessionId: id,
      expect: { phase: 'pushing', attemptId: 'a1' },
      event: { type: 'push_rejected' },
    });
    expect(late).toMatchObject({ wrote: false, reason: 'stale', slot: { phase: 'uncertain' } });
    const after = getStmts().getSession.get(id) as { autopilot_session_config: string };
    expect(after.autopilot_session_config).toBe(before.autopilot_session_config);
  });

  it('refuses a different attempt in the same phase', () => {
    const id = seedSession(baseConfig());
    transitionMainlineSlot({
      stmts,
      sessionId: id,
      expect: { phase: 'idle', attemptId: null },
      event: { type: 'begin_push', attemptId: 'a2', sha: SHA },
    });
    expect(
      transitionMainlineSlot({
        stmts,
        sessionId: id,
        expect: { phase: 'pushing', attemptId: 'a1' },
        event: { type: 'push_rejected' },
      }),
    ).toMatchObject({ wrote: false, reason: 'stale' });
    expect(storedSlot(id).attemptId).toBe('a2');
  });

  it('refuses an illegal move even when the identity matches', () => {
    const id = seedSession(baseConfig());
    expect(
      transitionMainlineSlot({
        stmts,
        sessionId: id,
        expect: { phase: 'idle', attemptId: null },
        event: { type: 'push_landed' },
      }),
    ).toMatchObject({ wrote: false, reason: 'illegal_transition' });
    expect(storedSlot(id).phase).toBe('idle');
  });

  it('refuses branch-target and missing configs', () => {
    const branchId = seedSession(baseConfig({ target: 'branch', mainline: null }));
    const emptyId = seedSession(null);
    const begin = { type: 'begin_push' as const, attemptId: 'a1', sha: SHA };
    const expect_ = { phase: 'idle' as const, attemptId: null };
    expect(
      transitionMainlineSlot({ stmts, sessionId: branchId, expect: expect_, event: begin }),
    ).toMatchObject({ wrote: false, reason: 'not_mainline' });
    expect(
      transitionMainlineSlot({ stmts, sessionId: emptyId, expect: expect_, event: begin }),
    ).toMatchObject({ wrote: false, reason: 'no_config' });
    expect(
      transitionMainlineSlot({
        stmts,
        sessionId: 'no-such-session',
        expect: expect_,
        event: begin,
      }),
    ).toMatchObject({ wrote: false, reason: 'no_config' });
  });

  it('still moves an owed landing after the run stopped', () => {
    const id = seedSession(baseConfig());
    transitionMainlineSlot({
      stmts,
      sessionId: id,
      expect: { phase: 'idle', attemptId: null },
      event: { type: 'begin_push', attemptId: 'a1', sha: SHA },
    });
    expect(stopAutopilotRun({ stmts, sessionId: id, to: 'expired' }).wrote).toBe(true);
    // The stop kept the slot.
    expect(storedSlot(id)).toMatchObject({ phase: 'pushing', attemptId: 'a1' });
    expect(
      transitionMainlineSlot({
        stmts,
        sessionId: id,
        expect: { phase: 'pushing', attemptId: 'a1' },
        event: { type: 'push_landed' },
      }).wrote,
    ).toBe(true);
    expect(stored(id)).toMatchObject({
      status: 'expired',
      mainline: { slot: { phase: 'landed' } },
    });
  });
});

describe('stopAutopilotRun', () => {
  it('moves a running row once; the second caller does not write', () => {
    const stmts = getStmts();
    const id = seedSession(baseConfig({ target: 'branch', mainline: null }));
    expect(stopAutopilotRun({ stmts, sessionId: id, to: 'expired' })).toMatchObject({
      wrote: true,
      cfg: { status: 'expired' },
    });
    expect(stopAutopilotRun({ stmts, sessionId: id, to: 'completed' })).toMatchObject({
      wrote: false,
      cfg: { status: 'expired' },
    });
    expect(stored(id)!.status).toBe('expired');
  });

  it('does not stop a row that is not running', () => {
    const stmts = getStmts();
    const id = seedSession(baseConfig({ status: 'paused' }));
    expect(stopAutopilotRun({ stmts, sessionId: id, to: 'expired' }).wrote).toBe(false);
    expect(stored(id)!.status).toBe('paused');
  });

  it('re-checks its guard against the stored row', () => {
    const stmts = getStmts();
    const id = seedSession(baseConfig());
    expect(stopAutopilotRun({ stmts, sessionId: id, to: 'expired', when: () => false }).wrote).toBe(
      false,
    );
    expect(stored(id)!.status).toBe('running');
  });
});

describe('casAutopilotConfig', () => {
  it('re-decides from the fresh row when another writer lands between read and write', () => {
    const real = getStmts();
    const id = seedSession(baseConfig({ cycle: 0 }));
    let interfered = false;
    const stmts: AutopilotRowStmts = {
      getSession: real.getSession,
      casSessionAutopilotConfig: {
        run: (...args: [string, string, string | null]) => {
          if (!interfered) {
            interfered = true;
            // Another process bumps the cycle after our read.
            const cfg = stored(id)!;
            real.updateSessionAutopilotConfig.run(
              JSON.stringify({ ...cfg, cycle: cfg.cycle + 10 }),
              id,
            );
          }
          return real.casSessionAutopilotConfig.run(...args);
        },
      } as unknown as AutopilotRowStmts['casSessionAutopilotConfig'],
    };
    const seen: number[] = [];
    const res = casAutopilotConfig(stmts, id, (current) => {
      seen.push(current.cycle);
      return { write: { ...current, cycle: current.cycle + 1 }, result: current.cycle + 1 };
    });
    expect(res).toMatchObject({ wrote: true, result: 11 });
    expect(seen).toEqual([0, 10]);
    expect(stored(id)!.cycle).toBe(11);
  });

  it('gives up after bounded conflicts without writing', () => {
    const real = getStmts();
    const id = seedSession(baseConfig());
    const stmts: AutopilotRowStmts = {
      getSession: real.getSession,
      casSessionAutopilotConfig: {
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
      } as unknown as AutopilotRowStmts['casSessionAutopilotConfig'],
    };
    const res = casAutopilotConfig(stmts, id, (current) => ({
      write: { ...current, status: 'completed' },
      result: null,
    }));
    expect(res).toMatchObject({ wrote: false, reason: 'conflict' });
    expect(stored(id)!.status).toBe('running');
  });
});
