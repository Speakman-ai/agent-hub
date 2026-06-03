import { describe, expect, it, vi } from 'vitest';
import { evaluateFinalizeShipGate } from './ship-gate.js';
import type { SessionRow } from '../types.js';

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
