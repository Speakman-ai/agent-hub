/**
 * Covers awaited session dependency installs: exec failures propagate and a
 * marker prevents hammering repeatedly with the session install timeout.
 * `child_process.exec` must be mocked before `./worktree.js` loads — keep this
 * file isolated so other suites still use real `exec`.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';

/**
 * Spy the exact {@link exec} function `worktree.ts` binds with `promisify` at
 * module load. Re-resolving `exec` from `import('child_process')` in `beforeEach`
 * can point at a different object than the one worktree imported (duplicate module
 * evaluation under Vitest shards), which makes `toHaveBeenCalled` flake.
 */
let childProcessExecMock: ReturnType<typeof vi.fn>;

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

    queueMicrotask(() => {
      if (process.env.TEST_WORKTREE_EXEC_FAIL === '1') {
        cb(new Error('mock install failure'));
        return;
      }
      mkdirSync(path.join(cwd, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(path.join(cwd, 'node_modules', '.bin', 'eslint'), '', 'utf8');
      cb(null);
    });

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

  it('skips host install when the session env is Firecracker (guest owns deps)', async () => {
    configState.sessionEnvAdapter = 'firecracker';
    const { __test } = await worktreePromise;
    childProcessExecMock.mockClear();

    await __test.setupDependencies(sourceDir, cloneDir, 'npm ci', {
      awaitInstall: true,
      preferInstallAllScript: false,
    });

    expect(childProcessExecMock).not.toHaveBeenCalled();
  });
});
