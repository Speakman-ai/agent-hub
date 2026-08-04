import './test/setup.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { getStmts } from './db.js';
import {
  appendRunCancelledSystemMessage,
  buildRunCancelledSystemMessage,
  consumeSessionTermination,
  finalizeChatRunAfterTermination,
  formatChatExitLog,
  isSignalTermination,
  markSessionTermination,
  resolveChatTerminationOnClose,
} from './process-termination.js';

describe('process-termination', () => {
  beforeEach(() => {
    // Drain any markers leaked across tests.
    const orphan = `orphan-${randomUUID()}`;
    markSessionTermination(orphan, 'user_cancel');
    consumeSessionTermination(orphan);
  });

  it('detects SIGTERM via signal name and shell exit 143', () => {
    expect(isSignalTermination(null, 'SIGTERM')).toBe(true);
    expect(isSignalTermination(143, null)).toBe(true);
    expect(isSignalTermination(null, 'SIGINT')).toBe(true);
    expect(isSignalTermination(130, null)).toBe(true);
    expect(isSignalTermination(0, null)).toBe(false);
    expect(isSignalTermination(1, null)).toBe(false);
  });

  it('mark/consume returns the reason once', () => {
    const sessionId = `term-${randomUUID()}`;
    markSessionTermination(sessionId, 'user_cancel');
    expect(consumeSessionTermination(sessionId)).toBe('user_cancel');
    expect(consumeSessionTermination(sessionId)).toBeNull();
  });

  it('resolveChatTerminationOnClose consumes a pending marker', () => {
    const sessionId = `term-close-${randomUUID()}`;
    markSessionTermination(sessionId, 'chat_interrupt');
    const resolved = resolveChatTerminationOnClose(sessionId, null, 'SIGTERM');
    expect(resolved).toEqual({ terminated: true, reason: 'chat_interrupt' });
    expect(consumeSessionTermination(sessionId)).toBeNull();
  });

  it('resolveChatTerminationOnClose falls back to unknown_signal', () => {
    const sessionId = `term-unknown-${randomUUID()}`;
    const resolved = resolveChatTerminationOnClose(sessionId, 143, null);
    expect(resolved).toEqual({ terminated: true, reason: 'unknown_signal' });
  });

  it('formatChatExitLog includes source when reason is known', () => {
    const line = formatChatExitLog({
      engine: 'claude-code',
      sessionId: 'sess-1',
      code: 143,
      signal: null,
      reason: 'user_cancel',
    });
    expect(line).toContain('source=user_cancel');
    expect(line).toContain('code=143');
  });

  it('buildRunCancelledSystemMessage uses the required prefix', () => {
    expect(buildRunCancelledSystemMessage('user_cancel')).toBe(
      'Run cancelled — reason: you cancelled the run (Stop / Cancel)',
    );
  });

  it('cancel pipeline: mark user_cancel → SIGTERM close → system message in transcript', () => {
    const stmts = getStmts();
    const agentId = `term-pipe-${randomUUID().slice(0, 8)}`;
    const sessionId = `term-pipe-${randomUUID().slice(0, 8)}`;
    stmts.createSession.run(
      sessionId,
      agentId,
      'cancel pipeline test',
      'claude-code',
      'claude-opus-4-8',
      0,
      0,
      1,
    );

    markSessionTermination(sessionId, 'user_cancel');
    const termination = resolveChatTerminationOnClose(sessionId, null, 'SIGTERM');
    expect(termination?.reason).toBe('user_cancel');

    appendRunCancelledSystemMessage(
      { stmts, broadcast: () => undefined },
      sessionId,
      termination!.reason,
    );

    const messages = stmts.getMessages.all(sessionId) as Array<{ role: string; content: string }>;
    expect(
      messages.some(
        (m) =>
          m.role === 'system' &&
          m.content === 'Run cancelled — reason: you cancelled the run (Stop / Cancel)',
      ),
    ).toBe(true);
  });

  it('finalizeChatRunAfterTermination saves partial assistant without continuation hooks', () => {
    const stmts = getStmts();
    const agentId = `term-part-${randomUUID().slice(0, 8)}`;
    const sessionId = `term-part-${randomUUID().slice(0, 8)}`;
    const assistantMsgId = `term-asst-${randomUUID().slice(0, 8)}`;
    stmts.createSession.run(
      sessionId,
      agentId,
      'partial cancel test',
      'claude-code',
      'claude-opus-4-8',
      0,
      0,
      1,
    );

    const broadcasts: Array<Record<string, unknown>> = [];
    finalizeChatRunAfterTermination({
      stmts,
      broadcast: (msg) => {
        broadcasts.push(msg as Record<string, unknown>);
      },
      sessionId,
      assistantMsgId,
      engine: 'claude-code',
      model: 'claude-opus-4-8',
      agentId,
      agentName: 'Partial agent',
      assembled: 'Partial answer before cancel.',
    });

    const messages = stmts.getMessages.all(sessionId) as Array<{
      id: string;
      role: string;
      content: string;
    }>;
    expect(messages.some((m) => m.id === assistantMsgId && m.role === 'assistant')).toBe(true);
    expect(broadcasts.some((b) => b.type === 'done' && b.messageId === assistantMsgId)).toBe(true);
    expect(broadcasts.some((b) => b.type === 'chat')).toBe(false);
  });

  // Regression: "Sessions kill processes but continue to wait". A hub kill that
  // landed before the CLI produced any assistant text broadcast nothing
  // terminal — `finalizeChatRunAfterTermination` returned early on empty
  // partial content. The client gates its streaming indicator on
  // `done`/`error`/`interrupted`, so every tab except the one that pressed Stop
  // kept the green "streaming" dot and the Interrupt badge indefinitely.
  it('finalizeChatRunAfterTermination emits a terminal frame when there is no partial output', () => {
    const stmts = getStmts();
    const agentId = `term-empty-${randomUUID().slice(0, 8)}`;
    const sessionId = `term-empty-${randomUUID().slice(0, 8)}`;
    const assistantMsgId = `term-empty-asst-${randomUUID().slice(0, 8)}`;
    stmts.createSession.run(
      sessionId,
      agentId,
      'empty cancel test',
      'claude-code',
      'claude-opus-4-8',
      0,
      0,
      1,
    );

    const broadcasts: Array<Record<string, unknown>> = [];
    finalizeChatRunAfterTermination({
      stmts,
      broadcast: (msg) => {
        broadcasts.push(msg as Record<string, unknown>);
      },
      sessionId,
      assistantMsgId,
      engine: 'claude-code',
      model: 'claude-opus-4-8',
      agentId,
      agentName: 'Empty agent',
      assembled: '',
    });

    expect(broadcasts.some((b) => b.type === 'interrupted' && b.sessionId === sessionId)).toBe(
      true,
    );
    // No assistant text means no phantom empty message.
    const messages = stmts.getMessages.all(sessionId) as Array<{ id: string }>;
    expect(messages.some((m) => m.id === assistantMsgId)).toBe(false);
  });

  it('finalizeChatRunAfterTermination emits the terminal frame even when the partial save throws', () => {
    const stmts = getStmts();
    const sessionId = `term-throw-${randomUUID().slice(0, 8)}`;
    const broadcasts: Array<Record<string, unknown>> = [];
    const throwingStmts = {
      ...stmts,
      addMessage: {
        run: () => {
          throw new Error('disk full');
        },
      },
    } as unknown as typeof stmts;

    finalizeChatRunAfterTermination({
      stmts: throwingStmts,
      broadcast: (msg) => {
        broadcasts.push(msg as Record<string, unknown>);
      },
      sessionId,
      assistantMsgId: 'asst-throw',
      engine: 'claude-code',
      model: null,
      agentId: 'agent-throw',
      agentName: 'Throwing agent',
      assembled: 'Some partial text.',
    });

    expect(broadcasts.some((b) => b.type === 'interrupted' && b.sessionId === sessionId)).toBe(
      true,
    );
  });

  it('chat termination path recomputes session state so the sidebar glyph converges', async () => {
    const { readFile } = await import('fs/promises');
    const src = await readFile(new URL('./chat.ts', import.meta.url), 'utf8');
    const termIdx = src.indexOf('finalizeChatRunAfterTermination({');
    expect(termIdx).toBeGreaterThan(-1);
    const returnIdx = src.indexOf('return;', termIdx);
    const between = src.slice(termIdx, returnIdx);
    expect(between).toMatch(/recomputeSessionState\(stmts, sessionId/);
  });

  it('chat close handler bails out before shouldAutoContinue when termination is set', async () => {
    const { readFile } = await import('fs/promises');
    const src = await readFile(new URL('./chat.ts', import.meta.url), 'utf8');
    const termIdx = src.indexOf('if (termination) {');
    const autoIdx = src.indexOf('shouldAutoContinue = budgetResult.ok');
    expect(termIdx).toBeGreaterThan(-1);
    expect(autoIdx).toBeGreaterThan(termIdx);
    const between = src.slice(termIdx, autoIdx);
    expect(between).toMatch(/finalizeChatRunAfterTermination\(/);
    expect(between).toMatch(/drainQueue\(sessionId\);\s*\n\s*return;/);
  });

  it('appendRunCancelledSystemMessage persists a system role row', () => {
    const stmts = getStmts();
    const agentId = `term-agent-${randomUUID().slice(0, 8)}`;
    const sessionId = `term-sess-${randomUUID().slice(0, 8)}`;
    stmts.createSession.run(
      sessionId,
      agentId,
      'termination test',
      'claude-code',
      'claude-opus-4-8',
      0,
      0,
      1,
    );

    const broadcasts: Array<Record<string, unknown>> = [];
    appendRunCancelledSystemMessage(
      {
        stmts,
        broadcast: (msg) => {
          broadcasts.push(msg as Record<string, unknown>);
        },
      },
      sessionId,
      'user_cancel',
    );

    const messages = stmts.getMessages.all(sessionId) as Array<{ role: string; content: string }>;
    const system = messages.find((m) => m.role === 'system');
    expect(system?.content).toContain('Run cancelled — reason:');
    expect(system?.content).toContain('Stop / Cancel');
    expect(broadcasts.some((b) => b.type === 'message')).toBe(true);
  });
});
