import { describe, it, expect, vi } from 'vitest';
import {
  buildAptInstallCommand,
  installDevServerSystemDeps,
  describeSystemDepsExit,
} from './dev-server-system-deps.js';
import type {
  SessionEnv,
  SessionEnvExit,
  SessionEnvKind,
  SessionEnvProcess,
} from '../session-env/session-env.js';

/**
 * Minimal fake SessionEnvProcess that replays a fixed exit + output. No real
 * process is spawned — this honors the "tests must not spawn real CLIs" rail.
 * `unsubs` records every unsubscribe returned so a test can assert cleanup.
 *
 * By default `onExit` fires the callback SYNCHRONOUSLY (`mode: 'sync'`) — the
 * documented already-exited contract, and the harder path for the runner to
 * get right (the exit unsub isn't registered when the callback runs). Pass
 * `mode: 'async'` to defer the exit to a microtask for the not-yet-exited path.
 */
function fakeProc(
  exit: SessionEnvExit,
  out: { stdout?: string; stderr?: string; mode?: 'sync' | 'async' } = {},
) {
  const unsubs = { stdout: vi.fn(), stderr: vi.fn(), exit: vi.fn() };
  const proc = {
    pid: 4242,
    name: 'apt',
    exited: true,
    exitResult: exit,
    onStdout(cb: (c: string) => void) {
      if (out.stdout) cb(out.stdout);
      return unsubs.stdout;
    },
    onStderr(cb: (c: string) => void) {
      if (out.stderr) cb(out.stderr);
      return unsubs.stderr;
    },
    onExit(cb: (r: SessionEnvExit) => void) {
      if (out.mode === 'async') queueMicrotask(() => cb(exit));
      else cb(exit); // sync: fires during registration (already-exited)
      return unsubs.exit;
    },
    kill() {},
  } as unknown as SessionEnvProcess;
  return { proc, unsubs };
}

/** Fake SessionEnv exposing only `kind` + `spawn`, which is all the runner uses. */
function fakeEnv(
  kind: SessionEnvKind,
  proc: SessionEnvProcess,
  onSpawn?: (command: string, opts?: unknown) => void,
) {
  return {
    kind,
    sessionId: 'sess-1',
    spawn: (command: string, opts?: unknown) => {
      onSpawn?.(command, opts);
      return proc;
    },
  } as unknown as SessionEnv;
}

describe('buildAptInstallCommand', () => {
  it('returns null for an empty package list', () => {
    expect(buildAptInstallCommand([])).toBeNull();
  });

  it('builds a single-shell update+install with non-interactive frontend', () => {
    const cmd = buildAptInstallCommand(['imagemagick', 'libmagickwand-dev']);
    expect(cmd).toBe(
      "apt_sudo=''; [ \"$(id -u)\" -eq 0 ] || apt_sudo='sudo -n'; " +
        '$apt_sudo apt-get update && ' +
        '$apt_sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y ' +
        '--no-install-recommends imagemagick libmagickwand-dev',
    );
  });

  // The container backends exec as the non-root `runner` sudoer, so an
  // unelevated apt-get fails with EACCES and the packages silently never land.
  it('elevates with sudo when the exec user is not root', () => {
    const cmd = buildAptInstallCommand(['awscli']);
    expect(cmd).toContain("apt_sudo='sudo -n'");
    expect(cmd).toContain('$apt_sudo apt-get update');
    expect(cmd).toContain('$apt_sudo env DEBIAN_FRONTEND=noninteractive apt-get install');
  });
});

describe('installDevServerSystemDeps', () => {
  it('skips with no-packages when the list is empty', async () => {
    const spy = vi.fn();
    const env = fakeEnv('sysbox', fakeProc({ code: 0, signal: null }).proc, spy);
    const result = await installDevServerSystemDeps({ env, aptPackages: [] });
    expect(result).toEqual({ ran: false, skipped: 'no-packages' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses to run on the host backend and warns instead of spawning apt', async () => {
    const spy = vi.fn();
    const warn = vi.fn();
    const lines: string[] = [];
    const env = fakeEnv('host', fakeProc({ code: 0, signal: null }).proc, spy);
    const result = await installDevServerSystemDeps({
      env,
      aptPackages: ['imagemagick'],
      logger: { warn },
      onLine: (line) => lines.push(line),
    });
    expect(result).toEqual({ ran: false, skipped: 'host-backend' });
    expect(spy).not.toHaveBeenCalled(); // never touches the shared host
    expect(warn).toHaveBeenCalledOnce();
    expect(lines.join('\n')).toContain('host');
  });

  it('runs apt inside the sysbox env and returns a clean exit', async () => {
    const spy = vi.fn();
    const lines: Array<[string, string]> = [];
    const env = fakeEnv(
      'sysbox',
      fakeProc({ code: 0, signal: null }, { stdout: 'Setting up imagemagick\n' }).proc,
      spy,
    );
    const result = await installDevServerSystemDeps({
      env,
      aptPackages: ['imagemagick'],
      onLine: (line, stream) => lines.push([stream, line]),
    });
    expect(result.ran).toBe(true);
    expect(result.exit).toEqual({ code: 0, signal: null });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain('apt-get install');
    expect(lines).toContainEqual(['stdout', 'Setting up imagemagick']);
  });

  // Regression: the gate read `kind !== 'sysbox'`, so every Hub whose host
  // lacks the sysbox runtime (the common case — it falls back to `container`)
  // silently skipped the install and the dev server started without its
  // declared OS packages.
  it('runs apt inside the container env too, not just sysbox', async () => {
    const spy = vi.fn();
    const warn = vi.fn();
    const env = fakeEnv('container', fakeProc({ code: 0, signal: null }).proc, spy);
    const result = await installDevServerSystemDeps({
      env,
      aptPackages: ['awscli', 'postgresql-client'],
      logger: { warn },
    });
    expect(result.ran).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(spy.mock.calls[0][0]).toContain('awscli postgresql-client');
  });

  it('forwards spawnEnv (project env + resolved secrets) to the apt process', async () => {
    const spy = vi.fn();
    const env = fakeEnv('sysbox', fakeProc({ code: 0, signal: null }).proc, spy);
    await installDevServerSystemDeps({
      env,
      aptPackages: ['imagemagick'],
      spawnEnv: { APT_HTTP_PROXY: 'http://proxy:3128', NPM_TOKEN: 'secret' },
    });
    const opts = spy.mock.calls[0][1] as { env?: Record<string, string> };
    expect(opts.env).toEqual({ APT_HTTP_PROXY: 'http://proxy:3128', NPM_TOKEN: 'secret' });
  });

  it('disposes stdout/stderr/exit listeners when the apt process exits synchronously (already-exited)', async () => {
    const { proc, unsubs } = fakeProc({ code: 0, signal: null }, { stdout: 'ok\n', mode: 'sync' });
    const env = fakeEnv('sysbox', proc);
    const result = await installDevServerSystemDeps({
      env,
      aptPackages: ['imagemagick'],
      onLine: () => {},
    });
    expect(result.exit).toEqual({ code: 0, signal: null });
    expect(unsubs.stdout).toHaveBeenCalledOnce();
    expect(unsubs.stderr).toHaveBeenCalledOnce();
    expect(unsubs.exit).toHaveBeenCalledOnce();
  });

  it('disposes all listeners when the apt process exits asynchronously (not-yet-exited)', async () => {
    const { proc, unsubs } = fakeProc({ code: 0, signal: null }, { stdout: 'ok\n', mode: 'async' });
    const env = fakeEnv('sysbox', proc);
    await installDevServerSystemDeps({ env, aptPackages: ['imagemagick'], onLine: () => {} });
    expect(unsubs.stdout).toHaveBeenCalledOnce();
    expect(unsubs.stderr).toHaveBeenCalledOnce();
    expect(unsubs.exit).toHaveBeenCalledOnce();
  });

  it('surfaces a non-zero apt exit so the caller can fail the start', async () => {
    const env = fakeEnv('sysbox', fakeProc({ code: 100, signal: null }).proc);
    const result = await installDevServerSystemDeps({ env, aptPackages: ['nonexistent-pkg'] });
    expect(result.ran).toBe(true);
    expect(result.exit?.code).toBe(100);
  });
});

describe('describeSystemDepsExit', () => {
  it('describes spawn errors, signals, and non-zero codes', () => {
    expect(
      describeSystemDepsExit({ code: null, signal: null, error: new Error('ENOENT') }),
    ).toContain('failed to spawn');
    expect(describeSystemDepsExit({ code: null, signal: 'SIGKILL' })).toContain('SIGKILL');
    expect(describeSystemDepsExit({ code: 100, signal: null })).toContain('100');
  });
});
