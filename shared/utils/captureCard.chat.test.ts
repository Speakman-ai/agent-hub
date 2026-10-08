import { describe, expect, it } from 'vitest';
import { buildChatCardDraft } from './captureCard';

describe('buildChatCardDraft', () => {
  it('uses the first line as title and stamps a manual source with the message reference', () => {
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
    expect(draft.source.sourceType).toBe('manual');
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
