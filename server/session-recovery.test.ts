import './test/setup.js';
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getStmts } from './db.js';
import { routeDeps } from './index.js';
import {
  beginSessionRecovery,
  allowSessionRecoveryTurn,
  endSessionRecovery,
  isSessionRecoveryBlockingChat,
} from './session-recovery.js';

describe('recovery dispatch suspension', () => {
  it('keeps queued messages through actual drain calls until recovery is complete', () => {
    const sessionId = randomUUID();
    const agentId = randomUUID();
    const messageId = randomUUID();
    const stmts = getStmts();
    stmts.createSession.run(sessionId, agentId, 'Recovery', 'claude-code', 'test', 0, 0, 1);
    stmts.enqueueMessage.run(messageId, sessionId, agentId, 'Queued work', null, 0, 0);
    beginSessionRecovery(sessionId);
    try {
      expect(isSessionRecoveryBlockingChat(sessionId)).toBe(true);
      routeDeps.drainSessionQueue!(sessionId);
      expect(stmts.getNextQueuedMessage.get(sessionId)).toMatchObject({ id: messageId });
      allowSessionRecoveryTurn(sessionId);
      expect(isSessionRecoveryBlockingChat(sessionId)).toBe(false);
      routeDeps.drainSessionQueue!(sessionId);
      expect(stmts.getNextQueuedMessage.get(sessionId)).toMatchObject({ id: messageId });
    } finally {
      endSessionRecovery(sessionId);
      stmts.clearSessionQueue.run(sessionId);
    }
    expect(isSessionRecoveryBlockingChat(sessionId)).toBe(false);
  });
});
