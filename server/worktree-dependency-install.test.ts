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

vi.mock('./config.js', () => ({
  default: { defaultCwd: '/tmp' },
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

  return {
    ...mod,
    exec: vi.fn(fakeExec),
  };
});

const worktreePromise = import('./worktree.js');

describe('setupDependencies awaited install failures', () => {
  let sourceDir = '';
  let cloneDir = '';
  let cleanup: Array<() => void> = [];
  let execMock!: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    cleanup = [];
    delete process.env.TEST_WORKTREE_EXEC_FAIL;
    sourceDir = path.join(os.tmpdir(), `wh-src-${Date.now()}`);
    cloneDir = path.join(os.tmpdir(), `wh-clone-${Date.now()}`);
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(cloneDir, { recursive: true });
    writeFileSync(path.join(sourceDir, 'noop.txt'), 'x');
    writeFileSync(path.join(cloneDir, 'package.json'), JSON.stringify({ name: 'fixture' }), 'utf8');
    writeFileSync(path.join(cloneDir, 'package-lock.json'), '{}', 'utf8');

    const cp = await import('child_process');
    execMock = vi.mocked(cp.exec);
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
    execMock.mockClear();

    await expect(
      __test.setupDependencies(sourceDir, cloneDir, null, {
        awaitInstall: true,
        preferInstallAllScript: false,
      }),
    ).rejects.toThrow(SessionDependencyInstallError);

    const markerPath = path.join(cloneDir, SESSION_DEPENDENCY_INSTALL_FAILURE_MARKER);
    expect(existsSync(markerPath)).toBe(true);

    execMock.mockClear();
    await expect(
      __test.setupDependencies(sourceDir, cloneDir, null, {
        awaitInstall: true,
        preferInstallAllScript: false,
      }),
    ).rejects.toThrow(/previously failed/);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('clears the failure marker after a successful awaited install so the next attempt runs npm again', async () => {
    const {
      SESSION_DEPENDENCY_INSTALL_FAILURE_MARKER,
      SessionDependencyInstallError,
      clearDependencyInstallFailureMarker,
      __test,
    } = await worktreePromise;
    execMock.mockClear();

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
    execMock.mockClear();

    await __test.setupDependencies(sourceDir, cloneDir, null, {
      awaitInstall: true,
      preferInstallAllScript: false,
    });

    expect(existsSync(markerPath)).toBe(false);
    expect(execMock).toHaveBeenCalled();

    rmSync(path.join(cloneDir, 'node_modules'), { recursive: true, force: true });
    execMock.mockClear();

    await __test.setupDependencies(sourceDir, cloneDir, null, {
      awaitInstall: true,
      preferInstallAllScript: false,
    });
    expect(execMock).toHaveBeenCalledTimes(1);
    clearDependencyInstallFailureMarker(cloneDir);
  });
});
