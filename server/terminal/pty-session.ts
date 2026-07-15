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
  /** Shell program. Default: the env's login shell (`SHELL` / `/bin/bash`). */
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
  /** Clock for output-quiescence tracking (agent turn-taking). Default `Date.now`. */
  now?: () => number;
  logger?: { warn: (msg: string) => void };
}

type PtySessionStatus = 'idle' | 'running' | 'exited' | 'disposed';

/**
 * Fold one input write into the "is the current prompt line dirty?" flag —
 * i.e. does the shell's input line hold un-submitted characters a human is
 * still editing? Since client local echo is disabled, EVERY keystroke a human
 * types is written through the PTY, so scanning the input byte stream is a
 * reliable-enough signal without a full terminal model:
 *   - `\n` / `\r` (Enter) submit the line, and Ctrl-C (0x03) / Ctrl-U (0x15)
 *     abort/kill it — all four leave the input line empty ⇒ clean.
 *   - Any other byte is (conservatively) treated as uncommitted input ⇒ dirty.
 * The agent's own inject ends with `\n`, so it always leaves the line clean.
 * Conservative on ambiguous edits (backspace, arrow keys): stays dirty, which
 * only ever *withholds* an inject — never lands one onto a human's line.
 */
export function promptLineDirtyAfterWrite(prevDirty: boolean, data: string): boolean {
  let dirty = prevDirty;
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    if (code === 0x0a || code === 0x0d || code === 0x03 || code === 0x15) {
      dirty = false;
    } else {
      dirty = true;
    }
  }
  return dirty;
}

/** Readiness primitives the agent turn-taking gate reads (a live PtySession
 *  satisfies this, and so do test fakes). */
export interface PromptInjectReadiness {
  isRunning: boolean;
  /** True when no input is queued/draining/paused on the single writer queue. */
  inputQueueIdle: boolean;
  /** True when the input line holds un-submitted characters (human mid-command). */
  promptLineDirty: boolean;
  /** Epoch ms of the last PTY output (or shell start); 0 before the shell runs. */
  lastOutputAt: number;
}

export interface InjectIdleGate {
  idle: boolean;
  /** Human-readable reason when not idle (empty when idle). */
  reason: string;
}

/**
 * The agent turn-taking gate. An inject is allowed only when ALL hold:
 *  1. the shell is running;
 *  2. the single writer queue holds nothing (no keystrokes mid-flight);
 *  3. the input line is clean — no un-submitted human characters (closes the
 *     "human typed half a command then paused past the window" hole that
 *     output-quiescence alone would miss); and
 *  4. the shell has been output-quiet for `quietWindowMs` (approximating an
 *     idle prompt, since a shell prompt can't be parsed reliably).
 *
 * Pure and synchronous, so {@link PtySession.injectAtIdle} can evaluate it and
 * enqueue in one un-interruptible step (no event-loop turn boundary between the
 * check and the write).
 */
export function evaluateInjectIdle(
  view: PromptInjectReadiness,
  now: number,
  quietWindowMs: number,
): InjectIdleGate {
  if (!view.isRunning) {
    return { idle: false, reason: 'The terminal shell is not running.' };
  }
  if (!view.inputQueueIdle) {
    return {
      idle: false,
      reason:
        'Input is already in flight — another write is queued/draining or the ' +
        'terminal is paused. Retry once it settles.',
    };
  }
  if (view.promptLineDirty) {
    return {
      idle: false,
      reason:
        'The prompt line holds un-submitted input — a human is mid-command. ' +
        'Injecting now would append onto their line. Wait until the line is ' +
        'submitted or cleared, then retry.',
    };
  }
  const quietForMs = view.lastOutputAt > 0 ? now - view.lastOutputAt : -1;
  if (quietForMs < quietWindowMs) {
    const since = quietForMs < 0 ? 'has not settled yet' : `was active ${quietForMs}ms ago`;
    return {
      idle: false,
      reason:
        `The shell ${since}; turn-taking waits for a ${quietWindowMs}ms output-quiet ` +
        'window (so an inject cannot land mid-line or mid-command). Retry shortly.',
    };
  }
  return { idle: true, reason: '' };
}

/** Result of an atomic {@link PtySession.injectAtIdle} attempt. */
export type InjectAtIdleResult =
  | { ok: true }
  /** Gate held it back (`deferred: true`) or the queue refused it (false). */
  | { ok: false; deferred: boolean; reason: string };

/** Options for {@link PtySession.injectAtIdle}. */
export interface InjectAtIdleOpts {
  now: number;
  quietWindowMs: number;
}

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
  readonly #now: () => number;
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
  /**
   * Epoch ms of the most recent PTY output (or shell start). Powers the
   * output-quiescence half of the agent turn-taking gate: an injected command
   * only lands once the shell has been quiet for a window, so it can't wedge
   * into a human's in-progress line or a running command's output.
   */
  #lastOutputAtMs = 0;
  /**
   * Whether the shell's input line currently holds un-submitted characters
   * (a human mid-command). Folded from every input write (see
   * {@link promptLineDirtyAfterWrite}). The agent turn-taking gate refuses an
   * inject while this is true, so a paused-but-partial human line can never be
   * appended to — closing the hole where output-quiescence alone would wrongly
   * read a stalled half-typed line as an idle prompt.
   */
  #promptLineDirty = false;

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
    this.#now = deps.now ?? (() => Date.now());
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
    // Treat the shell as "just active" so an agent inject can't fire before the
    // first prompt has had a chance to render.
    this.#lastOutputAtMs = this.#now();
    // Fresh shell → empty input line.
    this.#promptLineDirty = false;
    this.#queue = new PtyWriteQueue({
      write: (data) => pty.write(data),
      maxQueued: this.#writeQueueMaxQueued,
      logger: this.#logger,
    });
    this.#status = 'running';

    pty.onData((data) => {
      // Mirror into scrollback first so a viewer attaching mid-chunk can't
      // miss bytes, then fan out live to every current viewer.
      this.#lastOutputAtMs = this.#now();
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
    const accepted = this.#queue.enqueue(data);
    // Fold this write (human keystrokes OR an agent inject) into the
    // prompt-line-dirty flag ONLY for input the queue actually took. `enqueue`
    // refuses (drops the data entirely) only when the queue is closed; a
    // backpressure `false` still keeps THIS newest message, so the input did
    // reach the queue and must update the flag. Gate on `isClosed` rather than
    // the ambiguous boolean, so a refused write never corrupts turn-taking
    // state (which could otherwise wedge the session dirty forever).
    if (!this.#queue.isClosed) {
      this.#promptLineDirty = promptLineDirtyAfterWrite(this.#promptLineDirty, data);
    }
    return accepted;
  }

  /**
   * Atomic agent turn-taking reservation: evaluate the idle gate AND enqueue
   * the line in ONE synchronous step, so a human keystroke (delivered on a
   * separate event-loop turn — the terminal WS `message` handler) can never
   * interleave between the "is the prompt idle?" check and the write. The tool
   * layer cannot split these across an `await`, which is what makes the
   * turn-taking guarantee hold rather than relying on incidental call ordering.
   *
   * The enqueue folds `promptLineDirty` back to clean (the line ends with a
   * newline), so a follow-up inject won't fire until fresh human input or shell
   * output changes the state again.
   */
  injectAtIdle(line: string, opts: InjectAtIdleOpts): InjectAtIdleResult {
    const gate = evaluateInjectIdle(this, opts.now, opts.quietWindowMs);
    if (!gate.idle) return { ok: false, deferred: true, reason: gate.reason };
    const accepted = this.write(line);
    if (!accepted) {
      return {
        ok: false,
        deferred: false,
        reason: 'the terminal did not accept the command (queue closed or shell exited).',
      };
    }
    return { ok: true };
  }

  /** Epoch ms of the last PTY output (or shell start); 0 before the shell runs. */
  get lastOutputAt(): number {
    return this.#lastOutputAtMs;
  }

  /**
   * True when the shell's input line holds un-submitted characters (a human is
   * mid-command). The agent turn-taking gate refuses an inject while this is
   * set, so an injected command can never be appended onto a partial human
   * line. A non-running shell is reported clean (nothing to protect).
   */
  get promptLineDirty(): boolean {
    return this.#status === 'running' ? this.#promptLineDirty : false;
  }

  /**
   * True when the write queue holds nothing and is neither draining, paused,
   * nor closed — i.e. no input is mid-flight. This is the write-queue half of
   * the agent turn-taking gate (the output-quiescence half is
   * {@link lastOutputAt}). A non-running shell is never input-idle.
   */
  get inputQueueIdle(): boolean {
    const q = this.#queue;
    if (this.#status !== 'running' || !q) return false;
    return !q.isDraining && !q.isPaused && !q.isClosed && q.length === 0;
  }

  /**
   * Serialize the current scrollback for a read-only observer (the agent's
   * ReAct `terminal` read). Unlike {@link attach} this registers no viewer,
   * touches no resize arbiter, and fires no SIGWINCH — it is a pure read. The
   * buffer is flushed first so the snapshot reflects the latest output. Returns
   * `null` when there is no live buffer (shell never started / disposed).
   */
  async readSnapshot(): Promise<string | null> {
    const buffer = this.#buffer;
    if (!buffer) return null;
    await buffer.flush();
    return buffer.serialize();
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
