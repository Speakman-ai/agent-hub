import { describe, it, expect, vi } from 'vitest';
import {
  acquireRunnerWithRetry,
  isRetryableAcquireError,
  resolveDeployAcquireAttempts,
  resolveDeployAcquireBackoffMs,
  DEFAULT_DEPLOY_ACQUIRE_ATTEMPTS,
  DEFAULT_DEPLOY_ACQUIRE_BACKOFF_MS,
} from './deploy-acquire-retry.js';
import type { JobClaimSpec, RunnerBackend, RunnerLease } from '../finalize/runner-backend.js';

const SPEC = { jobId: 'production', runId: 'dep-1' } as unknown as JobClaimSpec;
const LEASE = { spawnStep: vi.fn(), release: vi.fn() } as unknown as RunnerLease;

function backendThatFailsThenSucceeds(errors: Error[]): {
  backend: RunnerBackend;
  calls: () => number;
} {
  let call = 0;
  const backend: RunnerBackend = {
    kind: 'fake',
    async acquire() {
      const err = errors[call++];
      if (err) throw err;
      return LEASE;
    },
  };
  return { backend, calls: () => call };
}

const lostBeforeAttach = () =>
  new Error(
    'runner-agent lost before attach for job production (abc): runner agent lost — ' +
      'lease expired with no heartbeat',
  );

describe('isRetryableAcquireError', () => {
  it('treats a lost-before-attach loss as transient (retryable)', () => {
    expect(isRetryableAcquireError(lostBeforeAttach())).toBe(true);
  });

  it('treats a no-agent-claimed timeout as transient (retryable)', () => {
    expect(
      isRetryableAcquireError(
        new Error('no runner-agent claimed job production (abc) within 5000ms'),
      ),
    ).toBe(true);
  });

  it('treats an unknown/novel acquire error as transient (retryable)', () => {
    expect(isRetryableAcquireError(new Error('something new the fleet did'))).toBe(true);
    expect(isRetryableAcquireError('a raw string error')).toBe(true);
  });

  it('treats a deterministic worktree-bundle failure as NON-retryable', () => {
    expect(isRetryableAcquireError(new Error('fatal: Refusing to create empty bundle'))).toBe(
      false,
    );
  });
});

describe('acquireRunnerWithRetry', () => {
  it('recovers when a transient loss precedes a successful acquire', async () => {
    const { backend, calls } = backendThatFailsThenSucceeds([lostBeforeAttach()]);
    const onRetry = vi.fn();
    const lease = await acquireRunnerWithRetry(backend, SPEC, {
      attempts: 3,
      backoffMs: 0,
      sleep: async () => {},
      onRetry,
    });
    expect(lease).toBe(LEASE);
    expect(calls()).toBe(2); // failed once, succeeded on the retry
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, 3, expect.stringContaining('lost before attach'));
  });

  it('re-throws the last error after exhausting all attempts on a persistent loss', async () => {
    const errs = [lostBeforeAttach(), lostBeforeAttach(), lostBeforeAttach()];
    const { backend, calls } = backendThatFailsThenSucceeds(errs);
    await expect(
      acquireRunnerWithRetry(backend, SPEC, { attempts: 3, backoffMs: 0, sleep: async () => {} }),
    ).rejects.toThrow('lost before attach');
    expect(calls()).toBe(3); // exactly `attempts` tries, no more
  });

  it('does NOT retry a deterministic worktree-bundle failure (fails fast)', async () => {
    const { backend, calls } = backendThatFailsThenSucceeds([
      new Error('fatal: Refusing to create empty bundle'),
    ]);
    const onRetry = vi.fn();
    await expect(
      acquireRunnerWithRetry(backend, SPEC, {
        attempts: 5,
        backoffMs: 0,
        sleep: async () => {},
        onRetry,
      }),
    ).rejects.toThrow('Refusing to create empty bundle');
    expect(calls()).toBe(1); // one attempt only — no retry
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('stops retrying when the deployment is cancelled mid-flight', async () => {
    const errs = [lostBeforeAttach(), lostBeforeAttach(), lostBeforeAttach()];
    const { backend, calls } = backendThatFailsThenSucceeds(errs);
    let cancelled = false;
    await expect(
      acquireRunnerWithRetry(backend, SPEC, {
        attempts: 5,
        backoffMs: 0,
        sleep: async () => {},
        // Cancel arrives right after the first failure (before the retry).
        onRetry: () => {
          cancelled = true;
        },
        isCancelled: () => cancelled,
      }),
    ).rejects.toThrow('lost before attach');
    // Attempt 1 fails → cancel flips → next iteration's pre-attempt guard throws
    // before a second acquire.
    expect(calls()).toBe(1);
  });

  it('never calls acquire when the deployment is already cancelled at entry', async () => {
    const { backend, calls } = backendThatFailsThenSucceeds([]); // would succeed if called
    const onRetry = vi.fn();
    await expect(
      acquireRunnerWithRetry(backend, SPEC, {
        attempts: 3,
        backoffMs: 0,
        sleep: async () => {},
        isCancelled: () => true, // cancelled before the first attempt
        onRetry,
      }),
    ).rejects.toThrow('deployment cancelled before first attempt');
    // The pre-attempt guard fires before any acquire — no runner is stood up.
    expect(calls()).toBe(0);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('awaits the configured backoff between attempts', async () => {
    const { backend } = backendThatFailsThenSucceeds([lostBeforeAttach()]);
    const sleep = vi.fn(async () => {});
    await acquireRunnerWithRetry(backend, SPEC, { attempts: 2, backoffMs: 1500, sleep });
    expect(sleep).toHaveBeenCalledWith(1500);
  });
});

describe('env resolution', () => {
  it('falls back to defaults when env is empty', () => {
    expect(resolveDeployAcquireAttempts({})).toBe(DEFAULT_DEPLOY_ACQUIRE_ATTEMPTS);
    expect(resolveDeployAcquireBackoffMs({})).toBe(DEFAULT_DEPLOY_ACQUIRE_BACKOFF_MS);
  });

  it('honors valid env overrides', () => {
    expect(resolveDeployAcquireAttempts({ DEPLOY_ACQUIRE_MAX_ATTEMPTS: '5' })).toBe(5);
    expect(resolveDeployAcquireBackoffMs({ DEPLOY_ACQUIRE_BACKOFF_MS: '250' })).toBe(250);
  });

  it('floors attempts at 1 and ignores non-numeric values', () => {
    expect(resolveDeployAcquireAttempts({ DEPLOY_ACQUIRE_MAX_ATTEMPTS: '0' })).toBe(1);
    expect(resolveDeployAcquireAttempts({ DEPLOY_ACQUIRE_MAX_ATTEMPTS: 'nope' })).toBe(
      DEFAULT_DEPLOY_ACQUIRE_ATTEMPTS,
    );
    expect(resolveDeployAcquireBackoffMs({ DEPLOY_ACQUIRE_BACKOFF_MS: '-5' })).toBe(0);
  });
});
