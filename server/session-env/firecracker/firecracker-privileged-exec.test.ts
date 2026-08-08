import { describe, expect, it } from 'vitest';
import {
  buildPrivilegedArgv,
  buildStopVmmArgv,
  resolveFirecrackerExecConfig,
  resolveHelperMounts,
  vmmContainerName,
  type FirecrackerExecConfig,
} from './firecracker-privileged-exec.js';
import type { FirecrackerPaths } from './firecracker-session-env.js';

const paths: FirecrackerPaths = {
  kernelPath: '/var/lib/agent-hub/firecracker/vmlinux',
  baseRootfsPath: '/var/lib/agent-hub/firecracker/rootfs.ext4',
  runDir: '/var/lib/agent-hub/firecracker/vms',
  diskHelper: '/usr/local/lib/agent-hub/fc-prepare-disks.sh',
};

function dockerCfg(overrides: Partial<FirecrackerExecConfig> = {}): FirecrackerExecConfig {
  return {
    mode: 'docker',
    image: 'runner:latest',
    dockerBin: 'docker',
    sudoBin: 'sudo',
    mounts: [
      { path: '/var/lib/agent-hub/firecracker' },
      { path: '/usr/bin/firecracker', readOnly: true },
    ],
    ...overrides,
  };
}

describe('buildPrivilegedArgv', () => {
  it('runs the argv under non-interactive sudo in local mode', () => {
    const cfg = dockerCfg({ mode: 'local', image: undefined });
    expect(buildPrivilegedArgv(cfg, ['ip', 'link', 'del', 'ahfct3'])).toEqual([
      'sudo',
      '-n',
      'ip',
      'link',
      'del',
      'ahfct3',
    ]);
  });

  it('wraps the argv in a privileged host-network container in docker mode', () => {
    const argv = buildPrivilegedArgv(dockerCfg(), ['ip', 'tuntap', 'add', 'ahfct3', 'mode', 'tap']);
    expect(argv).toEqual([
      'docker',
      'run',
      '--rm',
      // Bypasses the CI runner entrypoint; the command becomes the entrypoint.
      '--entrypoint',
      'ip',
      '--privileged',
      '--user',
      '0:0',
      '--network',
      'host',
      '-v',
      '/var/lib/agent-hub/firecracker:/var/lib/agent-hub/firecracker',
      '-v',
      '/usr/bin/firecracker:/usr/bin/firecracker:ro',
      '-w',
      '/',
      'runner:latest',
      'tuntap',
      'add',
      'ahfct3',
      'mode',
      'tap',
    ]);
  });

  it('names the container when asked, so teardown can find it without a pid', () => {
    const argv = buildPrivilegedArgv(dockerCfg(), ['firecracker'], {
      containerName: vmmContainerName('ahvm-sess-1'),
    });
    expect(argv.slice(0, 5)).toEqual(['docker', 'run', '--rm', '--name', 'ah-vmm-ahvm-sess-1']);
  });

  it('rejects an empty argv instead of building a container with no command', () => {
    expect(() => buildPrivilegedArgv(dockerCfg(), [])).toThrow(/requires a command/);
  });

  it('refuses docker mode without an image rather than shelling out to a bare argv', () => {
    const cfg = dockerCfg({ image: undefined });
    expect(() => buildPrivilegedArgv(cfg, ['ip', 'link'])).toThrow(/no helper image is configured/);
  });

  it('mounts every host path at the identical path inside the helper', () => {
    const cfg = dockerCfg({
      mounts: [{ path: '/a' }, { path: '/b/c', readOnly: true }],
    });
    const argv = buildPrivilegedArgv(cfg, ['true']);
    expect(argv).toContain('/a:/a');
    expect(argv).toContain('/b/c:/b/c:ro');
  });
});

describe('buildStopVmmArgv', () => {
  it('force-removes the named VMM container', () => {
    expect(buildStopVmmArgv(dockerCfg(), 'ahvm-sess-9')).toEqual([
      'docker',
      'rm',
      '-f',
      'ah-vmm-ahvm-sess-9',
    ]);
  });
});

describe('resolveFirecrackerExecConfig', () => {
  it('defaults to local when no helper image is configured', () => {
    const cfg = resolveFirecrackerExecConfig(paths, {});
    expect(cfg.mode).toBe('local');
    expect(cfg.image).toBeUndefined();
  });

  it('switches to docker as soon as a helper image exists', () => {
    const cfg = resolveFirecrackerExecConfig(paths, {
      AGENT_HUB_FIRECRACKER_PRIVILEGED_IMAGE: 'runner:main',
    });
    expect(cfg.mode).toBe('docker');
    expect(cfg.image).toBe('runner:main');
  });

  it('lets an explicit mode override the image-derived default', () => {
    const cfg = resolveFirecrackerExecConfig(paths, {
      AGENT_HUB_FIRECRACKER_PRIVILEGED_IMAGE: 'runner:main',
      AGENT_HUB_FIRECRACKER_EXEC_MODE: 'local',
    });
    expect(cfg.mode).toBe('local');
  });

  it('ignores an unrecognized mode instead of failing the boot', () => {
    const cfg = resolveFirecrackerExecConfig(paths, {
      AGENT_HUB_FIRECRACKER_EXEC_MODE: 'wishful',
    });
    expect(cfg.mode).toBe('local');
  });

  it('honors custom binaries', () => {
    const cfg = resolveFirecrackerExecConfig(paths, {
      AGENT_HUB_DOCKER_BIN: '/usr/local/bin/docker',
      AGENT_HUB_SUDO_BIN: '/run/wrappers/bin/sudo',
    });
    expect(cfg.dockerBin).toBe('/usr/local/bin/docker');
    expect(cfg.sudoBin).toBe('/run/wrappers/bin/sudo');
  });
});

describe('resolveHelperMounts', () => {
  it('mounts the artifact directory, the VMM binary, and the disk helper', () => {
    const mounts = resolveHelperMounts(paths, {});
    const byPath = new Map(mounts.map((m) => [m.path, m]));
    expect(byPath.has('/var/lib/agent-hub/firecracker')).toBe(true);
    expect(byPath.get('/usr/bin/firecracker')?.readOnly).toBe(true);
    expect(byPath.get('/usr/local/lib/agent-hub/fc-prepare-disks.sh')?.readOnly).toBe(true);
  });

  it('drops the run directory when the artifact mount already covers it', () => {
    const mounts = resolveHelperMounts(paths, {});
    expect(mounts.map((m) => m.path)).not.toContain('/var/lib/agent-hub/firecracker/vms');
  });

  it('keeps a run directory staged outside the artifact tree', () => {
    const mounts = resolveHelperMounts({ ...paths, runDir: '/run/agent-hub/vms' }, {});
    expect(mounts.map((m) => m.path)).toContain('/run/agent-hub/vms');
  });

  it('includes the worktrees directory so disk seeding can read the session checkout', () => {
    const mounts = resolveHelperMounts(paths, {
      AGENT_HUB_HOST_WORKSPACES_DIR: '/var/lib/agent-hub/workspaces',
    });
    expect(mounts.map((m) => m.path)).toContain('/var/lib/agent-hub/workspaces');
  });

  it('accepts extra mounts as a comma-separated list, ignoring blanks', () => {
    const mounts = resolveHelperMounts(paths, {
      AGENT_HUB_FIRECRACKER_EXTRA_MOUNTS: '/mnt/one, /mnt/two ,,',
    });
    const list = mounts.map((m) => m.path);
    expect(list).toContain('/mnt/one');
    expect(list).toContain('/mnt/two');
    expect(list).not.toContain('');
  });

  it('does not emit the same path twice', () => {
    const mounts = resolveHelperMounts(paths, {
      AGENT_HUB_FIRECRACKER_EXTRA_MOUNTS: '/usr/bin/firecracker',
    });
    const list = mounts.map((m) => m.path);
    expect(list.filter((p) => p === '/usr/bin/firecracker')).toHaveLength(1);
  });
});
