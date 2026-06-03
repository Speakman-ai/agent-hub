import { describe, expect, it, vi } from 'vitest';
import { FINALIZE_FIX_TURN_USER_PROMPT, createSpawnFinalizeFixTurn } from './spawn-fix-turn.js';

describe('createSpawnFinalizeFixTurn', () => {
  it('calls handleChat for the session owner with skip-user-persist', async () => {
    const handleChat = vi.fn().mockResolvedValue(undefined);
    const spawn = createSpawnFinalizeFixTurn({
      stmts: {
        getSession: {
          get: vi.fn(() => ({ agent_id: 'lead-1' })),
        },
      } as never,
      findAgent: vi.fn(() => ({ agent: { id: 'lead-1' } })),
      handleChat,
    });

    const result = await spawn({ sessionId: 'sess-1', body: 'full dispatch body' });

    expect(result.spawned).toBe(true);
    expect(handleChat).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        type: 'chat',
        agentId: 'lead-1',
        sessionId: 'sess-1',
        content: FINALIZE_FIX_TURN_USER_PROMPT,
        _skipUserMessagePersist: true,
      }),
    );
  });

  it('returns spawned:false when session is missing', async () => {
    const spawn = createSpawnFinalizeFixTurn({
      stmts: { getSession: { get: vi.fn(() => undefined) } } as never,
      findAgent: vi.fn(),
      handleChat: vi.fn(),
    });
    const result = await spawn({ sessionId: 'sess-missing', body: 'x' });
    expect(result.spawned).toBe(false);
  });
});
