import { describe, expect, it, vi } from 'vitest';
import {
  forgetPersistedFirecrackerDisks,
  resolveFirecrackerUseJailer,
} from './register-firecracker-backend.js';
import type { FirecrackerExecConfig } from './firecracker-privileged-exec.js';
import type { FirecrackerHostIo } from './firecracker-session-env.js';

const localCfg: FirecrackerExecConfig = {
  mode: 'local',
  sudoBin: 'sudo',
  dockerBin: 'docker',
  mounts: [],
};

const dockerCfg: FirecrackerExecConfig = {
  mode: 'docker',
  image: 'runner:latest',
  sudoBin: 'sudo',
  dockerBin: 'docker',
  mounts: [],
};

describe('resolveFirecrackerUseJailer', () => {
  it('defaults on for local and docker (production isolation)', () => {
    expect(resolveFirecrackerUseJailer(localCfg, {})).toBe(true);
    expect(resolveFirecrackerUseJailer(dockerCfg, {})).toBe(true);
  });

  it('honors explicit off/on overrides', () => {
    expect(resolveFirecrackerUseJailer(dockerCfg, { AGENT_HUB_FIRECRACKER_USE_JAILER: '0' })).toBe(
      false,
    );
    expect(
      resolveFirecrackerUseJailer(localCfg, { AGENT_HUB_FIRECRACKER_USE_JAILER: 'false' }),
    ).toBe(false);
    expect(resolveFirecrackerUseJailer(dockerCfg, { AGENT_HUB_FIRECRACKER_USE_JAILER: '1' })).toBe(
      true,
    );
    expect(resolveFirecrackerUseJailer(localCfg, { AGENT_HUB_FIRECRACKER_USE_JAILER: 'on' })).toBe(
      true,
    );
  });
});

describe('forgetPersistedFirecrackerDisks', () => {
  it('runs prepare-disks clean for the session vm id', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, stdout: '', stderr: '' });
    const io = { run } as unknown as FirecrackerHostIo;
    await forgetPersistedFirecrackerDisks('sess-1', {
      io,
      paths: {
        kernelPath: '/k',
        baseRootfsPath: '/r',
        runDir: '/vms',
        controlDir: '/c',
        diskHelper: '/usr/local/lib/agent-hub/fc-prepare-disks.sh',
      },
    });
    expect(run).toHaveBeenCalledWith([
      '/usr/local/lib/agent-hub/fc-prepare-disks.sh',
      'clean',
      '--vm-id',
      'ahvm-sess-1',
    ]);
  });

  it('fails closed when privileged clean cannot be proven', async () => {
    const run = vi.fn().mockResolvedValue({ ok: false, stdout: '', stderr: 'permission denied' });
    const io = { run } as unknown as FirecrackerHostIo;
    await expect(
      forgetPersistedFirecrackerDisks('sess-1', {
        io,
        paths: {
          kernelPath: '/k',
          baseRootfsPath: '/r',
          runDir: '/vms',
          controlDir: '/c',
          diskHelper: '/usr/local/lib/agent-hub/fc-prepare-disks.sh',
        },
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
