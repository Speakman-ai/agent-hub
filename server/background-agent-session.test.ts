/**
 * "Run as session" dispatch for custom background agents: the session row is
 * created under the right agent, the chosen mode maps onto session_mode +
 * finalize_automation, chosen skills are staged for the first turn, and the
 * prompt is kicked off through the late-bound handleChat (mocked, no CLI).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Stmts } from './types.js';

const mocks = vi.hoisted(() => ({
  loadSkillByName: vi.fn(),
  setSessionOwner: vi.fn(),
}));

vi.mock('./skill-invoke.js', () => ({ loadSkillByName: mocks.loadSkillByName }));
vi.mock('./session-ownership.js', () => ({ setSessionOwner: mocks.setSessionOwner }));
vi.mock('./session-checkpoint-rewind.js', () => ({ broadcastSessionCreated: vi.fn() }));
vi.mock('./effective-model.js', () => ({
  resolveEffectiveEngineAndModel: () => ({ engine: 'claude-code', model: 'claude-opus-5-5' }),
}));
vi.mock('./project-paths.js', () => ({ resolveWorkspaceSkillsDir: () => '/tmp/skills' }));

const {
  dispatchBackgroundAgentSession,
  initBackgroundAgentSessionHook,
  resetBackgroundAgentSessionHook,
  resolveBackgroundSessionControl,
  pickBackgroundSessionAgent,
  BackgroundSessionDispatchError,
} = await import('./background-agent-session.js');

function fakeStmts() {
  return {
    createSession: { run: vi.fn() },
    updateSessionMode: { run: vi.fn() },
    updateSessionFinalizeAutomation: { run: vi.fn() },
    updateSessionPendingSkillContext: { run: vi.fn() },
    getSession: { get: vi.fn(() => ({ id: 's' })) },
  };
}

function proj(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'P',
    cwd: '/tmp/p1',
    ahw: '/tmp/p1/.ahw',
    agents: [
      { id: 'docs', name: 'Docs', role: 'docs', engine: 'claude-code' },
      { id: 'dev', name: 'Dev', role: 'dev', engine: 'claude-code' },
      { id: 'dev2', name: 'Dev 2', role: 'dev', engine: 'claude-code' },
    ],
    ...over,
  } as unknown as Project;
}

describe('resolveBackgroundSessionControl', () => {
  it('maps build levels to chat mode and modes to manual finalize', () => {
    expect(resolveBackgroundSessionControl('merge')).toEqual({
      sessionMode: 'chat',
      finalizeAutomation: 'merge',
    });
    expect(resolveBackgroundSessionControl('consult')).toEqual({
      sessionMode: 'consult',
      finalizeAutomation: 'manual',
    });
    expect(resolveBackgroundSessionControl('autopilot')).toEqual({
      sessionMode: 'autopilot',
      finalizeAutomation: 'push',
    });
    expect(resolveBackgroundSessionControl('bogus').finalizeAutomation).toBe('manual');
  });
});

describe('pickBackgroundSessionAgent', () => {
  it('defaults to the first eligible agent and refuses helper roles', () => {
    expect(pickBackgroundSessionAgent(proj(), null)?.id).toBe('dev');
    expect(pickBackgroundSessionAgent(proj(), 'dev2')?.id).toBe('dev2');
    expect(pickBackgroundSessionAgent(proj(), 'docs')).toBeNull();
  });
});

describe('dispatchBackgroundAgentSession', () => {
  let stmts: ReturnType<typeof fakeStmts>;
  let handleChat: ReturnType<typeof vi.fn<(ws: unknown, msg: unknown) => Promise<void>>>;

  beforeEach(() => {
    vi.clearAllMocks();
    stmts = fakeStmts();
    handleChat = vi.fn<(ws: unknown, msg: unknown) => Promise<void>>().mockResolvedValue(undefined);
    initBackgroundAgentSessionHook({
      stmts: stmts as unknown as Stmts,
      config: {} as never,
      handleChat,
      broadcast: vi.fn(),
    });
    mocks.loadSkillByName.mockImplementation(({ name }: { name: string }) =>
      name === 'missing' ? '## Skill Load Error\nnope' : `## Loaded Skill: ${name}`,
    );
  });

  it('creates the session in the chosen mode with skills staged and the prompt sent', () => {
    const result = dispatchBackgroundAgentSession(proj(), {
      id: 'a1',
      name: 'Triage',
      prompt: 'Triage new cards',
      ownerUserId: 'user-9',
      runAsSession: true,
      sessionMode: 'consult',
      sessionAgentId: 'dev2',
      skills: ['agent-hub-kanban', 'missing'],
    });

    expect(result.agentId).toBe('dev2');
    expect(result.skippedSkills).toEqual(['missing']);
    const createArgs = stmts.createSession.run.mock.calls[0]!;
    expect(createArgs[1]).toBe('dev2');
    expect(createArgs[2]).toBe('[Background] Triage');
    expect(mocks.setSessionOwner).toHaveBeenCalledWith(result.sessionId, 'user-9');
    expect(stmts.updateSessionMode.run).toHaveBeenCalledWith('consult', result.sessionId);
    expect(stmts.updateSessionFinalizeAutomation.run).toHaveBeenCalledWith(
      'manual',
      result.sessionId,
    );
    expect(stmts.updateSessionPendingSkillContext.run).toHaveBeenCalledWith(
      '## Loaded Skill: agent-hub-kanban',
      result.sessionId,
    );
    expect(handleChat).toHaveBeenCalledWith(null, {
      type: 'chat',
      agentId: 'dev2',
      sessionId: result.sessionId,
      content: 'Triage new cards',
    });
  });

  it('leaves build-level sessions in chat mode', () => {
    const result = dispatchBackgroundAgentSession(proj(), {
      id: 'a1',
      name: 'Fixer',
      prompt: 'Fix lint',
      runAsSession: true,
      sessionMode: 'push',
    });
    expect(stmts.updateSessionMode.run).not.toHaveBeenCalled();
    expect(stmts.updateSessionFinalizeAutomation.run).toHaveBeenCalledWith(
      'push',
      result.sessionId,
    );
    expect(stmts.updateSessionPendingSkillContext.run).not.toHaveBeenCalled();
  });

  it('rejects ship levels on workflow projects', () => {
    expect(() =>
      dispatchBackgroundAgentSession(proj({ mode: 'workflow' } as Partial<Project>), {
        id: 'a1',
        name: 'X',
        prompt: 'x',
        sessionMode: 'merge',
      }),
    ).toThrow(BackgroundSessionDispatchError);
    expect(stmts.createSession.run).not.toHaveBeenCalled();
  });

  it.each([undefined, null])(
    'defaults a workflow project with sessionMode=%s to consult',
    (sessionMode) => {
      const result = dispatchBackgroundAgentSession(
        proj({ mode: 'workflow' } as Partial<Project>),
        {
          id: 'a1',
          name: 'X',
          prompt: 'x',
          runAsSession: true,
          sessionMode,
        },
      );
      expect(stmts.updateSessionMode.run).toHaveBeenCalledWith('consult', result.sessionId);
      expect(stmts.updateSessionFinalizeAutomation.run).toHaveBeenCalledWith(
        'manual',
        result.sessionId,
      );
    },
  );

  it('defaults a dev project with no sessionMode to Build (chat + manual)', () => {
    const result = dispatchBackgroundAgentSession(proj(), {
      id: 'a1',
      name: 'X',
      prompt: 'x',
      runAsSession: true,
    });
    expect(stmts.updateSessionMode.run).not.toHaveBeenCalled();
    expect(stmts.updateSessionFinalizeAutomation.run).toHaveBeenCalledWith(
      'manual',
      result.sessionId,
    );
  });

  it('reports a rejected first turn through onKickoffError', async () => {
    handleChat.mockRejectedValue(new Error('engine unavailable'));
    const onKickoffError = vi.fn();
    dispatchBackgroundAgentSession(
      proj(),
      { id: 'a1', name: 'X', prompt: 'x', runAsSession: true },
      { onKickoffError },
    );
    await vi.waitFor(() => expect(onKickoffError).toHaveBeenCalledWith('engine unavailable'));
  });

  it('throws when the hook is not wired', () => {
    resetBackgroundAgentSessionHook();
    expect(() =>
      dispatchBackgroundAgentSession(proj(), { id: 'a1', name: 'X', prompt: 'x' }),
    ).toThrow(/not initialised/);
  });
});
