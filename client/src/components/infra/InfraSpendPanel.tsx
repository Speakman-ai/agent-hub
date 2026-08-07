/**
 * Cost Explorer spend trends, on the Infrastructure Overview tab.
 *
 * The scope editor beside this panel answers "what will polling AWS cost me".
 * This panel answers the different and larger question, "what is AWS actually
 * charging me", and the two are deliberately adjacent: an operator weighing a
 * wider allowlist should be able to see the bill it lands on.
 *
 * Three things here are deliberate rather than incidental:
 *
 * The feature is opt-in and stays opt-in. `GetCostAndUsage` is billed at a cent
 * per paginated request with no free tier, so turning this on spends the
 * operator's money on a recurring basis. The opt-in card states that price
 * before the toggle, not after it.
 *
 * Reads are free. `GET /infra/spend` never calls AWS; it serves a cache a cron
 * fills at most three times a day (the cadence AWS's own billing data updates
 * at). So this panel polls on the same 60s interval as every other infra
 * surface without that costing anything, and "several hours old" is the normal
 * state of the numbers rather than a fault to flag.
 *
 * Bars, not a line. `buildChartGeometry` is right next door and would draw a
 * polyline in fewer lines, but daily spend is a discrete bucket rather than a
 * sampled continuum: a line between Monday and Tuesday claims a value for
 * Monday lunchtime that nothing measured. Bars also carry a per-day mark, which
 * is what the estimated/settled distinction needs and what a single stroke
 * cannot express. The bucketing is the shared `buildSpendBars`, so the phone
 * plots the same columns.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, DollarSign, Loader2 } from 'lucide-react';
import {
  COST_EXPLORER_OPT_IN_COPY,
  buildSpendBars,
  formatMoney,
  spendFailureHint,
  spendStalenessLabel,
  spendTrendSummary,
  type InfraSpendTrendWire,
} from '@shared/utils/infraSpend';
import { api } from '../../utils/api';

/** Poll interval, matching the rest of the infra module. The read is free. */
const POLL_MS = 60_000;

/** Trend window and ranked-list depth. One sync fetches about this much. */
const SPEND_DAYS = 30;
const TOP_SERVICES = 5;

/** Columns in the plot. A 30 day window draws one bar per day inside this. */
const BAR_COUNT = 45;

const VIEW_WIDTH = 720;
const VIEW_HEIGHT = 150;
const PAD_TOP = 8;
const PAD_BOTTOM = 18;

export interface InfraSpendPanelProps {
  projectId: string;
  showToast?: (message: string, type?: string) => void;
}

export default function InfraSpendPanel({
  projectId,
  showToast,
}: InfraSpendPanelProps): React.ReactElement {
  const [trend, setTrend] = useState<InfraSpendTrendWire | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Guards every settle against a project switch: a slow response must never
  // report one project's AWS bill under another project's header.
  const generation = useRef(0);

  const load = useCallback(() => {
    if (!projectId) return;
    const gen = generation.current;
    setLoading(true);
    api
      .getInfraSpend(projectId, { days: SPEND_DAYS, topServices: TOP_SERVICES })
      .then((response) => {
        if (generation.current !== gen) return;
        setTrend(response ?? null);
        setNowMs(Date.now());
        setError(null);
      })
      .catch((err: any) => {
        if (generation.current !== gen) return;
        setError(err?.message || 'Spend could not be loaded.');
      })
      .finally(() => {
        if (generation.current === gen) setLoading(false);
      });
  }, [projectId]);

  useEffect(() => {
    generation.current += 1;
    setTrend(null);
    setError(null);
    // `saving` is local widget state, not fetched data, so the generation guard
    // must not be what clears it. An in-flight config write whose project
    // changes under it never reaches a matching generation again, so its
    // `finally` is skipped and the new project's buttons would stay disabled
    // forever with no way back. Clearing it here is also why that `finally` can
    // stay guarded: an old request must never re-enable a button belonging to a
    // save that started after the switch.
    setSaving(false);
    load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const setEnabled = (enabled: boolean) => {
    if (!projectId || saving) return;
    const gen = generation.current;
    setSaving(true);
    api
      .updateInfraSpendConfig(projectId, { enabled })
      .then((response) => {
        if (generation.current !== gen) return;
        // The endpoint answers with the same spend body, so the panel repaints
        // from the response rather than issuing a second read.
        setTrend(response ?? null);
        setNowMs(Date.now());
        setError(null);
        showToast?.(
          enabled ? 'Cost Explorer polling enabled' : 'Cost Explorer polling disabled',
          'success',
        );
      })
      .catch((err: any) => {
        if (generation.current !== gen) return;
        const message = err?.message || 'The Cost Explorer setting could not be saved.';
        setError(message);
        showToast?.(message, 'error');
      })
      .finally(() => {
        if (generation.current === gen) setSaving(false);
      });
  };

  const header = (
    <header className="mb-3 flex items-center gap-2">
      <DollarSign size={15} className="text-gray-400" />
      <h3 className="text-sm font-medium text-gray-200">AWS spend</h3>
      {loading && <Loader2 size={13} className="animate-spin text-gray-500" aria-label="Loading" />}
    </header>
  );

  if (!trend) {
    return (
      <section
        className="rounded-xl border border-gray-800 bg-gray-900/40 p-4"
        data-testid="infra-spend-panel"
      >
        {header}
        {error ? (
          <p
            className="rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300"
            data-testid="infra-spend-error"
            role="alert"
          >
            {error}
          </p>
        ) : (
          <p className="text-xs text-gray-500">Loading spend…</p>
        )}
      </section>
    );
  }

  if (!trend.enabled) {
    return (
      <section
        className="rounded-xl border border-gray-800 bg-gray-900/40 p-4"
        data-testid="infra-spend-panel"
      >
        {header}
        <div data-testid="infra-spend-optin">
          <p className="text-xs leading-5 text-gray-400">
            Agent Hub can chart what AWS actually billed this account, per day and per service, next
            to what collection is projected to cost.
          </p>
          <p className="mt-2 text-xs leading-5 text-amber-400">{COST_EXPLORER_OPT_IN_COPY.price}</p>
          <p className="mt-1 text-xs leading-5 text-gray-500">
            {COST_EXPLORER_OPT_IN_COPY.cadence}
          </p>
          <p className="mt-1 text-xs leading-5 text-gray-500">
            {COST_EXPLORER_OPT_IN_COPY.estimates}
          </p>
          <button
            type="button"
            onClick={() => setEnabled(true)}
            disabled={saving}
            className="mt-3 inline-flex items-center gap-1.5 rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
            data-testid="infra-spend-enable"
          >
            {saving && <Loader2 size={13} className="animate-spin" />}
            Turn on Cost Explorer polling
          </button>
        </div>
        {error && (
          <p
            className="mt-3 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300"
            data-testid="infra-spend-error"
            role="alert"
          >
            {error}
          </p>
        )}
      </section>
    );
  }

  const summary = spendTrendSummary(trend);
  const plot = buildSpendBars(trend.days, BAR_COUNT);
  const money = (value: number | null | undefined) => formatMoney(value, trend.unit);
  const failed = trend.lastRun?.status === 'failed';
  const hint = failed ? spendFailureHint(trend.lastRun?.errorMessage) : null;

  const plotHeight = VIEW_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const columnWidth = plot.bars.length > 0 ? VIEW_WIDTH / plot.bars.length : VIEW_WIDTH;
  const barWidth = Math.max(1, columnWidth - 2);

  return (
    <section
      className="rounded-xl border border-gray-800 bg-gray-900/40 p-4"
      data-testid="infra-spend-panel"
    >
      {header}

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-semibold text-gray-100" data-testid="infra-spend-total">
          {money(summary.totalUsd)}
        </span>
        <span className="text-xs text-gray-500">
          over {summary.dayCount || SPEND_DAYS} days ({trend.windowStartDay} to {trend.windowEndDay}
          )
        </span>
        <span className="ml-auto text-[11px] text-gray-500" data-testid="infra-spend-staleness">
          {spendStalenessLabel(trend.syncedAt, trend.fetchedAt, nowMs)}
        </span>
      </div>

      {error && (
        <p
          className="mt-3 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300"
          data-testid="infra-spend-error"
          role="alert"
        >
          {error}
        </p>
      )}

      {failed && (
        <div
          className="mt-3 rounded-lg border border-red-900/60 bg-red-950/20 px-3 py-2 text-xs leading-5 text-red-300"
          data-testid="infra-spend-failed"
          role="alert"
        >
          <span className="flex items-center gap-1.5 font-medium">
            <AlertTriangle size={12} />
            The last Cost Explorer sync failed.
          </span>
          <p className="mt-1 break-words">
            {trend.lastRun?.errorMessage || 'AWS returned no reason.'}
          </p>
          {hint && (
            <p className="mt-1 text-amber-300" data-testid="infra-spend-data-unavailable">
              {hint}
            </p>
          )}
        </div>
      )}

      {plot.hasData ? (
        <div className="mt-3 rounded-lg border border-gray-800 bg-gray-950/50 p-3">
          <svg
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            className="h-36 w-full"
            role="img"
            aria-label="Daily AWS spend"
            data-testid="infra-spend-chart"
          >
            <defs>
              {/* Colour alone cannot carry "this number will still move", so an
                  estimated day is hatched as well as tinted, and the legend
                  below says what the hatching means in words. */}
              <pattern
                id="infra-spend-estimated"
                width={4}
                height={4}
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width={4} height={4} fill="rgba(56,189,248,0.18)" />
                <line x1={0} y1={0} x2={0} y2={4} stroke="#38bdf8" strokeWidth={1.5} />
              </pattern>
            </defs>

            <line
              x1={0}
              x2={VIEW_WIDTH}
              y1={PAD_TOP + plotHeight}
              y2={PAD_TOP + plotHeight}
              stroke="rgba(75,85,99,0.5)"
              strokeWidth={1}
            />

            {plot.bars.map((bar, index) => {
              // Floored above zero so a day with a real but tiny charge still
              // draws: a bar of height 0 is indistinguishable from a day that
              // was never billed.
              const height = Math.max(bar.amountUsd > 0 ? 1.5 : 0, bar.height * plotHeight);
              return (
                <rect
                  key={`${bar.day}-${index}`}
                  x={index * columnWidth + 1}
                  y={PAD_TOP + plotHeight - height}
                  width={barWidth}
                  height={height}
                  fill={bar.estimated ? 'url(#infra-spend-estimated)' : '#38bdf8'}
                  data-testid={bar.estimated ? 'infra-spend-bar-estimated' : 'infra-spend-bar'}
                >
                  <title>{`${bar.day}: ${money(bar.amountUsd)}${bar.estimated ? ' (estimated)' : ''}`}</title>
                </rect>
              );
            })}

            <text x={0} y={VIEW_HEIGHT - 4} fill="#9ca3af" fontSize={10}>
              {plot.bars[0]?.day ?? trend.windowStartDay}
            </text>
            <text x={VIEW_WIDTH} y={VIEW_HEIGHT - 4} fill="#9ca3af" fontSize={10} textAnchor="end">
              {plot.bars[plot.bars.length - 1]?.day ?? trend.windowEndDay}
            </text>
          </svg>

          <p className="mt-1 text-[11px] leading-5 text-gray-500" data-testid="infra-spend-legend">
            Peak day {money(plot.maxUsd)}. Hatched columns are AWS estimates rather than settled
            charges and will still move.{' '}
            {summary.latestEstimated ? 'The most recent day is always an estimate.' : ''}
          </p>
        </div>
      ) : (
        <p
          className="mt-3 rounded-lg border border-dashed border-gray-800 px-3 py-4 text-center text-xs text-gray-500"
          data-testid="infra-spend-empty"
        >
          No charges cached for this window yet. The sync runs a few times a day, and a newly
          enabled account can take up to 24 hours to report anything.
        </p>
      )}

      {(trend.topServices.length > 0 || summary.otherUsd > 0) && (
        <div className="mt-3" data-testid="infra-spend-services">
          <h4 className="text-xs font-medium text-gray-300">Top services</h4>
          <ul className="mt-1.5 space-y-1">
            {trend.topServices.map((service) => (
              <li
                key={service.service}
                className="flex items-baseline justify-between gap-3 text-xs"
                data-testid="infra-spend-service-row"
              >
                <span className="truncate text-gray-300">{service.service}</span>
                <span className="tabular-nums text-gray-200">{money(service.amountUsd)}</span>
              </li>
            ))}
            {/* Without this row the list sums to less than the total beside it,
                and a truncated ranked list that quietly understates the bill is
                the failure this panel most has to avoid. */}
            {summary.otherUsd > 0 && (
              <li
                className="flex items-baseline justify-between gap-3 border-t border-gray-800 pt-1 text-xs"
                data-testid="infra-spend-other"
              >
                <span className="text-gray-400">
                  Other services (not in the top {trend.topServices.length || TOP_SERVICES})
                </span>
                <span className="tabular-nums text-gray-300">{money(summary.otherUsd)}</span>
              </li>
            )}
          </ul>
        </div>
      )}

      {trend.accounts.length > 0 && (
        <div className="mt-3" data-testid="infra-spend-accounts">
          <h4 className="text-xs font-medium text-gray-300">By linked account</h4>
          <ul className="mt-1.5 space-y-1">
            {trend.accounts.map((account) => (
              <li
                key={account.linkedAccount}
                className="flex items-baseline justify-between gap-3 text-xs"
                data-testid="infra-spend-account-row"
              >
                <span className="truncate font-mono text-gray-300">{account.linkedAccount}</span>
                <span className="tabular-nums text-gray-200">{money(account.amountUsd)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 border-t border-gray-800 pt-3">
        <button
          type="button"
          onClick={() => setEnabled(false)}
          disabled={saving}
          className="rounded border border-gray-700 bg-gray-900 px-2.5 py-1.5 text-xs text-gray-300 hover:border-gray-600 disabled:opacity-40"
          data-testid="infra-spend-disable"
        >
          Turn off Cost Explorer polling
        </button>
        <span className="text-[11px] leading-5 text-gray-500">
          {COST_EXPLORER_OPT_IN_COPY.price} {COST_EXPLORER_OPT_IN_COPY.cadence}
        </span>
      </div>
    </section>
  );
}
