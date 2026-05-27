import { describe, it, expect } from 'vitest';
import { attachmentsFromQueuedMessage } from './queuedMessageAttachments.js';

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
