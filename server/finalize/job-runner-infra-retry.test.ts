import { describe, it, expect, vi } from 'vitest';
import { runInstanceWithInfraRetry, MAX_INSTANCE_INFRA_ATTEMPTS } from './job-runner.js';
import type { StepRunStatus } from './step-runner.js';

// Minimal JobInstanceOutcome — the helper only reads result.status + infraErrorDetail.
function outcome(status: StepRunStatus, detail?: string) {
  return {
    instance: {} as never,
    result: {
      status,
      stepResults: [],
      activeSecondsBilled: 0,
      ...(detail ? { infraErrorDetail: detail } : {}),
    },
  } as never;
}

describe('runInstanceWithInfraRetry', () => {
  it('retries an infra_error and returns the next attempt’s success', async () => {
    const runOnce = vi
      .fn()
      .mockResolvedValueOnce(outcome('infra_error', 'lease expired'))
      .mockResolvedValueOnce(outcome('success'));
    const onRetry = vi.fn();
    const res = await runInstanceWithInfraRetry(runOnce, 3, onRetry);
    expect((res as { result: { status: string } }).result.status).toBe('success');
    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, 'lease expired');
  });

  it('exhausts attempts on a persistent infra_error', async () => {
    const runOnce = vi.fn().mockResolvedValue(outcome('infra_error', 'lost'));
    const res = await runInstanceWithInfraRetry(runOnce, 3);
    expect((res as { result: { status: string } }).result.status).toBe('infra_error');
    expect(runOnce).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a real test failure', async () => {
    const runOnce = vi.fn().mockResolvedValue(outcome('failure'));
    const res = await runInstanceWithInfraRetry(runOnce, 3);
    expect((res as { result: { status: string } }).result.status).toBe('failure');
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a genuine timeout', async () => {
    const runOnce = vi.fn().mockResolvedValue(outcome('timeout'));
    const res = await runInstanceWithInfraRetry(runOnce, 3);
    expect((res as { result: { status: string } }).result.status).toBe('timeout');
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it('returns immediately on first-try success and defaults to the module cap', async () => {
    const runOnce = vi.fn().mockResolvedValue(outcome('success'));
    const res = await runInstanceWithInfraRetry(runOnce);
    expect((res as { result: { status: string } }).result.status).toBe('success');
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(MAX_INSTANCE_INFRA_ATTEMPTS).toBeGreaterThanOrEqual(2);
  });
});
