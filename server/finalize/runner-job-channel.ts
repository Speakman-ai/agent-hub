/**
 * runner-job-channel.ts — in-process bridge between the remote RunnerBackend and
 * the agent's HTTP transport, one per leased job.
 *
 * The backend pushes outbound directives (run_step / cancel / finish) and reads
 * back step output; the routes layer (the agent's polls/posts) drives the
 * inbound side. Keeping this transport-agnostic means the same channel works
 * whether the agent talks HTTP long-poll (today) or WebSocket (later).
 *
 *   backend.acquire  → createJobChannel(jobId) → await ready (agent claimed)
 *   spawnStep(step)  → channel.runStep() → RemoteSpawnedStep
 *   agent poll       → channel.nextDirective()  (long-poll; also attaches)
 *   agent log post   → channel.onLog()    → RemoteSpawnedStep.feed()
 *   agent result post→ channel.onStepResult() → RemoteSpawnedStep.exit() → close
 *   lease.release    → channel.finish() + dispose
 *
 * `ready` settles on claim (routes attach) so Hub acquire is not blocked on
 * worktree/DinD bring-up. Poll still calls attach() (idempotent) for tests /
 * backends that attach without going through /claim.
 */
import { RemoteSpawnedStep, type RemoteStepSink } from './remote-spawned-step.js';

export type RunnerDirective =
  | {
      type: 'run_step';
      stepIndex: number;
      run: string;
      env: Record<string, string>;
      /**
       * Hard wall-clock cap (ms) the AGENT enforces locally on this step's
       * container exec. The Hub already computes this per step
       * (`min(remainingBudget, STEP_SPAWN_HARD_TIMEOUT_MS)`); carrying it in the
       * directive makes it the single source of truth. The agent kills the exec
       * and tears the container down when it lapses, so a hung or runaway remote
       * step can never outlive its budget — the Hub-side `kill()` only QUEUES a
       * `cancel` the busy agent can't read mid-step, so without this an unbounded
       * step pins the agent in `execStep` forever while its heartbeat keeps the
       * lease fresh (the reaper never fires). Omitted → the agent's own default
       * ceiling applies (it never runs a step unbounded).
       */
      deadlineMs?: number;
    }
  | { type: 'cancel'; stepIndex: number; signal?: string }
  | { type: 'finish' };

export class RunnerJobChannel implements RemoteStepSink {
  /**
   * Resolves when the agent attaches (claim-time, or first poll as a fallback);
   * REJECTS if the channel fails before any attach (e.g. claim never completed
   * but the row was marked lost). The acquire-phase `Promise.race` in the
   * remote backend awaits this — without the reject path a pre-attach loss would
   * keep that race pending until its timeout (≈ the whole run budget), stranding
   * the Finalize run even though the lease reaper already marked the job `lost`.
   */
  readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (err: Error) => void;
  private attached = false;
  /** True once `ready` has settled (resolved via attach OR rejected via fail). */
  private settled = false;
  private disposed = false;

  private readonly outbound: RunnerDirective[] = [];
  private directiveWaiter: ((d: RunnerDirective | null) => void) | null = null;
  private readonly steps = new Map<number, RemoteSpawnedStep>();

  constructor(readonly jobId: string) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // The remote backend is the normal awaiter, but a channel can fail() with no
    // one yet awaiting `ready` (e.g. reaper fires between createJobChannel and the
    // acquire race). Attach a no-op catch so that rejection never surfaces as an
    // unhandledRejection; real awaiters still observe it via their own handlers.
    this.ready.catch(() => {});
  }

  /** Called when a live agent owns the job (claim) or first polls — Hub may proceed. */
  attach(): void {
    if (!this.settled) {
      this.attached = true;
      this.settled = true;
      this.readyResolve();
    }
  }

  get isAttached(): boolean {
    return this.attached;
  }

  // ── Backend → agent ────────────────────────────────────────────────────

  /** Queue a step for the agent and return its SpawnedStep handle. */
  runStep(
    stepIndex: number,
    run: string,
    env: Record<string, string>,
    deadlineMs?: number,
  ): RemoteSpawnedStep {
    const step = new RemoteSpawnedStep(stepIndex, this);
    this.steps.set(stepIndex, step);
    this.pushDirective({
      type: 'run_step',
      stepIndex,
      run,
      env,
      ...(typeof deadlineMs === 'number' && deadlineMs > 0 ? { deadlineMs } : {}),
    });
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
    // If the agent died before it ever attached, settle `ready` by rejecting it so
    // the acquire-phase wait unblocks immediately (→ infra_error → retry on a fresh
    // agent) instead of hanging until the acquire timeout. After a real attach this
    // is a no-op: `ready` already resolved and in-flight steps carry the failure.
    if (!this.settled) {
      this.settled = true;
      this.readyReject(err);
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
