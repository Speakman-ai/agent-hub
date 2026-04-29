/**
 * Output coalescer — buffers stdout/stderr writes from a spawned process
 * and emits one `stream` frame per channel per ~50 ms window. This caps
 * the per-frame WebSocket overhead at ~20 frames/sec/channel even for
 * processes that print byte-at-a-time, while still keeping the perceived
 * latency below human-noticeable thresholds for chat output.
 *
 * Design notes:
 *  - One coalescer per spawn id; it owns two independent buffers
 *    (stdout, stderr) so a chatty stderr does not block stdout flushes.
 *  - Per-(id, channel) sequence counters live here — every emitted frame
 *    gets `seq = next++`. The control plane uses this to detect drops if
 *    the runner's send buffer overflows mid-frame.
 *  - The flush callback is injected so tests can assert frame timing
 *    without booting a real WS, and so the production spawner can simply
 *    forward to `RunnerClient.send`.
 *  - `flushNow()` is called on process exit to drain any partial buffer
 *    before the `exit` frame is emitted. This guarantees ordered delivery
 *    of (stream*, exit) — the control plane relies on `exit` being the
 *    last frame for a given spawn id.
 *
 * The 50 ms window is a deliberate trade-off: short enough that interactive
 * CLIs feel responsive, long enough to absorb the burst of small writes
 * a typical CLI emits when streaming Claude/Cursor responses through a
 * tty-style pretty-printer.
 */

export const DEFAULT_FLUSH_INTERVAL_MS = 50;

/** Frame payload emitted via the `flush` callback. The runner client
 * wraps this with `{type:'stream', id, ...payload}` before sending. */
export interface CoalescerFrame {
  channel: 'stdout' | 'stderr';
  data: string;
  seq: number;
}

export interface SpawnCoalescerOptions {
  /** Forwarded to every emitted frame so the spawner can address it. */
  spawnId: string;
  /** Called every time a buffer is ready to ship. The coalescer never
   * calls this with an empty `data` string. */
  emit: (frame: CoalescerFrame) => void;
  /** Override the default 50 ms window. Tests use 1 ms to keep them fast. */
  flushIntervalMs?: number;
  /** Test seam — defaults to globalThis.setTimeout. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  /** Test seam — defaults to globalThis.clearTimeout. */
  clearTimeout?: (handle: unknown) => void;
}

interface ChannelState {
  buffer: string;
  /** Next `seq` value to assign. Starts at 0, increments after every emit. */
  nextSeq: number;
  /** Pending flush handle, or null when no flush is scheduled. */
  timer: unknown | null;
}

export class SpawnCoalescer {
  private readonly stdout: ChannelState = { buffer: '', nextSeq: 0, timer: null };
  private readonly stderr: ChannelState = { buffer: '', nextSeq: 0, timer: null };
  private readonly flushIntervalMs: number;
  private readonly setTimeoutImpl: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutImpl: (handle: unknown) => void;
  private closed = false;

  constructor(private readonly opts: SpawnCoalescerOptions) {
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.setTimeoutImpl =
      opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms) as unknown);
    this.clearTimeoutImpl =
      opts.clearTimeout ??
      ((h) => {
        if (h !== null && h !== undefined) clearTimeout(h as ReturnType<typeof setTimeout>);
      });
  }

  /** Append a chunk to the appropriate channel. Schedules a flush if
   * none is pending. Empty strings are ignored to avoid emitting
   * zero-byte frames. */
  write(channel: 'stdout' | 'stderr', data: string): void {
    if (this.closed) return;
    if (data.length === 0) return;
    const state = channel === 'stdout' ? this.stdout : this.stderr;
    state.buffer += data;
    if (state.timer === null) {
      state.timer = this.setTimeoutImpl(() => this.flushChannel(channel), this.flushIntervalMs);
    }
  }

  /** Flush both channels synchronously. Called on process exit so the
   * `exit` frame is preceded by every byte of output. After this returns
   * any further `write()` is a no-op (the coalescer is closed). */
  flushNow(): void {
    if (this.closed) return;
    this.flushChannel('stdout');
    this.flushChannel('stderr');
    this.closed = true;
  }

  /** Test helper — observe how many frames have been emitted on a
   * channel without forcing a flush. */
  getNextSeq(channel: 'stdout' | 'stderr'): number {
    return channel === 'stdout' ? this.stdout.nextSeq : this.stderr.nextSeq;
  }

  private flushChannel(channel: 'stdout' | 'stderr'): void {
    const state = channel === 'stdout' ? this.stdout : this.stderr;
    if (state.timer !== null) {
      this.clearTimeoutImpl(state.timer);
      state.timer = null;
    }
    if (state.buffer.length === 0) return;
    const seq = state.nextSeq;
    state.nextSeq += 1;
    const data = state.buffer;
    state.buffer = '';
    // Emit AFTER mutating state so a re-entrant write() during emit
    // (rare, but possible if the consumer is synchronous) lands in the
    // next window cleanly with seq+1.
    this.opts.emit({ channel, data, seq });
  }
}
