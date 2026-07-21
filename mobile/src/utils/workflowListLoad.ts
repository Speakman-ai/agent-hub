/**
 * Pure helpers for the mobile Workflows list load.
 *
 * The list view enriches each workflow with its latest run (+ step detail).
 * Doing that naively — one `getWorkflowRuns` and one `getWorkflowRunDetail`
 * per workflow, all fired at once, on every 2.5s poll tick — produces a burst
 * of dozens of requests while any run is active. That is a real
 * battery/network/server-load problem on mobile.
 *
 * These helpers bound the cost two ways:
 *   1. `mapWithConcurrency` caps how many enrichment chains run in parallel.
 *   2. `planWorkflowEnrichment` re-fetches only the workflows that can actually
 *      change on a background poll (active or not-yet-loaded), reusing cached
 *      run detail for settled workflows.
 */
import { isWorkflowRunActive } from '@shared/utils/workflowRunTimeline';

export interface WorkflowRow {
  workflow: any;
  lastRun: any;
  stepRuns: any[];
}

/** Max enrichment chains in flight at once, per load. */
export const WORKFLOW_ENRICH_CONCURRENCY = 5;

/**
 * Order-preserving async map with a bounded number of in-flight callbacks.
 * Never fans out more than `limit` concurrent calls regardless of input size.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  const workerCount = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let cursor = 0;
  const runWorker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
}

/**
 * Decide which workflows need a network refetch on this load.
 *
 * - A full load (`activeOnly === false`: initial mount, project switch, manual
 *   refresh) refetches everything.
 * - A background poll (`activeOnly === true`) refetches only workflows whose
 *   cached run is still active or that have no cached row yet. Settled
 *   workflows reuse their cached run/detail (with the workflow definition
 *   refreshed from the new list payload), so a quiet board issues no per-row
 *   calls at all.
 */
export function planWorkflowEnrichment(
  workflows: any[],
  prevRows: Map<string, WorkflowRow>,
  opts: { activeOnly: boolean },
): { fetchIds: Set<string>; reuse: Map<string, WorkflowRow> } {
  const fetchIds = new Set<string>();
  const reuse = new Map<string, WorkflowRow>();
  for (const workflow of workflows) {
    const id = String(workflow?.id);
    const prev = prevRows.get(id);
    if (!opts.activeOnly || !prev || isWorkflowRunActive(prev.lastRun)) {
      fetchIds.add(id);
    } else {
      reuse.set(id, { workflow, lastRun: prev.lastRun, stepRuns: prev.stepRuns });
    }
  }
  return { fetchIds, reuse };
}

/** Build a lookup of the current rows keyed by workflow id. */
export function indexRowsByWorkflowId(rows: WorkflowRow[]): Map<string, WorkflowRow> {
  const map = new Map<string, WorkflowRow>();
  for (const row of rows) map.set(String(row?.workflow?.id), row);
  return map;
}
