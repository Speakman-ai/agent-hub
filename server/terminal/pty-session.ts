/**
 * PtySession — one persistent shell per Agent Hub session, shared by every
 * viewer (a human tab, a second human, the agent injector).
 *
 * Ownership boundary (see the terminal-stack + shared-pty decisions):
 *   - The PTY is opened once through {@link SessionEnv.openPty} in the
 *     session worktree with project env, and OUTLIVES its clients: when the
 *     last viewer detaches the shell keeps running, so a WS drop / tab sleep
 *     never kills a long build or a running REPL.
 *   - Every byte the PTY emits is mirrored into a {@link TerminalBuffer}
 *     (headless xterm scrollback) and fanned out live to attached viewers.
 *     On (re)connect a viewer gets one serialized snapshot of that buffer,
 *     then a SIGWINCH nudge so full-screen TUIs redraw against the client.
 *   - All input funnels through a single {@link PtyWriteQueue}, so two
 *     clients can never interleave a master write.
 *   - Winsize is arbitrated by {@link PtyResizeArbiter} (tmux "smallest"):
 *     the PTY adopts the per-axis minimum across viewers.
 *
 * Everything the session touches is injectable (the SessionEnv, the buffer
 * factory), so unit tests exercise attach / snapshot / resize / write
 * without opening a real PTY or spawning a shell.
 */

import type { SessionEnv, SessionEnvPty } from '../session-env/session-env.js';
import { PtyResizeArbiter, type TerminalSize } from './pty-resize-arbiter.js';
import { PtyWriteQueue } from './pty-write-queue.js';
import {
  createXtermTerminalBuffer,
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  DEFAULT_TERMINAL_SCROLLBACK,
  type TerminalBuffer,
  type TerminalBufferFactory,
} from './terminal-buffer.js';

export interface PtySessionViewer {
  /** Stable id for this viewer (WS connection id). */
  id: string;
  /** Viewer geometry, fed to the resize arbiter. */
  cols: number;
  rows: number;
  /** Sink for live PTY output after the snapshot has been delivered. */
  onData: (data: string) => void;
}

export interface PtySessionAttachResult {
  /** Serialized scrollback to render before live output starts. */
  snapshot: string;
  /** Detach this viewer (drops it from fan-out and resize arbitration). */
  detach: () => void;
}

export interface PtySessionExit {
  exitCode: number;
  signal?: number;
}

export interface PtySessionDeps {
  sessionId: string;
  /** Isolation boundary the PTY is opened in (host or sysbox adapter). */
  env: SessionEnv;
  /** Shell program. Default: the env's login shell (`SHELL` / `/bin/sh`). */
  shell?: string;
  /** Shell args. Default `['-l']` — a login shell that reads the profile. */
  shellArgs?: string[];
  /** Worktree-relative cwd for the shell. Default: worktree root. */
  cwd?: string;
  /** Extra env merged over the adapter's base env for the shell. */
  shellEnv?: Record<string, string>;
  /** Initial PTY geometry before the first viewer resizes it. */
  cols?: number;
  rows?: number;
  /** Retained scrollback lines. */
  scrollback?: number;
  /** Buffer factory. Default: headless xterm + serialize addon. */
  createBuffer?: TerminalBufferFactory;
  /** Backpressure bound on the write queue. */
  writeQueueMaxQueued?: number;
  logger?: { warn: (msg: string) => void };
}

type PtySessionStatus = 'idle' | 'running' | 'exited' | 'disposed';

export class PtySession {
  readonly sessionId: string;

  readonly #env: SessionEnv;
  readonly #shell?: string;
  readonly #shellArgs: string[];
  readonly #cwd?: string;
  readonly #shellEnv?: Record<string, string>;
  readonly #initialCols: number;
  readonly #initialRows: number;
  readonly #scrollback: number;
  readonly #createBuffer: TerminalBufferFactory;
  readonly #writeQueueMaxQueued?: number;
  readonly #logger: { warn: (msg: string) => void };

  readonly #arbiter = new PtyResizeArbiter();
  readonly #viewers = new Map<string, PtySessionViewer>();
  readonly #exitHooks = new Set<(e: PtySessionExit) => void>();

  #status: PtySessionStatus = 'idle';
  #pty: SessionEnvPty | null = null;
  #buffer: TerminalBuffer | null = null;
  #queue: PtyWriteQueue | null = null;
  #startPromise: Promise<void> | null = null;
  #exitResult: PtySessionExit | null = null;
  /** Current PTY winsize, so we can detect whether a resize is a real change. */
  #currentSize: TerminalSize | null = null;

  constructor(deps: PtySessionDeps) {
    this.sessionId = deps.sessionId;
    this.#env = deps.env;
    this.#shell = deps.shell;
    this.#shellArgs = deps.shellArgs ?? ['-l'];
    this.#cwd = deps.cwd;
    this.#shellEnv = deps.shellEnv;
    this.#initialCols = deps.cols ?? DEFAULT_TERMINAL_COLS;
    this.#initialRows = deps.rows ?? DEFAULT_TERMINAL_ROWS;
    this.#scrollback = deps.scrollback ?? DEFAULT_TERMINAL_SCROLLBACK;
    this.#createBuffer = deps.createBuffer ?? createXtermTerminalBuffer;
    this.#writeQueueMaxQueued = deps.writeQueueMaxQueued;
    this.#logger = deps.logger ?? { warn: (m) => console.warn(m) };
  }

  get status(): PtySessionStatus {
    return this.#status;
  }

  get isRunning(): boolean {
    return this.#status === 'running';
  }

  get viewerCount(): number {
    return this.#viewers.size;
  }

  get exitResult(): PtySessionExit | null {
    return this.#exitResult;
  }

  /** PID of the live shell, or null before start / after exit. */
  get pid(): number | null {
    return this.#pty?.pid ?? null;
  }

  /**
   * Open the shell (idempotent, concurrency-safe). Attach calls this, so a
   * caller rarely needs it directly — it exists for a warm-start path that
   * boots the shell before the first viewer connects.
   */
  async start(): Promise<void> {
    if (this.#status === 'disposed') {
      throw new Error(`PtySession ${this.sessionId} is disposed`);
    }
    if (this.#status === 'running') return;
    if (this.#status === 'exited') {
      throw new Error(`PtySession ${this.sessionId} has already exited`);
    }
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#doStart();
    try {
      await this.#startPromise;
    } catch (err) {
      // Failed boot resets to idle so a later attach can retry.
      this.#startPromise = null;
      this.#status = 'idle';
      throw err;
    }
  }

  async #doStart(): Promise<void> {
    const buffer = await this.#createBuffer({
      cols: this.#initialCols,
      rows: this.#initialRows,
      scrollback: this.#scrollback,
    });
    let pty: SessionEnvPty;
    try {
      pty = await this.#env.openPty({
        command: this.#shell,
        args: this.#shellArgs,
        cwd: this.#cwd,
        env: this.#shellEnv,
        cols: this.#initialCols,
        rows: this.#initialRows,
      });
    } catch (err) {
      buffer.dispose();
      throw err;
    }

    this.#buffer = buffer;
    this.#pty = pty;
    this.#currentSize = { cols: this.#initialCols, rows: this.#initialRows };
    this.#queue = new PtyWriteQueue({
      write: (data) => pty.write(data),
      maxQueued: this.#writeQueueMaxQueued,
      logger: this.#logger,
    });
    this.#status = 'running';

    pty.onData((data) => {
      // Mirror into scrollback first so a viewer attaching mid-chunk can't
      // miss bytes, then fan out live to every current viewer.
      this.#buffer?.write(data);
      for (const viewer of this.#viewers.values()) {
        try {
          viewer.onData(data);
        } catch (err) {
          this.#logger.warn(
            `PtySession ${this.sessionId}: viewer ${viewer.id} onData threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    });
    pty.onExit((e) => this.#handleExit({ exitCode: e.exitCode, signal: e.signal }));
  }

  /**
   * Attach a viewer: boot the shell if needed, register the viewer, return a
   * snapshot of current scrollback, then SIGWINCH so a TUI repaints. The
   * snapshot is produced BEFORE the SIGWINCH nudge so the ordering the
   * client sees is replay-then-redraw.
   */
  async attach(viewer: PtySessionViewer): Promise<PtySessionAttachResult> {
    if (this.#status === 'disposed') {
      throw new Error(`PtySession ${this.sessionId} is disposed`);
    }
    await this.start();
    const buffer = this.#buffer;
    if (!buffer || this.#status !== 'running') {
      throw new Error(`PtySession ${this.sessionId} is not running`);
    }

    this.#viewers.set(viewer.id, viewer);
    this.#arbiter.set(viewer.id, { cols: viewer.cols, rows: viewer.rows });
    const effective = this.#arbiter.effectiveSize();

    // Serialize against the geometry the client will render at, so the
    // snapshot's wrapped lines line up with the viewport.
    if (effective) buffer.resize(effective.cols, effective.rows);
    await buffer.flush();
    const snapshot = buffer.serialize();

    // Replay delivered; now force a SIGWINCH so full-screen apps redraw
    // even when this viewer's size matches the current winsize.
    if (effective) this.#forceRedraw(effective);

    return {
      snapshot,
      detach: () => this.detach(viewer.id),
    };
  }

  /** Update a viewer's geometry and re-arbitrate the PTY winsize. */
  resize(viewerId: string, cols: number, rows: number): void {
    if (!this.#viewers.has(viewerId)) return;
    this.#arbiter.set(viewerId, { cols, rows });
    const effective = this.#arbiter.effectiveSize();
    if (effective) this.#applySize(effective);
  }

  /**
   * Detach a viewer. The PTY keeps running (it outlives clients); if other
   * viewers remain the winsize re-arbitrates upward now that a possibly
   * smaller viewer is gone.
   */
  detach(viewerId: string): void {
    if (!this.#viewers.delete(viewerId)) return;
    this.#arbiter.remove(viewerId);
    const effective = this.#arbiter.effectiveSize();
    if (effective) this.#applySize(effective);
  }

  /** Queue input for the shell. Returns false if the shell is not running. */
  write(data: string): boolean {
    if (this.#status !== 'running' || !this.#queue) return false;
    return this.#queue.enqueue(data);
  }

  /** Pause input delivery (agent/human turn-taking). */
  pauseInput(): void {
    this.#queue?.pause();
  }

  resumeInput(): void {
    this.#queue?.resume();
  }

  /** Register an exit hook; fires immediately if the shell already exited. */
  onExit(cb: (e: PtySessionExit) => void): () => void {
    if (this.#exitResult) {
      cb(this.#exitResult);
      return () => {};
    }
    this.#exitHooks.add(cb);
    return () => this.#exitHooks.delete(cb);
  }

  /** Kill the shell and release the buffer/queue. Idempotent. */
  dispose(): void {
    if (this.#status === 'disposed') return;
    this.#status = 'disposed';
    this.#queue?.close();
    try {
      this.#pty?.kill();
    } catch {
      // Already gone — nothing to signal.
    }
    this.#buffer?.dispose();
    this.#viewers.clear();
    this.#pty = null;
    this.#buffer = null;
    this.#queue = null;
  }

  #applySize(size: TerminalSize): void {
    if (
      this.#currentSize &&
      this.#currentSize.cols === size.cols &&
      this.#currentSize.rows === size.rows
    ) {
      return;
    }
    this.#currentSize = size;
    this.#pty?.resize(size.cols, size.rows);
    this.#buffer?.resize(size.cols, size.rows);
  }

  /**
   * Guarantee a SIGWINCH even when the winsize is unchanged: bounce the row
   * count by one and back. This is the standard reconnect-redraw trick
   * (tmux/screen do the same) — Linux only raises SIGWINCH on an actual
   * winsize *change*, so a no-op resize would leave a TUI un-repainted.
   */
  #forceRedraw(size: TerminalSize): void {
    if (!this.#pty) return;
    const transientRows = size.rows === 1 ? size.rows + 1 : size.rows - 1;
    this.#buffer?.resize(size.cols, size.rows);
    this.#pty.resize(size.cols, transientRows);
    this.#pty.resize(size.cols, size.rows);
    this.#currentSize = size;
  }

  #handleExit(result: PtySessionExit): void {
    if (this.#status === 'disposed' || this.#exitResult) return;
    this.#exitResult = result;
    this.#status = 'exited';
    this.#queue?.close();
    // Keep the buffer so a snapshot taken after exit still shows the final
    // screen; dispose() releases it. Fan-out stops (no more pty data).
    for (const cb of [...this.#exitHooks]) {
      try {
        cb(result);
      } catch (err) {
        this.#logger.warn(
          `PtySession ${this.sessionId}: onExit hook threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    this.#exitHooks.clear();
  }
}
