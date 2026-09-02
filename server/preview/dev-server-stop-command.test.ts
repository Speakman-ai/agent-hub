import { describe, expect, it, vi } from 'vitest';
import type {
  SessionEnv,
  SessionEnvExit,
  SessionEnvProcess,
  SessionEnvSpawnOpts,
} from '../session-env/session-env.js';
import { runDevServerStopCommand, describeStopExit } from './dev-server-stop-command.js';

class FakeProcess implements SessionEnvProcess {
  readonly pid = 4242;
  readonly name: string;
  exited = false;
  exitResult: SessionEnvExit | null = null;
  killCalls: NodeJS.Signals[] = [];
  private readonly exits = new Set<(r: SessionEnvExit) => void>();

  constructor(name: string) {
    this.name = name;
  }

  onStdout(): () => void {
    return () => {};
  }
  onStderr(): () => void {
    return () => {};
  }
  onExit(cb: (r: SessionEnvExit) => void): () => void {
    if (this.exitResult) cb(this.exitResult);
    else this.exits.add(cb);
    return () => this.exits.delete(cb);
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.killCalls.push(signal);
    this.exit({ code: null, signal });
  }
  exit(result: SessionEnvExit): void {
    if (this.exited) return;
    this.exited = true;
    this.exitResult = result;
    for (const cb of this.exits) cb(result);
  }
}

/** Minimal SessionEnv stub — only `spawn`/`sessionId` are exercised here. */
function makeEnv(
  spawnImpl: (command: string, opts: SessionEnvSpawnOpts) => SessionEnvProcess,
): SessionEnv {
  return {
    sessionId: 'sess-1',
    spawn: vi.fn(spawnImpl),
  } as unknown as SessionEnv;
}

describe('runDevServerStopCommand', () => {
  it('spawns the command via the env with the given cwd + env and resolves its exit', async () => {
    const proc = new FakeProcess('stop');
    const spawn = vi.fn(() => proc);
    const env = makeEnv(spawn);
    const promise = runDevServerStopCommand({
      env,
      stopCommand: 'docker compose down --remove-orphans',
      cwd: 'frontend',
      spawnEnv: { AGENT_HUB_SESSION_ID: 'sess-1' },
    });
    proc.exit({ code: 0, signal: null });
    const result = await promise;

    expect(spawn).toHaveBeenCalledWith('docker compose down --remove-orphans', {
      cwd: 'frontend',
      env: { AGENT_HUB_SESSION_ID: 'sess-1' },
      name: 'dev-server-stop:sess-1',
    });
    expect(result).toEqual({ exit: { code: 0, signal: null }, timedOut: false });
    expect(describeStopExit(result)).toBe('stopCommand completed');
  });

  it('reports a spawn failure as an errored exit instead of throwing', async () => {
    const env = makeEnv(() => {
      throw new Error('no docker');
    });
    const result = await runDevServerStopCommand({ env, stopCommand: 'docker compose down' });
    expect(result.timedOut).toBe(false);
    expect(result.exit.error?.message).toBe('no docker');
    expect(describeStopExit(result)).toBe('stopCommand failed to spawn: no docker');
  });

  it('kills the command and flags timedOut when it runs past the timeout', async () => {
    const proc = new FakeProcess('stop');
    const env = makeEnv(() => proc);
    // Fire the scheduled timeout synchronously so the wedged command is killed.
    const setTimeoutFn = vi.fn((cb: () => void) => {
      cb();
      return { unref: () => {} };
    });
    const clearTimeoutFn = vi.fn();
    const result = await runDevServerStopCommand({
      env,
      stopCommand: 'docker compose down',
      timeoutMs: 10,
      setTimeoutFn,
      clearTimeoutFn,
    });

    expect(proc.killCalls).toContain('SIGKILL');
    expect(result.timedOut).toBe(true);
    expect(describeStopExit(result)).toBe('stopCommand timed out and was killed');
    expect(clearTimeoutFn).toHaveBeenCalled();
  });

  it('still resolves at the timeout when kill throws and the backend emits no exit', async () => {
    // The wedge case: a backend whose kill() throws and never fires onExit must
    // not leave the promise (and therefore stop()) hung past the bound.
    const wedged = {
      pid: 1,
      name: 'stop',
      onStdout: () => () => {},
      onStderr: () => () => {},
      // Never fires — the process "exit" never arrives.
      onExit: () => () => {},
      kill: () => {
        throw new Error('backend kill failed');
      },
    } as unknown as SessionEnvProcess;
    const env = makeEnv(() => wedged);
    const setTimeoutFn = vi.fn((cb: () => void) => {
      cb();
      return { unref: () => {} };
    });

    const result = await runDevServerStopCommand({
      env,
      stopCommand: 'docker compose down',
      timeoutMs: 10,
      setTimeoutFn,
      clearTimeoutFn: vi.fn(),
    });

    expect(result.timedOut).toBe(true);
    expect(describeStopExit(result)).toBe('stopCommand timed out and was killed');
  });
});
