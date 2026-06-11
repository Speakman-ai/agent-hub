import { describe, expect, it, vi } from 'vitest';
import { createDispatchAndWaitForTurnEnd } from './dispatch-and-wait.js';
import {
  finalizeTurnEndSubscriber,
  notifyFinalizeSessionTurnEnd,
  __testResetFinalizeTurnEndListeners,
  __testFinalizeTurnEndListenerCount,
} from './turn-end.js';

function makeStmts() {
  return {
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
}

describe('createDispatchAndWaitForTurnEnd', () => {
  it('persists a system message and resolves on turn-end', async () => {
    __testResetFinalizeTurnEndListeners();
    const stmts = makeStmts();
    const broadcast = vi.fn();
    // Spawn that emulates the real handleChat path: ending the agent turn
    // fires the turn-end bus, which is what unblocks the wait.
    const spawnTurn = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      notifyFinalizeSessionTurnEnd(sessionId);
      return { spawned: true };
    });
    const dispatch = createDispatchAndWaitForTurnEnd({
      stmts: stmts as never,
      broadcast,
      turnEnd: finalizeTurnEndSubscriber,
      spawnTurn,
      newId: () => 'msg-1',
    });

    const result = await dispatch({
      sessionId: 'sess-1',
      cardId: 'card-1',
      body: 'resolve conflicts',
    });

    expect(stmts.addMessage.run).toHaveBeenCalled();
    expect(result.userMessagePersisted).toBe(true);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message', sessionId: 'sess-1' }),
    );
  });

  it('spawns the session agent with the conflict body so the run self-heals', async () => {
    // Regression: the rebase-conflict dispatch used to persist the message
    // and passively wait for a turn-end that nothing triggered, so an
    // automated Finalize run hung until the active-time budget expired.
    // The fix is to spawn the session agent with the conflict body.
    __testResetFinalizeTurnEndListeners();
    const stmts = makeStmts();
    const spawnTurn = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      notifyFinalizeSessionTurnEnd(sessionId);
      return { spawned: true };
    });
    const dispatch = createDispatchAndWaitForTurnEnd({
      stmts: stmts as never,
      broadcast: vi.fn(),
      turnEnd: finalizeTurnEndSubscriber,
      spawnTurn,
      newId: () => 'msg-1',
    });

    const result = await dispatch({
      sessionId: 'sess-1',
      cardId: 'card-1',
      body: '## conflict body',
    });

    expect(spawnTurn).toHaveBeenCalledWith({ sessionId: 'sess-1', body: '## conflict body' });
    expect(result.userMessagePersisted).toBe(true);
    // No listener should be left registered after the wait settles.
    expect(__testFinalizeTurnEndListenerCount('sess-1')).toBe(0);
  });

  it('resolves with userMessagePersisted=false when the agent spawn never starts', async () => {
    // A failed spawn must unblock the wait (so the rebase phase terminates
    // as rebase_aborted) instead of hanging until the budget timeout.
    __testResetFinalizeTurnEndListeners();
    const stmts = makeStmts();
    const spawnTurn = vi.fn(async () => ({ spawned: false }));
    const dispatch = createDispatchAndWaitForTurnEnd({
      stmts: stmts as never,
      broadcast: vi.fn(),
      turnEnd: finalizeTurnEndSubscriber,
      spawnTurn,
      newId: () => 'msg-1',
    });

    const result = await dispatch({
      sessionId: 'sess-1',
      cardId: 'card-1',
      body: 'resolve conflicts',
    });

    expect(spawnTurn).toHaveBeenCalled();
    expect(result.userMessagePersisted).toBe(false);
    expect(__testFinalizeTurnEndListenerCount('sess-1')).toBe(0);
  });

  it('resolves false when the spawn throws', async () => {
    __testResetFinalizeTurnEndListeners();
    const stmts = makeStmts();
    const spawnTurn = vi.fn(async () => {
      throw new Error('handleChat blew up');
    });
    const dispatch = createDispatchAndWaitForTurnEnd({
      stmts: stmts as never,
      broadcast: vi.fn(),
      turnEnd: finalizeTurnEndSubscriber,
      spawnTurn,
      newId: () => 'msg-1',
    });

    const result = await dispatch({
      sessionId: 'sess-1',
      cardId: 'card-1',
      body: 'resolve conflicts',
    });

    expect(result.userMessagePersisted).toBe(false);
    expect(__testFinalizeTurnEndListenerCount('sess-1')).toBe(0);
  });

  it('without spawnTurn wired, still persists and waits passively for a manual turn-end', async () => {
    // Back-compat: legacy callers / tests that drive turn-end manually.
    __testResetFinalizeTurnEndListeners();
    const stmts = makeStmts();
    const dispatch = createDispatchAndWaitForTurnEnd({
      stmts: stmts as never,
      broadcast: vi.fn(),
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
  });

  it('returns false without persisting when the body is empty', async () => {
    __testResetFinalizeTurnEndListeners();
    const stmts = makeStmts();
    const spawnTurn = vi.fn();
    const dispatch = createDispatchAndWaitForTurnEnd({
      stmts: stmts as never,
      broadcast: vi.fn(),
      turnEnd: finalizeTurnEndSubscriber,
      spawnTurn: spawnTurn as never,
      newId: () => 'msg-1',
    });

    const result = await dispatch({ sessionId: 'sess-1', cardId: 'card-1', body: '   ' });
    expect(result.userMessagePersisted).toBe(false);
    expect(stmts.addMessage.run).not.toHaveBeenCalled();
    expect(spawnTurn).not.toHaveBeenCalled();
  });
});
