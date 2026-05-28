import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SHIP_SKILL_ID,
  SHIP_CLI_PROMPT,
  SHIP_AUTO_CLI_PROMPT,
  SHIP_SYSTEM_MESSAGE,
  SHIP_AUTO_SYSTEM_MESSAGE,
  buildShipRequestedMetadata,
  parseShipRequestedMetadata,
  shouldAutoShipSessionAtEnd,
  triggerSessionShip,
} from './session-ship.js';
import type { SessionRow } from './types.js';

vi.mock('./skill-invoke.js', () => ({
  loadSkillByName: vi.fn(() => '# Create ticket & PR\n\nSkill body'),
}));

vi.mock('./project-paths.js', () => ({
  resolveWorkspaceSkillsDir: vi.fn(() => '/tmp/skills'),
}));

vi.mock('./project-mode.js', () => ({
  getProjectMode: vi.fn(() => 'kanban'),
}));

vi.mock('./session-title-pr.js', () => ({
  isResolvePrSessionTitle: vi.fn(() => false),
}));

describe('session-ship metadata', () => {
  it('round-trips ship_requested metadata', () => {
    const raw = buildShipRequestedMetadata();
    const parsed = parseShipRequestedMetadata(raw);
    expect(parsed).toEqual({ kind: 'ship_requested', skillId: SHIP_SKILL_ID });
  });

  it('includes auto flag for auto_session_end', () => {
    const parsed = parseShipRequestedMetadata(buildShipRequestedMetadata('auto_session_end'));
    expect(parsed?.auto).toBe(true);
  });

  it('returns null for unrelated metadata', () => {
    expect(parseShipRequestedMetadata(JSON.stringify({ kind: 'pr_created' }))).toBeNull();
    expect(parseShipRequestedMetadata('not-json')).toBeNull();
  });
});

describe('shouldAutoShipSessionAtEnd', () => {
  it('auto-ships when session.auto_ship_on_complete is set', () => {
    const session = { auto_ship_on_complete: 1 } as SessionRow;
    expect(shouldAutoShipSessionAtEnd(session, undefined)).toBe(true);
  });

  it('auto-ships legacy autonomous dispatch cards', () => {
    expect(shouldAutoShipSessionAtEnd(undefined, { dispatched_by_autonomous: 1 })).toBe(true);
  });

  it('does not auto-ship ad-hoc sessions', () => {
    expect(shouldAutoShipSessionAtEnd({ auto_ship_on_complete: 0 } as SessionRow, undefined)).toBe(
      false,
    );
    expect(shouldAutoShipSessionAtEnd(undefined, { dispatched_by_autonomous: 0 })).toBe(false);
  });
});

describe('triggerSessionShip', () => {
  const baseSession = {
    id: 'sess-1',
    agent_id: 'agent-1',
    worktree_path: '/wt/sess-1',
    name: 'Ad-hoc',
  } as SessionRow;

  const stmts = {
    updateSessionPendingSkillContext: { run: vi.fn() },
    addMessage: { run: vi.fn() },
    touchSession: { run: vi.fn() },
    getMessageById: { get: vi.fn(() => undefined) },
  };

  const broadcast = vi.fn();
  const handleChat = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists a system callout and starts handleChat without user message persist', async () => {
    const result = triggerSessionShip({
      sessionId: 'sess-1',
      session: baseSession,
      project: { id: 'p1' } as never,
      agent: { id: 'agent-1' } as never,
      stmts: stmts as never,
      broadcast,
      activeProcesses: new Map(),
      handleChat,
    });

    expect(result).toEqual({ ok: true });
    expect(stmts.updateSessionPendingSkillContext.run).toHaveBeenCalled();
    expect(stmts.addMessage.run).toHaveBeenCalledWith(
      expect.any(String),
      'sess-1',
      'system',
      SHIP_SYSTEM_MESSAGE,
      null,
      null,
      null,
      buildShipRequestedMetadata('manual'),
      null,
      null,
      null,
    );
    expect(handleChat).toHaveBeenCalledWith(null, {
      type: 'chat',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      content: SHIP_CLI_PROMPT,
      _skipUserMessagePersist: true,
    });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({ role: 'system' }),
      }),
    );
  });

  it('uses auto prompts when source is auto_session_end', () => {
    triggerSessionShip({
      sessionId: 'sess-1',
      session: baseSession,
      project: { id: 'p1' } as never,
      agent: { id: 'agent-1' } as never,
      stmts: stmts as never,
      broadcast,
      activeProcesses: new Map(),
      handleChat,
      source: 'auto_session_end',
    });
    expect(stmts.addMessage.run).toHaveBeenCalledWith(
      expect.any(String),
      'sess-1',
      'system',
      SHIP_AUTO_SYSTEM_MESSAGE,
      null,
      null,
      null,
      buildShipRequestedMetadata('auto_session_end'),
      null,
      null,
      null,
    );
    expect(handleChat).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ content: SHIP_AUTO_CLI_PROMPT }),
    );
  });

  it('rejects when session is still streaming', () => {
    const active = new Map([['sess-1', {} as never]]);
    const result = triggerSessionShip({
      sessionId: 'sess-1',
      session: baseSession,
      project: { id: 'p1' } as never,
      agent: { id: 'agent-1' } as never,
      stmts: stmts as never,
      broadcast,
      activeProcesses: active,
      handleChat,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('session_streaming');
    expect(handleChat).not.toHaveBeenCalled();
  });
});
