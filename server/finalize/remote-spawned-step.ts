/**
 * remote-spawned-step.ts — a SpawnedStep backed by frames arriving from a remote
 * runner-agent instead of a local child process.
 *
 * step-runner.ts treats a step as: read `stdout`/`stderr` data, wait for one
 * `close(code)` (or `error`), and maybe `kill()`. This class satisfies that
 * exact contract: `stdout`/`stderr` are PassThrough streams the transport feeds
 * log frames into, `close` fires once when the agent reports the step's exit
 * code, and `kill()` asks the transport to cancel the step. Honoring this
 * contract precisely is what lets the remote backend reuse step-runner, the
 * scheduler, and all persistence unchanged.
 */
import { PassThrough } from 'stream';
import type { SpawnedStep } from './step-runner.js';

export interface RemoteStepSink {
  /** Ask the remote agent to cancel this step (maps to SpawnedStep.kill). */
  cancelStep(stepIndex: number, signal?: NodeJS.Signals): void;
}

export class RemoteSpawnedStep implements SpawnedStep {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private closeListener?: (code: number | null) => void;
  private errorListener?: (err: Error) => void;
  private settled = false;
  // The agent can report the step's result BEFORE step-runner attaches its
  // 'close'/'error' listener (the directive is delivered to a waiting poll the
  // instant runStep() pushes it, and a fast step's result races back). Buffer the
  // terminal outcome so a late listener still fires — otherwise the close is lost
  // and the step (and the whole run) hangs. (stdout/stderr are PassThroughs, which
  // buffer data on their own, so only the terminal event needs this.)
  private pending?: { kind: 'close'; code: number | null } | { kind: 'error'; err: Error };

  constructor(
    private readonly stepIndex: number,
    private readonly sink: RemoteStepSink,
  ) {}

  on(event: 'close', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'close' | 'error', listener: (arg: never) => void): this {
    if (event === 'close') {
      this.closeListener = listener as (code: number | null) => void;
      if (this.pending?.kind === 'close') {
        const code = this.pending.code;
        this.pending = undefined;
        this.closeListener(code);
      }
    } else {
      this.errorListener = listener as (err: Error) => void;
      if (this.pending?.kind === 'error') {
        const err = this.pending.err;
        this.pending = undefined;
        this.errorListener(err);
      }
    }
    return this;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.sink.cancelStep(this.stepIndex, signal);
    return true;
  }

  /** Feed an inbound log frame (from the agent) into the right stream. */
  feed(stream: 'stdout' | 'stderr', data: string | Buffer): void {
    if (this.settled) return;
    (stream === 'stdout' ? this.stdout : this.stderr).write(data);
  }

  /** Terminal: the agent reported this step's exit code. Fires `close` once. */
  exit(code: number | null): void {
    if (this.settled) return;
    this.settled = true;
    this.stdout.end();
    this.stderr.end();
    if (this.closeListener) this.closeListener(code);
    else this.pending = { kind: 'close', code }; // buffer until listener attaches
  }

  /** Terminal failure (e.g. agent/transport dropped). Fires `error` once. */
  fail(err: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.stdout.end();
    this.stderr.end();
    if (this.errorListener) this.errorListener(err);
    else if (this.closeListener)
      this.closeListener(null); // never leave step-runner hanging
    else this.pending = { kind: 'error', err }; // buffer until a listener attaches
  }
}
