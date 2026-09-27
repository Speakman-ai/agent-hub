import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteDeps, SessionRow } from './types.js';
import {
  buildAutopilotKickoffMessage,
  deadlineAtFromDuration,
} from '../shared/utils/sessionAutopilot.js';

const mocks = vi.hoisted(() => ({
  startSessionPreview: vi.fn(),
}));

vi.mock('./preview/start-session-preview.js', () => ({
  startSessionPreview: mocks.startSessionPreview,
}));

const {
  buildAutopilotModePreamble,
  enforceAutopilotExpiry,
  scheduleAutopilotAfterPush,
  startAutopilotConfig,
} = await import('./session-autopilot.js');

/** In-memory session row with SQL-like compare-and-set semantics. */
function fakeRow(cfg: unknown) {
  let raw: string | null = cfg == null ? null : JSON.stringify(cfg);
  const cas = vi.fn((next: string, _id: string, expected: string | null) => {
    if (expected !== raw) return { changes: 0 };
    raw = next;
    return { changes: 1 };
  });
  return {
    stmts: {
      getSession: { get: vi.fn(() => ({ autopilot_session_config: raw })) },
      casSessionAutopilotConfig: { run: cas },
    },
    cas,
    stored: () => (raw == null ? null : JSON.parse(raw)),
  };
}

function runningConfig(overrides: Record<string, unknown> = {}) {
  return startAutopilotConfig({
    durationHours: 4,
    brief: 'Harden the 3D print UI',
    goal: 'Baseline journeys pass on preview',
    escalation: 'medium',
    target: 'branch',
    branch: 'autopilot/print-ui',
    deployEnvironment: null,
    ...overrides,
  });
}

describe('startAutopilotConfig', () => {
  it('starts running with a deadline for a finite duration', () => {
    const cfg = startAutopilotConfig(
      {
        durationHours: 2,
        brief: 'Do the work',
        goal: 'Done',
        escalation: 'low',
        target: 'branch',
        branch: 'autopilot/x',
        deployEnvironment: null,
      },
      '2026-09-17T12:00:00.000Z',
    );
    expect(cfg.status).toBe('running');
    expect(cfg.startedAt).toBe('2026-09-17T12:00:00.000Z');
    expect(cfg.deadlineAt).toBe(deadlineAtFromDuration('2026-09-17T12:00:00.000Z', 2));
    expect(cfg.cycle).toBe(0);
  });

  it('omits a deadline when duration is 0', () => {
    const cfg = startAutopilotConfig({
      durationHours: 0,
      brief: 'Do the work',
      goal: 'Done',
      escalation: 'none',
      target: 'branch',
      branch: 'autopilot/x',
      deployEnvironment: null,
    });
    expect(cfg.deadlineAt).toBeNull();
  });

  it('starts a mainline run with an idle slot and no stray setup fields', () => {
    const cfg = startAutopilotConfig(
      {
        durationHours: 1,
        brief: 'Do the work',
        goal: 'Done',
        escalation: 'none',
        target: 'mainline',
        branch: '',
        deployEnvironment: 'staging',
      },
      '2026-09-17T12:00:00.000Z',
    );
    expect(cfg.target).toBe('mainline');
    expect(cfg.mainline).toEqual({
      deployEnvironment: 'staging',
      landedCount: 0,
      slot: expect.objectContaining({ phase: 'idle', attemptId: null }),
    });
    expect(cfg).not.toHaveProperty('deployEnvironment');
  });
});

describe('buildAutopilotModePreamble', () => {
  it('asks the agent to wait when the startup card has not been submitted', () => {
    const text = buildAutopilotModePreamble(null);
    expect(text).toContain('has not been configured yet');
    expect(text).toContain('Do not implement anything');
  });

  it('names the branch, preview verify, and never-merge rule after start', () => {
    const cfg = runningConfig();
    const text = buildAutopilotModePreamble(cfg);
    expect(text).toContain('`autopilot/print-ui`');
    expect(text).toContain("this session's preview");
    expect(text).toContain('never merge');
    expect(text).toContain(cfg.goal);
  });
});

describe('scheduleAutopilotAfterPush', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startSessionPreview.mockResolvedValue({ ok: true });
  });

  it('no-ops for a non-autopilot session', () => {
    const handleChat = vi.fn();
    scheduleAutopilotAfterPush({
      deps: {
        stmts: { updateSessionAutopilotConfig: { run: vi.fn() } },
        handleChat,
        broadcast: vi.fn(),
        findAgent: vi.fn(),
        getDevServerRuntime: vi.fn(),
      } as unknown as Pick<
        RouteDeps,
        'stmts' | 'handleChat' | 'broadcast' | 'findAgent' | 'getDevServerRuntime'
      >,
      session: { id: 's1', session_mode: 'chat' } as SessionRow,
      sha: 'abc123',
      branch: 'feature/x',
    });
    expect(handleChat).not.toHaveBeenCalled();
    expect(mocks.startSessionPreview).not.toHaveBeenCalled();
  });

  it('starts preview and continues the same session after a successful push', async () => {
    const handleChat = vi.fn().mockResolvedValue(undefined);
    const cfg = runningConfig();
    const row = fakeRow(cfg);
    const session = {
      id: 's1',
      agent_id: 'agent-1',
      session_mode: 'autopilot',
      autopilot_session_config: JSON.stringify(cfg),
    } as SessionRow;

    scheduleAutopilotAfterPush({
      deps: {
        stmts: row.stmts,
        handleChat,
        broadcast: vi.fn(),
        findAgent: vi.fn(),
        getDevServerRuntime: vi.fn(),
      } as unknown as Pick<
        RouteDeps,
        'stmts' | 'handleChat' | 'broadcast' | 'findAgent' | 'getDevServerRuntime'
      >,
      session,
      sha: 'deadbeefcafebabe',
      branch: cfg.branch,
    });

    await vi.waitFor(() => expect(handleChat).toHaveBeenCalledTimes(1));
    const stored = row.stored();
    expect(stored.cycle).toBe(1);
    expect(stored.lastPushSha).toBe('deadbeefcafebabe');
    expect(mocks.startSessionPreview).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1' }),
    );
    const content = handleChat.mock.calls[0][1].content as string;
    expect(content).toContain('deadbeefcafe');
    expect(content).toContain(cfg.goal);
    expect(content).toContain('preview');
  });

  it('stops with a transcript notice (no model turn) when the wall clock has expired', async () => {
    const handleChat = vi.fn().mockResolvedValue(undefined);
    const addMessage = vi.fn();
    const broadcast = vi.fn();
    const cfg = {
      ...runningConfig(),
      startedAt: '2020-01-01T00:00:00.000Z',
      deadlineAt: '2020-01-01T01:00:00.000Z',
    };
    scheduleAutopilotAfterPush({
      deps: {
        stmts: {
          ...fakeRow(cfg).stmts,
          addMessage: { run: addMessage },
          getMessageById: { get: vi.fn(() => undefined) },
        },
        handleChat,
        broadcast,
        findAgent: vi.fn(),
        getDevServerRuntime: vi.fn(),
      } as unknown as Pick<
        RouteDeps,
        'stmts' | 'handleChat' | 'broadcast' | 'findAgent' | 'getDevServerRuntime'
      >,
      session: {
        id: 's1',
        agent_id: 'agent-1',
        session_mode: 'autopilot',
        autopilot_session_config: JSON.stringify(cfg),
      } as SessionRow,
      sha: 'abc123',
      branch: cfg.branch,
    });

    await vi.waitFor(() => expect(addMessage).toHaveBeenCalledTimes(1));
    // A stopped session must NOT launch another model turn just to announce it.
    expect(handleChat).not.toHaveBeenCalled();
    expect(mocks.startSessionPreview).not.toHaveBeenCalled();
    // addMessage(id, sessionId, role, content, ...)
    expect(addMessage.mock.calls[0][2]).toBe('system');
    expect(addMessage.mock.calls[0][3]).toContain('the time limit was reached');
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message_added', sessionId: 's1' }),
    );
  });
});

describe('enforceAutopilotExpiry', () => {
  function makeDeps(cfg: unknown = null) {
    const row = fakeRow(cfg);
    const updateSessionAutopilotConfig = row.cas;
    const addMessage = vi.fn();
    const broadcast = vi.fn();
    return {
      row,
      updateSessionAutopilotConfig,
      addMessage,
      broadcast,
      deps: {
        stmts: {
          ...row.stmts,
          addMessage: { run: addMessage },
          getMessageById: { get: vi.fn(() => undefined) },
        },
        broadcast,
      } as unknown as Pick<RouteDeps, 'stmts' | 'broadcast'>,
    };
  }

  it('does not block a non-autopilot session', () => {
    const { deps } = makeDeps();
    const blocked = enforceAutopilotExpiry({
      deps,
      session: { id: 's1', session_mode: 'chat' } as SessionRow,
    }).blocked;
    expect(blocked).toBe(false);
  });

  it('does not block a running autopilot session before its deadline', () => {
    const { deps, updateSessionAutopilotConfig } = makeDeps();
    const cfg = runningConfig(); // 4h from now
    const blocked = enforceAutopilotExpiry({
      deps,
      session: {
        id: 's1',
        session_mode: 'autopilot',
        autopilot_session_config: JSON.stringify(cfg),
      } as SessionRow,
    }).blocked;
    expect(blocked).toBe(false);
    expect(updateSessionAutopilotConfig).not.toHaveBeenCalled();
  });

  it('blocks, persists expiry, and posts a notice when the deadline has passed', () => {
    const cfg = {
      ...runningConfig(),
      startedAt: '2020-01-01T00:00:00.000Z',
      deadlineAt: '2020-01-01T01:00:00.000Z',
    };
    const { deps, updateSessionAutopilotConfig, addMessage } = makeDeps(cfg);
    const blocked = enforceAutopilotExpiry({
      deps,
      session: {
        id: 's1',
        session_mode: 'autopilot',
        autopilot_session_config: JSON.stringify(cfg),
      } as SessionRow,
    }).blocked;
    expect(blocked).toBe(true);
    expect(updateSessionAutopilotConfig).toHaveBeenCalledTimes(1);
    expect(JSON.parse(updateSessionAutopilotConfig.mock.calls[0][0]).status).toBe('expired');
    expect(addMessage).toHaveBeenCalledTimes(1);
  });

  it('posts the stop notice once when two gates race on the same stale snapshot', () => {
    const cfg = {
      ...runningConfig(),
      startedAt: '2020-01-01T00:00:00.000Z',
      deadlineAt: '2020-01-01T01:00:00.000Z',
    };
    const { deps, addMessage, row } = makeDeps(cfg);
    const snapshot = {
      id: 's1',
      session_mode: 'autopilot',
      autopilot_session_config: JSON.stringify(cfg),
    } as SessionRow;
    expect(enforceAutopilotExpiry({ deps, session: snapshot }).blocked).toBe(true);
    expect(enforceAutopilotExpiry({ deps, session: snapshot }).blocked).toBe(true);
    expect(addMessage).toHaveBeenCalledTimes(1);
    expect(row.stored().status).toBe('expired');
  });

  it('keeps an owed mainline slot when the run expires', () => {
    const slot = {
      phase: 'deploying',
      attemptId: 'a1',
      sha: 'd'.repeat(40),
      deploymentId: 'dep-1',
      outcome: null,
      escalatedAt: null,
      enteredAt: null,
    };
    const cfg = {
      ...runningConfig(),
      startedAt: '2020-01-01T00:00:00.000Z',
      deadlineAt: '2020-01-01T01:00:00.000Z',
      target: 'mainline',
      mainline: { deployEnvironment: 'prod', landedCount: 1, slot },
    };
    const { deps, row } = makeDeps(cfg);
    enforceAutopilotExpiry({
      deps,
      session: {
        id: 's1',
        session_mode: 'autopilot',
        autopilot_session_config: JSON.stringify(cfg),
      } as SessionRow,
    });
    expect(row.stored()).toMatchObject({ status: 'expired', mainline: { slot } });
  });

  it('blocks an already-stopped autopilot session without re-posting', () => {
    const { deps, addMessage } = makeDeps();
    const cfg = { ...runningConfig(), status: 'expired' as const };
    const blocked = enforceAutopilotExpiry({
      deps,
      session: {
        id: 's1',
        session_mode: 'autopilot',
        autopilot_session_config: JSON.stringify(cfg),
      } as SessionRow,
    }).blocked;
    expect(blocked).toBe(true);
    expect(addMessage).not.toHaveBeenCalled();
  });
});

describe('buildAutopilotKickoffMessage', () => {
  it('includes the named branch and never-merge instruction', () => {
    const cfg = runningConfig();
    const text = buildAutopilotKickoffMessage(cfg);
    expect(text).toContain(cfg.branch);
    expect(text).toContain('never merge');
    expect(text).toContain(cfg.brief);
  });
});
