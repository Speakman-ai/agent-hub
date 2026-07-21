import { describe, expect, it } from 'vitest';
import {
  indexRowsByWorkflowId,
  mapWithConcurrency,
  planWorkflowEnrichment,
  WORKFLOW_ENRICH_CONCURRENCY,
  type WorkflowRow,
} from './workflowListLoad';

function row(id: string, status: string | null): WorkflowRow {
  return {
    workflow: { id },
    lastRun: status ? { id: `${id}-run`, status } : null,
    stepRuns: [{ workflow_step_id: 's1', status: 'success' }],
  };
}

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of resolution order', async () => {
    const delays = [30, 5, 20, 1, 15];
    const out = await mapWithConcurrency(delays, 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(['0:30', '1:5', '2:20', '3:1', '4:15']);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (i) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return i;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('runs every item exactly once', async () => {
    const seen: number[] = [];
    const out = await mapWithConcurrency([10, 20, 30], 5, async (n) => {
      seen.push(n);
      return n * 2;
    });
    expect(out).toEqual([20, 40, 60]);
    expect(seen.sort((a, b) => a - b)).toEqual([10, 20, 30]);
  });

  it('returns an empty array without invoking the callback for no items', async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], 5, async (x) => {
      calls += 1;
      return x;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it('treats a non-positive limit as a single worker', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency([1, 2, 3, 4], 0, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return n;
    });
    expect(maxInFlight).toBe(1);
  });
});

describe('planWorkflowEnrichment', () => {
  const workflows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('refetches everything on a full (non-poll) load', () => {
    const prev = new Map([['a', row('a', 'success')]]);
    const { fetchIds, reuse } = planWorkflowEnrichment(workflows, prev, { activeOnly: false });
    expect([...fetchIds].sort()).toEqual(['a', 'b', 'c']);
    expect(reuse.size).toBe(0);
  });

  it('reuses settled rows and refetches only active/new rows on a poll', () => {
    const prev = new Map([
      ['a', row('a', 'success')], // settled -> reuse
      ['b', row('b', 'running')], // active -> refetch
      // c has no prior row -> refetch
    ]);
    const { fetchIds, reuse } = planWorkflowEnrichment(workflows, prev, { activeOnly: true });
    expect([...fetchIds].sort()).toEqual(['b', 'c']);
    expect([...reuse.keys()]).toEqual(['a']);
    expect(reuse.get('a')?.lastRun?.status).toBe('success');
  });

  it('refreshes the workflow definition on reused rows', () => {
    const prev = new Map([['a', row('a', 'success')]]);
    const renamed = [{ id: 'a', name: 'Renamed' }];
    const { reuse } = planWorkflowEnrichment(renamed, prev, { activeOnly: true });
    // Cached run detail is kept, but the workflow object is the fresh one.
    expect(reuse.get('a')?.workflow).toEqual({ id: 'a', name: 'Renamed' });
    expect(reuse.get('a')?.lastRun?.status).toBe('success');
  });

  it('treats a pending run as active', () => {
    const prev = new Map([['a', row('a', 'pending')]]);
    const { fetchIds, reuse } = planWorkflowEnrichment([{ id: 'a' }], prev, { activeOnly: true });
    expect([...fetchIds]).toEqual(['a']);
    expect(reuse.size).toBe(0);
  });
});

describe('indexRowsByWorkflowId', () => {
  it('keys rows by their workflow id', () => {
    const map = indexRowsByWorkflowId([row('a', 'success'), row('b', 'running')]);
    expect([...map.keys()].sort()).toEqual(['a', 'b']);
    expect(map.get('b')?.lastRun?.status).toBe('running');
  });
});

describe('WORKFLOW_ENRICH_CONCURRENCY', () => {
  it('is a small positive bound', () => {
    expect(WORKFLOW_ENRICH_CONCURRENCY).toBeGreaterThan(0);
    expect(WORKFLOW_ENRICH_CONCURRENCY).toBeLessThanOrEqual(8);
  });
});
