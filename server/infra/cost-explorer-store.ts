/**
 * The `infra_cost_daily` cache: writing what Cost Explorer returned, and reading
 * it back as a spend trend.
 *
 * This module is the reason the Overview tab is free to open. AWS's own
 * best-practices page asks for exactly this shape — *"we recommend architecting
 * the application so that it has a caching layer. This enables you to regularly
 * update the underlying data for your end users, but doesn't trigger queries
 * every time that an individual in your organization accesses it"* — and here
 * that is not a nicety: `GetCostAndUsage` bills $0.01 per paginated request with
 * no free tier, so a read path that hit AWS would charge a cent every time
 * someone refreshed a dashboard.
 *
 * So: {@link replaceInfraCostDailyWindow} is the only writer and only the poller
 * calls it; every read below touches SQLite and nothing else.
 *
 * ## Why the write is a window replace rather than an upsert
 *
 * Cost Explorer restates. A day comes back `Estimated: true` and settles over
 * the following days, line items get re-attributed, and a (day, service,
 * account) combination that had spend yesterday can legitimately have none
 * today. An upsert-only writer would leave that vanished row in place forever —
 * a phantom charge in the chart that no re-sync could ever clear, because the
 * only thing that would fix it is a row AWS has stopped sending. Deleting the
 * window and re-inserting it makes the cache a faithful mirror of the last
 * answer, which is the only definition under which "compare us to the console"
 * can succeed.
 *
 * The delete and the insert share one transaction, so a reader never observes
 * the window empty.
 *
 * The replace is also what keeps this table out of the retention reaper. Each
 * sync deletes exactly the window it is about to rewrite, so the row count
 * settles at roughly (days x services x accounts) and stays there no matter how
 * long the poller runs. `infra_metric_points` needs a reaper because it appends
 * forever; this table does not append at all.
 */

import { getInfraDb } from './infra-db.js';

/** One (day, service, linked account) bucket as Cost Explorer reported it. */
export interface InfraCostDailyRow {
  /** `YYYY-MM-DD`, UTC, exactly the string CE returned. */
  day: string;
  service: string;
  /** Member account id, or `''` for a standalone account CE did not attribute. */
  linkedAccount: string;
  amountUsd: number;
  unit: string;
  /** CE's `ResultByTime.Estimated`: the day has not finalized. */
  estimated: boolean;
}

export interface ReplaceInfraCostDailyWindow {
  projectId: string;
  profileName: string;
  /** Inclusive `YYYY-MM-DD` lower bound of the window being replaced. */
  startDay: string;
  /** **Exclusive** `YYYY-MM-DD` upper bound, matching CE's own `TimePeriod.End`. */
  endDay: string;
  rows: readonly InfraCostDailyRow[];
  fetchedAt: number;
}

/**
 * Swap one project/profile's cached window for a freshly fetched one.
 *
 * The window bounds are passed separately from the rows rather than derived from
 * them, and that is load-bearing: a window whose spend genuinely dropped to zero
 * returns **no rows at all**, and a delete bounded by `min(rows.day)` would then
 * delete nothing and leave the whole stale window standing. The bounds are what
 * we asked AWS about; the rows are what it answered.
 *
 * Bounds are half-open `[startDay, endDay)` so they can be handed straight to CE
 * as `TimePeriod` without an off-by-one adjustment in either direction.
 */
export function replaceInfraCostDailyWindow(input: ReplaceInfraCostDailyWindow): void {
  const db = getInfraDb();
  const del = db.prepare(
    `DELETE FROM infra_cost_daily
      WHERE project_id = ? AND profile_name = ? AND day >= ? AND day < ?`,
  );
  const ins = db.prepare(
    `INSERT INTO infra_cost_daily
       (project_id, profile_name, day, service, linked_account, amount_usd, unit, estimated, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, profile_name, day, service, linked_account) DO UPDATE SET
       amount_usd = excluded.amount_usd,
       unit       = excluded.unit,
       estimated  = excluded.estimated,
       fetched_at = excluded.fetched_at`,
  );

  db.transaction(() => {
    del.run(input.projectId, input.profileName, input.startDay, input.endDay);
    for (const row of input.rows) {
      // The ON CONFLICT arm above is unreachable after the delete for any row
      // inside the window, and is here for the one row that can fall outside it:
      // CE occasionally returns a bucket on the exclusive end boundary. Letting
      // that row update rather than throw keeps one boundary quirk from failing
      // the whole transaction and stranding the window mid-replace.
      ins.run(
        input.projectId,
        input.profileName,
        row.day,
        row.service,
        row.linkedAccount,
        row.amountUsd,
        row.unit,
        row.estimated ? 1 : 0,
        input.fetchedAt,
      );
    }
  })();
}

/** Total spend for one day, across every service and linked account. */
export interface InfraSpendDay {
  day: string;
  amountUsd: number;
  /** True when any bucket in the day is still estimated, so the bar will move. */
  estimated: boolean;
}

/** Spend attributed to one service over the whole queried window. */
export interface InfraSpendService {
  service: string;
  amountUsd: number;
}

/** Spend attributed to one linked (member) account over the whole window. */
export interface InfraSpendAccount {
  linkedAccount: string;
  amountUsd: number;
}

export interface InfraSpendTrend {
  /** Every day in the cache within the window, oldest first — plot order. */
  days: InfraSpendDay[];
  /** Services, most expensive first, already truncated to the requested top-N. */
  topServices: InfraSpendService[];
  /** Linked accounts, most expensive first. Empty for a standalone account. */
  accounts: InfraSpendAccount[];
  /** Window total. Includes services beyond the top-N, unlike `topServices`. */
  totalUsd: number;
  /** Currency CE reported. `null` when the cache is empty. */
  unit: string | null;
  /** Newest `fetched_at` in the window; `null` when nothing is cached. */
  fetchedAt: number | null;
}

/** Default number of services the top-N panel shows. */
export const DEFAULT_TOP_SERVICES = 5;

/** Upper bound on the top-N, so a caller cannot ask for the whole bill as a list. */
export const MAX_TOP_SERVICES = 25;

export interface QueryInfraSpendTrendOptions {
  projectId: string;
  profileName?: string | null;
  /** Inclusive `YYYY-MM-DD` lower bound. */
  startDay: string;
  /** Exclusive `YYYY-MM-DD` upper bound. */
  endDay: string;
  topServices?: number;
}

/**
 * Read the cached window back as a trend plus its top spenders.
 *
 * Three aggregations rather than one, because they answer three questions at
 * three different grains and folding them into one pass would mean the caller
 * re-grouping in JavaScript what SQLite groups better. All three ride the same
 * `(project_id, day)` index over the same bounded window.
 *
 * `totalUsd` is summed independently rather than taken from the top-N. Deriving
 * it from a truncated list is how a dashboard ends up claiming a $40 month on a
 * $200 bill — the summary number has to include the long tail the panel omits.
 */
export function queryInfraSpendTrend(opts: QueryInfraSpendTrendOptions): InfraSpendTrend {
  const db = getInfraDb();
  const limit = Math.min(
    Math.max(1, Math.floor(opts.topServices ?? DEFAULT_TOP_SERVICES)),
    MAX_TOP_SERVICES,
  );

  // A project has one monitoring profile at a time, but the cache outlives a
  // profile rename. Filtering when the caller names one and not otherwise means
  // "show me everything cached" stays expressible, which is what the read
  // endpoint wants when the project currently has no usable profile at all.
  const profileClause = opts.profileName ? ' AND profile_name = ?' : '';
  const params: unknown[] = [opts.projectId, opts.startDay, opts.endDay];
  if (opts.profileName) params.push(opts.profileName);
  const where = `WHERE project_id = ? AND day >= ? AND day < ?${profileClause}`;

  const dayRows = db
    .prepare(
      `SELECT day,
              SUM(amount_usd) AS amount,
              MAX(estimated)  AS estimated
         FROM infra_cost_daily
         ${where}
        GROUP BY day
        ORDER BY day ASC`,
    )
    .all(...params) as Array<{ day: string; amount: number | null; estimated: number | null }>;

  const serviceRows = db
    .prepare(
      `SELECT service, SUM(amount_usd) AS amount
         FROM infra_cost_daily
         ${where}
        GROUP BY service
        ORDER BY amount DESC, service ASC
        LIMIT ?`,
    )
    .all(...params, limit) as Array<{ service: string; amount: number | null }>;

  const accountRows = db
    .prepare(
      `SELECT linked_account, SUM(amount_usd) AS amount
         FROM infra_cost_daily
         ${where} AND linked_account <> ''
        GROUP BY linked_account
        ORDER BY amount DESC, linked_account ASC`,
    )
    .all(...params) as Array<{ linked_account: string; amount: number | null }>;

  const totals = db
    .prepare(
      `SELECT SUM(amount_usd) AS amount, MAX(fetched_at) AS fetched_at
         FROM infra_cost_daily
         ${where}`,
    )
    .get(...params) as { amount: number | null; fetched_at: number | null };

  // One extra single-row read rather than carrying `unit` through three
  // GROUP BYs. Taking the most recent row's unit is right because a billing
  // currency is an account setting: mixed units in one window would mean the
  // account changed currency mid-window, and the newest answer is the live one.
  const unitRow = db
    .prepare(
      `SELECT unit FROM infra_cost_daily
         ${where}
        ORDER BY day DESC LIMIT 1`,
    )
    .get(...params) as { unit: string } | undefined;

  return {
    days: dayRows.map((r) => ({
      day: r.day,
      amountUsd: r.amount ?? 0,
      estimated: (r.estimated ?? 0) === 1,
    })),
    topServices: serviceRows.map((r) => ({ service: r.service, amountUsd: r.amount ?? 0 })),
    accounts: accountRows.map((r) => ({
      linkedAccount: r.linked_account,
      amountUsd: r.amount ?? 0,
    })),
    totalUsd: totals?.amount ?? 0,
    unit: unitRow?.unit ?? null,
    fetchedAt: totals?.fetched_at ?? null,
  };
}
