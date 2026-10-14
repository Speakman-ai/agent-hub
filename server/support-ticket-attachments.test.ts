import { describe, it, expect } from 'vitest';
import {
  AttachmentValidationError,
  MAX_ATTACHMENT_BYTES,
  attachmentMarkdownLines,
  sanitizeAttachmentFilename,
  validateAttachment,
} from './support-ticket-attachments.js';
import type { SupportTicketAttachmentRow } from './types.js';

const bytes = (...b: number[]) => Buffer.from(b);
const withPad = (head: Buffer) => Buffer.concat([head, Buffer.alloc(16)]);

describe('validateAttachment', () => {
  it.each([
    ['png', withPad(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'image/png', 'png'],
    ['pdf', Buffer.from('%PDF-1.4\n...'), 'application/pdf', 'pdf'],
    ['mp4', withPad(Buffer.from('\0\0\0\x20ftypisom', 'latin1')), 'video/mp4', 'mp4'],
    ['mov', withPad(Buffer.from('\0\0\0\x14ftypqt  ', 'latin1')), 'video/quicktime', 'mov'],
    ['webm', withPad(bytes(0x1a, 0x45, 0xdf, 0xa3)), 'video/webm', 'webm'],
    ['zip', withPad(bytes(0x50, 0x4b, 0x03, 0x04)), 'application/zip', 'zip'],
  ])('accepts %s by its signature, whatever the filename', (_n, buf, mime, ext) => {
    expect(validateAttachment(buf, 'whatever.bin')).toEqual({ mime, ext });
  });

  it('accepts UTF-8 text only under a text extension, stored as .txt', () => {
    const text = Buffer.from('{"log":"héllo"}');
    expect(validateAttachment(text, 'capture.har')).toEqual({ mime: 'text/plain', ext: 'txt' });
    expect(() => validateAttachment(text, 'page.html')).toThrow(/unsupported file type/);
    expect(() => validateAttachment(text, 'icon.svg')).toThrow(AttachmentValidationError);
  });

  it('rejects binary or invalid UTF-8 posing as text', () => {
    expect(() => validateAttachment(bytes(0x61, 0x00, 0x62), 'a.txt')).toThrow();
    expect(() => validateAttachment(bytes(0xc3, 0x28), 'a.txt')).toThrow();
  });

  it('rejects empty and oversize files with the right status', () => {
    expect(() => validateAttachment(Buffer.alloc(0), 'a.txt')).toThrow(/empty/);
    try {
      validateAttachment(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x61), 'a.txt');
      expect.unreachable();
    } catch (err) {
      expect((err as AttachmentValidationError).status).toBe(413);
    }
  });
});

describe('sanitizeAttachmentFilename', () => {
  it('keeps the basename, strips control characters, and caps length', () => {
    expect(sanitizeAttachmentFilename('C:\\Users\\me\\crash.log')).toBe('crash.log');
    expect(sanitizeAttachmentFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeAttachmentFilename('a\u0000b\nc.txt')).toBe('abc.txt');
    expect(sanitizeAttachmentFilename('')).toBe('file');
    expect(sanitizeAttachmentFilename('..')).toBe('file');
    const long = sanitizeAttachmentFilename(`${'x'.repeat(300)}.json`);
    expect(long).toHaveLength(200);
    expect(long.endsWith('.json')).toBe(true);
  });
});

describe('attachmentMarkdownLines', () => {
  const row = (filename: string, mime: string): SupportTicketAttachmentRow => ({
    id: filename,
    support_ticket_id: 't',
    ref: `/uploads/support-attachment-${filename.length}.x`,
    filename,
    mime,
    size_bytes: 1,
    created_by: null,
    created_at: '',
  });

  it('inlines images, links other files, and escapes brackets in names', () => {
    expect(attachmentMarkdownLines([])).toBe('');
    const md = attachmentMarkdownLines([row('a.png', 'image/png'), row('b [1].log', 'text/plain')]);
    expect(md).toContain('**Attachments:**');
    expect(md).toContain('- ![a.png](/uploads/support-attachment-5.x)');
    expect(md).toContain('- [b \\[1\\].log](/uploads/support-attachment-9.x)');
  });
});
