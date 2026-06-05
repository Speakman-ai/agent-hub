import { describe, expect, it, vi } from 'vitest';
import {
  FINALIZE_FIX_TURN_USER_PROMPT,
  composeFixTurnContent,
  createSpawnFinalizeFixTurn,
} from './spawn-fix-turn.js';

const REVIEWER_BODY = [
  'Finalize Code Changes: phase=review, reviewer requested changes.',
  '',
  'Reviewer notes:',
  '- server/session-state.ts:38 — merge detection uses the wrong column.',
  '',
  'Please address the reviewer feedback and commit.',
].join('\n');

describe('createSpawnFinalizeFixTurn', () => {
  it('sends the full dispatch body as the turn content (reviewer notes reach the CLI)', async () => {
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

    const result = await spawn({ sessionId: 'sess-1', body: REVIEWER_BODY });

    expect(result.spawned).toBe(true);
    expect(handleChat).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        type: 'chat',
        agentId: 'lead-1',
        sessionId: 'sess-1',
        // Regression: the agent must receive the actual reviewer notes in its
        // CLI turn, not a pointer to a system message it cannot see on resume.
        content: REVIEWER_BODY,
        _skipUserMessagePersist: true,
      }),
    );
    // The reviewer's actual finding is present in what the CLI receives.
    const sentContent = (handleChat.mock.calls[0]![1] as { content: string }).content;
    expect(sentContent).toContain('server/session-state.ts:38');
    expect(sentContent).not.toBe(FINALIZE_FIX_TURN_USER_PROMPT);
  });

  it('falls back to the generic prompt only when the body is empty', async () => {
    const handleChat = vi.fn().mockResolvedValue(undefined);
    const spawn = createSpawnFinalizeFixTurn({
      stmts: { getSession: { get: vi.fn(() => ({ agent_id: 'lead-1' })) } } as never,
      findAgent: vi.fn(() => ({ agent: { id: 'lead-1' } })),
      handleChat,
    });

    await spawn({ sessionId: 'sess-1', body: '   ' });

    expect(handleChat).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ content: FINALIZE_FIX_TURN_USER_PROMPT }),
    );
  });

  it('composeFixTurnContent prefers the body, trims, and falls back when blank', () => {
    expect(composeFixTurnContent('  notes here  ')).toBe('notes here');
    expect(composeFixTurnContent('')).toBe(FINALIZE_FIX_TURN_USER_PROMPT);
    expect(composeFixTurnContent(null)).toBe(FINALIZE_FIX_TURN_USER_PROMPT);
    expect(composeFixTurnContent(undefined)).toBe(FINALIZE_FIX_TURN_USER_PROMPT);
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
