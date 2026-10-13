import { describe, expect, it } from 'vitest';
import {
  buildHubChatCardDraft,
  buildHubChatSessionSeed,
  hubChatMessageHash,
} from './hubChatCapture';
import { cardOriginAppLink, cardOriginDeepLink, cardOriginLabel } from './captureCard';

const LINK = 'https://hub.example.com/#/hub/chat?channel=chan-1&message=msg-1';

describe('hubChatMessageHash', () => {
  it('builds the Hub Chat route for a channel and message', () => {
    expect(hubChatMessageHash('chan-1', 'msg-1')).toBe('#/hub/chat?channel=chan-1&message=msg-1');
    expect(hubChatMessageHash('chan-1')).toBe('#/hub/chat?channel=chan-1');
  });

  it('refuses ids that are not plain ids', () => {
    expect(hubChatMessageHash('chan&x=1', 'msg-1')).toBeNull();
    expect(hubChatMessageHash('chan-1', 'javascript:alert(1)')).toBeNull();
    expect(hubChatMessageHash(undefined, 'msg-1')).toBeNull();
    expect(hubChatMessageHash('chan-1', 42)).toBeNull();
  });
});

describe('buildHubChatCardDraft', () => {
  it('stamps provenance that links back to the message', () => {
    const draft = buildHubChatCardDraft({
      channelId: 'chan-1',
      channelLabel: '# general',
      link: LINK,
      messages: [
        {
          id: 'msg-1',
          sender: 'bob',
          body: 'Login is broken for @[alice](user:u1)\nsecond line',
          plainText: 'Login is broken for @alice\nsecond line',
        },
      ],
    });
    expect(draft.title).toBe('Login is broken for @alice');
    expect(draft.description).toBe(
      `From bob in # general\n\nLogin is broken for @alice\nsecond line\n\nSource: ${LINK}`,
    );
    expect(draft.source).toEqual({
      sourceType: 'hub_chat',
      sourceId: 'msg-1',
      sourceMeta: {
        kind: 'hub-chat',
        channelId: 'chan-1',
        messageId: 'msg-1',
        channelLabel: '# general',
        from: 'bob',
      },
    });
  });

  it('keeps every picked message and their ids for a multi-select', () => {
    const draft = buildHubChatCardDraft({
      channelId: 'chan-1',
      channelLabel: '# general',
      messages: [
        { id: 'm1', sender: 'bob', createdAt: 'Oct 1, 9:00', plainText: 'first' },
        { id: 'm2', sender: 'carol', plainText: 'second' },
      ],
    });
    expect(draft.title).toBe('first');
    expect(draft.description).toBe(
      '2 messages in # general\n\nbob (Oct 1, 9:00):\nfirst\n\ncarol:\nsecond',
    );
    expect(draft.source.sourceId).toBe('m1');
    expect(draft.source.sourceMeta.messageIds).toEqual(['m1', 'm2']);
  });

  it('falls back to the channel for an empty message', () => {
    const draft = buildHubChatCardDraft({
      channelId: 'c',
      channelLabel: '# ops',
      messages: [{ id: 'm', plainText: '  ' }],
    });
    expect(draft.title).toBe('Chat request in # ops');
  });
});

describe('buildHubChatSessionSeed', () => {
  it('carries the channel reference and the raw body', () => {
    const seed = buildHubChatSessionSeed({
      channelId: 'chan-1',
      channelLabel: '# general',
      link: LINK,
      messages: [
        { id: 'msg-1', sender: 'bob', createdAt: 'Oct 1, 9:00', body: 'see @[AH-1](card:c1)' },
      ],
    });
    expect(seed).toContain("Here's an Agent Hub chat message");
    expect(seed).toContain('**Channel:** # general');
    expect(seed).toContain('**From:** bob');
    expect(seed).toContain(`**Link:** ${LINK}`);
    expect(seed).toContain('**Chat reference:** Agent Hub chat channel chan-1 (message msg-1)');
    expect(seed.endsWith('see @[AH-1](card:c1)')).toBe(true);
  });

  it('lists every picked message', () => {
    const seed = buildHubChatSessionSeed({
      channelId: 'chan-1',
      messages: [
        { id: 'm1', sender: 'bob', body: 'one' },
        { id: 'm2', sender: 'carol', body: 'two' },
      ],
    });
    expect(seed).toContain('Here are 2 Agent Hub chat messages');
    expect(seed).toContain('(messages m1, m2)');
    expect(seed).toContain('**bob**:\none\n\n**carol**:\ntwo');
  });
});

describe('card origin for Agent Hub chat captures', () => {
  const card = {
    source_type: 'hub_chat',
    source_meta: { channelId: 'chan-1', messageId: 'msg-1', deepLink: 'https://evil.google.com/' },
  };

  it('labels the card and links back to the message in-app', () => {
    expect(cardOriginLabel(card)).toBe('From Agent Hub chat');
    expect(cardOriginAppLink(card)).toBe('#/hub/chat?channel=chan-1&message=msg-1');
    expect(cardOriginDeepLink(card)).toBeNull();
  });

  it('gives no app link for other origins', () => {
    expect(cardOriginAppLink({ ...card, source_type: 'chat' })).toBeNull();
  });
});
