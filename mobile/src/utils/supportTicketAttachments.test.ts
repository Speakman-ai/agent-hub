import { describe, it, expect, vi } from 'vitest';

vi.mock('./config', () => ({
  getApiBaseUrl: () => 'https://hub.test/api',
  getAuthHeaders: () => ({ Authorization: 'Bearer tok' }),
}));

import {
  formatAttachmentSize,
  uploadSupportTicketAttachment,
  uploadSupportTicketAttachments,
} from './supportTicketAttachments';

describe('uploadSupportTicketAttachment', () => {
  it('posts raw bytes as octet-stream with the encoded filename', async () => {
    const uploadAsync = vi.fn().mockResolvedValue({
      status: 201,
      body: JSON.stringify({ attachment: { id: 'a1' }, ticket: { id: 't1' } }),
    });
    const out = await uploadSupportTicketAttachment(
      'proj',
      't1',
      { uri: 'file:///tmp/crash log.txt', name: 'crash log.txt' },
      { fileSystem: { uploadAsync }, uploadType: 'BINARY' },
    );
    expect(out.attachment.id).toBe('a1');
    expect(uploadAsync).toHaveBeenCalledWith(
      'https://hub.test/api/projects/proj/support-tickets/t1/attachments',
      'file:///tmp/crash log.txt',
      {
        httpMethod: 'POST',
        uploadType: 'BINARY',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Filename': 'crash%20log.txt',
          Authorization: 'Bearer tok',
        },
      },
    );
  });

  it('surfaces the server error message', async () => {
    const uploadAsync = vi.fn().mockResolvedValue({
      status: 400,
      body: JSON.stringify({ error: 'unsupported file type' }),
    });
    await expect(
      uploadSupportTicketAttachment(
        'proj',
        't1',
        { uri: 'file:///x.html', name: 'x.html' },
        { fileSystem: { uploadAsync }, uploadType: 0 },
      ),
    ).rejects.toThrow('unsupported file type');
  });
});

describe('uploadSupportTicketAttachments', () => {
  it('keeps going after a failure and reports each one', async () => {
    const upload = vi
      .fn()
      .mockResolvedValueOnce({ attachment: {}, ticket: { id: 't1', n: 1 } })
      .mockRejectedValueOnce(new Error('file exceeds the 25 MB limit'))
      .mockResolvedValueOnce({ attachment: {}, ticket: { id: 't1', n: 2 } });
    const onTicket = vi.fn();
    const onProgress = vi.fn();
    const files = ['a.png', 'big.mp4', 'c.log'].map((name) => ({ uri: `file:///${name}`, name }));

    const out = await uploadSupportTicketAttachments('p', 't1', files, {
      upload,
      onTicket,
      onProgress,
    });

    expect(out).toEqual({ uploaded: 2, failures: ['big.mp4: file exceeds the 25 MB limit'] });
    expect(onTicket.mock.calls.map(([t]) => t.n)).toEqual([1, 2]);
    expect(onProgress).toHaveBeenLastCalledWith(3, 3);
  });
});

describe('formatAttachmentSize', () => {
  it('formats sizes', () => {
    expect(formatAttachmentSize(10)).toBe('10 B');
    expect(formatAttachmentSize(1536)).toBe('2 KB');
    expect(formatAttachmentSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
