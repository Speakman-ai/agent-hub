import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useClientBuildVersion } from './useClientBuildVersion';

describe('useClientBuildVersion', () => {
  let originalElectronAPI: any;

  beforeEach(() => {
    originalElectronAPI = window.electronAPI;
    vi.stubEnv('VITE_APP_VERSION', '1.2.3');
  });

  afterEach(() => {
    window.electronAPI = originalElectronAPI;
    vi.unstubAllEnvs();
  });

  it('starts from VITE_APP_VERSION in the browser', () => {
    window.electronAPI = undefined;
    const { result } = renderHook(() => useClientBuildVersion());
    expect(result!.current).toBe('1.2.3');
  });

  it('replaces with getAppVersion() in Electron when resolved', async () => {
    window.electronAPI = {
      isElectron: true,
      getAppVersion: vi.fn().mockResolvedValue('9.9.9'),
    };
    const { result } = renderHook(() => useClientBuildVersion());
    expect(result!.current).toBe('1.2.3');
    await waitFor(() => {
      expect(result!.current).toBe('9.9.9');
    });
    expect(window.electronAPI.getAppVersion).toHaveBeenCalledOnce();
  });
});
