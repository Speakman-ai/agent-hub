import { afterEach, describe, expect, it, vi } from 'vitest';

const cfg = { desktopRuntime: 'auto', dataDir: '/tmp/desktop-setup-test' };
vi.mock('../config.js', () => ({ default: cfg }));
let firecracker = false;
vi.mock('../session-env/firecracker/firecracker-backend-status.js', () => ({
  isFirecrackerBackendRegistered: () => firecracker,
}));
let containersExist = false;
vi.mock('./desktop-containers-store.js', async (orig) => ({
  ...(await orig<typeof import('./desktop-containers-store.js')>()),
  hasDesktopContainers: () => containersExist,
  listActiveDesktopComputers: () => [],
}));

const {
  __resetDesktopRuntimeForTests,
  createDesktopContainerHost,
  getActiveDesktopRuntime,
  getContainerDesktopRuntime,
  registerContainerDesktopRuntimeOnBoot,
  resolveDesktopMaxRunning,
} = await import('./desktop-runtime-setup.js');
const { DesktopRuntimeUnavailableError } = await import('./desktop-runtime-selection.js');
const { getDesktopRuntime, registerDesktopRuntime, resetDesktopRuntimesForTests } =
  await import('./desktop-runtime-registry.js');

afterEach(() => {
  __resetDesktopRuntimeForTests();
  resetDesktopRuntimesForTests();
  firecracker = false;
  containersExist = false;
  cfg.desktopRuntime = 'auto';
  delete process.env.FINALIZE_RUNNER_BACKEND;
});

describe('container desktop runtime setup', () => {
  it('reads the capacity cap from env, defaulting to 4', () => {
    expect(resolveDesktopMaxRunning({})).toBe(4);
    expect(resolveDesktopMaxRunning({ AGENT_HUB_DESKTOP_MAX_RUNNING: '12' })).toBe(12);
    expect(resolveDesktopMaxRunning({ AGENT_HUB_DESKTOP_MAX_RUNNING: 'lots' })).toBe(4);
    expect(resolveDesktopMaxRunning({ AGENT_HUB_DESKTOP_MAX_RUNNING: '0' })).toBe(4);
  });

  it('maps placements to hosts', () => {
    expect(createDesktopContainerHost('hub-docker').placement).toBe('hub-docker');
    expect(createDesktopContainerHost('runner-fleet').placement).toBe('runner-fleet');
  });

  it('registers the container backend at boot when containers are selected', async () => {
    process.env.FINALIZE_RUNNER_BACKEND = 'remote';
    await registerContainerDesktopRuntimeOnBoot();
    const rt = getDesktopRuntime('container');
    expect(rt).toBe(getContainerDesktopRuntime());
    expect(rt?.kind).toBe('container');
  });

  it('stays out of the registry when Firecracker won and no container desktops exist', async () => {
    firecracker = true;
    await registerContainerDesktopRuntimeOnBoot();
    expect(getDesktopRuntime('container')).toBeNull();
    expect(() => getContainerDesktopRuntime()).toThrow(DesktopRuntimeUnavailableError);
  });

  it('still registers when container desktops exist, so profile deletes can clean them up', async () => {
    firecracker = true;
    containersExist = true;
    await registerContainerDesktopRuntimeOnBoot();
    expect(getDesktopRuntime('container')?.kind).toBe('container');
  });

  it('resolves the active runtime for the computer tool', () => {
    expect(getActiveDesktopRuntime().kind).toBe('container');

    firecracker = true;
    const fc = { kind: 'firecracker' } as Parameters<typeof registerDesktopRuntime>[0];
    registerDesktopRuntime(fc);
    expect(getActiveDesktopRuntime()).toBe(fc);

    resetDesktopRuntimesForTests();
    cfg.desktopRuntime = 'firecracker';
    expect(() => getActiveDesktopRuntime()).toThrow(DesktopRuntimeUnavailableError);
    firecracker = false;
    expect(() => getActiveDesktopRuntime()).toThrow(DesktopRuntimeUnavailableError);
  });
});
