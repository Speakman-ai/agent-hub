import { describe, expect, it } from 'vitest';
import {
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENTS_PER_MESSAGE,
  attachmentRejection,
  attachmentSlotsLeft,
  canSendComposer,
  failedSendNotice,
  hasFailedAttachments,
  readyAttachmentRefs,
  restoreFailedAttachments,
  type PendingChatAttachment,
} from './googleChatComposer';

const ready = (id: string): PendingChatAttachment => ({
  id,
  name: `${id}.pdf`,
  size: 10,
  status: 'ready',
  ref: { attachmentUploadToken: `tok-${id}` },
});

describe('googleChatComposer', () => {
  it('sends text alone, attachments alone, or both', () => {
    expect(canSendComposer('hi', [])).toBe(true);
    expect(canSendComposer('  ', [ready('a')])).toBe(true);
    expect(canSendComposer('  ', [])).toBe(false);
  });

  it('blocks sending while an upload is in flight', () => {
    expect(canSendComposer('hi', [{ id: 'b', name: 'b', size: 1, status: 'uploading' }])).toBe(
      false,
    );
  });

  it('blocks sending while a failed upload is still attached', () => {
    const failed: PendingChatAttachment = { id: 'c', name: 'c', size: 1, status: 'error' };
    expect(canSendComposer('', [failed])).toBe(false);
    expect(canSendComposer('hi', [failed])).toBe(false);
    expect(canSendComposer('hi', [ready('a'), failed])).toBe(false);
    expect(canSendComposer('', [ready('a'), failed])).toBe(false);
    expect(hasFailedAttachments([ready('a'), failed])).toBe(true);
    expect(hasFailedAttachments([ready('a')])).toBe(false);
    expect(readyAttachmentRefs([failed, ready('a')])).toEqual([{ attachmentUploadToken: 'tok-a' }]);
  });

  it('rejects empty and oversized files', () => {
    expect(attachmentRejection({ size: 0 })).toBe('File is empty');
    expect(attachmentRejection({ size: MAX_CHAT_ATTACHMENT_BYTES + 1 })).toMatch(/25 MB/);
    expect(attachmentRejection({ size: MAX_CHAT_ATTACHMENT_BYTES })).toBeNull();
  });

  it('caps the number of attachments per message', () => {
    const many = Array.from({ length: MAX_CHAT_ATTACHMENTS_PER_MESSAGE }, (_, i) => ready(`${i}`));
    expect(attachmentSlotsLeft(many)).toBe(0);
    expect(attachmentSlotsLeft([ready('a')])).toBe(MAX_CHAT_ATTACHMENTS_PER_MESSAGE - 1);
  });

  it('puts failed attachments back ahead of a new draft without duplicates', () => {
    const fresh = ready('new');
    const out = restoreFailedAttachments([fresh], [ready('a'), ready('b')]);
    expect(out.attachments.map((a) => a.id)).toEqual(['a', 'b', 'new']);
    expect(out.restored).toBe(2);
    expect(out.dropped).toEqual([]);
    expect(restoreFailedAttachments(out.attachments, [ready('a')]).restored).toBe(0);
  });

  it('reports failed attachments that no longer fit under the cap', () => {
    const full = Array.from({ length: MAX_CHAT_ATTACHMENTS_PER_MESSAGE - 1 }, (_, i) =>
      ready(`n${i}`),
    );
    const out = restoreFailedAttachments(full, [ready('a'), ready('b')]);
    expect(out.attachments).toHaveLength(MAX_CHAT_ATTACHMENTS_PER_MESSAGE);
    expect(out.restored).toBe(1);
    expect(out.dropped).toEqual(['b.pdf']);
  });

  it('mentions restored and dropped files in the failure notice', () => {
    expect(failedSendNotice('Rate limited', 'hi', 1, [])).toBe(
      'Rate limited. Not sent: "hi". 1 attachment was put back in the composer.',
    );
    expect(failedSendNotice('Rate limited', '', 0, ['b.pdf'])).toBe(
      'Rate limited. Attachment limit reached, so these were not kept: b.pdf.',
    );
  });
});
