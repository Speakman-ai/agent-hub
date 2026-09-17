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

const { buildAutopilotModePreamble, scheduleAutopilotAfterPush, startAutopilotConfig } =
  await import('./session-autopilot.js');

function runningConfig(overrides: Record<string, unknown> = {}) {
  return startAutopilotConfig({
    durationHours: 4,
    brief: 'Harden the 3D print UI',
    goal: 'Baseline journeys pass on preview',
    escalation: 'medium',
    branch: 'autopilot/print-ui',
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
        branch: 'autopilot/x',
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
      branch: 'autopilot/x',
    });
    expect(cfg.deadlineAt).toBeNull();
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
    const persist = vi.fn();
    const cfg = runningConfig();
    const session = {
      id: 's1',
      agent_id: 'agent-1',
      session_mode: 'autopilot',
      autopilot_session_config: JSON.stringify(cfg),
    } as SessionRow;

    scheduleAutopilotAfterPush({
      deps: {
        stmts: {
          updateSessionAutopilotConfig: { run: persist },
          getSession: { get: vi.fn(() => session) },
        },
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
    expect(persist).toHaveBeenCalled();
    const stored = JSON.parse(persist.mock.calls[0][0]);
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

  it('stops with a notice when the wall clock has expired', async () => {
    const handleChat = vi.fn().mockResolvedValue(undefined);
    const cfg = {
      ...runningConfig(),
      startedAt: '2020-01-01T00:00:00.000Z',
      deadlineAt: '2020-01-01T01:00:00.000Z',
    };
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
      session: {
        id: 's1',
        agent_id: 'agent-1',
        session_mode: 'autopilot',
        autopilot_session_config: JSON.stringify(cfg),
      } as SessionRow,
      sha: 'abc123',
      branch: cfg.branch,
    });

    await vi.waitFor(() => expect(handleChat).toHaveBeenCalledTimes(1));
    expect(mocks.startSessionPreview).not.toHaveBeenCalled();
    expect(handleChat.mock.calls[0][1].content).toContain('time ran out');
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
