/**
 * PtyWriteQueue — the single-writer funnel in front of a PTY master.
 *
 * Master writes are non-atomic: if two clients (a human and the agent, or
 * two humans) write concurrently their bytes interleave and corrupt the
 * shell's input line. The shared-pty decision resolves this by routing ALL
 * input through one server-side queue at *message granularity* — each
 * `enqueue` is one indivisible unit (the agent injects a command as one
 * whole line incl. the trailing newline; a human's keystroke batch is one
 * unit) and a single drain loop delivers them FIFO. There is never more
 * than one write in flight, so the "reject concurrent master writes"
 * invariant holds by construction: a second drain sees `#draining` and
 * returns immediately rather than racing the first.
 *
 * `pause()`/`resume()` back the agent/human turn-taking rule — the injector
 * pauses the queue while a human is mid-line and resumes at an idle prompt,
 * so an injected command can't land in the middle of typed input.
 */

export type PtyWriter = (data: string) => void | Promise<void>;

export interface PtyWriteQueueDeps {
  /**
   * Sink for one message. Awaited before the next message is written, so a
   * slow (containerized) write can't overlap the following one. A throw is
   * logged and swallowed — one bad write must not wedge the drain loop.
   */
  write: PtyWriter;
  /**
   * Cap on buffered (not-yet-written) messages. A full queue drops the
   * *oldest* pending message (the freshest keystrokes matter most) and
   * counts it in {@link PtyWriteQueue.droppedCount}. Default 1024. `0`
   * disables the bound.
   */
  maxQueued?: number;
  logger?: { warn: (msg: string) => void };
}

export class PtyWriteQueue {
  readonly #write: PtyWriter;
  readonly #maxQueued: number;
  readonly #logger: { warn: (msg: string) => void };

  readonly #queue: string[] = [];
  #draining = false;
  #paused = false;
  #closed = false;
  #dropped = 0;
  /** Resolves when the queue next goes idle (nothing draining/queued). */
  #idleWaiters: Array<() => void> = [];

  constructor(deps: PtyWriteQueueDeps) {
    this.#write = deps.write;
    this.#maxQueued = deps.maxQueued ?? 1024;
    this.#logger = deps.logger ?? { warn: (m) => console.warn(m) };
  }

  /** Buffered messages not yet handed to the writer. */
  get length(): number {
    return this.#queue.length;
  }

  /** True while the single drain loop is actively writing. */
  get isDraining(): boolean {
    return this.#draining;
  }

  get isPaused(): boolean {
    return this.#paused;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  /** Messages discarded by the backpressure bound over this queue's life. */
  get droppedCount(): number {
    return this.#dropped;
  }

  /**
   * Queue one message. Returns false if the queue is closed (write ignored)
   * or the message was dropped for backpressure. An empty string is a
   * no-op that returns true — nothing to serialize, nothing to drop.
   */
  enqueue(data: string): boolean {
    if (this.#closed) return false;
    if (data.length === 0) return true;
    this.#queue.push(data);
    if (this.#maxQueued > 0 && this.#queue.length > this.#maxQueued) {
      // Drop the oldest: newest input reflects the user's current intent.
      this.#queue.shift();
      this.#dropped += 1;
      this.#logger.warn(
        `PtyWriteQueue: backpressure — dropped oldest message (queue > ${this.#maxQueued})`,
      );
      void this.#drain();
      return false;
    }
    void this.#drain();
    return true;
  }

  /** Stop delivering messages after the in-flight write settles. */
  pause(): void {
    this.#paused = true;
  }

  /** Resume delivery and kick the drain loop if anything is queued. */
  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    void this.#drain();
  }

  /**
   * Resolve once the queue is idle: nothing draining and nothing queued.
   * Resolves synchronously-soon when already idle. Never rejects.
   */
  onIdle(): Promise<void> {
    if (!this.#draining && this.#queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  /**
   * Drop every pending message and refuse further writes. Does not wait for
   * the in-flight write — callers dispose the PTY separately. Idempotent.
   */
  close(): void {
    this.#closed = true;
    this.#queue.length = 0;
    this.#settleIdleWaiters();
  }

  async #drain(): Promise<void> {
    // The single-writer guard: a concurrent caller returns here rather than
    // starting a second, interleaving drain.
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (!this.#paused && !this.#closed && this.#queue.length > 0) {
        const message = this.#queue.shift()!;
        try {
          await this.#write(message);
        } catch (err) {
          this.#logger.warn(
            `PtyWriteQueue: write threw, dropping message: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } finally {
      this.#draining = false;
    }
    if (this.#queue.length === 0) this.#settleIdleWaiters();
  }

  #settleIdleWaiters(): void {
    if (this.#idleWaiters.length === 0) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
