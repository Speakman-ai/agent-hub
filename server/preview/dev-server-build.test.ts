import { describe, it, expect } from 'vitest';
import type { SessionEnvExit } from '../session-env/session-env.js';
import { runDevServerBuild, describeBuildExit, BUILD_PROCESS_NAME } from './dev-server-build.js';

/** Minimal SessionEnvProcess stand-in that exits with a preset result. */
class FakeProc {
  pid = 4242;
  exited = false;
  private exitResult: SessionEnvExit | null = null;
  private readonly stdout = new Set<(c: string) => void>();
  private readonly stderr = new Set<(c: string) => void>();
  private readonly exits = new Set<(r: SessionEnvExit) => void>();

  constructor(private readonly preExit: SessionEnvExit) {}

  onStdout(cb: (c: string) => void) {
    this.stdout.add(cb);
    return () => this.stdout.delete(cb);
  }
  onStderr(cb: (c: string) => void) {
    this.stderr.add(cb);
    return () => this.stderr.delete(cb);
  }
  onExit(cb: (r: SessionEnvExit) => void) {
    if (this.exitResult) cb(this.exitResult);
    else this.exits.add(cb);
    return () => this.exits.delete(cb);
  }
  emitStdout(chunk: string) {
    for (const cb of this.stdout) cb(chunk);
  }
  fire() {
    this.exited = true;
    this.exitResult = this.preExit;
    for (const cb of this.exits) cb(this.preExit);
  }
  kill() {}
}

function makeEnv(exit: SessionEnvExit, onSpawn?: (proc: FakeProc) => void) {
  const spawnCalls: Array<{ command: string; opts: any }> = [];
  const env = {
    sessionId: 'sess-1',
    kind: 'host' as const,
    spawn(command: string, opts: any = {}) {
      spawnCalls.push({ command, opts });
      const proc = new FakeProc(exit);
      // Fire asynchronously so listeners attach first (the live-exit path).
      queueMicrotask(() => {
        onSpawn?.(proc);
        proc.fire();
      });
      return proc as any;
    },
  } as any;
  return { env, spawnCalls };
}

describe('runDevServerBuild', () => {
  it('spawns the build command with the given cwd + env and resolves its exit', async () => {
    const { env, spawnCalls } = makeEnv({ code: 0, signal: null });
    const result = await runDevServerBuild({
      env,
      buildCommand: 'npm run build',
      cwd: 'apps/web',
      spawnEnv: { NODE_ENV: 'development' },
    });
    expect(result.exit.code).toBe(0);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe('npm run build');
    expect(spawnCalls[0].opts.cwd).toBe('apps/web');
    expect(spawnCalls[0].opts.env).toEqual({ NODE_ENV: 'development' });
    expect(spawnCalls[0].opts.name).toBe('dev-server-build:sess-1');
  });

  it('tees stdout lines to onLine, tagged with the build process banner', async () => {
    const lines: Array<{ line: string; stream: string }> = [];
    const { env } = makeEnv({ code: 0, signal: null }, (proc) => {
      proc.emitStdout('compiling\nbundled\n');
    });
    await runDevServerBuild({
      env,
      buildCommand: 'npm run build',
      onLine: (line, stream) => lines.push({ line, stream }),
    });
    // First line is the runner's own banner; then the process output.
    expect(lines[0]).toEqual({
      line: `[${BUILD_PROCESS_NAME}] running: npm run build`,
      stream: 'stdout',
    });
    expect(lines.map((l) => l.line)).toContain('compiling');
    expect(lines.map((l) => l.line)).toContain('bundled');
  });

  it('resolves (does not throw) on a non-zero exit — the caller decides', async () => {
    const { env } = makeEnv({ code: 2, signal: null });
    const result = await runDevServerBuild({ env, buildCommand: 'exit 2' });
    expect(result.exit.code).toBe(2);
  });
});

describe('describeBuildExit', () => {
  it('summarizes a non-zero code', () => {
    expect(describeBuildExit({ code: 3, signal: null })).toBe('buildCommand exited with code 3');
  });
  it('summarizes a signal', () => {
    expect(describeBuildExit({ code: null, signal: 'SIGKILL' })).toBe(
      'buildCommand killed by signal SIGKILL',
    );
  });
  it('summarizes a spawn error', () => {
    expect(describeBuildExit({ code: null, signal: null, error: new Error('nope') })).toBe(
      'buildCommand failed to spawn: nope',
    );
  });
});
