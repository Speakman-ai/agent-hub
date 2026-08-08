/**
 * Adapts a vm-agent stream to the `SessionEnvProcess` / `SessionEnvPty`
 * handles the rest of the Hub programs against.
 *
 * Kept separate from the adapter so the full lifecycle of a command running
 * "inside a VM" — output, exit codes, signals, resize, abrupt VM death — is
 * unit-testable against an in-memory stream, with no KVM and no VMM.
 *
 * The invariant every consumer depends on: a handle settles exactly once. The
 * agent normally sends an `exit` frame, but a VM can also disappear
 * mid-command (OOM kill, host reap, panic). Both paths converge on the same
 * single settle, so a dev-server runtime waiting on `onExit` can never hang
 * on a process whose VM is already gone.
 */

import type { SessionEnvExit, SessionEnvProcess, SessionEnvPty } from '../session-env.js';
import {
  decodeJsonPayload,
  encodeFrame,
  encodeJsonFrame,
  type VmAgentControl,
  type VmAgentError,
  type VmAgentExit,
  type VmAgentStarted,
} from './vm-agent-protocol.js';
import type { VmAgentStream } from './vm-agent-client.js';

export interface VmAgentProcessOpts {
  stream: VmAgentStream;
  name: string;
  /** Called on every frame, so the env can refresh its idle timer. */
  onActivity?: () => void;
  /** Fires once the handle settles, so the env can drop it from its live set. */
  onSettled?: () => void;
  logger?: { warn: (msg: string) => void };
}

export interface VmAgentProcessHandle {
  process: SessionEnvProcess;
  /** Resolves when the process has settled; used by dispose to await drain. */
  exited: Promise<void>;
}

export function createVmAgentProcess(opts: VmAgentProcessOpts): VmAgentProcessHandle {
  const { stream, name } = opts;
  const stdoutSubs = new Set<(chunk: string) => void>();
  const stderrSubs = new Set<(chunk: string) => void>();
  const exitSubs = new Set<(result: SessionEnvExit) => void>();

  let pid: number | null = null;
  let exitResult: SessionEnvExit | null = null;
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const settle = (result: SessionEnvExit) => {
    if (exitResult !== null) return;
    exitResult = result;
    for (const cb of exitSubs) {
      try {
        cb(result);
      } catch (err) {
        opts.logger?.warn(`vm-agent process "${name}" onExit hook threw: ${String(err)}`);
      }
    }
    exitSubs.clear();
    opts.onSettled?.();
    resolveExit();
  };

  stream.onFrame((frame) => {
    opts.onActivity?.();
    switch (frame.type) {
      case 'started':
        pid = decodeJsonPayload<VmAgentStarted>(frame.payload).pid;
        return;
      case 'stdout': {
        const text = frame.payload.toString();
        for (const cb of stdoutSubs) cb(text);
        return;
      }
      case 'stderr': {
        const text = frame.payload.toString();
        for (const cb of stderrSubs) cb(text);
        return;
      }
      case 'exit': {
        const payload = decodeJsonPayload<VmAgentExit>(frame.payload);
        settle({
          code: payload.code,
          signal: (payload.signal as NodeJS.Signals | null) ?? null,
        });
        return;
      }
      case 'error': {
        const payload = decodeJsonPayload<VmAgentError>(frame.payload);
        settle({ code: null, signal: null, error: new Error(payload.message) });
        return;
      }
      case 'request':
      case 'stdin':
      case 'control':
      case 'reply':
        // Host-to-guest kinds (and one-shot replies) never arrive on a
        // streaming process; ignore rather than treating them as an exit.
        return;
      default: {
        const exhaustive: never = frame.type;
        throw new Error(`unhandled vm-agent frame type ${String(exhaustive)}`);
      }
    }
  });

  stream.onClose((err) => {
    // The VM went away without an exit frame. Attributing a code here would
    // be a lie; report it as a spawn-level failure so callers surface the
    // real cause instead of a plausible-looking exit 0.
    settle({
      code: null,
      signal: null,
      error:
        err ??
        new Error(`vm-agent stream for "${name}" closed before the process reported an exit`),
    });
  });

  const process: SessionEnvProcess = {
    get pid() {
      return pid;
    },
    name,
    get exited() {
      return exitResult !== null;
    },
    get exitResult() {
      return exitResult;
    },
    onStdout: (cb) => {
      stdoutSubs.add(cb);
      return () => stdoutSubs.delete(cb);
    },
    onStderr: (cb) => {
      stderrSubs.add(cb);
      return () => stderrSubs.delete(cb);
    },
    onExit: (cb) => {
      if (exitResult !== null) {
        cb(exitResult);
        return () => {};
      }
      exitSubs.add(cb);
      return () => exitSubs.delete(cb);
    },
    kill: (signal: NodeJS.Signals = 'SIGTERM') => {
      if (exitResult !== null) return;
      const control: VmAgentControl = { kind: 'signal', signal };
      stream.send(encodeJsonFrame('control', control));
    },
  };

  return { process, exited };
}

export interface VmAgentPtyOpts {
  stream: VmAgentStream;
  /** PID reported by the guest in the `started` frame. */
  pid: number;
  onActivity?: () => void;
  onSettled?: () => void;
}

export interface VmAgentPtyHandle {
  pty: SessionEnvPty;
  exited: Promise<void>;
}

export function createVmAgentPty(opts: VmAgentPtyOpts): VmAgentPtyHandle {
  const { stream } = opts;
  const dataSubs = new Set<(data: string) => void>();
  const exitSubs = new Set<(e: { exitCode: number; signal?: number }) => void>();

  let settled = false;
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const settle = (e: { exitCode: number; signal?: number }) => {
    if (settled) return;
    settled = true;
    for (const cb of exitSubs) cb(e);
    exitSubs.clear();
    dataSubs.clear();
    opts.onSettled?.();
    resolveExit();
  };

  stream.onFrame((frame) => {
    opts.onActivity?.();
    if (frame.type === 'stdout' || frame.type === 'stderr') {
      // A PTY merges both streams onto the master; the guest labels output
      // stdout, but a stderr frame is still terminal output.
      const text = frame.payload.toString();
      for (const cb of dataSubs) cb(text);
      return;
    }
    if (frame.type === 'exit') {
      const payload = decodeJsonPayload<VmAgentExit>(frame.payload);
      settle({ exitCode: payload.code ?? 0, signal: undefined });
    }
  });

  // A closed stream means the shell is gone whether or not it said so.
  stream.onClose(() => settle({ exitCode: 0, signal: undefined }));

  const pty: SessionEnvPty = {
    pid: opts.pid,
    write: (data) => {
      opts.onActivity?.();
      stream.send(encodeFrame('stdin', Buffer.from(data, 'utf8')));
    },
    resize: (cols, rows) => {
      const control: VmAgentControl = { kind: 'resize', cols, rows };
      stream.send(encodeJsonFrame('control', control));
    },
    onData: (cb) => {
      dataSubs.add(cb);
      return () => dataSubs.delete(cb);
    },
    onExit: (cb) => {
      exitSubs.add(cb);
      return () => exitSubs.delete(cb);
    },
    kill: (signal = 'SIGTERM') => {
      const control: VmAgentControl = { kind: 'signal', signal };
      stream.send(encodeJsonFrame('control', control));
    },
  };

  return { pty, exited };
}
