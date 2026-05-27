import { describe, it, expect } from 'vitest';
import {
  attachmentsFromQueuedMessage,
  buildInterruptQueuedChatWsMessage,
  buildInterruptQueuedMessageDispatch,
  isPersistedUploadAttachment,
} from './queuedMessageAttachments.js';

describe('attachmentsFromQueuedMessage', () => {
  it('returns [] when attachments missing', () => {
    expect(attachmentsFromQueuedMessage({})).toEqual([]);
  });

  it('parses JSON string attachments', () => {
    const att = [{ url: '/uploads/a.png', contentType: 'image/png' }];
    expect(attachmentsFromQueuedMessage({ attachments: JSON.stringify(att) })).toEqual(att);
  });

  it('returns [] on invalid JSON', () => {
    expect(attachmentsFromQueuedMessage({ attachments: 'not-json' })).toEqual([]);
  });
});

describe('isPersistedUploadAttachment', () => {
  it('is true for server upload response rows', () => {
    expect(
      isPersistedUploadAttachment({
        id: 'u1',
        url: '/uploads/x.png',
        contentType: 'image/png',
        filename: 'x.png',
      }),
    ).toBe(true);
  });

  it('is false for composer shapes that still need upload', () => {
    expect(isPersistedUploadAttachment({ dataUrl: 'data:image/png;base64,abc', name: 'a.png' })).toBe(
      false,
    );
    expect(isPersistedUploadAttachment({ kind: 'image', uri: 'file:///tmp/a.png' })).toBe(false);
    expect(isPersistedUploadAttachment({ url: '/x', contentType: 'image/png', dataUrl: 'data:…' })).toBe(
      false,
    );
  });
});

describe('buildInterruptQueuedChatWsMessage', () => {
  it('carries persisted images and interrupt without re-upload fields', () => {
    const persisted = [
      {
        id: 'u1',
        url: '/uploads/x.png',
        contentType: 'image/png',
        filename: 'x.png',
        originalName: 'x.png',
      },
    ];
    expect(
      buildInterruptQueuedChatWsMessage({
        message: {
          id: 'msg-q1',
          content: 'Ship it',
          attachments: JSON.stringify(persisted),
        },
        agentId: 'agent-hub',
        sessionId: 'sess-1',
      }),
    ).toEqual({
      type: 'chat',
      agentId: 'agent-hub',
      sessionId: 'sess-1',
      content: 'Ship it',
      images: persisted,
      interrupt: true,
      _existingMsgId: 'msg-q1',
    });
  });

  it('omits images when the queued message has none', () => {
    expect(
      buildInterruptQueuedChatWsMessage({
        message: { id: 'm0', content: 'text only' },
        agentId: 'a',
        sessionId: 's',
      }),
    ).toEqual({
      type: 'chat',
      agentId: 'a',
      sessionId: 's',
      content: 'text only',
      interrupt: true,
      _existingMsgId: 'm0',
    });
  });
});

describe('buildInterruptQueuedMessageDispatch', () => {
  it('emits a single chat frame that promotes the existing queued row', () => {
    const persisted = [
      {
        id: 'u1',
        url: '/uploads/x.png',
        contentType: 'image/png',
        filename: 'x.png',
      },
    ];
    const message = {
      id: 'msg-q1',
      content: 'with image',
      attachments: JSON.stringify(persisted),
    };
    const { chat } = buildInterruptQueuedMessageDispatch({
      message,
      agentId: 'agent-hub',
      sessionId: 'sess-1',
    });
    expect(chat).toEqual({
      type: 'chat',
      agentId: 'agent-hub',
      sessionId: 'sess-1',
      content: 'with image',
      images: persisted,
      interrupt: true,
      _existingMsgId: 'msg-q1',
    });
  });
});
