/**
 * Covers awaited session dependency installs: exec failures propagate and a
 * marker prevents hammering repeatedly with the session install timeout.
 * `child_process.exec` must be mocked before `./worktree.js` loads — keep this
 * file isolated so other suites still use real `exec`.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, statSync } from 'fs';
import path from 'path';
import os from 'os';

/**
 * Spy the exact {@link exec} function `worktree.ts` binds with `promisify` at
 * module load. Re-resolving `exec` from `import('child_process')` in `beforeEach`
 * can point at a different object than the one worktree imported (duplicate module
 * evaluation under Vitest shards), which makes `toHaveBeenCalled` flake.
 */
let childProcessExecMock: ReturnType<typeof vi.fn>;
const deferredInstalls: Array<() => void> = [];

const { configState } = vi.hoisted(() => ({
  configState: { defaultCwd: '/tmp', sessionEnvAdapter: 'auto' as string },
}));

vi.mock('./config.js', () => ({
  default: configState,
}));

vi.mock('child_process', async (importOriginal) => {
  const mod = await importOriginal<typeof import('child_process')>();
  /**
   * `TEST_WORKTREE_EXEC_FAIL=1`: promisified `exec` rejects.
   * `TEST_WORKTREE_EXEC_FAIL=skip`: omit callback (simulate bug) — unused.
   * Otherwise: succeed and mimic `npm` creating minimal `node_modules`.
   */
  function fakeExec(
    command: string,
    optsOrCb?: unknown,
    maybeCb?: (err: unknown) => void,
  ): ReturnType<typeof mod.exec> {
    let cb: (err: unknown) => void;
    let cwd = process.cwd();

    if (typeof optsOrCb === 'function') {
      cb = optsOrCb as (err: unknown) => void;
    } else {
      cb = maybeCb!;
      if (optsOrCb && typeof optsOrCb === 'object' && optsOrCb !== null && 'cwd' in optsOrCb) {
        cwd = String((optsOrCb as { cwd?: string }).cwd ?? cwd);
      }
    }

    const finish = () => {
      if (process.env.TEST_WORKTREE_EXEC_FAIL === '1') {
        cb(new Error('mock install failure'));
        return;
      }
      // Like npm: populate the root only, write the hidden lockfile, and
      // create package-lock.json when the checkout had none.
      mkdirSync(path.join(cwd, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(path.join(cwd, 'node_modules', '.bin', 'eslint'), '', 'utf8');
      // `TEST_WORKTREE_EXEC_STAMP`: the completion stamp the "installer" writes
      // (default npm's), e.g. `.modules.yaml` for a script that runs pnpm.
      writeFileSync(
        path.join(
          cwd,
          'node_modules',
          process.env.TEST_WORKTREE_EXEC_STAMP ?? '.package-lock.json',
        ),
        '{}',
        'utf8',
      );
      // `TEST_WORKTREE_EXEC_ALSO=a,b`: sub-packages this "installer" also
      // populates; by default it installs the root only.
      for (const rel of (process.env.TEST_WORKTREE_EXEC_ALSO ?? '').split(',').filter(Boolean)) {
        mkdirSync(
          path.join(cwd, rel, 'node_modules', `.installed-${Date.now()}-${Math.random()}`),
          {
            recursive: true,
          },
        );
      }
      if (!existsSync(path.join(cwd, 'package-lock.json'))) {
        writeFileSync(path.join(cwd, 'package-lock.json'), '{}', 'utf8');
      }
      cb(null);
    };
    // `TEST_WORKTREE_EXEC_DEFER=1`: the install stays running until the test
    // calls a function from `deferredInstalls`.
    if (process.env.TEST_WORKTREE_EXEC_DEFER === '1') deferredInstalls.push(finish);
    else queueMicrotask(finish);

    return {} as ReturnType<typeof mod.exec>;
  }

  childProcessExecMock = vi.fn(fakeExec);
  return {
    ...mod,
    exec: childProcessExecMock,
  };
});

const worktreePromise = import('./worktree.js');

describe('setupDependencies awaited install failures', () => {
  let sourceDir = '';
  let cloneDir = '';
  let cleanup: Array<() => void> = [];

  beforeEach(() => {
    cleanup = [];
    configState.sessionEnvAdapter = 'auto';
    delete process.env.TEST_WORKTREE_EXEC_FAIL;
    sourceDir = path.join(os.tmpdir(), `wh-src-${Date.now()}`);
    cloneDir = path.join(os.tmpdir(), `wh-clone-${Date.now()}`);
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(cloneDir, { recursive: true });
    writeFileSync(path.join(sourceDir, 'noop.txt'), 'x');
    writeFileSync(path.join(cloneDir, 'package.json'), JSON.stringify({ name: 'fixture' }), 'utf8');
    writeFileSync(path.join(cloneDir, 'package-lock.json'), '{}', 'utf8');
    // Mirror husky-enabled repos so `needsDependencyInstall` consults eslint
    // in `node_modules/.bin` instead of returning early when `.husky` is absent.
    mkdirSync(path.join(cloneDir, '.husky'), { recursive: true });
    writeFileSync(path.join(cloneDir, '.husky', 'pre-commit'), '#!/bin/sh\nexit 0\n', 'utf8');

    cleanup.push(() => {
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
    });
  });

  afterEach(() => {
    for (const fn of cleanup) {
      fn();
    }
    delete process.env.TEST_WORKTREE_EXEC_FAIL;
  });

  it('throws SessionDependencyInstallError and records a marker when awaited install fails', async () => {
    process.env.TEST_WORKTREE_EXEC_FAIL = '1';
    const { SessionDependencyInstallError, SESSION_DEPENDENCY_INSTALL_FAILURE_MARKER, __test } =
      await worktreePromise;
    childProcessExecMock.mockClear();

    await expect(
      __test.setupDependencies(sourceDir, cloneDir, null, {
        awaitInstall: true,
        preferInstallAllScript: false,
      }),
    ).rejects.toThrow(SessionDependencyInstallError);

    const markerPath = path.join(cloneDir, SESSION_DEPENDENCY_INSTALL_FAILURE_MARKER);
    expect(existsSync(markerPath)).toBe(true);

    childProcessExecMock.mockClear();
    await expect(
      __test.setupDependencies(sourceDir, cloneDir, null, {
        awaitInstall: true,
        preferInstallAllScript: false,
      }),
    ).rejects.toThrow(/previously failed/);
    expect(childProcessExecMock).not.toHaveBeenCalled();
  });

  it('passes PIP_BREAK_SYSTEM_PACKAGES=1 in the install spawn env so PEP 668 hosts can pip-install', async () => {
    // Locks in the wire-level contract: agents on Debian/Ubuntu hosts run
    // install commands like `cd backend && pip install -r requirements.txt`
    // and the spawned shell inherits this env. If a future refactor drops
    // the env var off `installChildEnv` (or off the exec call), this test
    // catches it — the install-time assertion in worktree.test.ts only
    // pins the constant, not the wire it travels on.
    delete process.env.TEST_WORKTREE_EXEC_FAIL;
    const { __test } = await worktreePromise;
    childProcessExecMock.mockClear();

    await __test.setupDependencies(sourceDir, cloneDir, null, {
      awaitInstall: true,
      preferInstallAllScript: false,
    });

    expect(childProcessExecMock).toHaveBeenCalled();
    const opts = childProcessExecMock.mock.calls[0][1] as { env?: Record<string, string> };
    expect(opts?.env).toMatchObject({ PIP_BREAK_SYSTEM_PACKAGES: '1' });
  });

  it('clears the failure marker after a successful awaited install so the next attempt runs npm again', async () => {
    const {
      SESSION_DEPENDENCY_INSTALL_FAILURE_MARKER,
      SessionDependencyInstallError,
      clearDependencyInstallFailureMarker,
      __test,
    } = await worktreePromise;
    childProcessExecMock.mockClear();

    process.env.TEST_WORKTREE_EXEC_FAIL = '1';
    await expect(
      __test.setupDependencies(sourceDir, cloneDir, null, {
        awaitInstall: true,
        preferInstallAllScript: false,
      }),
    ).rejects.toThrow(SessionDependencyInstallError);
    const markerPath = path.join(cloneDir, SESSION_DEPENDENCY_INSTALL_FAILURE_MARKER);
    expect(existsSync(markerPath)).toBe(true);

    delete process.env.TEST_WORKTREE_EXEC_FAIL;
    clearDependencyInstallFailureMarker(cloneDir);
    childProcessExecMock.mockClear();

    await __test.setupDependencies(sourceDir, cloneDir, null, {
      awaitInstall: true,
      preferInstallAllScript: false,
    });

    expect(existsSync(markerPath)).toBe(false);
    expect(childProcessExecMock).toHaveBeenCalled();

    rmSync(path.join(cloneDir, 'node_modules'), { recursive: true, force: true });
    childProcessExecMock.mockClear();

    await __test.setupDependencies(sourceDir, cloneDir, null, {
      awaitInstall: true,
      preferInstallAllScript: false,
    });
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);
    clearDependencyInstallFailureMarker(cloneDir);
  });

  it('skips host install when skipHostInstall is set (isolated / guest owns deps)', async () => {
    const { __test } = await worktreePromise;
    childProcessExecMock.mockClear();

    await __test.setupDependencies(sourceDir, cloneDir, 'npm ci', {
      awaitInstall: true,
      preferInstallAllScript: false,
      skipHostInstall: true,
    });

    expect(childProcessExecMock).not.toHaveBeenCalled();
  });

  it('still installs on the host when sessionEnvAdapter is firecracker (VM is opt-in)', async () => {
    configState.sessionEnvAdapter = 'firecracker';
    const { __test } = await worktreePromise;
    childProcessExecMock.mockClear();

    await __test.setupDependencies(sourceDir, cloneDir, 'npm ci', {
      awaitInstall: true,
      preferInstallAllScript: false,
    });

    expect(childProcessExecMock).toHaveBeenCalled();
  });
});

describe('setupDependencies background install on session reopen', () => {
  let sourceDir = '';
  let cloneDir = '';
  const bg = { awaitInstall: false, preferInstallAllScript: false } as const;
  const awaited = { awaitInstall: true, preferInstallAllScript: false } as const;
  const newManifest = JSON.stringify({ name: 'fixture', dependencies: { a: '1' } });

  function installDeps(dir: string, at: Date): void {
    mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    mkdirSync(path.join(dir, 'node_modules', '@angular', 'common'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', '.bin', 'eslint'), '', 'utf8');
    const stamp = path.join(dir, 'node_modules', '.package-lock.json');
    writeFileSync(stamp, '{}', 'utf8');
    utimesSync(stamp, at, at);
  }

  function writeLockfile(dir: string, at: Date, content = '{}'): void {
    const lock = path.join(dir, 'package-lock.json');
    writeFileSync(lock, content, 'utf8');
    utimesSync(lock, at, at);
  }

  const cloned = new Date(Date.now() - 10 * 60_000);
  const installed = new Date(Date.now() - 5 * 60_000);
  const flush = () => new Promise((r) => setTimeout(r, 0));

  async function worktree() {
    return (await worktreePromise).__test;
  }

  /** Open the session in the background and let any install it started finish. */
  async function open(cmd = 'npm ci'): Promise<void> {
    const t = await worktree();
    await t.setupDependencies(sourceDir, cloneDir, cmd, bg);
    await t.waitForInFlightInstall(cloneDir);
  }

  /** Wait until `n` installs are running (package discovery is async). */
  async function running(n: number): Promise<void> {
    await vi.waitFor(() => expect(deferredInstalls.length).toBe(n));
  }

  /** Assert the exec count now, and that it stays there briefly. */
  async function execCountStays(n: number): Promise<void> {
    expect(childProcessExecMock).toHaveBeenCalledTimes(n);
    await new Promise((r) => setTimeout(r, 50));
    expect(childProcessExecMock).toHaveBeenCalledTimes(n);
  }

  function writePackage(dir: string, manifest = '{"name":"pkg"}', at = cloned): void {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'package.json');
    writeFileSync(file, manifest, 'utf8');
    utimesSync(file, at, at);
  }

  /** Finish the oldest deferred install and let the lock hand off. */
  async function finishOne(): Promise<void> {
    const next = deferredInstalls.shift();
    if (!next) throw new Error('no install is running');
    next();
    await flush();
  }

  beforeEach(async () => {
    delete process.env.TEST_WORKTREE_EXEC_FAIL;
    delete process.env.TEST_WORKTREE_EXEC_DEFER;
    deferredInstalls.length = 0;
    (await worktree()).resetBackgroundInstallMemo();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sourceDir = path.join(os.tmpdir(), `wh-bg-src-${id}`);
    cloneDir = path.join(os.tmpdir(), `wh-bg-clone-${id}`);
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(cloneDir, { recursive: true });
    const manifest = path.join(cloneDir, 'package.json');
    writeFileSync(manifest, JSON.stringify({ name: 'fixture' }), 'utf8');
    utimesSync(manifest, cloned, cloned);
    writeLockfile(cloneDir, cloned);
    childProcessExecMock.mockClear();
  });

  afterEach(async () => {
    delete process.env.TEST_WORKTREE_EXEC_DEFER;
    while (deferredInstalls.length > 0) await finishOne();
    await (await worktree()).waitForInFlightInstall(cloneDir);
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it('does not reinstall over populated node_modules (a running preview would lose its deps)', async () => {
    // Project checkout ships an empty node_modules, so nothing is linked and
    // the reopen previously fell through to `npm ci` on every chat turn.
    mkdirSync(path.join(sourceDir, 'node_modules'), { recursive: true });
    installDeps(cloneDir, installed);
    await open('npm ci --include=dev');
    expect(childProcessExecMock).not.toHaveBeenCalled();
  });

  it('installs when node_modules is missing', async () => {
    await open();
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);
  });

  it('installs when node_modules is empty', async () => {
    mkdirSync(path.join(cloneDir, 'node_modules'), { recursive: true });
    await open();
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);
  });

  it('reinstalls when the lockfile changed after the last install', async () => {
    installDeps(cloneDir, installed);
    writeLockfile(cloneDir, new Date());
    await open();
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);
  });

  it('reinstalls when package.json changed but the lockfile did not', async () => {
    installDeps(cloneDir, installed);
    writeFileSync(path.join(cloneDir, 'package.json'), newManifest, 'utf8');
    await open('npm install');
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);
  });

  it('reinstalls when package.json changed in a project without a lockfile', async () => {
    rmSync(path.join(cloneDir, 'package-lock.json'));
    installDeps(cloneDir, installed);
    await open('npm install');
    expect(childProcessExecMock).not.toHaveBeenCalled();

    writeFileSync(path.join(cloneDir, 'package.json'), newManifest, 'utf8');
    await open('npm install');
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);
  });

  it('treats a lockfile the install itself created as current', async () => {
    rmSync(path.join(cloneDir, 'package-lock.json'));
    await open('npm install');
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(cloneDir, 'package-lock.json'))).toBe(true);

    // Forget the last install (as after a Hub restart) so only freshness decides.
    (await worktree()).resetBackgroundInstallMemo();
    await open('npm install');
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);
  });

  it('never marks a sub-package current that a root-only install did not touch', async () => {
    installDeps(cloneDir, installed);
    const child = path.join(cloneDir, 'worker');
    writePackage(child);
    installDeps(child, installed);
    writePackage(child, newManifest, new Date());

    await open();
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);

    // Same inputs, same command: rerunning can't fix the child, so don't.
    await open();
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);

    // Nothing recorded the child as current: without that memo it is stale.
    (await worktree()).resetBackgroundInstallMemo();
    await open();
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);
  });

  it('reinstalls when package.json is edited right before the install finishes', async () => {
    installDeps(cloneDir, installed);
    writeLockfile(cloneDir, new Date());
    process.env.TEST_WORKTREE_EXEC_DEFER = '1';
    const t = await worktree();

    await t.setupDependencies(sourceDir, cloneDir, 'npm ci', bg);
    await running(1);

    // Edited at the current time, i.e. next to the stamp the install writes.
    writeFileSync(path.join(cloneDir, 'package.json'), newManifest, 'utf8');
    // A turn opening now must not start a second install.
    await t.setupDependencies(sourceDir, cloneDir, 'npm ci', bg);
    await execCountStays(1);

    await finishOne();
    await running(1);
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);
    await finishOne();
    await t.waitForInFlightInstall(cloneDir);

    delete process.env.TEST_WORKTREE_EXEC_DEFER;
    await open();
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);
  });

  it('reinstalls when a pre-existing lockfile is replaced mid-install', async () => {
    installDeps(cloneDir, installed);
    writeLockfile(cloneDir, new Date());
    process.env.TEST_WORKTREE_EXEC_DEFER = '1';
    const t = await worktree();

    await t.setupDependencies(sourceDir, cloneDir, 'npm ci', bg);
    await running(1);
    writeLockfile(cloneDir, new Date(), '{"lockfileVersion":3}');
    await finishOne();
    await running(1);
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);
  });

  it('runs simultaneous awaited installs one at a time', async () => {
    process.env.TEST_WORKTREE_EXEC_DEFER = '1';
    const t = await worktree();

    const first = t.setupDependencies(sourceDir, cloneDir, 'npm ci', awaited);
    const second = t.setupDependencies(sourceDir, cloneDir, 'npm ci', awaited);
    await running(1);
    await execCountStays(1);

    await finishOne();
    await Promise.all([first, second]);
    // The second saw the first's node_modules and had nothing to do.
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['background first', ['bg', 'awaited'] as const],
    ['awaited first', ['awaited', 'bg'] as const],
  ])(
    'never overlaps an awaited and a background install from an idle clone (%s)',
    async (_label, order) => {
      process.env.TEST_WORKTREE_EXEC_DEFER = '1';
      const t = await worktree();

      const calls = order.map((mode) =>
        t.setupDependencies(sourceDir, cloneDir, 'npm ci', mode === 'bg' ? bg : awaited),
      );
      await running(1);
      await execCountStays(1);

      await finishOne();
      await Promise.all(calls);
      await t.waitForInFlightInstall(cloneDir);
      expect(childProcessExecMock).toHaveBeenCalledTimes(1);
    },
  );

  it('runs a changed install command even when inputs match its last success', async () => {
    installDeps(cloneDir, installed);
    const child = path.join(cloneDir, 'worker');
    writePackage(child);
    installDeps(child, installed);
    writePackage(child, newManifest, new Date());

    await open('npm ci');
    await open('npm ci');
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);

    await open('npm run install:all');
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);
    expect(childProcessExecMock.mock.calls[1]?.[0]).toBe('npm run install:all');
  });

  it('retries on the next open after inputs kept changing through every follow-up', async () => {
    installDeps(cloneDir, installed);
    writeLockfile(cloneDir, new Date());
    process.env.TEST_WORKTREE_EXEC_DEFER = '1';
    const t = await worktree();
    const marker = path.join(cloneDir, '.agent-hub-dependency-install-retry');

    await t.setupDependencies(sourceDir, cloneDir, 'npm ci', bg);
    for (let run = 1; run <= 3; run++) {
      await running(1);
      writePackage(cloneDir, JSON.stringify({ name: 'fixture', v: run }), new Date(0));
      await finishOne();
    }
    await t.waitForInFlightInstall(cloneDir);
    expect(childProcessExecMock).toHaveBeenCalledTimes(3);
    expect(existsSync(marker)).toBe(true);

    // After a Hub restart the last install's stamp postdates the final edit,
    // so freshness alone says current; the marker still forces a retry.
    delete process.env.TEST_WORKTREE_EXEC_DEFER;
    t.resetBackgroundInstallMemo();
    await open();
    expect(childProcessExecMock).toHaveBeenCalledTimes(4);
    expect(existsSync(marker)).toBe(false);

    await open();
    expect(childProcessExecMock).toHaveBeenCalledTimes(4);
  });

  it('reinstalls when a workspace member is created while the install runs', async () => {
    writePackage(cloneDir, JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    writePackage(path.join(cloneDir, 'packages', 'client'));
    installDeps(cloneDir, installed);
    writeLockfile(cloneDir, new Date());
    process.env.TEST_WORKTREE_EXEC_DEFER = '1';
    const t = await worktree();

    await t.setupDependencies(sourceDir, cloneDir, 'npm install', bg);
    await running(1);
    writePackage(path.join(cloneDir, 'packages', 'new'));
    await finishOne();

    await running(1);
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);
  });

  it('marks retry-required before an awaited install starts, and clears it on clean success', async () => {
    process.env.TEST_WORKTREE_EXEC_DEFER = '1';
    const t = await worktree();
    const marker = path.join(cloneDir, '.agent-hub-dependency-install-retry');

    const install = t.setupDependencies(sourceDir, cloneDir, 'npm ci', awaited);
    await running(1);
    // A Hub exit right now must leave the next open forced to reinstall.
    expect(existsSync(marker)).toBe(true);

    await finishOne();
    await install;
    expect(existsSync(marker)).toBe(false);
  });

  it('never certifies a sub-package whose stamp the install did not rewrite, even within the same second', async () => {
    installDeps(cloneDir, installed);
    writeLockfile(cloneDir, new Date());
    const child = path.join(cloneDir, 'worker');
    writePackage(child);
    // Installed moments ago: its stamp shares the second the next install starts in.
    installDeps(child, new Date());
    writePackage(child, newManifest, new Date(Date.now() + 60_000));

    // The command (root-only here) rewrites the root stamp but not the child's.
    await open('npm ci');
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(cloneDir, 'node_modules', '.agent-hub-installed-inputs'))).toBe(
      true,
    );
    expect(existsSync(path.join(child, 'node_modules', '.agent-hub-installed-inputs'))).toBe(false);

    // After a restart nothing vouches for the child: it is still stale.
    (await worktree()).resetBackgroundInstallMemo();
    await open('npm ci');
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);
  });

  it('reinstalls a fully current tree when only the install command changes', async () => {
    await open('npm ci --omit=dev');
    await open('npm ci --omit=dev');
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);

    // Same lockfile, same stamp: only the command says devDependencies are missing.
    await open('npm ci --include=dev');
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);
    expect(childProcessExecMock.mock.calls[1]?.[0]).toBe('npm ci --include=dev');

    await open('npm ci --include=dev');
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);
  });

  it('reinstalls on a command change for a stamp-less installer (bun)', async () => {
    rmSync(path.join(cloneDir, 'package-lock.json'));
    const bunLock = path.join(cloneDir, 'bun.lock');
    writeFileSync(bunLock, '{}', 'utf8');
    utimesSync(bunLock, cloned, cloned);

    await open('bun install --production');
    await open('bun install --production');
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);
    // Bun leaves no stamp, so there is no per-dir record to carry the command.
    expect(existsSync(path.join(cloneDir, 'node_modules', '.agent-hub-installed-inputs'))).toBe(
      false,
    );

    await open('bun install');
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);
    expect(childProcessExecMock.mock.calls[1]?.[0]).toBe('bun install');

    await open('bun install');
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['package.json', newManifest],
    ['bunfig.toml', '[install]\noptional = false\n'],
  ])('reinstalls when %s changes right after a successful bun install', async (file, content) => {
    rmSync(path.join(cloneDir, 'package-lock.json'));
    const bunLock = path.join(cloneDir, 'bun.lock');
    writeFileSync(bunLock, '{}', 'utf8');
    utimesSync(bunLock, cloned, cloned);
    await open('bun install');
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);

    // Same instant as node_modules' mtime, bun's only install time: no mtime
    // allowance can see this, and restarting doesn't change the timestamps.
    const nmTime = statSync(path.join(cloneDir, 'node_modules')).mtime;
    const target = path.join(cloneDir, file);
    writeFileSync(target, content, 'utf8');
    utimesSync(target, nmTime, nmTime);
    utimesSync(path.join(cloneDir, 'node_modules'), nmTime, nmTime);
    (await worktree()).resetBackgroundInstallMemo();
    await open('bun install');
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);
  });

  it('keeps known drift for a stamp-less child the next install leaves untouched', async () => {
    rmSync(path.join(cloneDir, 'package-lock.json'));
    const child = path.join(cloneDir, 'worker');
    writePackage(child);
    // A bun install that covers the child too: both get content evidence.
    process.env.TEST_WORKTREE_EXEC_ALSO = 'worker';
    try {
      await open('bun install');
    } finally {
      delete process.env.TEST_WORKTREE_EXEC_ALSO;
    }
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);

    // Child manifest edited at its node_modules' own mtime: invisible to mtimes.
    const nm = path.join(child, 'node_modules');
    const nmTime = statSync(nm).mtime;
    writePackage(child, newManifest, nmTime);
    utimesSync(nm, nmTime, nmTime);
    await open('bun install');
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);

    // That install left the child untouched: its drift must still be known,
    // so after a restart it is still not accepted as current.
    await open('bun install');
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);
    (await worktree()).resetBackgroundInstallMemo();
    await open('bun install');
    expect(childProcessExecMock).toHaveBeenCalledTimes(3);

    // Once an install does cover the child, the drift is resolved for good.
    process.env.TEST_WORKTREE_EXEC_ALSO = 'worker';
    try {
      (await worktree()).resetBackgroundInstallMemo();
      await open('bun install');
    } finally {
      delete process.env.TEST_WORKTREE_EXEC_ALSO;
    }
    expect(childProcessExecMock).toHaveBeenCalledTimes(4);
    (await worktree()).resetBackgroundInstallMemo();
    await open('bun install');
    expect(childProcessExecMock).toHaveBeenCalledTimes(4);
  });

  it('never certifies an untouched sub-package through the last-command record', async () => {
    installDeps(cloneDir, installed);
    const child = path.join(cloneDir, 'worker');
    writePackage(child);
    installDeps(child, installed);
    // Bun leaves no stamp: node_modules' own mtime is the install time.
    utimesSync(path.join(child, 'node_modules'), installed, installed);
    writePackage(child, newManifest, new Date());

    await open('bun install');
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);

    // Same command as the last install: the child is still judged on its own
    // timestamps, which say stale.
    (await worktree()).resetBackgroundInstallMemo();
    await open('bun install');
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);
  });

  it('does not reinstall every open when an npm script delegates to another manager', async () => {
    // `npm run install:all` whose script runs pnpm: the result carries pnpm's
    // stamp, not npm's, and that must still count as a completed install.
    process.env.TEST_WORKTREE_EXEC_STAMP = '.modules.yaml';
    try {
      await open('npm run install:all');
      await open('npm run install:all');
      (await worktree()).resetBackgroundInstallMemo();
      await open('npm run install:all');
    } finally {
      delete process.env.TEST_WORKTREE_EXEC_STAMP;
    }
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);
  });

  it('reinstalls when an installed child node_modules is emptied after a successful install', async () => {
    const child = path.join(cloneDir, 'worker');
    writePackage(child);
    installDeps(child, installed);
    // Root missing: this install populates it; the child was already current.
    await open('npm run install:all');
    await open('npm run install:all');
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);

    rmSync(path.join(child, 'node_modules'), { recursive: true, force: true });
    mkdirSync(path.join(child, 'node_modules'));
    await open('npm run install:all');
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);

    // This command never fills the child (the mock installs the root only):
    // same situation as right after that install, so no loop.
    await open('npm run install:all');
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);
  });

  it('reinstalls when an installed child node_modules is deleted after a successful install', async () => {
    const child = path.join(cloneDir, 'worker');
    writePackage(child);
    installDeps(child, installed);
    const never = path.join(cloneDir, 'tools');
    writePackage(never);
    await open('npm run install:all');
    await open('npm run install:all');
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);

    rmSync(path.join(child, 'node_modules'), { recursive: true, force: true });
    await open('npm run install:all');
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);

    // This command doesn't recreate it (the mock installs the root only):
    // no loop, including after a Hub restart. `tools` never had one.
    await open('npm run install:all');
    (await worktree()).resetBackgroundInstallMemo();
    await open('npm run install:all');
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);
  });

  it('still installs on every open for a checkout with no root package.json', async () => {
    rmSync(path.join(cloneDir, 'package.json'));
    rmSync(path.join(cloneDir, 'package-lock.json'));
    await open('pip install -r requirements.txt');
    await open('pip install -r requirements.txt');
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['.npmrc', 'omit=optional\n', ''],
    ['.yarnrc.yml', 'nodeLinker: pnp\n', 'nodeLinker: node-modules\n'],
    ['bunfig.toml', '[install]\noptional = false\n', '[install]\noptional = true\n'],
  ])('reinstalls when only package-manager config (%s) changes', async (file, before, after) => {
    const config = path.join(cloneDir, file);
    writeFileSync(config, before, 'utf8');
    utimesSync(config, cloned, cloned);
    await open('npm ci');
    await open('npm ci');
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);

    // Content only, old mtime: the recorded fingerprint must catch it.
    writeFileSync(config, after, 'utf8');
    utimesSync(config, cloned, cloned);
    await open('npm ci');
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);
  });

  it('reinstalls when package-manager config changes on a tree installed outside the Hub', async () => {
    installDeps(cloneDir, installed);
    await open('npm ci');
    expect(childProcessExecMock).not.toHaveBeenCalled();

    writeFileSync(path.join(cloneDir, '.npmrc'), 'omit=optional\n', 'utf8');
    await open('npm ci');
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);
  });

  it('retries a failed install on the next open', async () => {
    process.env.TEST_WORKTREE_EXEC_FAIL = '1';
    await open();
    delete process.env.TEST_WORKTREE_EXEC_FAIL;
    await open();
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['removed', (nm: string) => rmSync(nm, { recursive: true, force: true })],
    [
      'emptied',
      (nm: string) => {
        rmSync(nm, { recursive: true, force: true });
        mkdirSync(nm);
      },
    ],
    ['left without its install stamp', (nm: string) => rmSync(path.join(nm, '.package-lock.json'))],
  ])(
    'reinstalls unchanged inputs when node_modules was %s after a successful install',
    async (_label, damage) => {
      await open();
      await open();
      expect(childProcessExecMock).toHaveBeenCalledTimes(1);

      damage(path.join(cloneDir, 'node_modules'));
      await open();
      expect(childProcessExecMock).toHaveBeenCalledTimes(2);
    },
  );

  it('reinstalls when an installed sub-package lockfile drifted, but ignores never-installed ones', async () => {
    installDeps(cloneDir, installed);
    const skipped = path.join(cloneDir, 'electron');
    writePackage(skipped);
    writeLockfile(skipped, new Date());
    await open();
    expect(childProcessExecMock).not.toHaveBeenCalled();

    const client = path.join(cloneDir, 'client');
    writePackage(client);
    installDeps(client, installed);
    writeLockfile(client, new Date());
    await open();
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);
  });

  it('checks installed packages nested below the first level', async () => {
    installDeps(cloneDir, installed);
    const nested = path.join(cloneDir, 'packages', 'client');
    writePackage(nested);
    installDeps(nested, installed);
    writeLockfile(nested, cloned);
    await open();
    expect(childProcessExecMock).not.toHaveBeenCalled();

    writePackage(nested, newManifest, new Date());
    await open();
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);
  });

  describe('workspace members hoisted into the root node_modules', () => {
    const client = () => path.join(cloneDir, 'packages', 'client');
    const tools = () => path.join(cloneDir, 'tools');

    function npmWorkspaces(patterns: string[]): void {
      writePackage(cloneDir, JSON.stringify({ name: 'root', workspaces: patterns }));
      writePackage(client());
      writePackage(tools());
    }

    it('reinstalls when a member manifest changes (install made outside the Hub)', async () => {
      npmWorkspaces(['packages/*']);
      installDeps(cloneDir, installed);
      await open('npm install');
      expect(childProcessExecMock).not.toHaveBeenCalled();

      writePackage(client(), newManifest, new Date());
      await open('npm install');
      expect(childProcessExecMock).toHaveBeenCalledTimes(1);
    });

    it('reinstalls when a member manifest changes after a Hub install, even with an old mtime', async () => {
      npmWorkspaces(['packages/*']);
      await open('npm install');
      expect(childProcessExecMock).toHaveBeenCalledTimes(1);
      await open('npm install');
      expect(childProcessExecMock).toHaveBeenCalledTimes(1);

      writePackage(client(), newManifest, cloned);
      await open('npm install');
      expect(childProcessExecMock).toHaveBeenCalledTimes(2);
    });

    it('still ignores an uninstalled package that is not a member', async () => {
      npmWorkspaces(['packages/*']);
      installDeps(cloneDir, installed);
      writePackage(tools(), newManifest, new Date());
      await open('npm install');
      expect(childProcessExecMock).not.toHaveBeenCalled();
    });

    it('honours negated workspace patterns', async () => {
      npmWorkspaces(['packages/*', '!packages/client']);
      installDeps(cloneDir, installed);
      writePackage(client(), newManifest, new Date());
      await open('npm install');
      expect(childProcessExecMock).not.toHaveBeenCalled();
    });

    it('matches members with a globstar that spans zero directories', async () => {
      npmWorkspaces(['packages/**/*']);
      installDeps(cloneDir, installed);
      await open('npm install');
      expect(childProcessExecMock).not.toHaveBeenCalled();

      writePackage(client(), newManifest, new Date());
      await open('npm install');
      expect(childProcessExecMock).toHaveBeenCalledTimes(1);
    });

    it('reads members from yarn-style workspaces.packages and pnpm-workspace.yaml', async () => {
      writePackage(cloneDir, JSON.stringify({ name: 'root', workspaces: { packages: ['tools'] } }));
      writePackage(client());
      writePackage(tools());
      const ws = path.join(cloneDir, 'pnpm-workspace.yaml');
      writeFileSync(ws, "packages:\n  - 'packages/**'\n", 'utf8');
      utimesSync(ws, cloned, cloned);
      installDeps(cloneDir, installed);
      await open('npm install');
      expect(childProcessExecMock).not.toHaveBeenCalled();

      writePackage(client(), newManifest, new Date());
      await open('npm install');
      expect(childProcessExecMock).toHaveBeenCalledTimes(1);

      writePackage(tools(), newManifest, new Date(Date.now() + 60_000));
      await open('npm install');
      expect(childProcessExecMock).toHaveBeenCalledTimes(2);
    });
  });

  async function gitFixture(): Promise<(...args: string[]) => void> {
    const { execFileSync } = await import('child_process');
    const git = (...args: string[]) => {
      execFileSync('git', args, { cwd: cloneDir, stdio: 'ignore' });
    };
    git('init', '-q');
    return git;
  }

  it('finds packages git would track, including unstaged ones, but not ignored or vendored', async () => {
    const t = await worktree();
    const git = await gitFixture();
    writeFileSync(path.join(cloneDir, '.gitignore'), 'vendor/\n', 'utf8');
    writePackage(path.join(cloneDir, 'packages', 'client'));
    writePackage(path.join(cloneDir, 'packages', 'client', 'node_modules', 'dep'));
    writePackage(path.join(cloneDir, 'packages', 'new'));
    writePackage(path.join(cloneDir, 'vendor', 'lib'));
    git('add', 'package.json', 'packages/client/package.json');

    const dirs = await t.discoverPackageDirs(cloneDir);

    expect(dirs.map((d) => path.relative(cloneDir, d)).sort()).toEqual([
      '',
      path.join('packages', 'client'),
      path.join('packages', 'new'),
    ]);
  });

  it('reinstalls when an unstaged workspace member appears in a git checkout', async () => {
    const git = await gitFixture();
    writePackage(cloneDir, JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    writePackage(path.join(cloneDir, 'packages', 'client'));
    git('add', '.');
    installDeps(cloneDir, installed);
    await open('npm install');
    expect(childProcessExecMock).not.toHaveBeenCalled();

    writePackage(path.join(cloneDir, 'packages', 'new'), newManifest, new Date());
    await open('npm install');
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the installed-inputs record valid when a workspace member is staged', async () => {
    const git = await gitFixture();
    writePackage(cloneDir, JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    writePackage(path.join(cloneDir, 'packages', 'a'));
    writePackage(path.join(cloneDir, 'packages', 'z'));
    git('add', 'package.json', 'package-lock.json', 'packages/a/package.json');
    const t = await worktree();
    // git lists the untracked z apart from the tracked files; order must not matter.
    expect((await t.discoverPackageDirs(cloneDir)).map((d) => path.relative(cloneDir, d))).toEqual([
      '',
      path.join('packages', 'a'),
      path.join('packages', 'z'),
    ]);

    await open('npm ci');
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);

    // Staging z changes only git's listing, not the inputs.
    git('add', 'packages/z/package.json');
    t.resetBackgroundInstallMemo();
    await open('npm ci');
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);
  });

  it("judges completion by the running installer's stamp, not every lockfile's", async () => {
    // npm ci in a checkout that also carries yarn.lock: npm never writes
    // Yarn's stamp, so that must not read as a broken install.
    const yarnLock = path.join(cloneDir, 'yarn.lock');
    writeFileSync(yarnLock, '# yarn\n', 'utf8');
    utimesSync(yarnLock, cloned, cloned);
    installDeps(cloneDir, installed);

    await open('npm ci');
    await open('npm ci');
    expect(childProcessExecMock).not.toHaveBeenCalled();

    // The same tree judged for a yarn command has no yarn stamp: broken.
    await open('yarn install --frozen-lockfile');
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['npm ci --include=dev', 'npm'],
    ['npm run install:all', null],
    ['npx pnpm install', null],
    ['yarn build', null],
    ['yarn', 'yarn'],
    ['NODE_ENV=production npm ci', 'npm'],
    ['/usr/local/bin/npm ci', 'npm'],
    ['pnpm install && npm run build', 'pnpm'],
    ['npm ci && cd web && yarn install', null],
    ['cd web && pnpm install --frozen-lockfile', 'pnpm'],
    ['yarn install --immutable', 'yarn'],
    ['bun install --frozen-lockfile', 'bun'],
    ['make deps', null],
  ])('reads the package manager from %s', async (cmd, expected) => {
    expect((await worktree()).packageManagerForCommand(cmd)).toBe(expected);
  });

  it('catches a package.json edit landing right after a Hub install finished', async () => {
    await open();
    expect(childProcessExecMock).toHaveBeenCalledTimes(1);
    const recorded = path.join(cloneDir, 'node_modules', '.agent-hub-installed-inputs');
    expect(existsSync(recorded)).toBe(true);

    // Same instant as the install stamp: no mtime allowance can see this.
    const stamp = statSync(path.join(cloneDir, 'node_modules', '.package-lock.json')).mtime;
    writePackage(cloneDir, newManifest, stamp);
    await open();
    expect(childProcessExecMock).toHaveBeenCalledTimes(2);
  });
});
