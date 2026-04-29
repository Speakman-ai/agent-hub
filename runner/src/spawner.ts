/**
 * Runner-side spawn handler. Owns the lifecycle of every CLI process the
 * control plane asks the runner to run:
 *
 *   spawn  → resolve engine → exec → ack `result {ok,pid}` → stream stdout/stderr
 *   stdin  → write to child's stdin (optionally end after the chunk)
 *   cancel → forward signal (default SIGTERM) to the child process
 *   <exit> → drain coalesced output, then send `exit {code, signal}`
 *
 * The registry layer (`SpawnRegistry`) is a Map<id, ActiveSpawn>; the
 * client.ts message dispatcher hands every spawn/stdin/cancel frame to it
 * and forgets about it. Lifecycle is fully owned by the registry, so a
 * disconnect just abandons the map — there is no graceful "drain on
 * disconnect" semantic in phase 2 (the control plane considers
 * disconnect-mid-spawn a failed run and the orphaned child will exit on
 * its own when stdin closes).
 *
 * Workspace prep is intentionally limited in this phase: the spawner
 * accepts `workspace` in the spawn frame, but if `repoUrl` is present
 * we reject with `workspace_failed` until the workspace manager lands
 * (tracked separately). This keeps the surface area small while the
 * stream/exit path matures.
 */
import { spawn as childSpawn, type ChildProcess } from 'child_process';
import type {
  RunnerCancelMessage,
  RunnerExitMessage,
  RunnerInbound,
  RunnerResultMessage,
  RunnerSpawnMessage,
  RunnerStdinMessage,
  RunnerStreamMessage,
} from '../../shared/runner-protocol.js';
import { resolveEngineBin } from './engine-resolver.js';
import { SpawnCoalescer } from './spawn-coalescer.js';

/** Function the spawner uses to ship a frame back to the control plane.
 * The client owns the actual WS; this signature lets the spawner stay
 * decoupled from the transport (and trivially mockable in tests). */
export type SendFrame = (msg: RunnerInbound) => void;

/**
 * Test seam — abstracts `child_process.spawn` so tests can replace it
 * with a fake that emits scripted stdout/stderr/exit events. Production
 * passes the real `child_process.spawn`.
 */
export type ChildSpawner = (
  bin: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcess;

export interface SpawnerOptions {
  send: SendFrame;
  /** Replaceable child spawner; defaults to `child_process.spawn`. */
  childSpawner?: ChildSpawner;
  /** 50ms by default; tests can shrink this for speed. */
  flushIntervalMs?: number;
  /** Process env override — defaults to `process.env`. The runner merges
   * spawn-frame `env` on top of this when launching the child. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Default cwd for spawned processes when `workspace` is absent.
   * Defaults to the runner process cwd. */
  defaultCwd?: string;
}

interface ActiveSpawn {
  id: string;
  child: ChildProcess;
  coalescer: SpawnCoalescer;
  /** True after we've sent the `exit` frame — guards against
   * close-after-error double emission. */
  exited: boolean;
}

/**
 * One instance per runner client. Holds all currently-running spawns and
 * routes inbound spawn/stdin/cancel frames to them.
 */
export class SpawnRegistry {
  private readonly active = new Map<string, ActiveSpawn>();
  private readonly childSpawner: ChildSpawner;
  private readonly flushIntervalMs: number;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly defaultCwd: string | undefined;

  constructor(private readonly opts: SpawnerOptions) {
    this.childSpawner = opts.childSpawner ?? (childSpawn as unknown as ChildSpawner);
    this.flushIntervalMs = opts.flushIntervalMs ?? 50;
    this.baseEnv = opts.baseEnv ?? process.env;
    this.defaultCwd = opts.defaultCwd;
  }

  /** Number of in-flight spawns. Exposed for tests + future metrics. */
  size(): number {
    return this.active.size;
  }

  /** Begin a new spawn. Synchronous from the control-plane's POV: the
   * `result` ack ships before we return. Subsequent stream/exit frames
   * arrive asynchronously.
   *
   * Idempotency: a duplicate `id` is rejected as `spawn_failed` rather
   * than overwriting the existing record — the control plane should
   * never reuse a spawn id, and silently swallowing a duplicate would
   * mask a routing bug. */
  handleSpawn(msg: RunnerSpawnMessage): void {
    if (this.active.has(msg.id)) {
      this.sendResult({
        type: 'result',
        id: msg.id,
        ok: false,
        errorCode: 'spawn_failed',
        error: 'duplicate spawn id',
      });
      return;
    }

    if (msg.workspace?.repoUrl) {
      // Workspace prep lands in a follow-up. Until then we refuse rather
      // than silently dropping the workspace request — callers must
      // observe the typed error and surface it.
      this.sendResult({
        type: 'result',
        id: msg.id,
        ok: false,
        errorCode: 'workspace_failed',
        error: 'Runner workspace preparation not implemented in this phase',
      });
      return;
    }

    const bin = resolveEngineBin(msg.engine, { env: this.baseEnv });
    if (!bin) {
      this.sendResult({
        type: 'result',
        id: msg.id,
        ok: false,
        errorCode: 'unknown_engine',
        error: `Unknown engine: ${msg.engine}`,
      });
      return;
    }

    const childEnv: NodeJS.ProcessEnv = { ...this.baseEnv, ...(msg.env ?? {}) };

    let child: ChildProcess;
    try {
      child = this.childSpawner(bin, msg.args, {
        cwd: this.defaultCwd,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.sendResult({
        type: 'result',
        id: msg.id,
        ok: false,
        errorCode: 'spawn_failed',
        error: (err as Error).message,
      });
      return;
    }

    // child.spawn() can fail asynchronously via 'error' before any pid
    // is assigned (e.g. ENOENT when bin doesn't exist). Track that path
    // separately from successful start.
    let resultSent = false;
    const sendResultOnce = (frame: RunnerResultMessage): void => {
      if (resultSent) return;
      resultSent = true;
      this.sendResult(frame);
    };

    const coalescer = new SpawnCoalescer({
      spawnId: msg.id,
      flushIntervalMs: this.flushIntervalMs,
      emit: ({ channel, data, seq }) => {
        const frame: RunnerStreamMessage = {
          type: 'stream',
          id: msg.id,
          channel,
          data,
          seq,
        };
        this.opts.send(frame);
      },
    });

    const entry: ActiveSpawn = { id: msg.id, child, coalescer, exited: false };
    this.active.set(msg.id, entry);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => coalescer.write('stdout', chunk));
    child.stderr?.on('data', (chunk: string) => coalescer.write('stderr', chunk));

    child.on('error', (err) => {
      // ENOENT / spawn failure routed through 'error' — we may not have
      // seen 'spawn' yet, so report `binary_not_found` if it looks like
      // ENOENT, else generic spawn_failed.
      const code = (err as NodeJS.ErrnoException).code;
      sendResultOnce({
        type: 'result',
        id: msg.id,
        ok: false,
        errorCode: code === 'ENOENT' ? 'binary_not_found' : 'spawn_failed',
        error: err.message,
      });
      // If we never started successfully, drop the registry slot now;
      // the close handler may still fire but won't double-send because
      // `exited` is already true.
      this.finishSpawn(msg.id, null, null);
    });

    child.on('spawn', () => {
      sendResultOnce({
        type: 'result',
        id: msg.id,
        ok: true,
        pid: child.pid,
      });
      // Initial stdin payload — written after the OS has acknowledged
      // the spawn so we never write to a pipe that doesn't exist yet.
      if (typeof msg.stdin === 'string' && msg.stdin.length > 0 && child.stdin) {
        try {
          child.stdin.write(msg.stdin);
        } catch (err) {
          console.warn(
            `[runner] spawn ${msg.id}: initial stdin write failed: ${(err as Error).message}`,
          );
        }
      }
    });

    child.on('close', (code, signal) => {
      this.finishSpawn(msg.id, code, signal);
    });
  }

  /** Forward a stdin chunk to the running child. Unknown ids are
   * silently dropped — this matches the protocol's tolerant stance
   * (ids may race against an exit). */
  handleStdin(msg: RunnerStdinMessage): void {
    const entry = this.active.get(msg.id);
    if (!entry || !entry.child.stdin) return;
    try {
      if (msg.data.length > 0) entry.child.stdin.write(msg.data);
      if (msg.end) entry.child.stdin.end();
    } catch (err) {
      console.warn(
        `[runner] stdin write to ${msg.id} failed: ${(err as Error).message}`,
      );
    }
  }

  /** Forward a signal to the running child. SIGTERM is the protocol
   * default; SIGKILL escalates if the child ignores SIGTERM. Unknown
   * ids are silently dropped to match the protocol. */
  handleCancel(msg: RunnerCancelMessage): void {
    const entry = this.active.get(msg.id);
    if (!entry) return;
    try {
      entry.child.kill(msg.signal ?? 'SIGTERM');
    } catch (err) {
      console.warn(
        `[runner] cancel of ${msg.id} failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Finalize a spawn: drain coalesced output, emit `exit`, drop registry
   * slot. Idempotent — guarded by `entry.exited` so a double-fire (error
   * THEN close) doesn't ship two `exit` frames.
   */
  private finishSpawn(id: string, code: number | null, signal: NodeJS.Signals | null): void {
    const entry = this.active.get(id);
    if (!entry) return;
    if (entry.exited) {
      this.active.delete(id);
      return;
    }
    entry.exited = true;
    entry.coalescer.flushNow();
    const exit: RunnerExitMessage = {
      type: 'exit',
      id,
      code,
      signal: signal ?? null,
    };
    this.opts.send(exit);
    this.active.delete(id);
  }

  private sendResult(frame: RunnerResultMessage): void {
    this.opts.send(frame);
  }
}
