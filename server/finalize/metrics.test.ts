/**
 * Unit tests for the Finalize Code Changes metrics module.
 *
 * The emitter helpers don't touch SQLite directly — they accept a
 * `Stmts`-shaped insert stmt and call `.run(...)` on it. Tests use a
 * spy stmt that captures the bound parameters so each metric's label
 * contract can be asserted in isolation.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  aggregateMetrics,
  isMetricName,
  METRIC_NAMES,
  parseRange,
  recordFixDispatchCount,
  recordMergedPrProvenance,
  recordMetric,
  recordReviewerVerdict,
  recordRunActiveSeconds,
  recordRunCompleted,
  recordRunStarted,
  recordRunWallSeconds,
  recordStalledNoResponse,
  recordStepResult,
  summarize,
  type MetricName,
} from './metrics.js';
import type { Stmts } from '../types.js';

function makeFakeStmts(): {
  stmts: Pick<Stmts, 'insertFinalizeMetric'>;
  calls: Array<{
    projectId: string;
    name: string;
    labels: Record<string, unknown>;
    value: number;
    runId: string | null;
    observedAt: number;
  }>;
} {
  const calls: Array<{
    projectId: string;
    name: string;
    labels: Record<string, unknown>;
    value: number;
    runId: string | null;
    observedAt: number;
  }> = [];
  const stmts = {
    insertFinalizeMetric: {
      run: vi.fn(
        (
          projectId: string,
          name: string,
          labels: string,
          value: number,
          runId: string | null,
          observedAt: number,
        ) => {
          calls.push({
            projectId,
            name,
            labels: JSON.parse(labels),
            value,
            runId,
            observedAt,
          });
        },
      ),
    },
  } as unknown as Pick<Stmts, 'insertFinalizeMetric'>;
  return { stmts, calls };
}

describe('recordMetric', () => {
  it('defaults value to 1 and labels to {}', () => {
    const { stmts, calls } = makeFakeStmts();
    recordMetric({ stmts, now: () => 1_000 }, { projectId: 'p', name: 'finalize_run_started' });
    expect(calls).toEqual([
      {
        projectId: 'p',
        name: 'finalize_run_started',
        labels: {},
        value: 1,
        runId: null,
        observedAt: 1_000,
      },
    ]);
  });

  it('serialises labels with sorted keys', () => {
    const { stmts, calls } = makeFakeStmts();
    recordMetric(
      { stmts, now: () => 0 },
      {
        projectId: 'p',
        name: 'finalize_step_result',
        labels: { step_name: 'lint', status: 'failed', exit_code: 1 },
        runId: 'run-1',
      },
    );
    // Inspect the JSON the stmt was bound with; the labels object on
    // the captured call already round-tripped through JSON.parse so
    // verify the storage form is canonical.
    const stmtSpy = stmts.insertFinalizeMetric.run as ReturnType<typeof vi.fn>;
    const bound = stmtSpy.mock.calls[0]?.[2] as string;
    expect(bound).toBe('{"exit_code":1,"status":"failed","step_name":"lint"}');
    expect(calls[0].runId).toBe('run-1');
  });

  it('swallows insert errors via the supplied log sink', () => {
    const stmts = {
      insertFinalizeMetric: {
        run: () => {
          throw new Error('boom');
        },
      },
    } as unknown as Pick<Stmts, 'insertFinalizeMetric'>;
    const log = vi.fn();
    expect(() =>
      recordMetric({ stmts, log, now: () => 0 }, { projectId: 'p', name: 'finalize_run_started' }),
    ).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('finalize_run_started');
  });
});

describe('typed emitter helpers', () => {
  it('recordRunStarted writes trigger_source label', () => {
    const { stmts, calls } = makeFakeStmts();
    recordRunStarted(
      { stmts, now: () => 5 },
      { projectId: 'p', runId: 'r1', triggerSource: 'agent_block' },
    );
    expect(calls[0]).toMatchObject({
      name: 'finalize_run_started',
      labels: { trigger_source: 'agent_block' },
      value: 1,
      runId: 'r1',
    });
  });

  it('recordRunCompleted writes status + trigger_source', () => {
    const { stmts, calls } = makeFakeStmts();
    recordRunCompleted(
      { stmts, now: () => 5 },
      { projectId: 'p', runId: 'r1', status: 'pushed', triggerSource: 'ui_button' },
    );
    expect(calls[0].labels).toEqual({ status: 'pushed', trigger_source: 'ui_button' });
  });

  it('recordRunActiveSeconds passes the sample as the histogram value', () => {
    const { stmts, calls } = makeFakeStmts();
    recordRunActiveSeconds(
      { stmts, now: () => 5 },
      { projectId: 'p', runId: 'r1', activeSeconds: 1234, status: 'pushed' },
    );
    expect(calls[0]).toMatchObject({
      name: 'finalize_run_active_seconds',
      value: 1234,
      labels: { status: 'pushed' },
    });
  });

  it('recordRunWallSeconds passes the wall sample', () => {
    const { stmts, calls } = makeFakeStmts();
    recordRunWallSeconds(
      { stmts, now: () => 5 },
      { projectId: 'p', runId: 'r1', wallSeconds: 5_000, status: 'failed' },
    );
    expect(calls[0]).toMatchObject({
      name: 'finalize_run_wall_seconds',
      value: 5_000,
      labels: { status: 'failed' },
    });
  });

  it('recordFixDispatchCount carries the count as value', () => {
    const { stmts, calls } = makeFakeStmts();
    recordFixDispatchCount(
      { stmts, now: () => 5 },
      { projectId: 'p', runId: 'r1', count: 3, status: 'pushed' },
    );
    expect(calls[0]).toMatchObject({
      name: 'finalize_fix_dispatch_count',
      value: 3,
      labels: { status: 'pushed' },
    });
  });

  it('recordReviewerVerdict labels verdict + attempt_index', () => {
    const { stmts, calls } = makeFakeStmts();
    recordReviewerVerdict(
      { stmts, now: () => 5 },
      { projectId: 'p', runId: 'r1', verdict: 'changes_requested', attemptIndex: 2 },
    );
    expect(calls[0].labels).toEqual({
      verdict: 'changes_requested',
      attempt_index: 2,
    });
  });

  it('recordStepResult labels step_name + status + exit_code', () => {
    const { stmts, calls } = makeFakeStmts();
    recordStepResult(
      { stmts, now: () => 5 },
      { projectId: 'p', runId: 'r1', stepName: 'tests', status: 'failed', exitCode: 137 },
    );
    expect(calls[0].labels).toEqual({
      step_name: 'tests',
      status: 'failed',
      exit_code: 137,
    });
  });

  it('recordStalledNoResponse is a label-free counter', () => {
    const { stmts, calls } = makeFakeStmts();
    recordStalledNoResponse({ stmts, now: () => 5 }, { projectId: 'p', runId: 'r1' });
    expect(calls[0]).toMatchObject({
      name: 'finalize_stalled_no_response_count',
      labels: {},
      value: 1,
      runId: 'r1',
    });
  });

  it('recordMergedPrProvenance labels source and tolerates a null runId', () => {
    const { stmts, calls } = makeFakeStmts();
    recordMergedPrProvenance({ stmts, now: () => 5 }, { projectId: 'p', source: 'external' });
    expect(calls[0]).toMatchObject({
      name: 'merged_pr_provenance',
      labels: { source: 'external' },
      runId: null,
    });
  });
});

describe('isMetricName', () => {
  it('accepts every documented metric name', () => {
    for (const n of METRIC_NAMES) expect(isMetricName(n)).toBe(true);
  });
  it('rejects unknown names', () => {
    expect(isMetricName('not_a_metric')).toBe(false);
    expect(isMetricName(42)).toBe(false);
    expect(isMetricName(null)).toBe(false);
  });
});

describe('summarize', () => {
  it('returns null fields for empty samples', () => {
    expect(summarize([])).toEqual({
      count: 0,
      min: null,
      max: null,
      avg: null,
      p50: null,
      p95: null,
      p99: null,
    });
  });

  it('computes quantiles via linear interpolation on a uniform sample', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    const s = summarize(values);
    expect(s.count).toBe(100);
    expect(s.min).toBe(1);
    expect(s.max).toBe(100);
    expect(s.avg).toBeCloseTo(50.5);
    // Type 7 quantile of 1..100 → p50 ≈ 50.5, p95 ≈ 95.05.
    expect(s.p50).toBeCloseTo(50.5);
    expect(s.p95).toBeCloseTo(95.05, 1);
    expect(s.p99).toBeCloseTo(99.01, 1);
  });

  it('handles single-sample sets without divide-by-zero', () => {
    expect(summarize([42])).toEqual({
      count: 1,
      min: 42,
      max: 42,
      avg: 42,
      p50: 42,
      p95: 42,
      p99: 42,
    });
  });
});

describe('aggregateMetrics', () => {
  it('groups counters by label combination and includes zero-row metrics', () => {
    const rows = [
      { metric_name: 'finalize_run_started', labels: '{"trigger_source":"ui_button"}', value: 1 },
      { metric_name: 'finalize_run_started', labels: '{"trigger_source":"ui_button"}', value: 1 },
      { metric_name: 'finalize_run_started', labels: '{"trigger_source":"agent_block"}', value: 1 },
    ];
    const out = aggregateMetrics(rows, {
      metrics: ['finalize_run_started', 'finalize_stalled_no_response_count'] as MetricName[],
    });
    const started = out.find((a) => a.metric === 'finalize_run_started');
    expect(started?.kind).toBe('counter');
    expect(started && started.kind === 'counter' && started.count).toBe(3);
    const groups = started?.kind === 'counter' ? started.groups : [];
    expect(groups).toEqual(
      expect.arrayContaining([
        { labels: { trigger_source: 'ui_button' }, count: 2 },
        { labels: { trigger_source: 'agent_block' }, count: 1 },
      ]),
    );
    const stalled = out.find((a) => a.metric === 'finalize_stalled_no_response_count');
    expect(stalled?.kind).toBe('counter');
    expect(stalled && stalled.kind === 'counter' && stalled.count).toBe(0);
  });

  it('builds histogram summaries with overall + per-label slices', () => {
    const rows = [
      { metric_name: 'finalize_run_active_seconds', labels: '{"status":"pushed"}', value: 100 },
      { metric_name: 'finalize_run_active_seconds', labels: '{"status":"pushed"}', value: 200 },
      { metric_name: 'finalize_run_active_seconds', labels: '{"status":"failed"}', value: 300 },
    ];
    const out = aggregateMetrics(rows, {
      metrics: ['finalize_run_active_seconds'] as MetricName[],
    });
    const hist = out[0];
    expect(hist.kind).toBe('histogram');
    if (hist.kind !== 'histogram') return;
    expect(hist.summary.count).toBe(3);
    expect(hist.summary.min).toBe(100);
    expect(hist.summary.max).toBe(300);
    expect(hist.summary.avg).toBeCloseTo(200);
    expect(hist.groups).toHaveLength(2);
    const pushed = hist.groups.find((g) => g.labels.status === 'pushed');
    expect(pushed?.summary.count).toBe(2);
    expect(pushed?.summary.avg).toBeCloseTo(150);
  });

  it('drops rows with unknown metric_name', () => {
    const rows = [{ metric_name: 'bogus', labels: '{}', value: 1 }];
    const out = aggregateMetrics(rows, { metrics: ['finalize_run_started'] as MetricName[] });
    const started = out[0];
    if (started.kind !== 'counter') throw new Error('expected counter');
    expect(started.count).toBe(0);
  });
});

describe('parseRange', () => {
  it('defaults to a 24h window when input is blank', () => {
    const r = parseRange('', () => 100_000_000);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.toMs).toBe(100_000_000);
    expect(r.fromMs).toBe(100_000_000 - 24 * 60 * 60 * 1000);
  });

  it('parses relative units (m, h, d)', () => {
    const now = () => 1_000_000_000;
    const m = parseRange('30m', now);
    const h = parseRange('2h', now);
    const d = parseRange('7d', now);
    expect(m?.fromMs).toBe(1_000_000_000 - 30 * 60 * 1000);
    expect(h?.fromMs).toBe(1_000_000_000 - 2 * 60 * 60 * 1000);
    expect(d?.fromMs).toBe(1_000_000_000 - 7 * 24 * 60 * 60 * 1000);
  });

  it('parses ISO8601 ranges with the `..` separator', () => {
    const r = parseRange('2026-05-01T00:00:00Z..2026-05-02T00:00:00Z');
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.toMs - r.fromMs).toBe(24 * 60 * 60 * 1000);
  });

  it('returns null on garbage', () => {
    expect(parseRange('not-a-range')).toBeNull();
    expect(parseRange('5z')).toBeNull();
    expect(parseRange('2026-05-02T00:00:00Z..2026-05-01T00:00:00Z')).toBeNull();
  });

  it('caps the window at 1 year (duration-aware, not literal-aware)', () => {
    // 9000 minutes ≈ 6.25 days — well under the 1-year cap. Previously
    // rejected by the literal `value > 365*24` bound.
    expect(parseRange('9000m')).not.toBeNull();
    // 8760 days ≈ 24 years — must be rejected.
    expect(parseRange('8760d')).toBeNull();
    // Explicit range > 1 year is also rejected.
    expect(parseRange('2024-01-01T00:00:00Z..2026-01-01T00:00:00Z')).toBeNull();
  });
});
