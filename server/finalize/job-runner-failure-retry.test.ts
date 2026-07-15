import { describe, it, expect, vi } from 'vitest';
import { runInstanceWithRetries, MAX_INSTANCE_INFRA_ATTEMPTS } from './job-runner.js';
import type { StepRunStatus } from './step-runner.js';

// Minimal JobInstanceOutcome — the retry driver reads result.status,
// result.failureReason, result.infraErrorDetail, and result.failedStep.name.
function outcome(
  status: StepRunStatus,
  opts: { detail?: string; failureReason?: string; failedStepName?: string } = {},
) {
  return {
    instance: {} as never,
    result: {
      status,
      stepResults: [],
      activeSecondsBilled: 0,
      ...(opts.detail ? { infraErrorDetail: opts.detail } : {}),
      ...(opts.failureReason ? { failureReason: opts.failureReason } : {}),
      ...(opts.failedStepName
        ? { failedStep: { index: 1, name: opts.failedStepName, run: 'x', exitCode: 1 } }
        : {}),
    },
  } as never;
}

const st = (o: unknown) => (o as { result: { status: string } }).result.status;

describe('runInstanceWithRetries — config-driven flaky-test reruns', () => {
  it('re-runs a genuine failure on the same commit and returns the eventual success', async () => {
    const runOnce = vi
      .fn()
      .mockResolvedValueOnce(outcome('failure', { failedStepName: 'Test' }))
      .mockResolvedValueOnce(outcome('failure', { failedStepName: 'Test' }))
      .mockResolvedValueOnce(outcome('success'));
    const onFailureRetry = vi.fn();
    const res = await runInstanceWithRetries(runOnce, {
      maxFailureRetries: 2,
      onFailureRetry,
    });
    expect(st(res)).toBe('success');
    expect(runOnce).toHaveBeenCalledTimes(3); // 1 initial + 2 reruns
    expect(onFailureRetry).toHaveBeenCalledTimes(2);
    expect(onFailureRetry).toHaveBeenNthCalledWith(1, 1, 'Test');
    expect(onFailureRetry).toHaveBeenNthCalledWith(2, 2, 'Test');
  });

  it('exhausts the failure-retry budget and reports the failure', async () => {
    const runOnce = vi.fn().mockResolvedValue(outcome('failure'));
    const res = await runInstanceWithRetries(runOnce, { maxFailureRetries: 2 });
    expect(st(res)).toBe('failure');
    expect(runOnce).toHaveBeenCalledTimes(3); // 1 initial + 2 reruns, all red
  });

  it('does NOT re-run a genuine failure when retries is 0', async () => {
    const runOnce = vi.fn().mockResolvedValue(outcome('failure'));
    const res = await runInstanceWithRetries(runOnce, { maxFailureRetries: 0 });
    expect(st(res)).toBe('failure');
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it('never re-runs a timeout (time-class, not flaky)', async () => {
    const runOnce = vi.fn().mockResolvedValue(outcome('timeout'));
    const res = await runInstanceWithRetries(runOnce, { maxFailureRetries: 3 });
    expect(st(res)).toBe('timeout');
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it('counts the infra and failure budgets independently', async () => {
    // Transient infra flap, then a flaky test failure, then green. Both retry
    // classes must fire without either starving the other.
    const runOnce = vi
      .fn()
      .mockResolvedValueOnce(outcome('infra_error', { detail: 'lease expired' }))
      .mockResolvedValueOnce(outcome('failure', { failedStepName: 'Test' }))
      .mockResolvedValueOnce(outcome('success'));
    const onInfraRetry = vi.fn();
    const onFailureRetry = vi.fn();
    const res = await runInstanceWithRetries(runOnce, {
      maxInfraAttempts: MAX_INSTANCE_INFRA_ATTEMPTS,
      maxFailureRetries: 2,
      onInfraRetry,
      onFailureRetry,
    });
    expect(st(res)).toBe('success');
    expect(runOnce).toHaveBeenCalledTimes(3);
    expect(onInfraRetry).toHaveBeenCalledTimes(1);
    expect(onFailureRetry).toHaveBeenCalledTimes(1);
  });

  it('still short-circuits a DETERMINISTIC infra reason (worktree_bundle_failed)', async () => {
    const runOnce = vi.fn().mockResolvedValue(
      outcome('infra_error', {
        detail: 'Refusing to create empty bundle',
        failureReason: 'worktree_bundle_failed',
      }),
    );
    const res = await runInstanceWithRetries(runOnce, {
      maxInfraAttempts: 3,
      maxFailureRetries: 2,
    });
    expect(st(res)).toBe('infra_error');
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it('returns first-try success without spending any budget', async () => {
    const runOnce = vi.fn().mockResolvedValue(outcome('success'));
    const res = await runInstanceWithRetries(runOnce, { maxFailureRetries: 2 });
    expect(st(res)).toBe('success');
    expect(runOnce).toHaveBeenCalledTimes(1);
  });
});
