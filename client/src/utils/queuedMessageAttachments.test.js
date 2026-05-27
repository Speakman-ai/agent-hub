import { describe, it, expect } from 'vitest';
import { attachmentsFromQueuedMessage } from '../../../shared/utils/queuedMessageAttachments.js';

describe('attachmentsFromQueuedMessage', () => {
  it('parses persisted attachment JSON for interrupt-now resend', () => {
    const att = [{ url: '/uploads/x.png', contentType: 'image/png' }];
    expect(attachmentsFromQueuedMessage({ attachments: JSON.stringify(att) })).toEqual(att);
  });
});
