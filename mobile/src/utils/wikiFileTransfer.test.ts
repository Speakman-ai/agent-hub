import { describe, it, expect, vi } from 'vitest';

vi.mock('./config', () => ({
  getApiBaseUrl: () => 'https://hub.test/api',
  getAuthHeaders: () => ({ Authorization: 'Bearer tok' }),
}));

import { uploadWikiFile, shareWikiFile } from './wikiFileTransfer';

describe('uploadWikiFile', () => {
  it('posts raw bytes as octet-stream to the folder-scoped upload URL', async () => {
    const uploadAsync = vi.fn().mockResolvedValue({
      status: 201,
      body: JSON.stringify({ replaced: false, file: { id: 'f1' }, page: { slug: 's' } }),
    });
    const out = await uploadWikiFile(
      'proj',
      ' SOPs / Safety ',
      { uri: 'file:///tmp/lockout.pdf', name: 'lockout.pdf' },
      { fileSystem: { uploadAsync }, uploadType: 'BINARY' },
    );
    expect(out.page.slug).toBe('s');
    expect(uploadAsync).toHaveBeenCalledWith(
      'https://hub.test/api/projects/proj/wiki-files?filename=lockout.pdf&folder=SOPs%2FSafety',
      'file:///tmp/lockout.pdf',
      {
        httpMethod: 'POST',
        uploadType: 'BINARY',
        headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer tok' },
      },
    );
  });

  it('surfaces the server error message', async () => {
    const uploadAsync = vi.fn().mockResolvedValue({
      status: 415,
      body: JSON.stringify({ error: 'Unsupported file type' }),
    });
    await expect(
      uploadWikiFile(
        'proj',
        '',
        { uri: 'file:///x.png', name: 'x.png' },
        {
          fileSystem: { uploadAsync },
          uploadType: 1,
        },
      ),
    ).rejects.toThrow('Unsupported file type');
  });
});

describe('uploadWikiFile retries when the server is busy', () => {
  it('waits Retry-After on 503 and succeeds on a later attempt', async () => {
    const uploadAsync = vi
      .fn()
      .mockResolvedValueOnce({ status: 503, headers: { 'Retry-After': '2' }, body: '{}' })
      .mockResolvedValueOnce({
        status: 201,
        body: JSON.stringify({ replaced: false, file: { id: 'f1' }, page: { slug: 's' } }),
      });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await uploadWikiFile(
      'proj',
      '',
      { uri: 'file:///a.md', name: 'a.md' },
      { fileSystem: { uploadAsync }, uploadType: 1, sleep },
    );
    expect(out.page.slug).toBe('s');
    expect(uploadAsync).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('gives up after the attempt limit and surfaces the busy error', async () => {
    const uploadAsync = vi
      .fn()
      .mockResolvedValue({ status: 503, headers: {}, body: JSON.stringify({ error: 'busy' }) });
    await expect(
      uploadWikiFile(
        'proj',
        '',
        { uri: 'file:///a.md', name: 'a.md' },
        { fileSystem: { uploadAsync }, uploadType: 1, sleep: async () => {} },
      ),
    ).rejects.toThrow('busy');
    expect(uploadAsync).toHaveBeenCalledTimes(4);
  });
});

describe('shareWikiFile', () => {
  it('downloads with auth into the cache and opens the share sheet', async () => {
    const downloadAsync = vi.fn().mockResolvedValue({ status: 200, uri: 'file:///c/sop.pdf' });
    const shareAsync = vi.fn().mockResolvedValue(undefined);
    await shareWikiFile(
      'proj',
      { id: 'f1', filename: '../sop.pdf', content_type: 'application/pdf' } as any,
      {
        fileSystem: { downloadAsync },
        sharing: { isAvailableAsync: async () => true, shareAsync },
        cacheDir: 'file:///c/',
      },
    );
    expect(downloadAsync).toHaveBeenCalledWith(
      'https://hub.test/api/projects/proj/wiki-files/f1/download',
      'file:///c/sop.pdf',
      { headers: { Authorization: 'Bearer tok' } },
    );
    expect(shareAsync).toHaveBeenCalledWith('file:///c/sop.pdf', {
      mimeType: 'application/pdf',
      dialogTitle: '../sop.pdf',
    });
  });
});
