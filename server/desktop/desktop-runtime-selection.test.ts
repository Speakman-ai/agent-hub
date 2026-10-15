import { describe, expect, it } from 'vitest';
import {
  DesktopRuntimeUnavailableError,
  FIRECRACKER_DESKTOP_UNAVAILABLE_REASON,
  describeDesktopRuntimeSelection,
  selectDesktopRuntime,
} from './desktop-runtime-selection.js';
import { coerceDesktopRuntimeMode } from './desktop-runtime.js';

describe('selectDesktopRuntime', () => {
  it('auto picks firecracker when the backend is registered', () => {
    const s = selectDesktopRuntime({ configured: 'auto', firecrackerRegistered: true });
    expect(s.kind).toBe('firecracker');
    expect(s.containerPlacement).toBeNull();
    expect(s.reason).toMatch(/Firecracker backend is registered/);
  });

  it('auto falls back to a Hub-host container when firecracker is not registered', () => {
    const s = selectDesktopRuntime({ configured: 'auto', firecrackerRegistered: false });
    expect(s.kind).toBe('container');
    expect(s.containerPlacement).toBe('hub-docker');
    expect(s.reason).toMatch(/not registered/);
  });

  it('auto container runs on the runner fleet when FINALIZE_RUNNER_BACKEND=remote', () => {
    const s = selectDesktopRuntime({
      configured: 'auto',
      firecrackerRegistered: false,
      finalizeRunnerBackend: 'REMOTE',
    });
    expect(s.containerPlacement).toBe('runner-fleet');
    expect(s.reason).toMatch(/runner fleet/);
  });

  it('explicit container stays a container even when firecracker is registered', () => {
    const s = selectDesktopRuntime({ configured: 'container', firecrackerRegistered: true });
    expect(s.kind).toBe('container');
    expect(s.reason).toMatch(/set to container/);
  });

  it('explicit firecracker uses firecracker when registered', () => {
    const s = selectDesktopRuntime({ configured: 'firecracker', firecrackerRegistered: true });
    expect(s.kind).toBe('firecracker');
  });

  it('explicit firecracker fails closed when the backend is not registered', () => {
    expect(() =>
      selectDesktopRuntime({ configured: 'firecracker', firecrackerRegistered: false }),
    ).toThrow(DesktopRuntimeUnavailableError);
    expect(() =>
      selectDesktopRuntime({ configured: 'firecracker', firecrackerRegistered: false }),
    ).toThrow(FIRECRACKER_DESKTOP_UNAVAILABLE_REASON);
  });

  it('describe reports the fail-closed case without throwing', () => {
    const s = describeDesktopRuntimeSelection({
      configured: 'firecracker',
      firecrackerRegistered: false,
      finalizeRunnerBackend: 'remote',
    });
    expect(s).toEqual({
      available: false,
      configured: 'firecracker',
      kind: null,
      containerPlacement: null,
      reason: FIRECRACKER_DESKTOP_UNAVAILABLE_REASON,
    });
  });
});

describe('coerceDesktopRuntimeMode', () => {
  it('accepts known modes case-insensitively and defaults typos to auto', () => {
    expect(coerceDesktopRuntimeMode(' Firecracker ')).toBe('firecracker');
    expect(coerceDesktopRuntimeMode('container')).toBe('container');
    expect(coerceDesktopRuntimeMode('firecraker')).toBe('auto');
    expect(coerceDesktopRuntimeMode(undefined)).toBe('auto');
  });
});
