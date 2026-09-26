/**
 * Bounded admission for memory-heavy request handlers.
 *
 * A gate admits at most `maxActive` holders at once and lets at most
 * `maxQueued` more wait, each for at most `maxWaitMs`. Anything beyond that is
 * rejected immediately with a retryable error.
 *
 * `admitted()` takes a slot *before* the body parser runs and gives it back
 * only after the handler's work has settled. A waiting request holds only its
 * socket (TCP backpressure keeps the body with the client), and an admitted
 * one keeps its slot until its bytes are really released, so retained upload
 * memory is capped at `maxActive × body limit` however clients behave.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface AdmissionGateOptions {
  name: string;
  maxActive: number;
  maxQueued: number;
  maxWaitMs: number;
}

export class AdmissionRejectedError extends Error {
  constructor(
    message: string,
    readonly reason: 'queue_full' | 'wait_timeout' | 'aborted',
    readonly retryAfterSec: number,
  ) {
    super(message);
    this.name = 'AdmissionRejectedError';
  }
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export class AdmissionGate {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(readonly opts: AdmissionGateOptions) {}

  get stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.waiters.length };
  }

  private retryAfter(): number {
    return Math.max(1, Math.ceil(this.opts.maxWaitMs / 1000));
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.admitNext();
    };
  }

  private admitNext(): void {
    while (this.active < this.opts.maxActive && this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      clearTimeout(w.timer);
      if (w.onAbort) w.signal?.removeEventListener('abort', w.onAbort);
      this.active++;
      w.resolve(this.makeRelease());
    }
  }

  private dropWaiter(w: Waiter): boolean {
    const i = this.waiters.indexOf(w);
    if (i < 0) return false;
    this.waiters.splice(i, 1);
    clearTimeout(w.timer);
    if (w.onAbort) w.signal?.removeEventListener('abort', w.onAbort);
    return true;
  }

  /** Resolve with a release function once admitted; reject if full, timed out, or aborted. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new AdmissionRejectedError('Request cancelled', 'aborted', 0));
    }
    if (this.active < this.opts.maxActive) {
      this.active++;
      return Promise.resolve(this.makeRelease());
    }
    if (this.waiters.length >= this.opts.maxQueued) {
      return Promise.reject(
        new AdmissionRejectedError(
          `${this.opts.name} is busy; try again shortly`,
          'queue_full',
          this.retryAfter(),
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        resolve,
        reject,
        signal,
        timer: setTimeout(() => {
          if (this.dropWaiter(w)) {
            reject(
              new AdmissionRejectedError(
                `${this.opts.name} is busy; try again shortly`,
                'wait_timeout',
                this.retryAfter(),
              ),
            );
          }
        }, this.opts.maxWaitMs),
      };
      if (signal) {
        w.onAbort = () => {
          if (this.dropWaiter(w)) {
            reject(new AdmissionRejectedError('Request cancelled', 'aborted', 0));
          }
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      this.waiters.push(w);
    });
  }

  /** Run `fn` while holding a slot. */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** 503 + Retry-After body for a rejected admission. */
export function sendAdmissionRejected(res: Response, err: AdmissionRejectedError): void {
  if (res.headersSent || res.writableEnded) return;
  res.setHeader('Retry-After', String(err.retryAfterSec));
  res.status(503).json({ error: err.message, code: 'busy', retryAfter: err.retryAfterSec });
}

export type AdmittedHandler = (req: Request, res: Response, signal: AbortSignal) => Promise<void>;

function runStep(step: RequestHandler, req: Request, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    step(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
  });
}

/**
 * Run `steps` (e.g. the body parser) and then `handler` while holding a gate
 * slot. The slot is released only in a `finally` after all of that work has
 * settled, never when the socket closes: a client that disconnects mid-work
 * aborts `signal` so cooperative work can stop early, but the slot (and the
 * memory it stands for) stays accounted until the work actually ends.
 *
 * A client that disconnects while still queued simply leaves the queue.
 */
export function admitted(
  gate: AdmissionGate,
  steps: RequestHandler[],
  handler: AdmittedHandler,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    gate.acquire(controller.signal).then(
      async (release) => {
        try {
          for (const step of steps) await runStep(step, req, res);
          if (controller.signal.aborted) return;
          await handler(req, res, controller.signal);
        } catch (err) {
          if (!controller.signal.aborted && !res.headersSent) next(err);
        } finally {
          release();
        }
      },
      (err: unknown) => {
        if (err instanceof AdmissionRejectedError) {
          if (err.reason === 'aborted') return;
          // Close the connection so the unread body never lands on the heap.
          res.setHeader('Connection', 'close');
          sendAdmissionRejected(res, err);
          return;
        }
        next(err);
      },
    );
  };
}

/** Error thrown by cooperative work that noticed its request was cancelled. */
export class RequestCancelledError extends Error {
  constructor() {
    super('Request cancelled');
    this.name = 'RequestCancelledError';
  }
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RequestCancelledError();
}
