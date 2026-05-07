import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./connection.js', () => ({
  getConnectionConfig: vi.fn(),
  getServerBase: vi.fn(),
}));

import { fetchDesktopUpdateHealth } from './desktopUpdateCheck.js';
import { getConnectionConfig, getServerBase } from './connection.js';

describe('fetchDesktopUpdateHealth', () => {
  let origWindow;

  beforeEach(() => {
    origWindow = globalThis.window;
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.window = origWindow;
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('returns null when window.electronAPI.isElectron is false', async () => {
    globalThis.window = { electronAPI: { isElectron: false } };
    await expect(fetchDesktopUpdateHealth()).resolves.toBeNull();
  });

  it('in remote mode fetches /api/health on the remote base URL', async () => {
    globalThis.window = { electronAPI: { isElectron: true } };
    getConnectionConfig.mockReturnValue({
      mode: 'remote',
      remoteUrl: 'https://hub.example.com/',
    });
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '2.1.0', gitHash: 'abc123' }),
    });

    const out = await fetchDesktopUpdateHealth();
    expect(out).toEqual({ version: '2.1.0', gitHash: 'abc123' });
    expect(globalThis.fetch).toHaveBeenCalledWith('https://hub.example.com/api/health');
  });

  it('in local mode uses main-process fetch when publicUrl is configured', async () => {
    globalThis.window = {
      electronAPI: {
        isElectron: true,
        fetchRemoteHealth: vi.fn().mockResolvedValue({ version: '3.0.0', gitHash: 'def' }),
      },
    };
    getConnectionConfig.mockReturnValue({ mode: 'local', remoteUrl: '' });
    getServerBase.mockReturnValue('');
    globalThis.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ publicUrl: 'https://prod.example.com' }),
    });

    const out = await fetchDesktopUpdateHealth();
    expect(out).toEqual({ version: '3.0.0', gitHash: 'def' });
    expect(globalThis.window.electronAPI.fetchRemoteHealth).toHaveBeenCalledWith(
      'https://prod.example.com/api/health',
    );
  });

  it('in local mode falls back to embedded /api/health when publicUrl and env are empty', async () => {
    globalThis.window = {
      electronAPI: {
        isElectron: true,
        fetchRemoteHealth: vi.fn().mockResolvedValue(null),
      },
    };
    getConnectionConfig.mockReturnValue({ mode: 'local', remoteUrl: '' });
    getServerBase.mockReturnValue('');
    globalThis.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ publicUrl: '' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ version: '1.0.0', gitHash: 'local' }),
      });

    const out = await fetchDesktopUpdateHealth();
    expect(out).toEqual({ version: '1.0.0', gitHash: 'local' });
    expect(globalThis.fetch).toHaveBeenLastCalledWith('/api/health');
  });

  it('uses VITE_DESKTOP_UPDATE_CHECK_URL when publicUrl is missing', async () => {
    vi.stubEnv('VITE_DESKTOP_UPDATE_CHECK_URL', 'https://channel.example.org');
    globalThis.window = {
      electronAPI: {
        isElectron: true,
        fetchRemoteHealth: vi.fn().mockResolvedValue({ version: '4.5.6', gitHash: '' }),
      },
    };
    getConnectionConfig.mockReturnValue({ mode: 'local', remoteUrl: '' });
    getServerBase.mockReturnValue('');
    globalThis.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ publicUrl: '' }),
    });

    const out = await fetchDesktopUpdateHealth();
    expect(out).toEqual({ version: '4.5.6', gitHash: '' });
    expect(globalThis.window.electronAPI.fetchRemoteHealth).toHaveBeenCalledWith(
      'https://channel.example.org/api/health',
    );
  });
});
