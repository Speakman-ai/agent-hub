import { describe, expect, it } from 'vitest';
import {
  DesktopRuntimeUnavailableError,
  FIRECRACKER_DESKTOP_UNAVAILABLE_REASON,
  describeDesktopRuntimeSelection,
  selectDesktopRuntime,
} from './desktop-runtime-selection.js';
import { coerceDesktopRuntimeMode } from './desktop-runtime.js';
import { firecrackerDesktopRootfsStatus } from './desktop-rootfs-status.js';

const ROOTFS_PATH = '/var/lib/agent-hub/firecracker/rootfs-desktop.ext4';
const ROOTFS = { path: ROOTFS_PATH, present: true };
const NO_ROOTFS = { path: ROOTFS_PATH, present: false };

describe('selectDesktopRuntime', () => {
  it('auto picks firecracker when the backend is registered', () => {
    const s = selectDesktopRuntime({
      configured: 'auto',
      firecrackerRegistered: true,
      desktopRootfs: ROOTFS,
    });
    expect(s.kind).toBe('firecracker');
    expect(s.containerPlacement).toBeNull();
    expect(s.reason).toMatch(/Firecracker backend is registered/);
  });

  it('auto falls back to a Hub-host container when firecracker is not registered', () => {
    const s = selectDesktopRuntime({
      configured: 'auto',
      firecrackerRegistered: false,
      desktopRootfs: ROOTFS,
    });
    expect(s.kind).toBe('container');
    expect(s.containerPlacement).toBe('hub-docker');
    expect(s.reason).toMatch(/not registered/);
  });

  it('auto container runs on the runner fleet when FINALIZE_RUNNER_BACKEND=remote', () => {
    const s = selectDesktopRuntime({
      configured: 'auto',
      firecrackerRegistered: false,
      desktopRootfs: ROOTFS,
      finalizeRunnerBackend: 'REMOTE',
    });
    expect(s.containerPlacement).toBe('runner-fleet');
    expect(s.reason).toMatch(/runner fleet/);
  });

  it('explicit container stays a container even when firecracker is registered', () => {
    const s = selectDesktopRuntime({
      configured: 'container',
      firecrackerRegistered: true,
      desktopRootfs: ROOTFS,
    });
    expect(s.kind).toBe('container');
    expect(s.reason).toMatch(/set to container/);
  });

  it('explicit firecracker uses firecracker when registered', () => {
    const s = selectDesktopRuntime({
      configured: 'firecracker',
      firecrackerRegistered: true,
      desktopRootfs: ROOTFS,
    });
    expect(s.kind).toBe('firecracker');
  });

  it('explicit firecracker fails closed when the backend is not registered', () => {
    expect(() =>
      selectDesktopRuntime({
        configured: 'firecracker',
        firecrackerRegistered: false,
        desktopRootfs: ROOTFS,
      }),
    ).toThrow(DesktopRuntimeUnavailableError);
    expect(() =>
      selectDesktopRuntime({
        configured: 'firecracker',
        firecrackerRegistered: false,
        desktopRootfs: ROOTFS,
      }),
    ).toThrow(FIRECRACKER_DESKTOP_UNAVAILABLE_REASON);
  });

  it('describe reports the fail-closed case without throwing', () => {
    const s = describeDesktopRuntimeSelection({
      configured: 'firecracker',
      firecrackerRegistered: false,
      desktopRootfs: ROOTFS,
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

describe('desktop rootfs missing', () => {
  it('auto falls back to containers when firecracker is registered but the desktop rootfs is missing', () => {
    const s = selectDesktopRuntime({
      configured: 'auto',
      firecrackerRegistered: true,
      desktopRootfs: NO_ROOTFS,
    });
    expect(s.kind).toBe('container');
    expect(s.containerPlacement).toBe('hub-docker');
    expect(s.reason).toMatch(/desktop rootfs is missing/);
    expect(s.reason).toContain(ROOTFS_PATH);
  });

  it('explicit firecracker fails closed naming the missing path and the build command', () => {
    const host = {
      configured: 'firecracker' as const,
      firecrackerRegistered: true,
      desktopRootfs: NO_ROOTFS,
    };
    expect(() => selectDesktopRuntime(host)).toThrow(DesktopRuntimeUnavailableError);
    const s = describeDesktopRuntimeSelection(host);
    expect(s.available).toBe(false);
    expect(s.reason).toContain(ROOTFS_PATH);
    expect(s.reason).toContain('build-guest-artifacts.sh --variant desktop');
  });
});

describe('firecrackerDesktopRootfsStatus', () => {
  it('checks the default desktop rootfs path through the injected exists', () => {
    const seen: string[] = [];
    const status = firecrackerDesktopRootfsStatus({
      env: {},
      exists: (p) => (seen.push(p), false),
    });
    expect(status).toEqual({ path: ROOTFS_PATH, present: false });
    expect(seen).toEqual([ROOTFS_PATH]);
  });

  it('honours the env override and treats a throwing exists as missing', () => {
    expect(
      firecrackerDesktopRootfsStatus({
        env: { AGENT_HUB_FIRECRACKER_DESKTOP_ROOTFS: '/x/desk.ext4' },
        exists: () => true,
      }),
    ).toEqual({ path: '/x/desk.ext4', present: true });
    expect(
      firecrackerDesktopRootfsStatus({
        env: {},
        exists: () => {
          throw new Error('EACCES');
        },
      }).present,
    ).toBe(false);
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
