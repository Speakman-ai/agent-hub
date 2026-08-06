/**
 * infra-retention-reaper.ts — periodic retention + quota prune for `infra.db`.
 *
 * Metric points arrive at collector cadence for every series in every scope, so
 * without a bound the store grows for as long as monitoring is enabled
 * (decision INFRA-STORE). Two passes keep it bounded, in this order:
 *
 *  1. **Age** — points older than each project's window (default 30 days) are
 *     deleted, oldest first across every project.
 *  2. **Byte quota** — a project still over its quota (default 8 GiB) has its
 *     oldest points evicted down to it.
 *
 * The age pass runs first deliberately: it deletes the points nobody asked to
 * keep, so the quota pass — the one that throws away data inside a window an
 * operator explicitly chose — only ever spends what the cheap pass left behind.
 *
 * Pure SQLite against `infra.db`. Never touches `agent-hub.db` / `orgs.db`, and
 * is not docker- or fleet-gated, so it runs on every Hub.
 */

import { isInfraDbInitialized } from './infra-db.js';
import {
  getInfraDbFileBytes,
  listInfraProjectUsage,
  listInfraRetentionOverrides,
  getInfraRetentionConfig,
  pruneExpiredInfraMetricPoints,
  enforceInfraProjectQuota,
} from './infra-retention-store.js';
import { DEFAULT_INFRA_PROJECT_QUOTA_BYTES } from './infra-schema.js';

/** Runs every 10 minutes, matching the logs reaper's cadence. */
export const INFRA_RETENTION_REAPER_CRON = '*/10 * * * *';

/**
 * Per-tick deletion budget shared across both passes.
 *
 * An order of magnitude above the logs reaper's 5,000 because the drain rate
 * has to exceed the fill rate, and metric points fill far faster than log
 * records: ~600 series polled at a 60s period is ~864k points/day, and a large
 * scoped deployment is several times that. At 144 ticks/day this budget drains
 * up to 7.2M points/day — comfortably ahead of what a cost-capped collector can
 * write — while each tick stays a bounded slice that a chart read can interleave
 * with (the deletes are sub-chunked into short transactions in the store).
 */
export const MAX_INFRA_DELETES_PER_TICK = 50_000;

export interface InfraReaperResult {
  expiredDeleted: number;
  quotaDeleted: number;
  /** True when the quota pass was skipped because the store is smaller than any quota. */
  quotaScanSkipped: boolean;
}

/**
 * The smallest quota any project could be held to right now.
 *
 * No project's accounted bytes can exceed the whole database file, so a file
 * smaller than this cannot contain an over-quota project. That turns the common
 * case — a Hub whose `infra.db` is nowhere near a multi-gigabyte quota — into
 * two `PRAGMA` reads instead of a full-table aggregate, which is what makes it
 * safe to run this pass every ten minutes on a store with tens of millions of
 * points.
 */
function smallestConfiguredQuota(): number {
  let smallest = DEFAULT_INFRA_PROJECT_QUOTA_BYTES;
  for (const o of listInfraRetentionOverrides()) {
    if (o.quotaBytes < smallest) smallest = o.quotaBytes;
  }
  return smallest;
}

/**
 * One reaper tick: drop expired points first, then enforce per-project quotas
 * on whatever remains. `nowMs` is injectable for deterministic tests.
 *
 * The budget is SHARED across both passes and across every project: the age
 * pass spends first, then the remainder is drawn down project-by-project by
 * quota enforcement. One tick therefore stays a single bounded slice even with
 * a large multi-project backlog, and the leftover drains on the next tick.
 *
 * A no-op when `infra.db` never opened. `initInfraDb()` failures are logged and
 * swallowed at boot so infra telemetry can never block startup, which means
 * this cron can legitimately fire with no store behind it — the same reason the
 * cost routes check `isInfraDbInitialized()` before reading.
 */
export function runInfraRetentionReaper(
  nowMs: number = Date.now(),
  maxDeletes: number = MAX_INFRA_DELETES_PER_TICK,
): InfraReaperResult {
  if (!isInfraDbInitialized()) {
    return { expiredDeleted: 0, quotaDeleted: 0, quotaScanSkipped: true };
  }

  let remaining = maxDeletes;

  const expiredDeleted = pruneExpiredInfraMetricPoints(nowMs, remaining);
  remaining -= expiredDeleted;

  if (remaining <= 0) {
    return { expiredDeleted, quotaDeleted: 0, quotaScanSkipped: true };
  }

  if (getInfraDbFileBytes() <= smallestConfiguredQuota()) {
    return { expiredDeleted, quotaDeleted: 0, quotaScanSkipped: true };
  }

  // One grouped scan gives both the project list and the bytes each holds, so
  // the per-project eviction below never re-aggregates the table.
  let quotaDeleted = 0;
  for (const usage of listInfraProjectUsage()) {
    if (remaining <= 0) break;
    const { quotaBytes } = getInfraRetentionConfig(usage.projectId);
    if (usage.bytes <= quotaBytes) continue;
    const deleted = enforceInfraProjectQuota(usage.projectId, remaining, usage.bytes);
    quotaDeleted += deleted;
    remaining -= deleted;
  }

  return { expiredDeleted, quotaDeleted, quotaScanSkipped: false };
}
