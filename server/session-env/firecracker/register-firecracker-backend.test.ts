import { describe, expect, it } from 'vitest';
import { resolveFirecrackerUseJailer } from './register-firecracker-backend.js';
import type { FirecrackerExecConfig } from './firecracker-privileged-exec.js';

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
