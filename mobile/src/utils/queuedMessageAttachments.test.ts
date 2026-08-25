// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { buildInterruptQueuedMessageDispatch } from '@shared/utils/queuedMessageAttachments';
describe('buildInterruptQueuedMessageDispatch (mobile interrupt-now)', () => {
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
    expect(chat).toMatchObject({
      type: 'chat',
      interrupt: true,
      _existingMsgId: 'msg-42',
      images,
    });
  });
});
