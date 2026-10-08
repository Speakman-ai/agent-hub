import { describe, expect, it } from 'vitest';
import { buildChatCardDraft, cardOriginDeepLink, cardOriginLabel } from './captureCard';
import { buildChatTodoDraft, todoOriginDeepLink, todoOriginLabel } from './captureTodo';

describe('buildChatCardDraft', () => {
  it('uses the first line as title and stamps a chat source with the message reference', () => {
    const draft = buildChatCardDraft({
      messageName: 'spaces/A/messages/M',
      spaceName: 'spaces/A',
      threadName: 'spaces/A/threads/T',
      spaceLabel: 'Support',
      sender: 'Dana',
      text: '  Reset   staging please \nmore',
      deepLink: 'https://chat.google.com/room/A',
    });
    expect(draft.title).toBe('Reset staging please');
    expect(draft.description).toBe(
      'From Dana in Support\n\nReset   staging please \nmore\n\nSource: https://chat.google.com/room/A',
    );
    expect(draft.source.sourceType).toBe('chat');
    expect(draft.source.sourceId).toBe('spaces/A/messages/M');
  });

  it('falls back to a space title and drops unsafe links', () => {
    const draft = buildChatCardDraft({
      spaceLabel: 'Support',
      text: '',
      deepLink: 'javascript:alert(1)',
    });
    expect(draft.title).toBe('Chat request in Support');
    expect(draft.description).toBe('in Support');
    expect(draft.source.sourceMeta).toEqual({ kind: 'google-chat' });
    expect(draft.source.sourceId).toBeNull();
  });

  it('clamps long titles', () => {
    const draft = buildChatCardDraft({ text: 'x'.repeat(300) });
    expect(draft.title).toHaveLength(140);
    expect(draft.title.endsWith('…')).toBe(true);
  });
});

describe('buildChatTodoDraft', () => {
  it('stamps a chat source and keeps the sender line and text as notes', () => {
    const draft = buildChatTodoDraft({
      messageName: 'spaces/A/messages/M',
      spaceName: 'spaces/A',
      spaceLabel: 'Support',
      sender: 'Dana',
      text: 'Reset staging please\nmore',
      deepLink: 'https://chat.google.com/room/A',
    });
    expect(draft).toEqual({
      title: 'Reset staging please',
      notes: 'From Dana in Support\n\nReset staging please\nmore',
      sourceType: 'chat',
      sourceId: 'spaces/A/messages/M',
      sourceMeta: {
        kind: 'google-chat',
        messageName: 'spaces/A/messages/M',
        spaceName: 'spaces/A',
        from: 'Dana',
        deepLink: 'https://chat.google.com/room/A',
      },
    });
  });

  it('omits notes when there is nothing to say', () => {
    const draft = buildChatTodoDraft({});
    expect(draft.title).toBe('Chat request');
    expect(draft).not.toHaveProperty('notes');
  });
});

describe('Google Chat origin display', () => {
  const meta = { kind: 'google-chat', deepLink: 'https://chat.google.com/room/A' };

  it('labels and reopens chat cards', () => {
    const card = { source_type: 'chat', source_meta: meta };
    expect(cardOriginLabel(card)).toBe('From Google Chat');
    expect(cardOriginDeepLink(card)).toBe('https://chat.google.com/room/A');
  });

  it('labels and reopens chat todos', () => {
    const todo = { sourceType: 'chat', sourceMeta: meta };
    expect(todoOriginLabel(todo)).toBe('From Google Chat');
    expect(todoOriginDeepLink(todo)).toBe('https://chat.google.com/room/A');
  });

  it('drops a non-Google reopen link on a chat card', () => {
    expect(
      cardOriginDeepLink({ source_type: 'chat', source_meta: { deepLink: 'https://evil.test' } }),
    ).toBeNull();
  });
});
