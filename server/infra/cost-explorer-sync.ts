/**
 * Cost Explorer spend sync — the poller behind decision INFRA-COST mechanism 5.
 *
 * Spend is the question operators ask immediately after "is it up?", and it is
 * the one signal in this epic that costs money to read. Everything unusual about
 * this module follows from that.
 *
 * ## Why Cost Explorer at all, when AWS recommends CUR 2.0
 *
 * AWS's current recommendation for **detailed programmatic cost data** is not
 * this API. It is Cost and Usage Report 2.0 delivered through Data Exports,
 * which AWS calls "the new and recommended way to receive your detailed cost and
 * usage data": a fixed schema, resource-level line items, no per-request charge,
 * and no 13-month horizon.
 *
 * We poll `GetCostAndUsage` anyway, deliberately, because CUR 2.0 is not an API
 * — it is a **pipeline**. Consuming it means the customer creates an export, we
 * require write access to an S3 bucket in their account, and then we own
 * bucket-policy setup, Parquet/gzip CSV parsing, manifest tracking, a
 * once-daily-at-best delivery latency, and an Athena or DuckDB layer to make any
 * of it queryable. None of that exists in this epic, and standing it up would
 * also break the read-only posture INFRA-CRED committed to (decision
 * INFRA-COLLECT rejected Metric Streams for the same reason: requiring write
 * access in someone else's account to enable monitoring is the wrong trade for a
 * self-hosted product).
 *
 * What we actually need here is a spend *trend* and a top-N services panel —
 * daily totals at service grain, which is precisely what one `GetCostAndUsage`
 * call returns. So we buy the answer for a few cents a month instead of building
 * an export pipeline for it. Revisit when a deployment wants resource-level
 * attribution or per-hour spend; that is the point where CUR 2.0 stops being
 * over-engineering and starts being the only option.
 *
 * ## The three guards, all of which must hold before a request is signed
 *
 *   1. **Opt-in.** `infra_cost_config.cost_explorer_enabled`. This API bills
 *      $0.01 per paginated request with no free tier whatsoever, so nothing here
 *      runs until an operator said yes by name.
 *   2. **Cadence.** At most once per {@link MIN_COST_EXPLORER_SYNC_INTERVAL_MS},
 *      enforced against a persisted timestamp rather than against the cron
 *      string. AWS updates billing data at most three times daily and explicitly
 *      anticipates "a call pattern cadence ranging from daily to several times
 *      per day"; polling faster buys nothing but bill.
 *   3. **Ceiling.** A project the collector has paused for overspending does not
 *      get to spend more here. Cost Explorer draws on the same budget.
 *
 * ## Spend is recorded per page, as it is incurred
 *
 * Every page of a paginated response is its own billed request. The run row is
 * opened before the first call and incremented by one cent as each page returns,
 * for the reason `recordInfraCollectRunProgress` documents at length: a hard
 * kill does not run `finally`, and a crash loop that never records its spend
 * defeats the very ceiling meant to stop it.
 */

import { randomUUID } from 'crypto';
import {
  GetCostAndUsageCommand,
  type GetCostAndUsageCommandInput,
  type GetCostAndUsageCommandOutput,
} from '@aws-sdk/client-cost-explorer';
import { getProjectCostExplorerClient, requireProjectMonitoringProfile } from './aws-clients.js';
import { isInfraDbInitialized } from './infra-db.js';
import {
  getInfraCostConfig,
  listCostExplorerEnabledProjects,
  recordCostExplorerSyncStart,
  resolveProjectDegradation,
} from './infra-cost-store.js';
import {
  startInfraCollectRun,
  recordInfraCollectRunProgress,
  finishInfraCollectRun,
} from './infra-metric-store.js';
import {
  COST_EXPLORER_USD_PER_REQUEST,
  COST_EXPLORER_LOOKBACK_DAYS,
  MIN_COST_EXPLORER_SYNC_INTERVAL_MS,
} from './infra-cost.js';
import { replaceInfraCostDailyWindow, type InfraCostDailyRow } from './cost-explorer-store.js';

/**
 * When the sweep runs: three times a day, at 08 minutes past, eight hours apart.
 *
 * The cron is the schedule; {@link MIN_COST_EXPLORER_SYNC_INTERVAL_MS} is the
 * guarantee. Both exist because a cron expression is easy to edit and a spend
 * cap should not be one edit away from a fourth daily charge on every project.
 *
 * The offset minute keeps this off :00 and off :17, where the inventory sweep
 * already sits, so three AWS-touching crons never fire into the same second.
 */
export const INFRA_COST_EXPLORER_CRON = '8 1,9,17 * * *';

/**
 * Hard cap on pages followed in one sync.
 *
 * At a cent a page this is the difference between a predictable few cents a
 * month and an unbounded loop billing against someone else's account. Ten pages
 * is far above the realistic shape of a 30-day daily query grouped two ways —
 * but "realistic" is not a bound, and this module's whole premise is that spend
 * must be capped rather than trusted.
 *
 * Hitting it is reported, never silent: {@link InfraCostExplorerSyncResult}
 * carries `truncated`, the run row is closed `partial`, and the read endpoint
 * surfaces it. A truncated window that looked complete would under-report the
 * bill, which is the one direction decision INFRA-COST refuses everywhere.
 */
export const MAX_COST_EXPLORER_PAGES = 10;

/**
 * Re-exported so the window is readable from the poller that uses it, while the
 * single declaration stays in `infra-cost.ts` where the REST schema can reach it
 * without pulling the AWS SDK into the OpenAPI generator.
 */
export { COST_EXPLORER_LOOKBACK_DAYS };

/**
 * The cost metric requested.
 *
 * `UnblendedCost` is what the Cost Explorer console shows by default and what an
 * operator diffing our chart against theirs will be looking at. `AmortizedCost`
 * spreads Reserved Instance and Savings Plan up-front fees across the term and
 * is the better number for a company that buys them — but it silently disagrees
 * with the console for everyone else, and a spend panel whose job is to be
 * checkable should match the thing it will be checked against.
 */
export const COST_EXPLORER_METRIC = 'UnblendedCost';

/** The two dimensions each daily bucket is grouped by. */
export const COST_EXPLORER_GROUP_BY = [
  { Type: 'DIMENSION', Key: 'SERVICE' },
  { Type: 'DIMENSION', Key: 'LINKED_ACCOUNT' },
] as const;

/** The one call this module makes, narrowed so tests can supply a fake. */
export interface CostExplorerClientLike {
  send(command: GetCostAndUsageCommand): Promise<GetCostAndUsageCommandOutput>;
}

export interface InfraCostExplorerSyncOptions {
  nowMs?: number;
  /** Restrict the sweep to one project. Used by tests and by a targeted refresh. */
  projectId?: string;
  /** Injected client, bypassing the per-project factory. Tests only. */
  client?: CostExplorerClientLike;
  /** Bypass the cadence guard. Tests only — never wired to a request path. */
  ignoreCadence?: boolean;
}

/** Why one project was passed over, for the log line and the result counters. */
export type InfraCostExplorerSkipReason =
  | 'not_enabled'
  | 'too_soon'
  | 'paused'
  | 'no_monitoring_profile';

export interface InfraCostExplorerSyncResult {
  projectsConsidered: number;
  synced: number;
  failed: number;
  skipped: Record<InfraCostExplorerSkipReason, number>;
  pages: number;
  rowsWritten: number;
  estimatedCostUsd: number;
  truncated: boolean;
}

function emptyResult(): InfraCostExplorerSyncResult {
  return {
    projectsConsidered: 0,
    synced: 0,
    failed: 0,
    skipped: { not_enabled: 0, too_soon: 0, paused: 0, no_monitoring_profile: 0 },
    pages: 0,
    rowsWritten: 0,
    estimatedCostUsd: 0,
    truncated: false,
  };
}

/**
 * `YYYY-MM-DD` for an epoch, in **UTC**.
 *
 * UTC because that is the calendar Cost Explorer buckets on and the calendar AWS
 * bills on. Deriving the day through the Hub's local timezone would shift every
 * bucket by up to a day, so a re-sync from a host in another zone would write a
 * second copy of the same spend under a neighbouring date.
 */
export function utcDayString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Milliseconds in a day, for window arithmetic that never crosses a DST seam. */
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CostExplorerWindow {
  /** Inclusive `YYYY-MM-DD` start. */
  startDay: string;
  /** Exclusive `YYYY-MM-DD` end. */
  endDay: string;
}

/**
 * The `TimePeriod` for a sync ending at `nowMs`.
 *
 * The end is **tomorrow**, not today. Cost Explorer's end date is exclusive
 * ("if start is 2017-01-01 and end is 2017-05-01, then the data is retrieved
 * from 2017-01-01 up to and including 2017-04-30"), so an end of today would
 * stop at yesterday and the panel would never show month-to-date spend — the
 * number the operator actually opened the page for. Today's bucket comes back
 * flagged `Estimated`, which is carried through to the row rather than hidden.
 */
export function costExplorerWindow(
  nowMs: number,
  lookbackDays: number = COST_EXPLORER_LOOKBACK_DAYS,
): CostExplorerWindow {
  const endMs = nowMs + DAY_MS;
  return {
    startDay: utcDayString(endMs - lookbackDays * DAY_MS),
    endDay: utcDayString(endMs),
  };
}

/**
 * Flatten one CE response page into cache rows.
 *
 * The group keys are matched positionally against the response's **own**
 * `GroupDefinitions`, not against the order we sent. AWS echoes the definitions
 * back precisely so a client does not have to assume, and assuming is how
 * service names and account ids end up swapped in the chart the day AWS decides
 * to normalize the order.
 *
 * Everything in a CE response is a string, including the amount. `Number()` on
 * an absent or unparseable amount yields `NaN`, which would poison every `SUM`
 * downstream, so an unparseable bucket is dropped rather than stored.
 */
export function parseCostExplorerPage(page: GetCostAndUsageCommandOutput): InfraCostDailyRow[] {
  const definitions = page.GroupDefinitions ?? [];
  const serviceIndex = definitions.findIndex((d) => d.Key === 'SERVICE');
  const accountIndex = definitions.findIndex((d) => d.Key === 'LINKED_ACCOUNT');
  const rows: InfraCostDailyRow[] = [];

  for (const result of page.ResultsByTime ?? []) {
    const day = result.TimePeriod?.Start;
    if (!day) continue;
    const estimated = result.Estimated === true;

    for (const group of result.Groups ?? []) {
      const keys = group.Keys ?? [];
      const metric = group.Metrics?.[COST_EXPLORER_METRIC];
      const amount = Number(metric?.Amount);
      if (!Number.isFinite(amount)) continue;

      rows.push({
        day,
        // A group with no service key is not dropped: its spend is real and has
        // to land somewhere, and a bucket silently discarded is a bill that does
        // not add up. It is labelled instead.
        service: (serviceIndex >= 0 ? keys[serviceIndex] : undefined) || 'Unattributed',
        linkedAccount: (accountIndex >= 0 ? keys[accountIndex] : undefined) || '',
        amountUsd: amount,
        unit: metric?.Unit || 'USD',
        estimated,
      });
    }
  }
  return rows;
}

/** Whether enough time has passed since the last sync for another to be allowed. */
export function isCostExplorerSyncDue(
  lastSyncedAtMs: number | null,
  nowMs: number,
  minIntervalMs: number = MIN_COST_EXPLORER_SYNC_INTERVAL_MS,
): boolean {
  if (lastSyncedAtMs === null) return true;
  // A future-dated stamp means the host clock moved backwards. Treating it as
  // "due" would let every tick spend until the clock caught up, so it is treated
  // as a sync that just happened — the direction that cannot overspend.
  if (lastSyncedAtMs > nowMs) return false;
  return nowMs - lastSyncedAtMs >= minIntervalMs;
}

interface SyncProjectOutcome {
  pages: number;
  rowsWritten: number;
  estimatedCostUsd: number;
  truncated: boolean;
}

async function syncProject(
  projectId: string,
  profileName: string,
  client: CostExplorerClientLike,
  nowMs: number,
): Promise<SyncProjectOutcome> {
  const window = costExplorerWindow(nowMs);
  const runId = randomUUID();
  // Stamped before the first billed call. A sync that dies partway has still
  // spent money, and a stamp written only on success would let a crash loop
  // re-issue the whole sweep on the very next tick.
  recordCostExplorerSyncStart(projectId, nowMs);
  startInfraCollectRun({
    id: runId,
    projectId,
    region: null,
    startedAt: nowMs,
    kind: 'cost_explorer',
  });

  const outcome: SyncProjectOutcome = {
    pages: 0,
    rowsWritten: 0,
    estimatedCostUsd: 0,
    truncated: false,
  };
  const rows: InfraCostDailyRow[] = [];
  let nextPageToken: string | undefined;

  try {
    do {
      const input: GetCostAndUsageCommandInput = {
        TimePeriod: { Start: window.startDay, End: window.endDay },
        Granularity: 'DAILY',
        Metrics: [COST_EXPLORER_METRIC],
        // Two groups is the documented maximum ("You can group AWS costs using
        // up to two different groups"), so this is the whole grain budget spent
        // on the two dimensions the panel needs.
        GroupBy: COST_EXPLORER_GROUP_BY.map((g) => ({ Type: g.Type, Key: g.Key })),
        NextPageToken: nextPageToken,
      };
      const page = await client.send(new GetCostAndUsageCommand(input));

      // Charged the moment AWS answers, so it is recorded the moment AWS
      // answers — before the page is even parsed.
      outcome.pages += 1;
      outcome.estimatedCostUsd += COST_EXPLORER_USD_PER_REQUEST;
      recordInfraCollectRunProgress(runId, {
        queriesIssued: 1,
        estimatedCostUsd: COST_EXPLORER_USD_PER_REQUEST,
      });

      rows.push(...parseCostExplorerPage(page));
      nextPageToken = page.NextPageToken;

      if (nextPageToken && outcome.pages >= MAX_COST_EXPLORER_PAGES) {
        outcome.truncated = true;
        console.warn(
          `[infra-cost-explorer] ${projectId}: stopped at the ${MAX_COST_EXPLORER_PAGES}-page cap ` +
            `with more results available; the ${window.startDay}..${window.endDay} window is incomplete`,
        );
        break;
      }
    } while (nextPageToken);

    replaceInfraCostDailyWindow({
      projectId,
      profileName,
      startDay: window.startDay,
      endDay: window.endDay,
      rows,
      fetchedAt: nowMs,
    });
    outcome.rowsWritten = rows.length;

    finishInfraCollectRun(runId, {
      finishedAt: Date.now(),
      status: outcome.truncated ? 'partial' : 'ok',
      errorMessage: outcome.truncated
        ? `Stopped at the ${MAX_COST_EXPLORER_PAGES}-page cap; window is incomplete`
        : null,
    });
    return outcome;
  } catch (err) {
    // The run row carries the reason so an operator who opted in and sees no
    // chart can find out why without a log grep. DataUnavailableException here
    // usually means Cost Explorer has never been enabled in the account — a
    // one-click console action, and not something an IAM grant can fix.
    recordInfraCollectRunProgress(runId, { errors: 1 });
    finishInfraCollectRun(runId, {
      finishedAt: Date.now(),
      status: 'failed',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Refresh the Cost Explorer cache for every opted-in project.
 *
 * Never throws: one project's expired role or disabled Cost Explorer must not
 * starve every other project of its spend trend, which is the same per-scope
 * isolation the inventory sweep holds to.
 */
export async function runInfraCostExplorerSync(
  opts: InfraCostExplorerSyncOptions = {},
): Promise<InfraCostExplorerSyncResult> {
  const result = emptyResult();
  // Scheduled unconditionally at boot; infra.db only exists once initInfraDb has
  // run. A no-op beats a thrown tick on a Hub that never opened the store.
  if (!isInfraDbInitialized()) return result;

  const nowMs = opts.nowMs ?? Date.now();
  const projects = opts.projectId ? [opts.projectId] : listCostExplorerEnabledProjects();
  result.projectsConsidered = projects.length;

  for (const projectId of projects) {
    const config = getInfraCostConfig(projectId);
    if (!config.costExplorerEnabled) {
      result.skipped.not_enabled += 1;
      continue;
    }
    if (!opts.ignoreCadence && !isCostExplorerSyncDue(config.costExplorerSyncedAt, nowMs)) {
      result.skipped.too_soon += 1;
      continue;
    }
    // Resolved rather than read off the config row, because the stored level is
    // what the *collector* last acted on and this sweep runs on its own cron —
    // between two collector ticks a project can cross the ceiling, and spending
    // here on a stale 'normal' is exactly the leak the ceiling exists to stop.
    if (resolveProjectDegradation(projectId, nowMs).level === 'paused') {
      result.skipped.paused += 1;
      continue;
    }

    let profileName: string;
    try {
      profileName = requireProjectMonitoringProfile(projectId);
    } catch {
      result.skipped.no_monitoring_profile += 1;
      continue;
    }

    try {
      const client = opts.client ?? getProjectCostExplorerClient(projectId);
      const outcome = await syncProject(projectId, profileName, client, nowMs);
      result.synced += 1;
      result.pages += outcome.pages;
      result.rowsWritten += outcome.rowsWritten;
      result.estimatedCostUsd += outcome.estimatedCostUsd;
      result.truncated = result.truncated || outcome.truncated;
    } catch (err) {
      result.failed += 1;
      console.warn(
        `[infra-cost-explorer] ${projectId} failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return result;
}
