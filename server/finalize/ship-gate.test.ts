import { describe, expect, it, vi } from 'vitest';
import { evaluateFinalizeShipGate, findLatestFinalizeRunForHead } from './ship-gate.js';
import { computeIdempotencyKey } from './finalize-keys.js';
import type { FinalizeRunRow, SessionRow } from '../types.js';

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-1',
    agent_id: 'agent-1',
    worktree_path: '/wt',
    worktree_branch: 'feature/x',
    ...overrides,
  } as SessionRow;
}

describe('evaluateFinalizeShipGate', () => {
  it('allows legacy ship when no ci.yaml', async () => {
    const gate = await evaluateFinalizeShipGate(
      {
        stmts: {
          getActiveFinalizeRunForSession: { get: vi.fn() },
          getFinalizeRunByIdempotencyKey: { get: vi.fn() },
        } as never,
        ciConfigExists: async () => false,
      },
      { session: session(), projectId: 'proj', headSha: 'abc' },
    );
    expect(gate.allowed).toBe(true);
    expect(gate.code).toBe('no_finalize_config');
  });

  it('blocks direct PR when ci.yaml exists and no finalize run', async () => {
    const gate = await evaluateFinalizeShipGate(
      {
        stmts: {
          getActiveFinalizeRunForSession: { get: vi.fn(() => undefined) },
          getFinalizeRunByIdempotencyKey: { get: vi.fn(() => undefined) },
        } as never,
        ciConfigExists: async () => true,
      },
      { session: session(), projectId: 'proj', headSha: 'abc123' },
    );
    expect(gate.allowed).toBe(false);
    expect(gate.code).toBe('must_use_finalize');
  });

  it('blocks when finalize failed for this head', async () => {
    const gate = await evaluateFinalizeShipGate(
      {
        stmts: {
          getActiveFinalizeRunForSession: { get: vi.fn(() => undefined) },
          getFinalizeRunByIdempotencyKey: {
            get: vi.fn(() => ({
              id: 'run-1',
              status: 'failed',
              failure_reason: 'review_failed',
            })),
          },
        } as never,
        ciConfigExists: async () => true,
      },
      { session: session(), projectId: 'proj', headSha: 'abc123' },
    );
    expect(gate.allowed).toBe(false);
    expect(gate.code).toBe('failed');
    expect(gate.failure_reason).toBe('review_failed');
  });

  it('allows when finalize already pushed', async () => {
    const gate = await evaluateFinalizeShipGate(
      {
        stmts: {
          getActiveFinalizeRunForSession: { get: vi.fn(() => undefined) },
          getFinalizeRunByIdempotencyKey: {
            get: vi.fn(() => ({ id: 'run-1', status: 'pushed', failure_reason: null })),
          },
        } as never,
        ciConfigExists: async () => true,
      },
      { session: session(), projectId: 'proj', headSha: 'abc123' },
    );
    expect(gate.allowed).toBe(true);
    expect(gate.code).toBe('allowed');
  });

  it('allows git push to attach to an already-open PR (no finalize run needed)', async () => {
    const stmts = {
      // Should not even be consulted — short-circuits on existing PR.
      getActiveFinalizeRunForSession: { get: vi.fn(() => undefined) },
      getFinalizeRunByIdempotencyKey: { get: vi.fn(() => undefined) },
    };
    const gate = await evaluateFinalizeShipGate(
      { stmts: stmts as never, ciConfigExists: async () => true },
      {
        session: session(),
        projectId: 'proj',
        headSha: 'abc123',
        action: 'git_push',
        existingPrUrl: 'https://github.com/o/r/pull/42',
      },
    );
    expect(gate.allowed).toBe(true);
    expect(gate.code).toBe('existing_pr');
    expect(gate.message).toContain('pull/42');
    expect(stmts.getFinalizeRunByIdempotencyKey.get).not.toHaveBeenCalled();
  });

  it('still blocks gh pr create when a PR is already open (no duplicate)', async () => {
    const gate = await evaluateFinalizeShipGate(
      {
        stmts: {
          getActiveFinalizeRunForSession: { get: vi.fn(() => undefined) },
          getFinalizeRunByIdempotencyKey: { get: vi.fn(() => undefined) },
        } as never,
        ciConfigExists: async () => true,
      },
      {
        session: session(),
        projectId: 'proj',
        headSha: 'abc123',
        action: 'gh_pr_create',
        existingPrUrl: 'https://github.com/o/r/pull/42',
      },
    );
    expect(gate.allowed).toBe(false);
    expect(gate.code).toBe('existing_pr');
    expect(gate.message).toContain('duplicate');
  });

  it('reads the latest re-run attempt for the head, not the stale attempt-1 row', async () => {
    // A failed attempt-1 run plus a passing attempt-2 re-run on the same head.
    // The gate must reflect the newest attempt (ready_to_push), not the old fail.
    const rows: Record<string, FinalizeRunRow> = {
      [computeIdempotencyKey({ projectId: 'proj', branch: 'feature/x', headSha: 'abc123' })]: {
        id: 'run-1',
        status: 'failed',
        failure_reason: 'tests_failed',
      } as FinalizeRunRow,
      [computeIdempotencyKey({
        projectId: 'proj',
        branch: 'feature/x',
        headSha: 'abc123',
        attempt: 2,
      })]: { id: 'run-2', status: 'ready_to_push', failure_reason: null } as FinalizeRunRow,
    };
    const gate = await evaluateFinalizeShipGate(
      {
        stmts: {
          getActiveFinalizeRunForSession: { get: vi.fn(() => undefined) },
          getFinalizeRunByIdempotencyKey: { get: vi.fn((key: string) => rows[key]) },
        } as never,
        ciConfigExists: async () => true,
      },
      { session: session(), projectId: 'proj', headSha: 'abc123' },
    );
    expect(gate.allowed).toBe(false);
    expect(gate.code).toBe('must_use_finalize');
    expect(gate.run_id).toBe('run-2');
    // Host-neutral wording — the Push button itself carries the host label.
    expect(gate.message).toContain('click **Push** on the session');
  });

  it('gates on a failed re-run even when an earlier attempt reached ready_to_push', async () => {
    // Append-only rerun model: attempt 1 was ready_to_push, then a manual
    // re-run (attempt 2) FAILED. Shipping must be gated on attempt 2, not the
    // stale attempt-1 success — the newest attempt for the head wins.
    const rows: Record<string, FinalizeRunRow> = {
      [computeIdempotencyKey({ projectId: 'proj', branch: 'feature/x', headSha: 'abc123' })]: {
        id: 'run-1',
        status: 'ready_to_push',
        failure_reason: null,
      } as FinalizeRunRow,
      [computeIdempotencyKey({
        projectId: 'proj',
        branch: 'feature/x',
        headSha: 'abc123',
        attempt: 2,
      })]: { id: 'run-2', status: 'failed', failure_reason: 'tests_failed' } as FinalizeRunRow,
    };
    const gate = await evaluateFinalizeShipGate(
      {
        stmts: {
          getActiveFinalizeRunForSession: { get: vi.fn(() => undefined) },
          getFinalizeRunByIdempotencyKey: { get: vi.fn((key: string) => rows[key]) },
        } as never,
        ciConfigExists: async () => true,
      },
      { session: session(), projectId: 'proj', headSha: 'abc123' },
    );
    expect(gate.allowed).toBe(false);
    expect(gate.code).toBe('failed');
    expect(gate.run_id).toBe('run-2');
    expect(gate.failure_reason).toBe('tests_failed');
  });

  it('gates on an in-flight re-run even when an earlier attempt reached ready_to_push', async () => {
    // attempt 1 ready_to_push, attempt 2 still running. The session-level
    // active check may not see this head's run (it is session-scoped), so the
    // attempt walk itself must surface the newest attempt as in_flight.
    const rows: Record<string, FinalizeRunRow> = {
      [computeIdempotencyKey({ projectId: 'proj', branch: 'feature/x', headSha: 'abc123' })]: {
        id: 'run-1',
        status: 'ready_to_push',
        failure_reason: null,
      } as FinalizeRunRow,
      [computeIdempotencyKey({
        projectId: 'proj',
        branch: 'feature/x',
        headSha: 'abc123',
        attempt: 2,
      })]: { id: 'run-2', status: 'running', failure_reason: null } as FinalizeRunRow,
    };
    const gate = await evaluateFinalizeShipGate(
      {
        stmts: {
          // Session-level active probe misses this head's run on purpose.
          getActiveFinalizeRunForSession: { get: vi.fn(() => undefined) },
          getFinalizeRunByIdempotencyKey: { get: vi.fn((key: string) => rows[key]) },
        } as never,
        ciConfigExists: async () => true,
      },
      { session: session(), projectId: 'proj', headSha: 'abc123' },
    );
    expect(gate.allowed).toBe(false);
    expect(gate.code).toBe('in_flight');
    expect(gate.run_id).toBe('run-2');
  });

  it('falls back to finalize gating for git push when no PR exists', async () => {
    const gate = await evaluateFinalizeShipGate(
      {
        stmts: {
          getActiveFinalizeRunForSession: { get: vi.fn(() => undefined) },
          getFinalizeRunByIdempotencyKey: { get: vi.fn(() => undefined) },
        } as never,
        ciConfigExists: async () => true,
      },
      {
        session: session(),
        projectId: 'proj',
        headSha: 'abc123',
        action: 'git_push',
        existingPrUrl: null,
      },
    );
    expect(gate.allowed).toBe(false);
    expect(gate.code).toBe('must_use_finalize');
  });
});

describe('findLatestFinalizeRunForHead', () => {
  const head = { projectId: 'proj', branch: 'feature/x', headSha: 'abc123' };
  const keyAt = (attempt: number) =>
    computeIdempotencyKey({ ...head, attempt: attempt === 1 ? undefined : attempt });
  const lookupFrom =
    (rows: Record<number, FinalizeRunRow>) =>
    (key: string): FinalizeRunRow | undefined => {
      for (const [attempt, row] of Object.entries(rows)) {
        if (key === keyAt(Number(attempt))) return row;
      }
      return undefined;
    };

  it('returns undefined when no attempt exists', () => {
    expect(findLatestFinalizeRunForHead(lookupFrom({}), head)).toBeUndefined();
  });

  it('returns the only attempt when a single run exists', () => {
    const r1 = { id: 'r1', status: 'failed' } as FinalizeRunRow;
    expect(findLatestFinalizeRunForHead(lookupFrom({ 1: r1 }), head)).toBe(r1);
  });

  it('returns the HIGHEST attempt regardless of earlier statuses (newest wins)', () => {
    // attempt 1 ready_to_push must NOT win over a later attempt.
    const r1 = { id: 'r1', status: 'ready_to_push' } as FinalizeRunRow;
    const r2 = { id: 'r2', status: 'failed' } as FinalizeRunRow;
    const r3 = { id: 'r3', status: 'running' } as FinalizeRunRow;
    expect(findLatestFinalizeRunForHead(lookupFrom({ 1: r1, 2: r2, 3: r3 }), head)).toBe(r3);
  });

  it('stops at the first gap (contiguous attempts)', () => {
    const r1 = { id: 'r1', status: 'failed' } as FinalizeRunRow;
    // attempt 3 present but attempt 2 missing → walk stops at the gap, returns r1.
    const r3 = { id: 'r3', status: 'ready_to_push' } as FinalizeRunRow;
    expect(findLatestFinalizeRunForHead(lookupFrom({ 1: r1, 3: r3 }), head)).toBe(r1);
  });

  it('does not spin when a lookup ignores the attempt segment (same-row guard)', () => {
    const r1 = { id: 'r1', status: 'ready_to_push' } as FinalizeRunRow;
    let calls = 0;
    const lookup = () => {
      calls++;
      return r1;
    };
    expect(findLatestFinalizeRunForHead(lookup, head)).toBe(r1);
    // attempt 1 sets latest, attempt 2 repeats the id → break. No cap-length spin.
    expect(calls).toBe(2);
  });
});
