/**
 * Mainline result delivery against the real session, messages, and
 * message_queue tables. The chat entry point is faked: it persists the user
 * message the way `handleChat` does, or never settles, or refuses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, getStmts } from './db.js';
import {
  MAINLINE_REPORT_BUSY_RETRY_MS,
  MAINLINE_REPORT_DISPATCH_STALL_MS,
  MAINLINE_REPORT_MAX_DISPATCHES,
  createMainlineReportDelivery,
  findMainlineReportKey,
  mainlineReportRetryMs,
  type MainlineReportDeps,
} from './autopilot-mainline-report.js';
import { createMainlineDeployWatcher } from './autopilot-mainline-deploy-watcher.js';
import { postAutopilotSystemNotice } from './session-autopilot.js';
import {
  type AutopilotSessionConfig,
  autopilotStopNoticeContent,
  parseAutopilotSessionConfig,
} from '../shared/utils/sessionAutopilot.js';
import {
  type MainlineOutcome,
  type MainlineSlot,
  idleMainlineSlot,
  mainlineReportKey,
} from '../shared/utils/autopilotMainlineSlot.js';

const SHA = 'b'.repeat(40);
const ATTEMPT = 'attempt-report-1';
const AGENT = 'agent-ml-report';
const T0 = Date.parse('2026-09-27T12:00:00.000Z');

const SUCCEEDED: MainlineOutcome = {
  status: 'succeeded',
  detail: null,
  origin: 'https://prod.example.com',
  readiness: 'https://prod.example.com/healthz',
};

function config(
  opts: {
    outcome?: MainlineOutcome;
    phase?: MainlineSlot['phase'];
    patch?: Partial<AutopilotSessionConfig>;
  } = {},
): AutopilotSessionConfig {
  const phase = opts.phase ?? 'reporting';
  return {
    durationHours: 0,
    brief: 'Ship it',
    goal: 'Checkout page loads under 1s',
    escalation: 'medium',
    branch: 'main',
    startedAt: new Date(T0).toISOString(),
    deadlineAt: null,
    status: 'running',
    cycle: 0,
    lastPushSha: null,
    target: 'mainline',
    mainline: {
      deployEnvironment: 'prod',
      landedCount: 1,
      slot: {
        ...idleMainlineSlot(),
        phase,
        attemptId: ATTEMPT,
        sha: SHA,
        deploymentId: 'dep-1',
        outcome: phase === 'reporting' ? (opts.outcome ?? SUCCEEDED) : null,
        enteredAt: new Date(T0).toISOString(),
      },
    },
    ...opts.patch,
  };
}

let seq = 0;
function seedSession(cfg: AutopilotSessionConfig, mode = 'autopilot'): string {
  const stmts = getStmts();
  const id = `ml-report-${++seq}-${uuidv4()}`;
  stmts.createSession.run(id, AGENT, 'Autopilot', 'claude-code', 'test', 1, 0, 1);
  stmts.updateSessionMode.run(mode, id);
  stmts.updateSessionAutopilotConfig.run(JSON.stringify(cfg), id);
  return id;
}

function stored(id: string): AutopilotSessionConfig {
  const row = getStmts().getSession.get(id) as { autopilot_session_config: string | null };
  return parseAutopilotSessionConfig(row.autopilot_session_config)!;
}

function messagesOf(id: string): Array<{ role: string; content: string }> {
  return getDb()
    .prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY rowid')
    .all(id) as Array<{ role: string; content: string }>;
}

/** Persists the user message like `handleChat` does, then resolves. */
function persistingDispatch() {
  return vi.fn(async (session: { id: string }, content: string) => {
    getStmts().addMessage.run(
      uuidv4(),
      session.id,
      'user',
      content,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
  });
}

function harness(overrides: Partial<MainlineReportDeps> = {}) {
  const stmts = getStmts();
  const clock = { now: T0 };
  const dispatchTurn = overrides.dispatchTurn
    ? vi.fn(overrides.dispatchTurn)
    : persistingDispatch();
  const deps: MainlineReportDeps = {
    stmts,
    findReportKey: (sessionId, key) => findMainlineReportKey(getDb(), sessionId, key),
    postNotice: (sessionId, content) =>
      postAutopilotSystemNotice({ stmts, broadcast: () => {} }, sessionId, content),
    now: () => clock.now,
    log: () => {},
    ...overrides,
    dispatchTurn,
  };
  return { deps, clock, dispatchTurn };
}

const session = (id: string) => ({ id, agent_id: AGENT });
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  getDb().prepare('DELETE FROM sessions WHERE agent_id = ?').run(AGENT);
});

describe('findMainlineReportKey (real DB)', () => {
  it('finds the key in messages and in the queue, scoped to the session', () => {
    const a = seedSession(config());
    const b = seedSession(config());
    const key = mainlineReportKey(a, ATTEMPT);
    expect(findMainlineReportKey(getDb(), a, key)).toBe(false);

    getStmts().enqueueMessage.run(uuidv4(), a, AGENT, `verify\nReport key: ${key}`, null, 0, 0);
    expect(findMainlineReportKey(getDb(), a, key)).toBe(true);
    expect(findMainlineReportKey(getDb(), b, key)).toBe(false);

    getStmts().clearSessionQueue.run(a);
    expect(findMainlineReportKey(getDb(), a, key)).toBe(false);
    getStmts().addMessage.run(
      uuidv4(),
      a,
      'system',
      `x ${key} y`,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
    expect(findMainlineReportKey(getDb(), a, key)).toBe(true);
  });

  it('treats LIKE wildcards in the key literally', () => {
    const a = seedSession(config());
    getStmts().addMessage.run(
      uuidv4(),
      a,
      'user',
      'autopilot-report:aXb',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
    expect(findMainlineReportKey(getDb(), a, 'autopilot-report:a_b')).toBe(false);
    expect(findMainlineReportKey(getDb(), a, 'autopilot-report:a%')).toBe(false);
  });
});

describe('mainline report delivery', () => {
  it('dispatches one verify turn carrying the key, then frees the slot once it is found', async () => {
    const h = harness();
    const id = seedSession(config());
    const reporter = createMainlineReportDelivery(h.deps);

    reporter.deliver(session(id));
    await flush();
    expect(h.dispatchTurn).toHaveBeenCalledTimes(1);
    const content = h.dispatchTurn.mock.calls[0][1] as string;
    expect(content).toContain('succeeded');
    expect(content).toContain('Live origin: https://prod.example.com');
    expect(content).toContain('Readiness: https://prod.example.com/healthz');
    expect(content).toContain('Goal: Checkout page loads under 1s');
    expect(content).toContain(`Report key: ${mainlineReportKey(id, ATTEMPT)}`);
    // Delivery is proven on the next pass, not assumed from the dispatch.
    expect(stored(id).mainline!.slot.phase).toBe('reporting');

    reporter.deliver(session(id));
    expect(stored(id).mainline!.slot.phase).toBe('idle');
    reporter.deliver(session(id));
    expect(h.dispatchTurn).toHaveBeenCalledTimes(1);
  });

  it('tells the agent to fix forward when the deploy failed', () => {
    const h = harness();
    const id = seedSession(
      config({
        outcome: { status: 'failed', detail: 'step ship exited 1', origin: null, readiness: null },
      }),
    );
    createMainlineReportDelivery(h.deps).deliver(session(id));
    const content = h.dispatchTurn.mock.calls[0][1] as string;
    expect(content).toContain('failed (step ship exited 1)');
    expect(content).toContain('fix forward');
    expect(content).toContain('Live origin: not declared in deploy.yaml');
  });

  it('never awaits the agent turn: a dispatch that never settles is not sent twice', () => {
    const h = harness({ dispatchTurn: () => new Promise<void>(() => {}) });
    const id = seedSession(config());
    const reporter = createMainlineReportDelivery(h.deps);

    reporter.deliver(session(id));
    h.clock.now += 60_000;
    reporter.deliver(session(id));
    expect(h.dispatchTurn).toHaveBeenCalledTimes(1);
    expect(stored(id).mainline!.slot.phase).toBe('reporting');

    // A stalled dispatch falls back to the keyed notice.
    h.clock.now += MAINLINE_REPORT_DISPATCH_STALL_MS;
    reporter.deliver(session(id));
    expect(stored(id).mainline!.slot.phase).toBe('idle');
    const notice = messagesOf(id).find((m) => m.role === 'system')!;
    expect(notice.content).toContain('did not start in time');
    expect(h.dispatchTurn).toHaveBeenCalledTimes(1);
  });

  it('a turn that persists after the stall notice is withdrawn, not delivered again', async () => {
    // Holds the dispatch open, then lands it late the way handleChat does:
    // check the gate synchronously, and persist only if it is still open.
    let landLate: (() => void) | null = null;
    const h = harness({
      dispatchTurn: (s, content, acceptTurn) =>
        new Promise<void>((resolve, reject) => {
          landLate = () => {
            if (!acceptTurn({ busy: false })) {
              reject(new Error('turn withdrawn'));
              return;
            }
            getStmts().addMessage.run(
              uuidv4(),
              s.id,
              'user',
              content,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
            );
            resolve();
          };
        }),
    });
    const id = seedSession(config());
    const reporter = createMainlineReportDelivery(h.deps);

    reporter.deliver(session(id));
    h.clock.now += MAINLINE_REPORT_DISPATCH_STALL_MS;
    reporter.deliver(session(id));
    expect(stored(id).mainline!.slot.phase).toBe('idle');

    landLate!();
    await flush();
    const key = mainlineReportKey(id, ATTEMPT);
    const carrying = messagesOf(id).filter((m) => m.content.includes(key));
    expect(carrying).toHaveLength(1);
    expect(carrying[0].role).toBe('system');
    expect(messagesOf(id).filter((m) => m.role === 'user')).toHaveLength(0);
    expect(h.dispatchTurn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['running', config()],
    ['stopped', config({ patch: { status: 'paused' } })],
  ])('restart + failed lookup (%s): an existing report is not sent again', (_label, cfg) => {
    const id = seedSession(cfg);
    const key = mainlineReportKey(id, ATTEMPT);
    // Delivered by the previous process; the slot write was lost.
    getStmts().addMessage.run(
      uuidv4(),
      id,
      'user',
      `verify\nReport key: ${key}`,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
    let calls = 0;
    const h = harness({
      findReportKey: (sessionId, k) => {
        if (calls++ === 0) throw new Error('database is locked');
        return findMainlineReportKey(getDb(), sessionId, k);
      },
    });
    const reporter = createMainlineReportDelivery(h.deps);

    reporter.deliver(session(id));
    expect(h.dispatchTurn).not.toHaveBeenCalled();
    expect(messagesOf(id)).toHaveLength(1);
    expect(stored(id).mainline!.slot.phase).toBe('reporting');

    reporter.deliver(session(id));
    expect(h.dispatchTurn).not.toHaveBeenCalled();
    expect(messagesOf(id)).toHaveLength(1);
    expect(stored(id).mainline!.slot.phase).toBe('idle');
  });

  it('retries a refused dispatch with backoff, then posts a keyed notice at the cap', async () => {
    const h = harness({ dispatchTurn: async () => Promise.reject(new Error('queue full')) });
    const id = seedSession(config());
    const reporter = createMainlineReportDelivery(h.deps);

    for (let attempt = 1; attempt < MAINLINE_REPORT_MAX_DISPATCHES; attempt++) {
      reporter.deliver(session(id));
      await flush();
      expect(h.dispatchTurn).toHaveBeenCalledTimes(attempt);
      // Inside the backoff window nothing is dispatched.
      reporter.deliver(session(id));
      expect(h.dispatchTurn).toHaveBeenCalledTimes(attempt);
      expect(stored(id).mainline!.slot.phase).toBe('reporting');
      h.clock.now += mainlineReportRetryMs(attempt);
    }
    reporter.deliver(session(id));
    await flush();
    // The last refusal falls straight back to the notice.
    reporter.deliver(session(id));
    expect(h.dispatchTurn).toHaveBeenCalledTimes(MAINLINE_REPORT_MAX_DISPATCHES);
    expect(stored(id).mainline!.slot.phase).toBe('idle');
    const notices = messagesOf(id).filter((m) => m.role === 'system');
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toContain('could not be started after several tries');
    expect(notices[0].content).toContain(mainlineReportKey(id, ATTEMPT));
  });

  it.each([
    ['stopped', () => seedSession(config({ patch: { status: 'paused' } })), 'status is paused'],
    ['mode-switched', () => seedSession(config(), 'chat'), 'left Autopilot mode'],
    [
      'archived',
      () => {
        const id = seedSession(config());
        getDb().prepare("UPDATE sessions SET deleted_at = datetime('now') WHERE id = ?").run(id);
        return id;
      },
      'archived',
    ],
  ])('a %s session gets a keyed notice, never an agent turn', (_label, seed, why) => {
    const h = harness();
    const id = seed();
    createMainlineReportDelivery(h.deps).deliver(session(id));

    expect(h.dispatchTurn).not.toHaveBeenCalled();
    expect(stored(id).mainline!.slot.phase).toBe('idle');
    const notices = messagesOf(id).filter((m) => m.role === 'system');
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toContain('succeeded');
    expect(notices[0].content).toContain(why);
    expect(notices[0].content).toContain(mainlineReportKey(id, ATTEMPT));
  });

  it('past the deadline: expires the run once, still reports the owed deploy as a notice', () => {
    const h = harness();
    const id = seedSession(
      config({ patch: { durationHours: 1, deadlineAt: new Date(T0 - 1000).toISOString() } }),
    );
    const reporter = createMainlineReportDelivery(h.deps);
    reporter.deliver(session(id));
    reporter.deliver(session(id));

    expect(h.dispatchTurn).not.toHaveBeenCalled();
    const cfg = stored(id);
    expect(cfg.status).toBe('expired');
    expect(cfg.mainline!.slot.phase).toBe('idle');
    const notices = messagesOf(id).filter((m) => m.role === 'system');
    expect(notices).toHaveLength(2);
    expect(notices[0].content).toContain('time limit was reached');
    expect(notices[0].content).toContain('already deployed to `prod`');
    expect(notices[1].content).toContain('time limit was reached');
    expect(notices[1].content).toContain('Live origin: https://prod.example.com');
  });

  it('restart before dispatch: a fresh process sends the verify turn', () => {
    const id = seedSession(config());
    // First process died before dispatching; nothing is on record.
    const h = harness();
    createMainlineReportDelivery(h.deps).deliver(session(id));
    expect(h.dispatchTurn).toHaveBeenCalledTimes(1);
    expect(messagesOf(id).filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('restart after dispatch: a fresh process finds the key and does not send it again', async () => {
    const id = seedSession(config());
    const first = harness();
    createMainlineReportDelivery(first.deps).deliver(session(id));
    await flush();
    expect(first.dispatchTurn).toHaveBeenCalledTimes(1);
    expect(stored(id).mainline!.slot.phase).toBe('reporting');

    // New process: no in-memory record.
    const second = harness();
    createMainlineReportDelivery(second.deps).deliver(session(id));
    expect(second.dispatchTurn).not.toHaveBeenCalled();
    expect(stored(id).mainline!.slot.phase).toBe('idle');
    expect(messagesOf(id).filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('ignores slots that are not reporting', () => {
    const h = harness();
    const id = seedSession(config({ phase: 'deploying' }));
    createMainlineReportDelivery(h.deps).deliver(session(id));
    expect(h.dispatchTurn).not.toHaveBeenCalled();
    expect(messagesOf(id)).toHaveLength(0);
  });
});

describe('watcher hands a finished deploy to delivery in the same sweep', () => {
  it('calls report once the slot reaches reporting', async () => {
    const id = seedSession(config({ phase: 'deploying' }));
    const report = vi.fn();
    const watcher = createMainlineDeployWatcher({
      stmts: getStmts(),
      listCandidates: () => [{ id, agent_id: AGENT, owner_user_id: null }],
      findProjectForAgent: () => null,
      readDeployYamlAtCommit: async () => ({ kind: 'absent' }),
      isEnvironmentDeployable: () => true,
      prepareCheckout: async () => ({ worktreePath: '/tmp/none', resolvedRef: SHA }),
      triggerDeployment: async () => {
        throw new Error('not used');
      },
      listDeploymentsByLandingKey: () => [],
      getDeployment: () => null,
      postNotice: () => {},
      report,
      log: () => {},
    });
    await watcher.sweep();
    expect(stored(id).mainline!.slot).toMatchObject({
      phase: 'reporting',
      outcome: { status: 'missing' },
    });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({ id });
  });
});

describe('stop notice names an in-flight deploy', () => {
  const base = config({ phase: 'deploying' });
  it('says the deploy is still running', () => {
    const text = autopilotStopNoticeContent('expired', 'main', 'mainline', base.mainline);
    expect(text).toContain('`bbbbbbb` is still deploying to `prod`');
    expect(text).toContain('result posts here as a notice');
  });
  it('says nothing is in flight for an idle slot', () => {
    const idle = { ...base.mainline!, slot: idleMainlineSlot() };
    expect(autopilotStopNoticeContent('completed', 'main', 'mainline', idle)).toContain(
      'No deploy is in flight.',
    );
  });
  it('covers a push that has not settled yet', () => {
    const pushing = {
      ...base.mainline!,
      slot: { ...base.mainline!.slot, phase: 'uncertain' as const },
    };
    expect(autopilotStopNoticeContent('paused', 'main', 'mainline', pushing)).toContain(
      'still landing on `main`',
    );
  });
});

describe('eligibility is decided when the turn lands, not when it was sent', () => {
  /** A dispatch held open until the test lands it, checking the gate like handleChat. */
  function heldDispatch() {
    const pending: Array<(busy?: boolean) => boolean> = [];
    const dispatchTurn: MainlineReportDeps['dispatchTurn'] = (s, content, acceptTurn) =>
      new Promise<void>((resolve, reject) => {
        pending.push((busy = false) => {
          if (!acceptTurn({ busy })) {
            reject(new Error('turn refused'));
            return false;
          }
          getStmts().addMessage.run(
            uuidv4(),
            s.id,
            'user',
            content,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
          );
          resolve();
          return true;
        });
      });
    return { dispatchTurn, land: (busy?: boolean) => pending.shift()!(busy) };
  }

  function writeConfig(id: string, patch: Partial<AutopilotSessionConfig>): void {
    getStmts().updateSessionAutopilotConfig.run(JSON.stringify({ ...stored(id), ...patch }), id);
  }

  function keyed(id: string) {
    const key = mainlineReportKey(id, ATTEMPT);
    return messagesOf(id).filter((m) => m.content.includes(key));
  }

  it.each([
    ['the run stops', (id: string) => writeConfig(id, { status: 'paused' }), 'status is paused'],
    [
      'the session leaves Autopilot mode',
      (id: string) => getStmts().updateSessionMode.run('chat', id),
      'left Autopilot mode',
    ],
    [
      'the session is archived',
      (id: string) =>
        getDb().prepare("UPDATE sessions SET deleted_at = datetime('now') WHERE id = ?").run(id),
      'archived',
    ],
  ])(
    '%s after dispatch: the late turn is refused and a notice is owed',
    async (_l, change, why) => {
      const held = heldDispatch();
      const h = harness({ dispatchTurn: held.dispatchTurn });
      const id = seedSession(config());
      const reporter = createMainlineReportDelivery(h.deps);
      reporter.deliver(session(id));

      change(id);
      expect(held.land()).toBe(false);
      await flush();
      expect(messagesOf(id).filter((m) => m.role === 'user')).toHaveLength(0);

      reporter.deliver(session(id));
      expect(stored(id).mainline!.slot.phase).toBe('idle');
      const carrying = keyed(id);
      expect(carrying).toHaveLength(1);
      expect(carrying[0].role).toBe('system');
      expect(carrying[0].content).toContain(why);
      expect(h.dispatchTurn).toHaveBeenCalledTimes(1);
    },
  );

  it('the deadline passes after dispatch: the late turn is refused, the run expires once', async () => {
    const held = heldDispatch();
    const h = harness({ dispatchTurn: held.dispatchTurn });
    const id = seedSession(
      config({ patch: { durationHours: 1, deadlineAt: new Date(T0 + 1000).toISOString() } }),
    );
    const reporter = createMainlineReportDelivery(h.deps);
    reporter.deliver(session(id));

    h.clock.now += 2000;
    expect(held.land()).toBe(false);
    await flush();
    reporter.deliver(session(id));
    reporter.deliver(session(id));

    const cfg = stored(id);
    expect(cfg.status).toBe('expired');
    expect(cfg.mainline!.slot.phase).toBe('idle');
    expect(messagesOf(id).filter((m) => m.role === 'user')).toHaveLength(0);
    const notices = messagesOf(id).filter((m) => m.role === 'system');
    expect(notices).toHaveLength(2);
    expect(notices[0].content).toContain('Autopilot stopped');
    expect(keyed(id)).toHaveLength(1);
  });

  it('a sweep that sees the stop first withdraws the in-flight turn before posting the notice', async () => {
    const held = heldDispatch();
    const h = harness({ dispatchTurn: held.dispatchTurn });
    const id = seedSession(config());
    const reporter = createMainlineReportDelivery(h.deps);
    reporter.deliver(session(id));

    writeConfig(id, { status: 'completed' });
    reporter.deliver(session(id));
    expect(stored(id).mainline!.slot.phase).toBe('idle');
    // Even if the run were restarted, the withdrawn turn stays refused.
    writeConfig(id, { status: 'running' });
    expect(held.land()).toBe(false);
    await flush();
    expect(keyed(id)).toHaveLength(1);
    expect(keyed(id)[0].role).toBe('system');
  });

  it('a busy session is never queued into; retries do not count toward the cap', async () => {
    const held = heldDispatch();
    const h = harness({ dispatchTurn: held.dispatchTurn });
    const id = seedSession(config());
    const reporter = createMainlineReportDelivery(h.deps);

    for (let i = 0; i < MAINLINE_REPORT_MAX_DISPATCHES + 2; i++) {
      reporter.deliver(session(id));
      expect(held.land(true)).toBe(false);
      await flush();
      reporter.deliver(session(id));
      h.clock.now += MAINLINE_REPORT_BUSY_RETRY_MS;
    }
    expect(getStmts().getNextQueuedMessage.get(id)).toBeUndefined();
    expect(messagesOf(id)).toHaveLength(0);
    expect(stored(id).mainline!.slot.phase).toBe('reporting');

    reporter.deliver(session(id));
    expect(held.land(false)).toBe(true);
    await flush();
    reporter.deliver(session(id));
    expect(stored(id).mainline!.slot.phase).toBe('idle');
    expect(keyed(id)).toHaveLength(1);
    expect(keyed(id)[0].role).toBe('user');
  });
});
