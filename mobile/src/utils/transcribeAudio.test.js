import { describe, it, expect, vi } from 'vitest';
import {
  parseTranscribeUploadResult,
  transcribeAudio,
} from './transcribeAudio.js';

vi.mock('./config', () => ({
  getApiBaseUrl: () => 'https://example.test/api',
  getAuthHeaders: () => ({ 'X-API-Key': 'test-key' }),
}));

function makeFakeFileSystem({ status = 200, body = null } = {}) {
  const calls = [];
  const uploadAsync = vi.fn(async (url, uri, opts) => {
    calls.push({ url, uri, opts });
    return { status, body: body ?? '' };
  });
  return {
    uploadAsync,
    calls,
    FileSystemUploadType: { BINARY_CONTENT: 'BINARY_CONTENT' },
  };
}

describe('parseTranscribeUploadResult', () => {
  it('returns transcript on success', () => {
    const result = parseTranscribeUploadResult(
      200,
      JSON.stringify({ transcript: ' hello ' }),
    );
    expect(result).toEqual({ ok: true, transcript: ' hello ' });
  });

  it('maps 501 to configuration hint', () => {
    const result = parseTranscribeUploadResult(
      501,
      JSON.stringify({ hint: 'Set xAI key' }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Set xAI key');
  });

  it('maps empty transcript to retry message', () => {
    const result = parseTranscribeUploadResult(200, JSON.stringify({ transcript: '  ' }));
    expect(result).toEqual({ ok: false, message: "Couldn't hear anything — try again." });
  });
});

describe('transcribeAudio', () => {
  it('posts raw bytes with Content-Type to /transcribe', async () => {
    const fs = makeFakeFileSystem({
      status: 200,
      body: JSON.stringify({ transcript: 'test phrase' }),
    });
    const out = await transcribeAudio('file:///rec.m4a', 'audio/m4a', { fileSystem: fs });
    expect(out).toEqual({ transcript: 'test phrase' });
    expect(fs.uploadAsync).toHaveBeenCalledTimes(1);
    const [url, uri, opts] = fs.uploadAsync.mock.calls[0];
    expect(url).toBe('https://example.test/api/transcribe');
    expect(uri).toBe('file:///rec.m4a');
    expect(opts.httpMethod).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('audio/m4a');
    expect(opts.headers['X-API-Key']).toBe('test-key');
  });

  it('throws user-facing message on provider error', async () => {
    const fs = makeFakeFileSystem({ status: 415, body: JSON.stringify({ hint: 'bad format' }) });
    await expect(
      transcribeAudio('file:///rec.webm', 'audio/webm', { fileSystem: fs }),
    ).rejects.toThrow('bad format');
  });

  // Regression: `uploadAsync` is deprecated on the main `expo-file-system`
  // module in SDK 54 and THROWS at runtime there. It must be resolved from
  // the `/legacy` entry point. Importing the main module makes the happy path
  // (record → stop → upload) blow up before `/api/transcribe` is reached.
  // https://docs.expo.dev/versions/latest/sdk/filesystem/
  it('resolves uploadAsync from expo-file-system/legacy, not the main module', async () => {
    vi.resetModules();
    const legacyUpload = vi
      .fn()
      .mockResolvedValue({ status: 200, body: JSON.stringify({ transcript: 'from legacy' }) });
    vi.doMock('expo-file-system/legacy', () => ({
      uploadAsync: legacyUpload,
      FileSystemUploadType: { BINARY_CONTENT: 'BINARY_CONTENT' },
    }));
    vi.doMock('expo-file-system', () => {
      throw new Error('main module uploadAsync throws at runtime — use /legacy');
    });

    const { transcribeAudio: freshTranscribe } = await import('./transcribeAudio.js');
    const out = await freshTranscribe('file:///rec.m4a', 'audio/m4a');
    expect(out).toEqual({ transcript: 'from legacy' });
    expect(legacyUpload).toHaveBeenCalledTimes(1);

    vi.doUnmock('expo-file-system/legacy');
    vi.doUnmock('expo-file-system');
    vi.resetModules();
  });
});
