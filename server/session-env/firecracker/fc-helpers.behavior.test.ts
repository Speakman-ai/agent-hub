/**
 * Behavioral tests for fc-jail-manage.sh, fc-launch-vmm.sh, and fc-netctl.sh.
 * These execute the real helpers (no root required for path validation /
 * local stage+clean under a temp tree owned by the test user).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jailHelper = path.join(here, 'build/fc-jail-manage.sh');
const launchHelper = path.join(here, 'build/fc-launch-vmm.sh');
const netctlHelper = path.join(here, 'build/fc-netctl.sh');
const pathGuard = path.join(here, 'build/fc-path-guard.sh');

function writeRootsConf(base: string): string {
  const conf = path.join(base, 'roots.conf');
  writeFileSync(
    conf,
    [
      `ARTIFACT_DIR="${base}"`,
      `RUN_DIR="${base}"`,
      `JAILER_DIR="${base}"`,
      `WORKTREE_ROOTS="${base}"`,
      'BRIDGE=ahfc0',
      'BRIDGE_CIDR=172.30.0.1/16',
      'SUBNET=172.30.0.0/16',
      'GATEWAY_IP=172.30.0.1',
      '',
    ].join('\n'),
  );
  return conf;
}

function run(
  helper: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(helper, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('fc-jail-manage.sh clean', () => {
  it('rejects the always-true *""* class of paths and traversal', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'fc-jail-reject-'));
    try {
      const conf = writeRootsConf(base);
      const env = { AGENT_HUB_FC_ROOTS_CONF: conf };
      expect(run(jailHelper, ['clean', '/tmp/firecracker/../etc'], env).status).toBe(2);
      expect(run(jailHelper, ['clean', 'relative/firecracker/x'], env).status).toBe(2);
      expect(run(jailHelper, ['clean', path.join(base, 'firecracker')], env).status).toBe(2);
      expect(run(jailHelper, ['clean', '/tmp/not-fc/ahvm'], env).status).toBe(2);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('removes a valid .../firecracker/<vmId> tree', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'fc-jail-clean-'));
    try {
      const conf = writeRootsConf(base);
      const tree = path.join(base, 'firecracker', 'ahvm-proof');
      mkdirSync(path.join(tree, 'root'), { recursive: true });
      writeFileSync(path.join(tree, 'root', 'marker'), 'x');
      const res = run(jailHelper, ['clean', tree], { AGENT_HUB_FC_ROOTS_CONF: conf });
      expect(res.status, res.stderr).toBe(0);
      expect(existsSync(tree)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('fc-jail-manage.sh stage', () => {
  it('stages disks+config and applies jailer uid modes', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'fc-jail-stage-'));
    try {
      const conf = writeRootsConf(base);
      const root = path.join(base, 'firecracker', 'ahvm-1', 'root');
      const kernel = path.join(base, 'vmlinux');
      const rootfs = path.join(base, 'rootfs.ext4');
      const workspace = path.join(base, 'workspace.ext4');
      const configSrc = path.join(base, 'cfg.json');
      writeFileSync(kernel, 'k');
      writeFileSync(rootfs, 'r');
      writeFileSync(workspace, 'w');
      writeFileSync(configSrc, '{"ok":true}');
      const uid = String(process.getuid?.() ?? 1000);
      const gid = String(process.getgid?.() ?? 1000);
      const res = run(jailHelper, ['stage', root, kernel, rootfs, workspace, uid, gid, configSrc], {
        AGENT_HUB_FC_ROOTS_CONF: conf,
      });
      expect(res.status, res.stderr).toBe(0);
      expect(readFileSync(path.join(root, 'vm-config.json'), 'utf8')).toBe('{"ok":true}');
      expect(existsSync(path.join(root, 'vmlinux'))).toBe(true);
      expect(existsSync(path.join(root, 'rootfs.ext4'))).toBe(true);
      expect(existsSync(path.join(root, 'workspace.ext4'))).toBe(true);
      const diskMode = statSync(path.join(root, 'workspace.ext4')).mode & 0o777;
      expect(diskMode).toBe(0o660);
      const kernelMode = statSync(path.join(root, 'vmlinux')).mode & 0o777;
      expect(kernelMode).toBe(0o444);
      // RW disks must be writable by the staging uid (jailer contract).
      chmodSync(path.join(root, 'workspace.ext4'), 0o660);
      writeFileSync(path.join(root, 'workspace.ext4'), 'ww');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('refuses stage sources outside configured roots', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'fc-jail-outside-'));
    try {
      const conf = writeRootsConf(base);
      const root = path.join(base, 'firecracker', 'ahvm-1', 'root');
      const res = run(
        jailHelper,
        [
          'stage',
          root,
          '/etc/passwd',
          path.join(base, 'rootfs.ext4'),
          path.join(base, 'workspace.ext4'),
          '1000',
          '1000',
          path.join(base, 'cfg.json'),
        ],
        { AGENT_HUB_FC_ROOTS_CONF: conf },
      );
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/outside configured/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('fc-launch-vmm.sh', () => {
  it('refuses arbitrary executables', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'fc-launch-'));
    try {
      const conf = writeRootsConf(base);
      const sock = path.join(base, 'vsock');
      const res = run(launchHelper, [sock, '1000:1000', '/bin/sh', '-c', 'true'], {
        AGENT_HUB_FC_ROOTS_CONF: conf,
      });
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/refused mode/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('refuses jailer without pinned --exec-file /usr/bin/firecracker', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'fc-launch-jail-'));
    try {
      const conf = writeRootsConf(base);
      const sock = path.join(base, 'vsock');
      const res = run(
        launchHelper,
        [
          sock,
          '1000:1000',
          'jailer',
          '--id',
          'x',
          '--exec-file',
          '/bin/sh',
          '--uid',
          '1000',
          '--gid',
          '1000',
          '--chroot-base-dir',
          base,
          '--',
          '--api-sock',
          'api.sock',
        ],
        { AGENT_HUB_FC_ROOTS_CONF: conf },
      );
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/--exec-file \/usr\/bin\/firecracker/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('fc-netctl.sh', () => {
  it('refuses non-session tap names', () => {
    const res = run(netctlHelper, ['tap-create', 'eth0']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/refused tap name/);
  });
});

describe('bash -n helpers', () => {
  it('parses', () => {
    for (const helper of [jailHelper, launchHelper, netctlHelper, pathGuard]) {
      execFileSync('bash', ['-n', helper]);
    }
  });
});
