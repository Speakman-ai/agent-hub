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
  symlinkSync,
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
      `CONTROL_DIR="${base}"`,
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

  it('refuses stage when config is outside CONTROL_DIR', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'fc-jail-ctrl-'));
    const other = mkdtempSync(path.join(os.tmpdir(), 'fc-jail-ctrl-other-'));
    try {
      const conf = path.join(base, 'roots.conf');
      writeFileSync(
        conf,
        [
          `ARTIFACT_DIR="${base}"`,
          `RUN_DIR="${base}"`,
          `JAILER_DIR="${base}"`,
          `CONTROL_DIR="${path.join(base, 'control')}"`,
          `WORKTREE_ROOTS="${base}"`,
          '',
        ].join('\n'),
      );
      mkdirSync(path.join(base, 'control'), { recursive: true });
      const root = path.join(base, 'firecracker', 'ahvm-1', 'root');
      writeFileSync(path.join(base, 'vmlinux'), 'k');
      writeFileSync(path.join(base, 'rootfs.ext4'), 'r');
      writeFileSync(path.join(base, 'workspace.ext4'), 'w');
      const outsideCfg = path.join(other, 'cfg.json');
      writeFileSync(outsideCfg, '{}');
      const res = run(
        jailHelper,
        [
          'stage',
          root,
          path.join(base, 'vmlinux'),
          path.join(base, 'rootfs.ext4'),
          path.join(base, 'workspace.ext4'),
          '1000',
          '1000',
          outsideCfg,
        ],
        { AGENT_HUB_FC_ROOTS_CONF: conf },
      );
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/outside configured/);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses stage destination outside JAILER_DIR even under WORKTREE_ROOTS', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'fc-jail-dest-'));
    try {
      const jailer = path.join(base, 'jailer');
      const worktree = path.join(base, 'wt');
      mkdirSync(jailer, { recursive: true });
      mkdirSync(worktree, { recursive: true });
      const conf = path.join(base, 'roots.conf');
      writeFileSync(
        conf,
        [
          `ARTIFACT_DIR="${base}"`,
          `RUN_DIR="${base}"`,
          `JAILER_DIR="${jailer}"`,
          `CONTROL_DIR="${base}"`,
          `WORKTREE_ROOTS="${worktree}"`,
          '',
        ].join('\n'),
      );
      writeFileSync(path.join(base, 'vmlinux'), 'k');
      writeFileSync(path.join(base, 'rootfs.ext4'), 'r');
      writeFileSync(path.join(base, 'workspace.ext4'), 'w');
      writeFileSync(path.join(base, 'cfg.json'), '{}');
      const evilRoot = path.join(worktree, 'firecracker', 'ahvm-1', 'root');
      const res = run(
        jailHelper,
        [
          'stage',
          evilRoot,
          path.join(base, 'vmlinux'),
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

  it('accepts pinned --exec-file /usr/bin/firecracker in argv path validation', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'fc-launch-ok-'));
    try {
      const conf = writeRootsConf(base);
      const chroot = path.join(base, 'jail');
      mkdirSync(chroot, { recursive: true });
      const script = `
        set -euo pipefail
        source ${JSON.stringify(pathGuard)}
        export AGENT_HUB_FC_ROOTS_CONF=${JSON.stringify(conf)}
        fc_assert_argv_paths_under_roots \\
          --id ahvm-test \\
          --exec-file /usr/bin/firecracker \\
          --uid 1000 \\
          --gid 1000 \\
          --chroot-base-dir ${JSON.stringify(chroot)} \\
          -- \\
          --api-sock ${JSON.stringify(path.join(base, 'api.sock'))} \\
          --config-file ${JSON.stringify(path.join(base, 'vm-config.json'))}
        echo OK
      `;
      const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toMatch(/OK/);
      expect(res.stderr).not.toMatch(/outside configured/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('fc-path-guard symlink escape', () => {
  it('rejects a worktree symlink that retargets an output under /tmp', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'fc-symlink-'));
    const outside = mkdtempSync(path.join(os.tmpdir(), 'fc-outside-'));
    try {
      const conf = writeRootsConf(base);
      const link = path.join(base, 'escape');
      // Hub-writable worktree entry pointing outside the allowed roots.
      symlinkSync(outside, link);
      const evilOut = path.join(link, 'disk.ext4');
      const script = `
        set -euo pipefail
        source ${JSON.stringify(pathGuard)}
        export AGENT_HUB_FC_ROOTS_CONF=${JSON.stringify(conf)}
        fc_assert_output_under_roots 'workspace-out' ${JSON.stringify(evilOut)}
      `;
      const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/outside configured/);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects disk outputs under WORKTREE_ROOTS even without a symlink', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'fc-wt-out-'));
    try {
      const conf = writeRootsConf(base);
      const wtOut = path.join(base, 'session-tree', 'workspace.ext4');
      mkdirSync(path.dirname(wtOut), { recursive: true });
      // Reconfigure so RUN_DIR is separate from WORKTREE_ROOTS.
      writeFileSync(
        conf,
        [
          `ARTIFACT_DIR="${path.join(base, 'artifacts')}"`,
          `RUN_DIR="${path.join(base, 'vms')}"`,
          `JAILER_DIR="${path.join(base, 'jailer')}"`,
          `CONTROL_DIR="${path.join(base, 'control')}"`,
          `WORKTREE_ROOTS="${path.join(base, 'session-tree')}"`,
          '',
        ].join('\n'),
      );
      mkdirSync(path.join(base, 'artifacts'), { recursive: true });
      mkdirSync(path.join(base, 'vms'), { recursive: true });
      const script = `
        set -euo pipefail
        source ${JSON.stringify(pathGuard)}
        export AGENT_HUB_FC_ROOTS_CONF=${JSON.stringify(conf)}
        fc_assert_output_under_roots 'workspace-out' ${JSON.stringify(wtOut)}
      `;
      const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/outside configured/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('allows CONTROL_DIR paths and rejects mid-path symlink retargets', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'fc-ctrl-'));
    const outside = mkdtempSync(path.join(os.tmpdir(), 'fc-ctrl-out-'));
    try {
      const control = path.join(base, 'control');
      mkdirSync(control, { recursive: true });
      const conf = path.join(base, 'roots.conf');
      writeFileSync(
        conf,
        [
          `ARTIFACT_DIR="${base}"`,
          `RUN_DIR="${base}"`,
          `JAILER_DIR="${base}"`,
          `CONTROL_DIR="${control}"`,
          `WORKTREE_ROOTS="${base}"`,
          '',
        ].join('\n'),
      );
      const okCfg = path.join(control, 'vm', 'cfg.json');
      mkdirSync(path.dirname(okCfg), { recursive: true });
      writeFileSync(okCfg, '{}');
      const okScript = `
        set -euo pipefail
        source ${JSON.stringify(pathGuard)}
        export AGENT_HUB_FC_ROOTS_CONF=${JSON.stringify(conf)}
        fc_assert_control_under_roots 'config' ${JSON.stringify(okCfg)}
        fc_assert_no_symlink_components 'config' ${JSON.stringify(okCfg)}
        echo OK
      `;
      const ok = spawnSync('bash', ['-c', okScript], { encoding: 'utf8' });
      expect(ok.status, ok.stderr).toBe(0);

      const link = path.join(control, 'escape');
      symlinkSync(outside, link);
      const evil = path.join(link, 'cfg.json');
      const badScript = `
        set -euo pipefail
        source ${JSON.stringify(pathGuard)}
        export AGENT_HUB_FC_ROOTS_CONF=${JSON.stringify(conf)}
        fc_assert_no_symlink_components 'config' ${JSON.stringify(evil)}
      `;
      const bad = spawnSync('bash', ['-c', badScript], { encoding: 'utf8' });
      expect(bad.status).toBe(2);
      expect(bad.stderr).toMatch(/symlink component/);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('fc-prepare-disks.sh worktree copy', () => {
  it('streams the worktree tar instead of buffering produced.stdout', () => {
    const src = readFileSync(path.join(here, 'build/fc-prepare-disks.sh'), 'utf8');
    expect(src).not.toMatch(/produced\.stdout/);
    expect(src).toMatch(/AGENT_HUB_FC_WORKTREE_TAR_MAX_BYTES|worktree archive exceeded/);
    expect(src).toMatch(/Popen\([\s\S]*tar[\s\S]*-cf[\s\S]*Popen\([\s\S]*tar[\s\S]*-xf/);
  });
});

describe('fc-netctl.sh', () => {
  it('refuses non-session tap names', () => {
    const res = run(netctlHelper, ['tap-create', 'eth0']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/refused tap name/);
  });
});

describe('fc-prepare-disks.sh argv', () => {
  const prepareHelper = path.join(here, 'build/fc-prepare-disks.sh');

  it('refuses caller-supplied --rootfs-out / --workspace-out', () => {
    const res = run(prepareHelper, [
      '--vm-id',
      'ahvm-x',
      '--base-rootfs',
      '/tmp/x',
      '--worktree',
      '/tmp/y',
      '--rootfs-out',
      '/tmp/z',
    ]);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/refusing caller-supplied output path/);
  });
});

describe('bash -n helpers', () => {
  it('parses', () => {
    const prepareHelper = path.join(here, 'build/fc-prepare-disks.sh');
    for (const helper of [jailHelper, launchHelper, netctlHelper, pathGuard, prepareHelper]) {
      execFileSync('bash', ['-n', helper]);
    }
  });
});
