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
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
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
      const kernelBefore = statSync(kernel);
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
      // Copy/reflink kernel — never hard-link — so chown cannot retarget ARTIFACT_DIR.
      const kernelAfter = statSync(kernel);
      expect(kernelAfter.ino).not.toBe(statSync(path.join(root, 'vmlinux')).ino);
      expect(kernelAfter.uid).toBe(kernelBefore.uid);
      expect(kernelAfter.mode).toBe(kernelBefore.mode);
      // Workspace is the same inode as RUN_DIR so guest writes persist.
      expect(statSync(workspace).ino).toBe(statSync(path.join(root, 'workspace.ext4')).ino);
      // RW disks must be writable by the staging uid (jailer contract).
      chmodSync(path.join(root, 'workspace.ext4'), 0o660);
      writeFileSync(path.join(root, 'workspace.ext4'), 'ww');
      expect(readFileSync(workspace, 'utf8')).toBe('ww');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('jail clean drops the staged link without deleting the RUN_DIR workspace', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'fc-jail-keep-ws-'));
    try {
      const conf = writeRootsConf(base);
      const tree = path.join(base, 'firecracker', 'ahvm-1');
      const root = path.join(tree, 'root');
      const kernel = path.join(base, 'vmlinux');
      const rootfs = path.join(base, 'rootfs.ext4');
      const workspace = path.join(base, 'workspace.ext4');
      const configSrc = path.join(base, 'cfg.json');
      writeFileSync(kernel, 'k');
      writeFileSync(rootfs, 'r');
      writeFileSync(workspace, 'seed\n');
      writeFileSync(configSrc, '{}');
      const uid = String(process.getuid?.() ?? 1000);
      const gid = String(process.getgid?.() ?? 1000);
      const staged = run(
        jailHelper,
        ['stage', root, kernel, rootfs, workspace, uid, gid, configSrc],
        { AGENT_HUB_FC_ROOTS_CONF: conf },
      );
      expect(staged.status, staged.stderr).toBe(0);
      writeFileSync(path.join(root, 'workspace.ext4'), 'guest-commit\n');

      const cleaned = run(jailHelper, ['clean', tree], { AGENT_HUB_FC_ROOTS_CONF: conf });
      expect(cleaned.status, cleaned.stderr).toBe(0);
      expect(existsSync(tree)).toBe(false);
      expect(readFileSync(workspace, 'utf8')).toBe('guest-commit\n');
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
  it('reuses an existing workspace disk instead of reseeding from the host', () => {
    const src = readFileSync(path.join(here, 'build/fc-prepare-disks.sh'), 'utf8');
    expect(src).toMatch(/workspace\.ready/);
    expect(src).toMatch(/reusing workspace=/);
    expect(src).not.toMatch(/rm -f -- "\$\{ROOTFS_OUT\}" "\$\{WORKSPACE_OUT\}"/);
    expect(src).toMatch(/rm -f -- "\$\{ROOTFS_OUT\}"/);
  });

  it('streams the worktree tar instead of buffering produced.stdout', () => {
    const src = readFileSync(path.join(here, 'build/fc-prepare-disks.sh'), 'utf8');
    expect(src).not.toMatch(/produced\.stdout/);
    expect(src).toMatch(/AGENT_HUB_FC_WORKTREE_TAR_MAX_BYTES|worktree archive exceeded/);
    expect(src).toMatch(/Popen\(\s*tar_create[\s\S]*Popen\([\s\S]*tar[\s\S]*-xf/);
    expect(src).toMatch(/"-cf"/);
  });

  it('keeps the worktree-copy Python heredoc compilable (nonlocal needs a function)', () => {
    const src = readFileSync(path.join(here, 'build/fc-prepare-disks.sh'), 'utf8');
    const match = src.match(
      /python3 - "\$\{WORKTREE\}" "\$\{MOUNT_DIR\}" <<'PY'\n([\s\S]*?)\nPY\n/,
    );
    expect(match?.[1], 'missing worktree-copy heredoc').toBeTruthy();
    const py = match![1];
    // Module-level `nonlocal` raises SyntaxError at compile time — the bug that
    // took down every Firecracker session boot on DEV (label warning was noise).
    expect(py).toMatch(/def stream_worktree\(/);
    const compiled = spawnSync(
      'python3',
      ['-c', 'import sys; compile(sys.stdin.read(), "<fc-prepare>", "exec")'],
      {
        input: py,
        encoding: 'utf8',
      },
    );
    expect(compiled.status, compiled.stderr).toBe(0);
  });

  it('tar-streams via /proc/<pid>/fd (not /proc/self/fd — self is the tar child)', () => {
    const src = readFileSync(path.join(here, 'build/fc-prepare-disks.sh'), 'utf8');
    expect(src).toMatch(/\/proc\/\{os\.getpid\(\)\}\/fd\/\{src_fd\}/);
    expect(src).not.toMatch(/src = f"\/proc\/self\/fd\/\{src_fd\}"/);
  });

  it('excludes generated dependency trees and treats GNU tar exit 1 as success', () => {
    const src = readFileSync(path.join(here, 'build/fc-prepare-disks.sh'), 'utf8');
    // Live node_modules is what made Survey Tracker session boots hang on
    // "Waiting for first event…" then die with "File shrank" / "file changed
    // as we read it". The guest installs its own deps.
    expect(src).toMatch(/--exclude=node_modules/);
    expect(src).toMatch(/--exclude-vcs-ignores/);
    expect(src).toMatch(/prod_rc not in \(0, 1\)/);
    // Tracked-but-ignored paths must be re-materialized or Changes shows
    // false deletions (sample.env / .vscode on Survey Tracker).
    expect(src).toMatch(/checkout-index.*-a.*-f|checkout-index", "-a", "-f"/);
    // Dirty working-tree edits must be re-copied after checkout-index via
    // O_NOFOLLOW dirfds (never shutil.copy2 onto a destination symlink).
    expect(src).toMatch(/diff", "--name-only", "-z", "HEAD"/);
    expect(src).toMatch(/O_NOFOLLOW/);
    expect(src).toMatch(/os\.unlink\(/);
    expect(src).not.toMatch(/shutil\.copy2/);
  });

  // O_NOFOLLOW + `/proc/<pid>/fd` are Linux-only; macOS tmpdirs also walk
  // through `/var` → `/private/var` symlinks that the guard correctly refuses.
  it.skipIf(process.platform !== 'linux')(
    'copies a real worktree through the heredoc into a dest dir',
    () => {
      const src = readFileSync(path.join(here, 'build/fc-prepare-disks.sh'), 'utf8');
      const match = src.match(
        /python3 - "\$\{WORKTREE\}" "\$\{MOUNT_DIR\}" <<'PY'\n([\s\S]*?)\nPY\n/,
      );
      expect(match?.[1]).toBeTruthy();
      const base = mkdtempSync(path.join(os.tmpdir(), 'fc-prepare-copy-'));
      const worktree = path.join(base, 'wt');
      const dest = path.join(base, 'out');
      try {
        mkdirSync(worktree);
        mkdirSync(dest);
        writeFileSync(path.join(worktree, 'README.md'), 'hello from prepare\n');
        writeFileSync(path.join(worktree, '.gitignore'), 'tracked-ignored.txt\nnode_modules/\n');
        writeFileSync(path.join(worktree, 'tracked-ignored.txt'), 'keep-me\n');
        mkdirSync(path.join(worktree, 'frontend', 'node_modules', 'async'), { recursive: true });
        writeFileSync(
          path.join(worktree, 'frontend', 'node_modules', 'async', 'priorityQueue.js'),
          'should-not-be-copied\n',
        );
        const gitEnv = {
          ...process.env,
          GIT_CONFIG_COUNT: '2',
          GIT_CONFIG_KEY_0: 'user.email',
          GIT_CONFIG_VALUE_0: 'test@example.com',
          GIT_CONFIG_KEY_1: 'user.name',
          GIT_CONFIG_VALUE_1: 'Test',
        };
        expect(
          spawnSync('git', ['init'], { cwd: worktree, encoding: 'utf8', env: gitEnv }).status,
        ).toBe(0);
        expect(
          spawnSync('git', ['add', '-f', 'README.md', '.gitignore', 'tracked-ignored.txt'], {
            cwd: worktree,
            encoding: 'utf8',
            env: gitEnv,
          }).status,
        ).toBe(0);
        expect(
          spawnSync('git', ['commit', '-m', 'init'], {
            cwd: worktree,
            encoding: 'utf8',
            env: gitEnv,
          }).status,
        ).toBe(0);
        // Uncommitted edit must survive checkout-index (dirty restore).
        writeFileSync(path.join(worktree, 'README.md'), 'dirty working tree\n');
        // Dirty symlink (possibly dangling) must be preserved, not treated as delete.
        writeFileSync(path.join(worktree, 'was-file.txt'), 'blob\n');
        expect(
          spawnSync('git', ['add', 'was-file.txt'], {
            cwd: worktree,
            encoding: 'utf8',
            env: gitEnv,
          }).status,
        ).toBe(0);
        expect(
          spawnSync('git', ['commit', '-m', 'add file'], {
            cwd: worktree,
            encoding: 'utf8',
            env: gitEnv,
          }).status,
        ).toBe(0);
        rmSync(path.join(worktree, 'was-file.txt'));
        symlinkSync('missing-target', path.join(worktree, 'was-file.txt'));
        const py = match![1];
        const run = spawnSync('python3', ['-', worktree, dest], {
          input: py,
          encoding: 'utf8',
          env: { ...process.env, AGENT_HUB_WORKSPACE_SIZE_MIB: '64' },
        });
        expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
        expect(readFileSync(path.join(dest, 'README.md'), 'utf8')).toBe('dirty working tree\n');
        expect(lstatSync(path.join(dest, 'was-file.txt')).isSymbolicLink()).toBe(true);
        expect(readlinkSync(path.join(dest, 'was-file.txt'))).toBe('missing-target');
        expect(existsSync(path.join(dest, 'frontend', 'node_modules'))).toBe(false);
        // Tar skipped this via --exclude-vcs-ignores; checkout-index restores it.
        expect(readFileSync(path.join(dest, 'tracked-ignored.txt'), 'utf8')).toBe('keep-me\n');
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it('dirty restore walks the source via O_NOFOLLOW dirfds (no join+open escape)', () => {
    const src = readFileSync(path.join(here, 'build/fc-prepare-disks.sh'), 'utf8');
    expect(src).toMatch(/src_root_fd = open_nofollow_dir\(worktree\)/);
    expect(src).toMatch(/os\.open\(leaf, os\.O_RDONLY \| nofollow, dir_fd=src_parent\)/);
    expect(src).toMatch(/symlink escape/);
    // Must not reintroduce path-join then open/stat on the source.
    expect(src).not.toMatch(/src_path = os\.path\.join\(worktree, rel_s\)/);
  });

  it.skipIf(process.platform !== 'linux')(
    'dirty restore does not follow an intermediate source symlink outside the worktree',
    () => {
      const src = readFileSync(path.join(here, 'build/fc-prepare-disks.sh'), 'utf8');
      const match = src.match(
        /python3 - "\$\{WORKTREE\}" "\$\{MOUNT_DIR\}" <<'PY'\n([\s\S]*?)\nPY\n/,
      );
      expect(match?.[1]).toBeTruthy();
      const base = mkdtempSync(path.join(os.tmpdir(), 'fc-prepare-src-escape-'));
      const worktree = path.join(base, 'wt');
      const dest = path.join(base, 'out');
      const hostSecret = path.join(base, 'host-secret.txt');
      try {
        mkdirSync(worktree);
        mkdirSync(dest);
        writeFileSync(hostSecret, 'classified\n');
        mkdirSync(path.join(worktree, 'escape'));
        writeFileSync(path.join(worktree, 'escape', 'host-secret.txt'), 'tracked\n');
        const gitEnv = {
          ...process.env,
          GIT_CONFIG_COUNT: '2',
          GIT_CONFIG_KEY_0: 'user.email',
          GIT_CONFIG_VALUE_0: 'test@example.com',
          GIT_CONFIG_KEY_1: 'user.name',
          GIT_CONFIG_VALUE_1: 'Test',
        };
        expect(
          spawnSync('git', ['init'], { cwd: worktree, encoding: 'utf8', env: gitEnv }).status,
        ).toBe(0);
        expect(
          spawnSync('git', ['add', 'escape/host-secret.txt'], {
            cwd: worktree,
            encoding: 'utf8',
            env: gitEnv,
          }).status,
        ).toBe(0);
        expect(
          spawnSync('git', ['commit', '-m', 'track'], {
            cwd: worktree,
            encoding: 'utf8',
            env: gitEnv,
          }).status,
        ).toBe(0);
        // Intermediate dir → host parent. join(worktree,"escape/host-secret.txt")
        // would open the host file; O_NOFOLLOW on the component must refuse.
        rmSync(path.join(worktree, 'escape'), { recursive: true, force: true });
        symlinkSync(base, path.join(worktree, 'escape'));
        const run = spawnSync('python3', ['-', worktree, dest], {
          input: match![1],
          encoding: 'utf8',
          env: { ...process.env, AGENT_HUB_WORKSPACE_SIZE_MIB: '64' },
        });
        expect(run.status, `${run.stdout}\n${run.stderr}`).not.toBe(0);
        expect(`${run.stdout}\n${run.stderr}`).toMatch(/symlink escape|refusing dirty/i);
        expect(readFileSync(hostSecret, 'utf8')).toBe('classified\n');
        if (existsSync(path.join(dest, 'escape', 'host-secret.txt'))) {
          expect(readFileSync(path.join(dest, 'escape', 'host-secret.txt'), 'utf8')).not.toBe(
            'classified\n',
          );
        }
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'dirty restore does not follow a destination symlink outside dest (root escape)',
    () => {
      const src = readFileSync(path.join(here, 'build/fc-prepare-disks.sh'), 'utf8');
      const match = src.match(
        /python3 - "\$\{WORKTREE\}" "\$\{MOUNT_DIR\}" <<'PY'\n([\s\S]*?)\nPY\n/,
      );
      expect(match?.[1]).toBeTruthy();
      const base = mkdtempSync(path.join(os.tmpdir(), 'fc-prepare-escape-'));
      const worktree = path.join(base, 'wt');
      const dest = path.join(base, 'out');
      const hostVictim = path.join(base, 'host-secret.txt');
      try {
        mkdirSync(worktree);
        mkdirSync(dest);
        writeFileSync(hostVictim, 'safe\n');
        // Index holds an absolute symlink; dirty tree replaces it with a file.
        symlinkSync(hostVictim, path.join(worktree, 'victim'));
        const gitEnv = {
          ...process.env,
          GIT_CONFIG_COUNT: '2',
          GIT_CONFIG_KEY_0: 'user.email',
          GIT_CONFIG_VALUE_0: 'test@example.com',
          GIT_CONFIG_KEY_1: 'user.name',
          GIT_CONFIG_VALUE_1: 'Test',
        };
        expect(
          spawnSync('git', ['init'], { cwd: worktree, encoding: 'utf8', env: gitEnv }).status,
        ).toBe(0);
        expect(
          spawnSync('git', ['add', 'victim'], {
            cwd: worktree,
            encoding: 'utf8',
            env: gitEnv,
          }).status,
        ).toBe(0);
        expect(
          spawnSync('git', ['commit', '-m', 'symlink'], {
            cwd: worktree,
            encoding: 'utf8',
            env: gitEnv,
          }).status,
        ).toBe(0);
        rmSync(path.join(worktree, 'victim'));
        writeFileSync(path.join(worktree, 'victim'), 'pwned\n');
        const run = spawnSync('python3', ['-', worktree, dest], {
          input: match![1],
          encoding: 'utf8',
          env: { ...process.env, AGENT_HUB_WORKSPACE_SIZE_MIB: '64' },
        });
        expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
        expect(readFileSync(hostVictim, 'utf8')).toBe('safe\n');
        expect(lstatSync(path.join(dest, 'victim')).isSymbolicLink()).toBe(false);
        expect(readFileSync(path.join(dest, 'victim'), 'utf8')).toBe('pwned\n');
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it('uses an ext4 label within the 16-byte limit', () => {
    const src = readFileSync(path.join(here, 'build/fc-prepare-disks.sh'), 'utf8');
    const label = src.match(/mkfs\.ext4[^\n]*-L\s+(\S+)/)?.[1];
    expect(label).toBeTruthy();
    expect(Buffer.byteLength(label!, 'utf8')).toBeLessThanOrEqual(16);
  });
});

describe('jailer Hub traverse contract', () => {
  it('setup script makes JAILER_DIR execute-only for others (0711), not 0750', () => {
    const setup = readFileSync(
      path.join(here, '../../../ops/scripts/setup-firecracker-host.sh'),
      'utf8',
    );
    expect(setup).toMatch(/chmod 0711 "\$\{JAILER_DIR\}"/);
    expect(setup).not.toMatch(/chmod 0750 "\$\{VM_SCRATCH\}" "\$\{JAILER_DIR\}"/);
  });

  const canSudoNobody =
    spawnSync('sudo', ['-n', '-u', 'nobody', 'true'], { encoding: 'utf8' }).status === 0;

  it.skipIf(!canSudoNobody)(
    'distinct hub uid can traverse 0711 jailer ancestors to the vsock (0750 cannot)',
    () => {
      const base = mkdtempSync(path.join(os.tmpdir(), 'fc-jail-traverse-'));
      try {
        // mkdtemp is 0700; the distinct test user must be able to walk into
        // `base` before JAILER_DIR's 0711-vs-0750 behavior is observable.
        chmodSync(base, 0o755);
        const jailer = path.join(base, 'jailer');
        const sock = path.join(jailer, 'firecracker', 'ahvm-1', 'root', 'vsock.sock');
        mkdirSync(path.dirname(sock), { recursive: true });
        writeFileSync(sock, '');
        chmodSync(path.join(jailer, 'firecracker'), 0o755);
        chmodSync(path.join(jailer, 'firecracker', 'ahvm-1'), 0o755);
        chmodSync(path.join(jailer, 'firecracker', 'ahvm-1', 'root'), 0o755);
        chmodSync(sock, 0o666);

        chmodSync(jailer, 0o711);
        const ok = spawnSync('sudo', ['-n', '-u', 'nobody', 'test', '-r', sock], {
          encoding: 'utf8',
        });
        expect(ok.status, ok.stderr).toBe(0);

        chmodSync(jailer, 0o750);
        const blocked = spawnSync('sudo', ['-n', '-u', 'nobody', 'test', '-r', sock], {
          encoding: 'utf8',
        });
        expect(blocked.status).not.toBe(0);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );
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
