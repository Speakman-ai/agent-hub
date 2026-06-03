/**
 * runner-job-channel.ts — in-process bridge between the remote RunnerBackend and
 * the agent's HTTP transport, one per leased job.
 *
 * The backend pushes outbound directives (run_step / cancel / finish) and reads
 * back step output; the routes layer (the agent's polls/posts) drives the
 * inbound side. Keeping this transport-agnostic means the same channel works
 * whether the agent talks HTTP long-poll (today) or WebSocket (later).
 *
 *   backend.acquire  → createJobChannel(jobId) → await ready (agent attached)
 *   spawnStep(step)  → channel.runStep() → RemoteSpawnedStep
 *   agent poll       → channel.nextDirective()  (long-poll)
 *   agent log post   → channel.onLog()    → RemoteSpawnedStep.feed()
 *   agent result post→ channel.onStepResult() → RemoteSpawnedStep.exit() → close
 *   lease.release    → channel.finish() + dispose
 */
import { RemoteSpawnedStep, type RemoteStepSink } from './remote-spawned-step.js';

export type RunnerDirective =
  | { type: 'run_step'; stepIndex: number; run: string; env: Record<string, string> }
  | { type: 'cancel'; stepIndex: number; signal?: string }
  | { type: 'finish' };

export class RunnerJobChannel implements RemoteStepSink {
  readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private attached = false;
  private disposed = false;

  private readonly outbound: RunnerDirective[] = [];
  private directiveWaiter: ((d: RunnerDirective | null) => void) | null = null;
  private readonly steps = new Map<number, RemoteSpawnedStep>();

  constructor(readonly jobId: string) {
    this.ready = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
  }

  /** Called by the routes layer when the agent first polls — the runner is live. */
  attach(): void {
    if (!this.attached) {
      this.attached = true;
      this.readyResolve();
    }
  }

  get isAttached(): boolean {
    return this.attached;
  }

  // ── Backend → agent ────────────────────────────────────────────────────

  /** Queue a step for the agent and return its SpawnedStep handle. */
  runStep(stepIndex: number, run: string, env: Record<string, string>): RemoteSpawnedStep {
    const step = new RemoteSpawnedStep(stepIndex, this);
    this.steps.set(stepIndex, step);
    this.pushDirective({ type: 'run_step', stepIndex, run, env });
    return step;
  }

  /** RemoteStepSink: SpawnedStep.kill() → ask the agent to cancel the step. */
  cancelStep(stepIndex: number, signal?: NodeJS.Signals): void {
    this.pushDirective({ type: 'cancel', stepIndex, signal });
  }

  /** Tell the agent the job is done so it tears down and exits. */
  finish(): void {
    this.pushDirective({ type: 'finish' });
  }

  private pushDirective(d: RunnerDirective): void {
    if (this.directiveWaiter) {
      const w = this.directiveWaiter;
      this.directiveWaiter = null;
      w(d);
    } else {
      this.outbound.push(d);
    }
  }

  /**
   * Long-poll for the next directive (the agent's poll endpoint). Resolves with a
   * directive immediately if one is queued, otherwise after `timeoutMs` with null
   * (the agent re-polls). The first poll attaches the channel.
   */
  nextDirective(timeoutMs: number): Promise<RunnerDirective | null> {
    this.attach();
    const queued = this.outbound.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.directiveWaiter === settle) this.directiveWaiter = null;
        resolve(null);
      }, timeoutMs);
      const settle = (d: RunnerDirective | null): void => {
        clearTimeout(timer);
        resolve(d);
      };
      this.directiveWaiter = settle;
    });
  }

  // ── Agent → backend ────────────────────────────────────────────────────

  onLog(stepIndex: number, stream: 'stdout' | 'stderr', data: string): void {
    this.steps.get(stepIndex)?.feed(stream, data);
  }

  onStepResult(stepIndex: number, exitCode: number | null): void {
    this.steps.get(stepIndex)?.exit(exitCode);
  }

  /** Agent reported the whole job ended (teardown done) — settle any stragglers. */
  onFinish(): void {
    for (const step of this.steps.values()) step.exit(null);
  }

  /** Transport dropped / agent lost: fail any unsettled steps so step-runner unblocks. */
  fail(err: Error): void {
    for (const step of this.steps.values()) step.fail(err);
    if (this.directiveWaiter) {
      const w = this.directiveWaiter;
      this.directiveWaiter = null;
      w(null);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.steps.clear();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}

// ── Process-wide registry (the bridge both backend and routes look up) ──────
const channels = new Map<string, RunnerJobChannel>();

export function createJobChannel(jobId: string): RunnerJobChannel {
  const ch = new RunnerJobChannel(jobId);
  channels.set(jobId, ch);
  return ch;
}

export function getJobChannel(jobId: string): RunnerJobChannel | undefined {
  return channels.get(jobId);
}

export function removeJobChannel(jobId: string): void {
  const ch = channels.get(jobId);
  if (ch) ch.dispose();
  channels.delete(jobId);
}
