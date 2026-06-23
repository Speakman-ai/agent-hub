import { describe, it, expect } from 'vitest';
import {
  attachmentsFromQueuedMessage,
  buildInterruptQueuedMessageDispatch,
} from '@shared/utils/queuedMessageAttachments';

describe('attachmentsFromQueuedMessage', () => {
  it('parses persisted attachment JSON for interrupt-now resend', () => {
    const att = [{ url: '/uploads/x.png', contentType: 'image/png' }];
    expect(attachmentsFromQueuedMessage({ attachments: JSON.stringify(att) })).toEqual(att);
  });
});

describe('buildInterruptQueuedMessageDispatch (web interrupt-now)', () => {
  it('builds dequeue then chat with persisted images (no re-upload)', () => {
    const images = [
      {
        id: 'u1',
        url: '/uploads/photo.png',
        contentType: 'image/png',
        filename: 'photo.png',
      },
    ];
    const message = {
      id: 'msg-42',
      content: 'with image',
      attachments: JSON.stringify(images),
    };
    const { chat } = buildInterruptQueuedMessageDispatch({
      message,
      agentId: 'agent-hub',
      sessionId: 'sess-42',
    });
    expect(chat._existingMsgId).toBe('msg-42');
    expect(chat.images).toEqual(images);
    expect(chat.interrupt).toBe(true);
    expect(chat._fromQueue).toBeUndefined();
  });
});
