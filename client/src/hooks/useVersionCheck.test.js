import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useVersionCheck } from './useVersionCheck.js';

// VITE_APP_VERSION is exposed by vite.config.js at build time. For tests we
// stub it per-test via vi.stubEnv so we control the "client" side of the
// compare.
function stubClientVersion(v) {
  vi.stubEnv('VITE_APP_VERSION', v);
}

function stubElectron({ platform = 'darwin', arch = 'arm64' } = {}) {
  window.electronAPI = { isElectron: true, platform, arch };
}

function stubBrowser() {
  window.electronAPI = undefined;
}

describe('useVersionCheck', () => {
  let originalElectronAPI;

  beforeEach(() => {
    originalElectronAPI = window.electronAPI;
    sessionStorage.clear();
  });

  afterEach(() => {
    window.electronAPI = originalElectronAPI;
    vi.unstubAllEnvs();
    sessionStorage.clear();
  });

  it('returns updateAvailable=false when not in Electron', () => {
    stubBrowser();
    stubClientVersion('1.0.0');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '2.0.0' }));
    expect(result.current.updateAvailable).toBe(false);
  });

  it('returns updateAvailable=false when versions are equal', () => {
    stubElectron();
    stubClientVersion('1.4.2');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.4.2' }));
    expect(result.current.updateAvailable).toBe(false);
  });

  it('returns updateAvailable=false when client is ahead of server', () => {
    stubElectron();
    stubClientVersion('1.5.0');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.4.2' }));
    expect(result.current.updateAvailable).toBe(false);
  });

  it('returns updateAvailable=true when client is behind server', () => {
    stubElectron();
    stubClientVersion('1.4.2');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.5.0' }));
    expect(result.current.updateAvailable).toBe(true);
    expect(result.current.serverVersion).toBe('1.5.0');
    expect(result.current.clientVersion).toBe('1.4.2');
  });

  it('returns a darwin arm64 download URL for Apple Silicon desktops', () => {
    stubElectron({ platform: 'darwin', arch: 'arm64' });
    stubClientVersion('1.4.2');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.5.0' }));
    expect(result.current.downloadUrl).toBe(
      'https://agent-hub-prod-releases.s3.us-east-2.amazonaws.com/v1.5.0/Agent%20Hub-1.5.0-arm64.dmg',
    );
  });

  it('returns null downloadUrl on non-darwin Electron (no published DMG)', () => {
    stubElectron({ platform: 'linux', arch: 'x64' });
    stubClientVersion('1.4.2');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.5.0' }));
    expect(result.current.updateAvailable).toBe(true);
    expect(result.current.downloadUrl).toBeNull();
  });

  it('respects a dismissal stored in sessionStorage for this server version', () => {
    sessionStorage.setItem('update-dismissed-version', '1.5.0');
    stubElectron();
    stubClientVersion('1.4.2');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.5.0' }));
    expect(result.current.updateAvailable).toBe(false);
  });

  it('still prompts when sessionStorage dismissal is for a different (older) server version', () => {
    // User dismissed 1.5.0 earlier; server has since been bumped to 1.6.0.
    sessionStorage.setItem('update-dismissed-version', '1.5.0');
    stubElectron();
    stubClientVersion('1.4.2');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.6.0' }));
    expect(result.current.updateAvailable).toBe(true);
  });

  it('dismiss() hides the modal and persists to sessionStorage', () => {
    stubElectron();
    stubClientVersion('1.4.2');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.5.0' }));
    expect(result.current.updateAvailable).toBe(true);

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.updateAvailable).toBe(false);
    expect(sessionStorage.getItem('update-dismissed-version')).toBe('1.5.0');
  });

  it('returns updateAvailable=false when serverVersion is null/undefined', () => {
    stubElectron();
    stubClientVersion('1.4.2');
    const { result: r1 } = renderHook(() => useVersionCheck({ serverVersion: null }));
    expect(r1.current.updateAvailable).toBe(false);
    const { result: r2 } = renderHook(() => useVersionCheck({}));
    expect(r2.current.updateAvailable).toBe(false);
  });
});
