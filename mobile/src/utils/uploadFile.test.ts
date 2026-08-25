// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
vi.mock('./config', () => ({
  getApiBaseUrl: () => 'https://example.test/api',
  getAuthHeaders: () => ({ 'X-API-Key': 'test-key' }),
}));
const { uploadFile } = await import('./uploadFile.js');
/**
 * Build a fake expo-file-system surface. `uploadAsync` records every
 * invocation so tests can assert URL / options / headers parity with the
 * web client's `fetch`-based uploader.
 */
function makeFakeFileSystem({ status = 200, body = null }: any = {}) {
  const calls = [];
  const uploadAsync = vi.fn(async (url: any, uri: any, opts: any) => {
    calls.push({ url, uri, opts });
    return {
      status,
      body: body === null ? JSON.stringify({ id: 'uuid', url: '/uploads/uuid.mp4' }) : body,
    };
  });
  return {
    uploadAsync,
    FileSystemUploadType: { BINARY_CONTENT: 'BINARY_CONTENT' },
    _calls: calls,
  };
}
describe('uploadFile — binary upload parity with web client', () => {
  it('POSTs to /api/upload/file with X-Filename + Content-Type + auth headers', async () => {
    const fs = makeFakeFileSystem();
    const result = await uploadFile(
      { uri: 'file:///local/video.mp4', name: 'clip.mp4', type: 'video/mp4' },
      { fileSystem: fs },
    );
    expect(result).toEqual({ id: 'uuid', url: '/uploads/uuid.mp4' });
    expect(fs.uploadAsync).toHaveBeenCalledTimes(1);
    const [url, uri, opts] = fs.uploadAsync.mock.calls[0];
    expect(url).toBe('https://example.test/api/upload/file');
    expect(uri).toBe('file:///local/video.mp4');
    expect(opts.httpMethod).toBe('POST');
    expect(opts.uploadType).toBe('BINARY_CONTENT');
    expect(opts.headers).toEqual({
      'Content-Type': 'video/mp4',
      'X-Filename': 'clip.mp4',
      'X-API-Key': 'test-key',
    });
  });
  it('defaults Content-Type + filename when the caller omits them', async () => {
    const fs = makeFakeFileSystem();
    await uploadFile({ uri: 'file:///x.bin' }, { fileSystem: fs });
    const { opts } = fs._calls[0];
    expect(opts.headers['Content-Type']).toBe('application/octet-stream');
    expect(opts.headers['X-Filename']).toBe('upload.bin');
  });
  it('throws when the server returns a non-2xx status', async () => {
    const fs = makeFakeFileSystem({ status: 413, body: 'too large' });
    await expect(
      uploadFile({ uri: 'file:///big.mp4', name: 'big.mp4' }, { fileSystem: fs }),
    ).rejects.toThrow(/API error: 413/);
  });
  it('throws when the success body is not valid JSON', async () => {
    const fs = makeFakeFileSystem({ status: 200, body: 'not-json' });
    await expect(
      uploadFile({ uri: 'file:///x.mp4', name: 'x.mp4' }, { fileSystem: fs }),
    ).rejects.toThrow(/Invalid upload response/);
  });
  it('requires fileRef.uri', async () => {
    const fs = makeFakeFileSystem();
    await expect(uploadFile({ name: 'x.mp4' }, { fileSystem: fs })).rejects.toThrow(
      /fileRef\.uri is required/,
    );
    expect(fs.uploadAsync).not.toHaveBeenCalled();
  });
});
