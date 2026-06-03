import { describe, expect, it, vi } from 'vitest';
import { createDispatchAndWaitForTurnEnd } from './dispatch-and-wait.js';
import {
  finalizeTurnEndSubscriber,
  notifyFinalizeSessionTurnEnd,
  __testResetFinalizeTurnEndListeners,
} from './turn-end.js';

describe('createDispatchAndWaitForTurnEnd', () => {
  it('persists a system message and resolves on turn-end', async () => {
    __testResetFinalizeTurnEndListeners();
    const stmts = {
      addMessage: { run: vi.fn() },
      getMessageById: {
        get: vi.fn(() => ({
          id: 'msg-1',
          session_id: 'sess-1',
          role: 'system',
          content: 'resolve conflicts',
        })),
      },
      touchSession: { run: vi.fn() },
    };
    const broadcast = vi.fn();
    const dispatch = createDispatchAndWaitForTurnEnd({
      stmts: stmts as never,
      broadcast,
      turnEnd: finalizeTurnEndSubscriber,
      newId: () => 'msg-1',
    });

    const promise = dispatch({
      sessionId: 'sess-1',
      cardId: 'card-1',
      body: 'resolve conflicts',
    });

    expect(stmts.addMessage.run).toHaveBeenCalled();
    notifyFinalizeSessionTurnEnd('sess-1');
    const result = await promise;
    expect(result.userMessagePersisted).toBe(true);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message', sessionId: 'sess-1' }),
    );
  });
});
