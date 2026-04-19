/**
 * Tests for the container exit classifier (W1).
 *
 * Exercises:
 *   1. classifyInspect — pure mapping from State.* to ExitReason.kind
 *   2. classifyExit — end-to-end via a mocked DockerRunner, including
 *      the best-effort `remove` call on quota violations
 *   3. isQuotaViolation predicate
 *
 * No real docker is spawned; DockerRunner is the single IO seam.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  classifyInspect,
  classifyExit,
  isQuotaViolation,
  type DockerInspectResult,
  type DockerRunner,
} from './docker-lifecycle.js';

function inspectFixture(overrides: Partial<DockerInspectResult['State']>): DockerInspectResult {
  return {
    Id: 'c-abc123',
    State: {
      Status: 'exited',
      ExitCode: 0,
      OOMKilled: false,
      Error: '',
      FinishedAt: '2026-04-19T12:00:00Z',
      ...overrides,
    },
  };
}

function makeRunner(
  inspect: DockerInspectResult,
  opts: { removeThrows?: boolean } = {},
): DockerRunner & { inspectMock: ReturnType<typeof vi.fn>; removeMock: ReturnType<typeof vi.fn> } {
  const inspectMock = vi.fn().mockResolvedValue(inspect);
  const removeMock = opts.removeThrows
    ? vi.fn().mockRejectedValue(new Error('no such container'))
    : vi.fn().mockResolvedValue(undefined);
  return {
    inspect: inspectMock,
    remove: removeMock,
    inspectMock,
    removeMock,
  };
}

describe('classifyInspect — pure mapping', () => {
  it('detects OOM kill authoritatively via State.OOMKilled', () => {
    const reason = classifyInspect(inspectFixture({ OOMKilled: true, ExitCode: 137 }));
    expect(reason.kind).toBe('oom');
    expect(reason.oomKilled).toBe(true);
    expect(reason.exitCode).toBe(137);
    expect(reason.message).toMatch(/OOM-killed/);
    expect(reason.containerId).toBe('c-abc123');
    expect(reason.finishedAt).toBe('2026-04-19T12:00:00Z');
  });

  it('trusts OOMKilled=true even when ExitCode is atypical', () => {
    // If the kernel says OOM, we say OOM. Don't let a weird exit code
    // (e.g. 0 because the init process caught the signal) mask the
    // actual quota violation.
    const reason = classifyInspect(inspectFixture({ OOMKilled: true, ExitCode: 0 }));
    expect(reason.kind).toBe('oom');
  });

  it('detects pids_limit violation from State.Error text', () => {
    const reason = classifyInspect(
      inspectFixture({
        OOMKilled: false,
        ExitCode: 1,
        Error: 'runtime error: fork/exec: resource temporarily unavailable (EAGAIN)',
      }),
    );
    expect(reason.kind).toBe('pids');
    expect(reason.oomKilled).toBe(false);
    expect(reason.message).toMatch(/pids_limit/);
  });

  it('does not misclassify "pidfile" errors as pids_limit violations', () => {
    const reason = classifyInspect(
      inspectFixture({
        OOMKilled: false,
        ExitCode: 1,
        Error: 'pidfile not found',
      }),
    );
    // "pidfile" contains "pid" as a substring but is unrelated to pids_limit.
    // It should be classified as a crash, not a pids quota violation.
    expect(reason.kind).toBe('crash');
    expect(isQuotaViolation(reason)).toBe(false);
  });

  it('does not misclassify "invalid pid" errors as pids_limit violations', () => {
    const reason = classifyInspect(
      inspectFixture({
        OOMKilled: false,
        ExitCode: 1,
        Error: 'invalid pid 12345',
      }),
    );
    expect(reason.kind).toBe('crash');
  });

  it('classifies exit code 0 with no error as clean', () => {
    const reason = classifyInspect(inspectFixture({ ExitCode: 0 }));
    expect(reason.kind).toBe('clean');
    expect(reason.exitCode).toBe(0);
    expect(reason.message).toMatch(/cleanly/);
  });

  it('classifies a non-zero exit without OOM as crash', () => {
    const reason = classifyInspect(
      inspectFixture({ ExitCode: 2, Error: 'process exited with non-zero status' }),
    );
    expect(reason.kind).toBe('crash');
    expect(reason.oomKilled).toBe(false);
    expect(reason.exitCode).toBe(2);
    expect(reason.message).toContain('process exited');
  });

  it('does not classify 137 as OOM without the OOMKilled flag', () => {
    // Exit 137 is SIGKILL — could be OOM, could be `docker kill` from
    // an operator or reaper. Without the kernel-sourced flag we
    // conservatively call it a crash so we don't wrongly quarantine a
    // slot that the operator themselves killed.
    const reason = classifyInspect(inspectFixture({ ExitCode: 137, OOMKilled: false }));
    expect(reason.kind).toBe('crash');
  });

  it('treats a missing State as a crash with exit -1', () => {
    const reason = classifyInspect({ Id: 'c-missing', State: undefined as never });
    expect(reason.kind).toBe('crash');
    expect(reason.exitCode).toBe(-1);
  });
});

describe('isQuotaViolation predicate', () => {
  it('returns true for oom and pids, false for crash and clean', () => {
    const base = { exitCode: 0, oomKilled: false, message: '', containerId: 'c' };
    expect(isQuotaViolation({ ...base, kind: 'oom', oomKilled: true, exitCode: 137 })).toBe(true);
    expect(isQuotaViolation({ ...base, kind: 'pids' })).toBe(true);
    expect(isQuotaViolation({ ...base, kind: 'crash' })).toBe(false);
    expect(isQuotaViolation({ ...base, kind: 'clean' })).toBe(false);
  });
});

describe('classifyExit — runs via injected DockerRunner', () => {
  it('calls runner.inspect and returns the classified reason', async () => {
    const runner = makeRunner(inspectFixture({ OOMKilled: true, ExitCode: 137 }));
    const reason = await classifyExit('c-abc123', runner);

    expect(runner.inspectMock).toHaveBeenCalledWith('c-abc123');
    expect(reason.kind).toBe('oom');
  });

  it('force-removes the container on a quota violation', async () => {
    // Simulates the full "quota violation" path: OOM kill → inspect →
    // classify → remove so the container doesn't linger consuming disk
    // while the operator reclaims the slot.
    const runner = makeRunner(inspectFixture({ OOMKilled: true, ExitCode: 137 }));
    await classifyExit('c-abc123', runner);

    expect(runner.removeMock).toHaveBeenCalledWith('c-abc123');
  });

  it('does NOT call remove for clean exits', async () => {
    const runner = makeRunner(inspectFixture({ ExitCode: 0 }));
    await classifyExit('c-abc123', runner);

    expect(runner.removeMock).not.toHaveBeenCalled();
  });

  it('does NOT call remove for plain crashes (let the job retry policy decide)', async () => {
    const runner = makeRunner(inspectFixture({ ExitCode: 2, Error: 'segfault' }));
    await classifyExit('c-abc123', runner);

    expect(runner.removeMock).not.toHaveBeenCalled();
  });

  it('swallows remove errors on quota violations — classification still returns', async () => {
    // A best-effort reap: if the container is already gone (e.g. the
    // daemon already GC'd it), classifyExit should still report the
    // structured reason so the allocator can quarantine the slot.
    const runner = makeRunner(inspectFixture({ OOMKilled: true, ExitCode: 137 }), {
      removeThrows: true,
    });
    const reason = await classifyExit('c-abc123', runner);

    expect(reason.kind).toBe('oom');
    expect(runner.removeMock).toHaveBeenCalledTimes(1);
  });
});
