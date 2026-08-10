/**
 * Behavioral tests for fc-jail-manage.sh and fc-launch-vmm.sh.
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

function run(
  helper: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(helper, args, { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('fc-jail-manage.sh clean', () => {
  it('rejects the always-true *""* class of paths and traversal', () => {
    expect(run(jailHelper, ['clean', '/tmp/firecracker/../etc']).status).toBe(2);
    expect(run(jailHelper, ['clean', 'relative/firecracker/x']).status).toBe(2);
    expect(run(jailHelper, ['clean', '/tmp/firecracker']).status).toBe(2);
    expect(run(jailHelper, ['clean', '/tmp/not-fc/ahvm']).status).toBe(2);
  });

  it('removes a valid .../firecracker/<vmId> tree', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'fc-jail-clean-'));
    try {
      const tree = path.join(base, 'firecracker', 'ahvm-proof');
      mkdirSync(path.join(tree, 'root'), { recursive: true });
      writeFileSync(path.join(tree, 'root', 'marker'), 'x');
      const res = run(jailHelper, ['clean', tree]);
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
      const res = run(jailHelper, ['stage', root, kernel, rootfs, workspace, uid, gid, configSrc]);
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
});

describe('fc-launch-vmm.sh', () => {
  it('refuses arbitrary executables', () => {
    const res = run(launchHelper, ['/tmp/vsock', '1000:1000', '/bin/sh', '-c', 'true']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/refused mode/);
  });

  it('refuses jailer without pinned --exec-file /usr/bin/firecracker', () => {
    const res = run(launchHelper, [
      '/tmp/vsock',
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
      '/tmp',
      '--',
      '--api-sock',
      'api.sock',
    ]);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--exec-file \/usr\/bin\/firecracker/);
  });
});

describe('bash -n helpers', () => {
  it('parses', () => {
    execFileSync('bash', ['-n', jailHelper]);
    execFileSync('bash', ['-n', launchHelper]);
  });
});
