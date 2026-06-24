/**
 * Tests for `server/finalize/infra-retry.ts` — the §10 failure-class
 * classifier and one-auto-retry orchestration helpers.
 *
 * Coverage:
 *   - `classifyFailureReason` and `isInfraFailureReason`: every code in
 *     both whitelists, plus unknown / null / empty strings.
 *   - `computeRetryIdempotencyKey`: stable + parent-derived + distinct
 *     from the original `computeIdempotencyKey` shape.
 *   - `openInfraRetryRun`: happy path, idempotent reuse, missing parent,
 *     parent-is-already-a-retry refusal, insert errors.
 *   - `composeInfraTerminalMessageBody`: header + machine code + detail
 *     + escalation hint.
 *   - `postInfraTerminalMessage`: insert + touch + broadcast, no-op
 *     when session is null.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { BroadcastFn, FinalizeRunRow, Stmts } from '../types.js';
import {
  CI_FAILURE_REASONS,
  INFRA_FAILURE_REASONS,
  RECLAIM_FAILURE_REASONS,
  INFRA_TERMINAL_HEADER,
  MAX_INFRA_RETRY_GENERATIONS,
  MAX_RECLAIM_RETRY_GENERATIONS,
  classifyFailureReason,
  composeInfraTerminalMessageBody,
  computeRetryIdempotencyKey,
  getRetryGenerationDepth,
  isInfraFailureReason,
  isReclaimFailureReason,
  openInfraRetryRun,
  postInfraTerminalMessage,
  resolveRetryGenerationCap,
} from './infra-retry.js';
import { computeIdempotencyKey } from './orchestrator.js';

// ─── Helpers ─────────────────────────────────────────────────────────

type RetryStmts = Pick<
  Stmts,
  | 'getFinalizeRun'
  | 'getFinalizeRunByIdempotencyKey'
  | 'insertFinalizeRun'
  | 'addMessage'
  | 'touchSession'
  | 'getMessageById'
>;

function makeStmts(rows: Record<string, Partial<FinalizeRunRow>> = {}): {
  stmts: RetryStmts;
  rowMap: Map<string, Partial<FinalizeRunRow>>;
  byKey: Map<string, Partial<FinalizeRunRow>>;
  inserted: Array<{
    id: string;
    sessionId: string;
    body: string;
    metadata: string | null;
  }>;
  insertCalls: unknown[][];
} {
  const rowMap = new Map(Object.entries(rows));
  const byKey = new Map<string, Partial<FinalizeRunRow>>();
  for (const row of rowMap.values()) {
    if (row.idempotency_key) byKey.set(row.idempotency_key, row);
  }
  const inserted: Array<{
    id: string;
    sessionId: string;
    body: string;
    metadata: string | null;
  }> = [];
  const insertCalls: unknown[][] = [];
  const stmts = {
    getFinalizeRun: {
      get: vi.fn((id: string) => rowMap.get(id)),
    },
    getFinalizeRunByIdempotencyKey: {
      get: vi.fn((key: string) => byKey.get(key)),
    },
    insertFinalizeRun: {
      run: vi.fn((...args: unknown[]) => {
        insertCalls.push(args);
        const [
          id,
          cardId,
          sessionId,
          projectId,
          branch,
          headSha,
          idempotencyKey,
          status,
          phase,
          triggerSource,
          worktreePath,
          triggeredByUserId,
          authorName,
          authorEmail,
          retryOfRunId,
          startedAt,
        ] = args as [
          string,
          string,
          string | null,
          string,
          string,
          string,
          string,
          string,
          string | null,
          string,
          string | null,
          string,
          string,
          string,
          string | null,
          number,
        ];
        if (byKey.has(idempotencyKey)) {
          const err = new Error('UNIQUE constraint failed: finalize_runs.idempotency_key');
          (err as unknown as { code: string }).code = 'SQLITE_CONSTRAINT_UNIQUE';
          throw err;
        }
        const row: Partial<FinalizeRunRow> = {
          id,
          card_id: cardId,
          session_id: sessionId,
          project_id: projectId,
          branch,
          head_sha: headSha,
          idempotency_key: idempotencyKey,
          status: status as FinalizeRunRow['status'],
          phase: phase as FinalizeRunRow['phase'],
          trigger_source: triggerSource as FinalizeRunRow['trigger_source'],
          worktree_path: worktreePath,
          triggered_by_user_id: triggeredByUserId,
          author_name: authorName,
          author_email: authorEmail,
          retry_of_run_id: retryOfRunId,
          active_seconds_consumed: 0,
          started_at: startedAt,
        };
        rowMap.set(id, row);
        byKey.set(idempotencyKey, row);
      }),
    },
    addMessage: {
      run: vi.fn(
        (
          id: string,
          sessionId: string,
          _role: string,
          body: string,
          _engine: unknown,
          _model: unknown,
          _toolCalls: unknown,
          metadata: string | null,
        ) => {
          inserted.push({ id, sessionId, body, metadata });
        },
      ),
    },
    touchSession: { run: vi.fn() },
    getMessageById: {
      get: vi.fn((id: string) => {
        const m = inserted.find((x) => x.id === id);
        if (!m) return undefined;
        return { id: m.id, session_id: m.sessionId };
      }),
    },
  } as unknown as RetryStmts;
  return { stmts, rowMap, byKey, inserted, insertCalls };
}

function makeBroadcast(): { broadcast: BroadcastFn; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const broadcast: BroadcastFn = (data) => {
    calls.push(data);
  };
  return { broadcast, calls };
}

function fakeParentRow(overrides: Partial<FinalizeRunRow> = {}): Partial<FinalizeRunRow> {
  return {
    id: 'parent-run',
    card_id: 'card-1',
    session_id: 'sess-1',
    project_id: 'proj-1',
    branch: 'feature/x',
    head_sha: 'deadbeef',
    idempotency_key: 'orig-key',
    status: 'infra_error',
    trigger_source: 'ui_button',
    worktree_path: '/tmp/wt',
    triggered_by_user_id: 'user-1',
    author_name: 'Test',
    author_email: 'test@example.com',
    retry_of_run_id: null,
    active_seconds_consumed: 600,
    ...overrides,
  };
}

// ─── classifyFailureReason ──────────────────────────────────────────

describe('classifyFailureReason', () => {
  it('returns "infra" for every reason in INFRA_FAILURE_REASONS', () => {
    for (const code of INFRA_FAILURE_REASONS) {
      expect(classifyFailureReason(code)).toBe('infra');
    }
  });

  it('returns "ci" for every reason in CI_FAILURE_REASONS', () => {
    for (const code of CI_FAILURE_REASONS) {
      expect(classifyFailureReason(code)).toBe('ci');
    }
  });

  it('returns "unknown" for null / undefined / empty string', () => {
    expect(classifyFailureReason(null)).toBe('unknown');
    expect(classifyFailureReason(undefined)).toBe('unknown');
    expect(classifyFailureReason('')).toBe('unknown');
  });

  it('returns "unknown" for arbitrary unrecognised codes', () => {
    expect(classifyFailureReason('disk_full')).toBe('unknown');
    expect(classifyFailureReason('flux_capacitor_failure')).toBe('unknown');
    // Case-sensitive — `Worktree_create_failed` is NOT infra.
    expect(classifyFailureReason('Worktree_create_failed')).toBe('unknown');
    // No whitespace trimming.
    expect(classifyFailureReason(' container_unavailable')).toBe('unknown');
  });

  it('INFRA list is the §10 trio plus the reclaim + cancellation classes — no more, no less', () => {
    // Locks the whitelist to prevent accidental drift. If §10 ever
    // gains another infra code, update both the wiki and this test.
    expect([...INFRA_FAILURE_REASONS]).toEqual([
      'worktree_create_failed',
      'container_unavailable',
      'github_push_5xx',
      'runner_cancelled',
      'spot_reclaimed',
    ]);
  });

  it('runner_cancelled classifies as infra (collateral cancellation, retryable) but is not a reclaim', () => {
    // A step cancelled mid-run by runner/daemon teardown is infra-class so the
    // §10 auto-retry re-runs it — but it gets the CONSERVATIVE generation cap
    // (it is not a known-transient Spot reclaim).
    expect(classifyFailureReason('runner_cancelled')).toBe('infra');
    expect(isInfraFailureReason('runner_cancelled')).toBe(true);
    expect(isReclaimFailureReason('runner_cancelled')).toBe(false);
  });

  it('worktree_bundle_failed is CI-class (deterministic) — never auto-retried', () => {
    // A `git bundle` failure recurs identically on retry, so it must NOT be
    // infra-class. If this regresses, the remote fleet livelocks re-running the
    // same broken bundle as a "transient" container_unavailable.
    expect(classifyFailureReason('worktree_bundle_failed')).toBe('ci');
    expect(isInfraFailureReason('worktree_bundle_failed')).toBe(false);
    expect((CI_FAILURE_REASONS as readonly string[]).includes('worktree_bundle_failed')).toBe(true);
    expect((INFRA_FAILURE_REASONS as readonly string[]).includes('worktree_bundle_failed')).toBe(
      false,
    );
  });

  it('spot_reclaimed classifies as infra and as a reclaim', () => {
    expect(classifyFailureReason('spot_reclaimed')).toBe('infra');
    expect(isReclaimFailureReason('spot_reclaimed')).toBe(true);
    // Other infra codes are NOT reclaims (they get the conservative cap).
    expect(isReclaimFailureReason('container_unavailable')).toBe(false);
    expect(isReclaimFailureReason('github_push_5xx')).toBe(false);
    expect(isReclaimFailureReason(null)).toBe(false);
    expect([...RECLAIM_FAILURE_REASONS]).toEqual(['spot_reclaimed']);
  });

  it('INFRA and CI lists are disjoint', () => {
    const infraSet = new Set<string>(INFRA_FAILURE_REASONS);
    for (const code of CI_FAILURE_REASONS) {
      expect(infraSet.has(code)).toBe(false);
    }
  });
});

describe('isInfraFailureReason', () => {
  it('is true exactly for infra codes', () => {
    for (const code of INFRA_FAILURE_REASONS) {
      expect(isInfraFailureReason(code)).toBe(true);
    }
    for (const code of CI_FAILURE_REASONS) {
      expect(isInfraFailureReason(code)).toBe(false);
    }
    expect(isInfraFailureReason('unknown_code')).toBe(false);
    expect(isInfraFailureReason(null)).toBe(false);
  });
});

// ─── computeRetryIdempotencyKey ──────────────────────────────────────

describe('computeRetryIdempotencyKey', () => {
  it('produces a stable 64-char hex digest', () => {
    const a = computeRetryIdempotencyKey({
      projectId: 'p',
      branch: 'feature/x',
      headSha: 'aaa',
      parentRunId: 'run-1',
    });
    const b = computeRetryIdempotencyKey({
      projectId: 'p',
      branch: 'feature/x',
      headSha: 'aaa',
      parentRunId: 'run-1',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('differs from the original idempotency key for the same triple', () => {
    const orig = computeIdempotencyKey({ projectId: 'p', branch: 'feature/x', headSha: 'aaa' });
    const retry = computeRetryIdempotencyKey({
      projectId: 'p',
      branch: 'feature/x',
      headSha: 'aaa',
      parentRunId: 'run-1',
    });
    expect(orig).not.toBe(retry);
  });

  it('differs when the parent run id differs', () => {
    const a = computeRetryIdempotencyKey({
      projectId: 'p',
      branch: 'feature/x',
      headSha: 'aaa',
      parentRunId: 'run-1',
    });
    const b = computeRetryIdempotencyKey({
      projectId: 'p',
      branch: 'feature/x',
      headSha: 'aaa',
      parentRunId: 'run-2',
    });
    expect(a).not.toBe(b);
  });
});

// ─── openInfraRetryRun ──────────────────────────────────────────────

describe('openInfraRetryRun', () => {
  // The generation caps are read LIVE from the environment
  // (`resolveRetryGenerationCap` → `FINALIZE_MAX_*_RETRY_GENERATIONS`), so the
  // Finalize CI runner — which sets these to non-default values for the fleet
  // — would otherwise leak into the assertions below that expect the built-in
  // defaults (generic 2 / reclaim 3). Pin the env to "unset" for this block so
  // the defaults are deterministic regardless of ambient runner config, then
  // restore whatever the host had.
  const RETRY_GEN_ENV = [
    'FINALIZE_MAX_INFRA_RETRY_GENERATIONS',
    'FINALIZE_MAX_RECLAIM_RETRY_GENERATIONS',
  ] as const;
  const savedRetryGenEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const name of RETRY_GEN_ENV) {
      savedRetryGenEnv[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const name of RETRY_GEN_ENV) {
      const prev = savedRetryGenEnv[name];
      if (prev === undefined) delete process.env[name];
      else process.env[name] = prev;
    }
  });

  it('inserts a retry row mirroring the parent + sets retry_of_run_id', () => {
    const parent = fakeParentRow();
    const { stmts, rowMap, insertCalls } = makeStmts({ 'parent-run': parent });
    const { broadcast, calls } = makeBroadcast();
    const result = openInfraRetryRun(
      { stmts, broadcast, newId: () => 'retry-1', now: () => 9_999, log: vi.fn() },
      { parentRunId: 'parent-run', triggerSource: 'ui_button' },
    );
    expect(result).toEqual({ runId: 'retry-1' });
    const retryRow = rowMap.get('retry-1');
    expect(retryRow).toBeDefined();
    expect(retryRow!.card_id).toBe(parent.card_id);
    expect(retryRow!.session_id).toBe(parent.session_id);
    expect(retryRow!.project_id).toBe(parent.project_id);
    expect(retryRow!.branch).toBe(parent.branch);
    expect(retryRow!.head_sha).toBe(parent.head_sha);
    expect(retryRow!.worktree_path).toBe(parent.worktree_path);
    expect(retryRow!.author_name).toBe(parent.author_name);
    expect(retryRow!.author_email).toBe(parent.author_email);
    expect(retryRow!.triggered_by_user_id).toBe(parent.triggered_by_user_id);
    expect(retryRow!.retry_of_run_id).toBe('parent-run');
    expect(retryRow!.status).toBe('queued');
    expect(retryRow!.started_at).toBe(9_999);
    // active_seconds_consumed on the retry ROW starts at 0; the family
    // total is computed via getRunFamilyActiveSeconds which sums parent
    // + retry. We are not testing that here; what matters is that the
    // retry row itself starts at zero so its own bills are tracked
    // separately.
    expect(retryRow!.active_seconds_consumed).toBe(0);
    // insertFinalizeRun called with a retry idempotency key distinct
    // from the parent's.
    expect(insertCalls).toHaveLength(1);
    const insertedKey = insertCalls[0][6] as string;
    expect(insertedKey).not.toBe(parent.idempotency_key);
    expect(insertedKey).toMatch(/^[a-f0-9]{64}$/);
    // Broadcast finalize_run_created with the retry's run_id.
    const created = calls.find((c) => c.type === 'finalize_run_created');
    expect(created).toEqual({
      type: 'finalize_run_created',
      run_id: 'retry-1',
      card_id: parent.card_id,
      session_id: parent.session_id,
      trigger_source: 'ui_button',
    });
  });

  it('returns null when the parent row is missing', () => {
    const { stmts } = makeStmts({});
    const { broadcast, calls } = makeBroadcast();
    const log = vi.fn();
    const result = openInfraRetryRun(
      { stmts, broadcast, newId: () => 'retry-1', now: () => 0, log },
      { parentRunId: 'gone', triggerSource: 'ui_button' },
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
    expect(log).toHaveBeenCalled();
  });

  // ── Generation-aware retry cap (double-reclaim hardening) ──────────
  // Build a retry chain g0 → g1 → g2 → … so we can assert that
  // openInfraRetryRun keeps opening generations up to the per-class cap
  // and refuses beyond it. Each link carries a distinct idempotency key.
  function chainRows(depth: number): Record<string, Partial<FinalizeRunRow>> {
    const rows: Record<string, Partial<FinalizeRunRow>> = {};
    for (let g = 0; g <= depth; g++) {
      rows[`g${g}`] = fakeParentRow({
        id: `g${g}`,
        idempotency_key: `g${g}-key`,
        retry_of_run_id: g === 0 ? null : `g${g - 1}`,
      });
    }
    return rows;
  }

  it('default generic-infra cap is 2 and reclaim cap is 3', () => {
    expect(MAX_INFRA_RETRY_GENERATIONS).toBe(2);
    expect(MAX_RECLAIM_RETRY_GENERATIONS).toBe(3);
    expect(resolveRetryGenerationCap('container_unavailable')).toBe(2);
    expect(resolveRetryGenerationCap('spot_reclaimed')).toBe(3);
    expect(resolveRetryGenerationCap(undefined)).toBe(2);
  });

  it('FINALIZE_MAX_RECLAIM_RETRY_GENERATIONS env overrides the reclaim cap live (prod sets 5)', () => {
    // The prod Spot fleet sets FINALIZE_MAX_RECLAIM_RETRY_GENERATIONS=5 (ops/
    // terraform/environments/prod/prod.tfvars → finalize-hub.tf) so a long job
    // survives a correlated reclaim wave. The cap is read at CALL time, so the
    // deployed env must take effect without a re-import. Lock that in.
    const saved = process.env.FINALIZE_MAX_RECLAIM_RETRY_GENERATIONS;
    try {
      process.env.FINALIZE_MAX_RECLAIM_RETRY_GENERATIONS = '5';
      expect(resolveRetryGenerationCap('spot_reclaimed')).toBe(5);
      // Generic infra is unaffected by the reclaim-specific override.
      expect(resolveRetryGenerationCap('container_unavailable')).toBe(2);
      // Values below 1 are coerced to the historical single-retry floor.
      process.env.FINALIZE_MAX_RECLAIM_RETRY_GENERATIONS = '0';
      expect(resolveRetryGenerationCap('spot_reclaimed')).toBe(1);
      // A non-numeric env falls back to the default reclaim cap (3).
      process.env.FINALIZE_MAX_RECLAIM_RETRY_GENERATIONS = 'not-a-number';
      expect(resolveRetryGenerationCap('spot_reclaimed')).toBe(3);
    } finally {
      if (saved === undefined) delete process.env.FINALIZE_MAX_RECLAIM_RETRY_GENERATIONS;
      else process.env.FINALIZE_MAX_RECLAIM_RETRY_GENERATIONS = saved;
    }
  });

  it('getRetryGenerationDepth counts the retry_of_run_id chain', () => {
    const { stmts } = makeStmts(chainRows(2));
    expect(getRetryGenerationDepth(stmts, 'g0')).toBe(0);
    expect(getRetryGenerationDepth(stmts, 'g1')).toBe(1);
    expect(getRetryGenerationDepth(stmts, 'g2')).toBe(2);
  });

  it('generic infra ALLOWS a retry-of-a-retry up to the cap (survives a double reclaim)', () => {
    // Parent is itself a retry (generation 1); opening generation 2 is at the
    // cap (2) → allowed. This is the core double-reclaim hardening: the second
    // consecutive infra failure no longer terminates an otherwise-green run.
    const { stmts, rowMap } = makeStmts(chainRows(1));
    const { broadcast, calls } = makeBroadcast();
    const result = openInfraRetryRun(
      { stmts, broadcast, newId: () => 'retry-g2', now: () => 0, log: vi.fn() },
      {
        parentRunId: 'g1',
        triggerSource: 'ui_button',
        parentFailureReason: 'container_unavailable',
      },
    );
    expect(result).toEqual({ runId: 'retry-g2' });
    expect(rowMap.get('retry-g2')!.retry_of_run_id).toBe('g1');
    expect(calls.find((c) => c.type === 'finalize_run_created')).toBeDefined();
  });

  it('generic infra REFUSES once the generation cap is reached', () => {
    // Parent is generation 2; opening generation 3 exceeds the generic cap (2).
    const { stmts } = makeStmts(chainRows(2));
    const { broadcast, calls } = makeBroadcast();
    const log = vi.fn();
    const result = openInfraRetryRun(
      { stmts, broadcast, newId: () => 'retry-x', now: () => 0, log },
      {
        parentRunId: 'g2',
        triggerSource: 'ui_button',
        parentFailureReason: 'container_unavailable',
      },
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
    expect(log).toHaveBeenCalled();
  });

  it('reclaim-class gets a more generous cap than generic infra', () => {
    // At generation 2, generic infra refuses (above) but a known spot_reclaimed
    // is still allowed (cap 3) — a reclaim is known-transient.
    const { stmts, rowMap } = makeStmts(chainRows(2));
    const { broadcast } = makeBroadcast();
    const result = openInfraRetryRun(
      { stmts, broadcast, newId: () => 'retry-g3', now: () => 0, log: vi.fn() },
      { parentRunId: 'g2', triggerSource: 'ui_button', parentFailureReason: 'spot_reclaimed' },
    );
    expect(result).toEqual({ runId: 'retry-g3' });
    expect(rowMap.get('retry-g3')!.retry_of_run_id).toBe('g2');
  });

  it('reclaim-class still REFUSES past its own cap', () => {
    // Generation 3 → opening 4 exceeds the reclaim cap (3).
    const { stmts } = makeStmts(chainRows(3));
    const { broadcast } = makeBroadcast();
    const log = vi.fn();
    const result = openInfraRetryRun(
      { stmts, broadcast, newId: () => 'retry-x', now: () => 0, log },
      { parentRunId: 'g3', triggerSource: 'ui_button', parentFailureReason: 'spot_reclaimed' },
    );
    expect(result).toBeNull();
    expect(log).toHaveBeenCalled();
  });

  it('reuses an existing retry row when one already exists for the same parent', () => {
    const parent = fakeParentRow();
    const retryKey = computeRetryIdempotencyKey({
      projectId: parent.project_id!,
      branch: parent.branch!,
      headSha: parent.head_sha!,
      parentRunId: parent.id!,
    });
    const existingRetry = fakeParentRow({
      id: 'existing-retry',
      idempotency_key: retryKey,
      retry_of_run_id: parent.id,
      status: 'rebasing',
    });
    const { stmts, insertCalls } = makeStmts({
      'parent-run': parent,
      'existing-retry': existingRetry,
    });
    const { broadcast, calls } = makeBroadcast();
    const result = openInfraRetryRun(
      { stmts, broadcast, newId: () => 'new-retry', now: () => 0, log: vi.fn() },
      { parentRunId: 'parent-run', triggerSource: 'ui_button' },
    );
    expect(result).toEqual({ runId: 'existing-retry' });
    // No new insert.
    expect(insertCalls).toHaveLength(0);
    // No new broadcast (the retry row already existed).
    expect(calls.filter((c) => c.type === 'finalize_run_created')).toHaveLength(0);
  });

  it('returns null when the insert raises (and the caller surfaces as terminal infra_error)', () => {
    const parent = fakeParentRow();
    const { stmts } = makeStmts({ 'parent-run': parent });
    // Force the insert to throw without prior collision in byKey.
    (stmts.insertFinalizeRun.run as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const { broadcast } = makeBroadcast();
    const log = vi.fn();
    const result = openInfraRetryRun(
      { stmts, broadcast, newId: () => 'retry-x', now: () => 0, log },
      { parentRunId: 'parent-run', triggerSource: 'ui_button' },
    );
    expect(result).toBeNull();
    expect(log).toHaveBeenCalled();
  });

  it('carries the trigger source from the agent_block path verbatim', () => {
    const parent = fakeParentRow({ trigger_source: 'agent_block' });
    const { stmts } = makeStmts({ 'parent-run': parent });
    const { broadcast, calls } = makeBroadcast();
    openInfraRetryRun(
      { stmts, broadcast, newId: () => 'retry-1', now: () => 0, log: vi.fn() },
      { parentRunId: 'parent-run', triggerSource: 'agent_block' },
    );
    const created = calls.find((c) => c.type === 'finalize_run_created');
    expect(created?.trigger_source).toBe('agent_block');
  });
});

// ─── composeInfraTerminalMessageBody ─────────────────────────────────

describe('composeInfraTerminalMessageBody', () => {
  it('includes header, machine code, detail, and escalation hint', () => {
    const body = composeInfraTerminalMessageBody({
      failureReason: 'github_push_5xx',
      detail: 'HTTP 502 from github.com',
      parentRunId: 'parent-1',
      retryRunId: 'retry-1',
    });
    expect(body).toContain(INFRA_TERMINAL_HEADER);
    expect(body).toContain('github_push_5xx');
    expect(body).toContain('infra-class');
    expect(body).toContain('HTTP 502 from github.com');
    expect(body).toContain('parent-1');
    expect(body).toContain('retry-1');
    expect(body).toContain('Re-trigger Finalize Code Changes');
    // No GitHub check-run or PR comment hint — Finalize is pre-PR.
    expect(body).toContain('pre-PR');
  });

  it('omits the detail block when not supplied', () => {
    const body = composeInfraTerminalMessageBody({
      failureReason: 'container_unavailable',
      parentRunId: 'parent-1',
      retryRunId: 'retry-1',
    });
    expect(body).toContain('container_unavailable');
    expect(body).not.toMatch(/^Detail:$/m);
  });
});

// ─── postInfraTerminalMessage ────────────────────────────────────────

describe('postInfraTerminalMessage', () => {
  it('inserts a system message + touches the session + broadcasts a message event', () => {
    const { stmts, inserted } = makeStmts();
    const { broadcast, calls } = makeBroadcast();
    const result = postInfraTerminalMessage(
      { stmts, broadcast, newId: () => 'msg-1', log: vi.fn() },
      {
        parentRunId: 'parent-1',
        retryRunId: 'retry-1',
        sessionId: 'sess-1',
        cardId: 'card-1',
        projectId: 'proj-1',
        failureReason: 'worktree_create_failed',
        detail: 'spawnSession returned null',
      },
    );
    expect(result).toEqual({ messageId: 'msg-1' });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].sessionId).toBe('sess-1');
    expect(inserted[0].body).toContain('worktree_create_failed');
    expect(inserted[0].body).toContain('spawnSession returned null');
    const meta = JSON.parse(inserted[0].metadata ?? '{}') as Record<string, unknown>;
    expect(meta.kind).toBe('finalize_infra_terminal');
    expect(meta.parentRunId).toBe('parent-1');
    expect(meta.retryRunId).toBe('retry-1');
    expect(meta.failureReason).toBe('worktree_create_failed');
    expect(stmts.touchSession.run).toHaveBeenCalledWith('sess-1');
    const messageEvents = calls.filter((c) => c.type === 'message');
    expect(messageEvents).toHaveLength(1);
  });

  it('no-ops when sessionId is null', () => {
    const { stmts, inserted } = makeStmts();
    const { broadcast, calls } = makeBroadcast();
    const result = postInfraTerminalMessage(
      { stmts, broadcast, log: vi.fn() },
      {
        parentRunId: 'parent-1',
        retryRunId: 'retry-1',
        sessionId: null,
        cardId: 'card-1',
        projectId: 'proj-1',
        failureReason: 'github_push_5xx',
      },
    );
    expect(result).toBeNull();
    expect(inserted).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('swallows DB insert failures and returns null', () => {
    const { stmts } = makeStmts();
    (stmts.addMessage.run as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const { broadcast } = makeBroadcast();
    const log = vi.fn();
    const result = postInfraTerminalMessage(
      { stmts, broadcast, newId: () => 'msg-1', log },
      {
        parentRunId: 'parent-1',
        retryRunId: 'retry-1',
        sessionId: 'sess-1',
        cardId: 'card-1',
        projectId: 'proj-1',
        failureReason: 'container_unavailable',
        detail: 'rebase phase threw',
      },
    );
    expect(result).toBeNull();
    expect(log).toHaveBeenCalled();
  });
});
