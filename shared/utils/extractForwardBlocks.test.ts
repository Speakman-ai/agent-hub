import { describe, expect, it } from 'vitest';
import {
  createSessionForwardTracker,
  extractForwardBlocks,
  initialSessionForwardMode,
  sessionForwardModesFor,
  sessionForwardStorageKey,
} from './extractForwardBlocks.js';

const PAYLOAD = {
  projectId: 'app',
  agentId: 'ada',
  name: 'Fix login',
  summary: 'Repair the expired-session redirect.',
  prompt: 'The login redirect drops the return path. Fix it and add a test.',
  mode: 'push',
};

function fence(body: unknown): string {
  return '```agenthub:forward\n' + JSON.stringify(body) + '\n```';
}

describe('extractForwardBlocks', () => {
  it('pulls a fenced card out of the surrounding prose', () => {
    const { strippedText, forwards } = extractForwardBlocks(
      `Handing this off.\n\n${fence(PAYLOAD)}\n\nI will stay here.`,
    );
    expect(forwards).toHaveLength(1);
    expect(forwards[0]).toMatchObject({
      projectId: 'app',
      agentId: 'ada',
      name: 'Fix login',
      mode: 'push',
      summary: 'Repair the expired-session redirect.',
    });
    expect(forwards[0].forwardId).toMatch(/^fwd-/);
    expect(strippedText).toBe('Handing this off.\n\nI will stay here.');
    expect(strippedText).not.toContain('agenthub:forward');
  });

  it('parses an XML card and keeps a prompt that contains a code fence', () => {
    const body = {
      ...PAYLOAD,
      prompt: 'Apply this:\n```ts\nconst n = 1;\n```\nthen test it.',
    };
    const text = `<agenthub:forward>${JSON.stringify(body)}</agenthub:forward>`;
    const { strippedText, forwards } = extractForwardBlocks(`Before\n${text}\nAfter`);
    expect(forwards[0].prompt).toContain('```ts');
    expect(strippedText).toBe('Before\n\nAfter');
  });

  it('leaves a partial fence and a nameless payload in the text', () => {
    const partial = '```agenthub:forward\n' + JSON.stringify(PAYLOAD);
    expect(extractForwardBlocks(partial).forwards).toEqual([]);
    expect(extractForwardBlocks(partial).strippedText).toBe(partial);
    const nameless = fence({ summary: 'no ids' });
    expect(extractForwardBlocks(nameless).forwards).toEqual([]);
    expect(extractForwardBlocks(nameless).strippedText).toContain('agenthub:forward');
  });

  it('defaults an unknown mode and ignores lookalike tokens', () => {
    const { forwards } = extractForwardBlocks(fence({ ...PAYLOAD, mode: 'scoping' }));
    expect(forwards[0].mode).toBe('manual');
    expect(extractForwardBlocks(fence({ ...PAYLOAD, mode: 'consult' })).forwards[0].mode).toBe(
      'consult',
    );
    expect(extractForwardBlocks('See agenthub:forwarding for the old notes.').forwards).toEqual([]);
    expect(
      extractForwardBlocks('```agenthub:forward:answer\n' + JSON.stringify(PAYLOAD) + '\n```')
        .forwards,
    ).toEqual([]);
  });

  it('reuses a supplied id so a reload finds the same card', () => {
    const { forwards } = extractForwardBlocks(fence({ ...PAYLOAD, id: 'fix-login-1' }));
    expect(forwards[0].forwardId).toBe('fix-login-1');
  });
});

describe('session forward modes', () => {
  it('offers only Consult for a workflow project and the ship levels otherwise', () => {
    expect(sessionForwardModesFor(true, 'manual')).toEqual(['consult']);
    expect(sessionForwardModesFor(false, 'consult')).toEqual(['manual', 'review', 'push', 'merge']);
    // Project list not loaded yet: the suggestion is the only hint.
    expect(sessionForwardModesFor(null, 'consult')).toEqual(['consult']);
    expect(sessionForwardModesFor(null, 'push')).toEqual(['manual', 'review', 'push', 'merge']);
  });

  it('falls back to the first allowed mode when the suggestion does not fit', () => {
    expect(initialSessionForwardMode(['consult'], 'merge')).toBe('consult');
    expect(initialSessionForwardMode(['manual', 'review', 'push', 'merge'], 'push')).toBe('push');
  });
});

describe('sessionForwardStorageKey', () => {
  const base = {
    owner: 'https://hub.test|user-1',
    sessionId: 'chat-1',
    messageId: 'm-1',
    forwardId: 'fwd-1',
    occurrence: 0,
  };

  it('separates the same card id across messages, chats, accounts and occurrences', () => {
    const key = sessionForwardStorageKey(base);
    expect(key).toBeTruthy();
    expect(sessionForwardStorageKey({ ...base })).toBe(key);
    for (const change of [
      { messageId: 'm-2' },
      { sessionId: 'chat-2' },
      { owner: 'https://hub.test|user-2' },
      { owner: 'https://other.test|user-1' },
      { occurrence: 1 },
    ]) {
      expect(sessionForwardStorageKey({ ...base, ...change })).not.toBe(key);
    }
  });

  it('returns null without a chat and message to anchor to', () => {
    expect(sessionForwardStorageKey({ ...base, messageId: null })).toBeNull();
    expect(sessionForwardStorageKey({ ...base, sessionId: undefined })).toBeNull();
  });
});

describe('createSessionForwardTracker', () => {
  it('hands a text-derived card to the later explicit event exactly once', () => {
    const tracker = createSessionForwardTracker([
      { type: 'assistant_text' },
      { type: 'session_forward', forwardId: 'fwd-1' },
    ]);
    expect(tracker.takenByEvent('fwd-1', 0)).toBe(true);
    expect(tracker.takenByEvent('fwd-1', 0)).toBe(false);
    expect(tracker.takenByEvent('fwd-2', 0)).toBe(false);
  });

  it('ignores explicit events that came before the text', () => {
    const tracker = createSessionForwardTracker([
      { type: 'session_forward', forwardId: 'fwd-1' },
      { type: 'assistant_text' },
    ]);
    expect(tracker.takenByEvent('fwd-1', 1)).toBe(false);
  });

  it('numbers repeat occurrences of one id', () => {
    const tracker = createSessionForwardTracker([]);
    expect(tracker.occurrence('fwd-1')).toBe(0);
    expect(tracker.occurrence('fwd-1')).toBe(1);
    expect(tracker.occurrence('fwd-2')).toBe(0);
  });
});
