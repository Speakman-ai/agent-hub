import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getToken } = vi.hoisted(() => ({
  getToken: vi.fn<() => string | null>(() => null),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    setItem: vi.fn(async () => undefined),
    getItem: vi.fn(async () => null),
  },
}));

vi.mock('./auth', () => ({ getToken }));

import { getTerminalWsUrl, saveConnectionConfig } from './config';

describe('getTerminalWsUrl', () => {
  beforeEach(async () => {
    getToken.mockReturnValue(null);
    await saveConnectionConfig({ remoteUrl: '', apiKey: '' });
  });

  it('returns empty when the mobile server is not configured', () => {
    expect(getTerminalWsUrl('session-1')).toBe('');
  });

  it('builds a trimmed wss URL with encoded session id and JWT precedence', async () => {
    getToken.mockReturnValue('jwt token');
    await saveConnectionConfig({ remoteUrl: 'https://hub.example.test///', apiKey: 'fallback key' });

    expect(getTerminalWsUrl('session/a?')).toBe(
      'wss://hub.example.test/api/sessions/session%2Fa%3F/terminal/ws?token=jwt%20token',
    );
  });

  it('uses ws for http and falls back to a cleaned, encoded API key', async () => {
    await saveConnectionConfig({ remoteUrl: 'http://hub.example.test/', apiKey: ' key with spaces ' });

    expect(getTerminalWsUrl('session-1')).toBe(
      'ws://hub.example.test/api/sessions/session-1/terminal/ws?apiKey=keywithspaces',
    );
  });
});
