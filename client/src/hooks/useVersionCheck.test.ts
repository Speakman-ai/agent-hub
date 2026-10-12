import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  useVersionCheck,
  INSTALLER_RECHECK_MS,
  INSTALLER_MAX_TIMED_RECHECKS,
} from './useVersionCheck';

// VITE_APP_VERSION is exposed by vite.config.js at build time. For tests we
// stub it per-test via vi.stubEnv so we control the "client" side of the
// compare.
function stubClientVersion(v: any) {
  vi.stubEnv('VITE_APP_VERSION', v);
}

function stubElectron({ platform = 'darwin', arch = 'arm64' }: any = {}) {
  window.electronAPI = { isElectron: true, platform, arch };
}

function stubBrowser() {
  window.electronAPI = undefined;
}

describe('useVersionCheck', () => {
  let originalElectronAPI: any;

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
    expect(result!.current.updateAvailable).toBe(false);
  });

  it('returns updateAvailable=false when versions are equal', () => {
    stubElectron();
    stubClientVersion('1.4.2');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.4.2' }));
    expect(result!.current.updateAvailable).toBe(false);
  });

  it('returns updateAvailable=false when client is ahead of server', () => {
    stubElectron();
    stubClientVersion('1.5.0');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.4.2' }));
    expect(result!.current.updateAvailable).toBe(false);
  });

  it('returns updateAvailable=true when client is behind server', () => {
    stubElectron();
    stubClientVersion('1.4.2');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.5.0' }));
    expect(result!.current.updateAvailable).toBe(true);
    expect(result!.current.serverVersion).toBe('1.5.0');
    expect(result!.current.clientVersion).toBe('1.4.2');
  });

  it('returns a darwin arm64 download URL for Apple Silicon desktops when a bucket is configured', () => {
    vi.stubEnv('VITE_RELEASE_BUCKET_BASE', 'https://releases.example.test');
    stubElectron({ platform: 'darwin', arch: 'arm64' });
    stubClientVersion('1.4.2');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.5.0' }));
    expect(result!.current.downloadUrl).toBe(
      'https://releases.example.test/v1.5.0/Agent%20Hub-1.5.0-arm64.dmg',
    );
  });

  it('offers the arm64 DMG when the preload reports arm64 for an Intel build under Rosetta', () => {
    // The preload resolves `arch` from app.runningUnderARM64Translation, so a
    // translated x64 build shows up here as arm64 and gets the native DMG.
    vi.stubEnv('VITE_RELEASE_BUCKET_BASE', 'https://releases.example.test');
    stubElectron({ platform: 'darwin', arch: 'arm64' });
    window.electronAPI!.runningUnderArm64Translation = true;
    stubClientVersion('1.4.2');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.5.0' }));
    expect(result!.current.downloadUrl).toBe(
      'https://releases.example.test/v1.5.0/Agent%20Hub-1.5.0-arm64.dmg',
    );
  });

  it('still offers the Intel DMG when the desktop reports a genuine x64 machine', () => {
    vi.stubEnv('VITE_RELEASE_BUCKET_BASE', 'https://releases.example.test');
    stubElectron({ platform: 'darwin', arch: 'x64' });
    stubClientVersion('1.4.2');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.5.0' }));
    expect(result!.current.downloadUrl).toBe(
      'https://releases.example.test/v1.5.0/Agent%20Hub-1.5.0.dmg',
    );
  });

  it('returns null downloadUrl when no release bucket is configured (self-hosted)', () => {
    stubElectron({ platform: 'darwin', arch: 'arm64' });
    stubClientVersion('1.4.2');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.5.0' }));
    expect(result!.current.updateAvailable).toBe(true);
    expect(result!.current.downloadUrl).toBeNull();
  });

  it('returns null downloadUrl on non-darwin Electron (no published DMG)', () => {
    stubElectron({ platform: 'linux', arch: 'x64' });
    stubClientVersion('1.4.2');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.5.0' }));
    expect(result!.current.updateAvailable).toBe(true);
    expect(result!.current.downloadUrl).toBeNull();
  });

  it('keeps the update available but hides the pointer after a stored dismissal', () => {
    sessionStorage.setItem('update-dismissed-version', '1.5.0');
    stubElectron();
    stubClientVersion('1.4.2');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.5.0' }));
    expect(result!.current.updateAvailable).toBe(true);
    expect(result!.current.showUpdateHint).toBe(false);
  });

  it('shows the pointer again when the dismissal is for an older server version', () => {
    sessionStorage.setItem('update-dismissed-version', '1.5.0');
    stubElectron();
    stubClientVersion('1.4.2');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.6.0' }));
    expect(result!.current.showUpdateHint).toBe(true);
  });

  it('dismiss() hides the pointer and persists to sessionStorage', () => {
    stubElectron();
    stubClientVersion('1.4.2');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.5.0' }));
    expect(result!.current.showUpdateHint).toBe(true);

    act(() => {
      result.current.dismiss();
    });

    expect(result!.current.showUpdateHint).toBe(false);
    expect(result!.current.updateAvailable).toBe(true);
    expect(sessionStorage.getItem('update-dismissed-version')).toBe('1.5.0');
  });

  it('does not announce a version whose DMG is not published yet', async () => {
    // Regression: the hub reported 2.31.185 before its DMG was uploaded, and
    // the update link opened an S3 AccessDenied page.
    vi.stubEnv('VITE_RELEASE_BUCKET_BASE', 'https://releases.example.test');
    stubElectron();
    const probe = vi.fn().mockResolvedValue(false);
    window.electronAPI!.probeInstallerUrl = probe;
    stubClientVersion('1.4.2');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.5.0' }));
    await waitFor(() => expect(probe).toHaveBeenCalled());
    expect(probe).toHaveBeenCalledWith(
      'https://releases.example.test/v1.5.0/Agent%20Hub-1.5.0-arm64.dmg',
    );
    await act(async () => {});
    expect(result!.current.updateAvailable).toBe(false);
    expect(result!.current.showUpdateHint).toBe(false);
  });

  it('rechecks a missing DMG on a timer and announces it once uploaded', async () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv('VITE_RELEASE_BUCKET_BASE', 'https://releases.example.test');
      stubElectron();
      const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
      window.electronAPI!.probeInstallerUrl = probe;
      stubClientVersion('1.4.2');
      const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.5.0' }));
      await act(async () => {});
      expect(result!.current.updateAvailable).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(INSTALLER_RECHECK_MS);
      });
      expect(probe).toHaveBeenCalledTimes(2);
      expect(result!.current.updateAvailable).toBe(true);
      expect(result!.current.showUpdateHint).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops timed rechecks after the cap but still rechecks on window focus', async () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv('VITE_RELEASE_BUCKET_BASE', 'https://releases.example.test');
      stubElectron();
      let published = false;
      const probe = vi.fn(async () => published);
      window.electronAPI!.probeInstallerUrl = probe;
      stubClientVersion('1.4.2');
      const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.5.0' }));
      await act(async () => {});

      for (let i = 0; i < INSTALLER_MAX_TIMED_RECHECKS + 5; i += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(INSTALLER_RECHECK_MS);
        });
      }
      expect(probe).toHaveBeenCalledTimes(1 + INSTALLER_MAX_TIMED_RECHECKS);

      published = true;
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(probe).toHaveBeenCalledTimes(2 + INSTALLER_MAX_TIMED_RECHECKS);
      expect(result!.current.updateAvailable).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('announces unverified when the main process will not probe the release host', async () => {
    vi.stubEnv('VITE_RELEASE_BUCKET_BASE', 'https://releases.example.test');
    stubElectron();
    window.electronAPI!.probeInstallerUrl = vi.fn().mockResolvedValue(null);
    stubClientVersion('1.4.2');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.5.0' }));
    await act(async () => {});
    expect(result!.current.updateAvailable).toBe(true);
  });

  it('announces the update once the probe confirms the DMG exists', async () => {
    vi.stubEnv('VITE_RELEASE_BUCKET_BASE', 'https://releases.example.test');
    stubElectron();
    let resolveProbe: (ok: boolean) => void = () => {};
    window.electronAPI!.probeInstallerUrl = vi.fn(
      () => new Promise<boolean>((r) => (resolveProbe = r)),
    );
    stubClientVersion('1.4.2');
    const { result } = renderHook(() => useVersionCheck({ serverVersion: '1.5.0' }));
    expect(result!.current.updateAvailable).toBe(false);
    await act(async () => resolveProbe(true));
    expect(result!.current.updateAvailable).toBe(true);
    expect(result!.current.showUpdateHint).toBe(true);
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
