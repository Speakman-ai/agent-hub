import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    setItem: vi.fn(async () => undefined),
    getItem: vi.fn(async () => null),
  },
}));

vi.mock('./auth', () => ({ getToken: vi.fn(() => null) }));

import { resolveToolImageSrc } from './toolImageSrc';
import { saveConnectionConfig } from './config';

describe('resolveToolImageSrc', () => {
  beforeEach(async () => {
    await saveConnectionConfig({ remoteUrl: '', apiKey: '' });
  });

  it('resolves a relative /uploads path against the server root', async () => {
    await saveConnectionConfig({ remoteUrl: 'https://hub.example.test', apiKey: '' });
    expect(resolveToolImageSrc({ url: '/uploads/tool-image-abc.png' })).toBe(
      'https://hub.example.test/uploads/tool-image-abc.png',
    );
  });

  it('does NOT corrupt an api.* host (regression for getApiBaseUrl().replace)', async () => {
    // getApiBaseUrl() here would be "https://api.example.com/api"; the old
    // `.replace('/api','')` matched inside `//api` and produced a broken host.
    await saveConnectionConfig({ remoteUrl: 'https://api.example.com', apiKey: '' });
    expect(resolveToolImageSrc({ url: '/uploads/x.png' })).toBe(
      'https://api.example.com/uploads/x.png',
    );
  });

  it('trims trailing slashes on the configured remote URL', async () => {
    await saveConnectionConfig({ remoteUrl: 'https://hub.example.test///', apiKey: '' });
    expect(resolveToolImageSrc({ url: '/uploads/y.png' })).toBe(
      'https://hub.example.test/uploads/y.png',
    );
  });

  it('passes absolute URLs through unchanged', () => {
    expect(resolveToolImageSrc({ url: 'https://cdn.example.com/z.png' })).toBe(
      'https://cdn.example.com/z.png',
    );
  });

  it('falls back to a base64 data URL when no url is present', () => {
    expect(resolveToolImageSrc({ mediaType: 'image/png', dataBase64: 'QUJD' })).toBe(
      'data:image/png;base64,QUJD',
    );
  });

  it('returns null for an empty/absent ref', () => {
    expect(resolveToolImageSrc(null)).toBeNull();
    expect(resolveToolImageSrc({})).toBeNull();
  });
});
