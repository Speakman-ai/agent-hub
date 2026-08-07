import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Gauge, Loader2 } from 'lucide-react';

import {
  formatQuotaHeadroom,
  formatQuotaUtilization,
  quotaBandLabel,
  quotaBandTone,
  quotaBarPercent,
  quotaRefreshFailureNote,
  quotaSummaryLine,
  quotaUnknownReason,
  type QuotaBandTone,
  type QuotaHeadroomResponse,
  type QuotaHeadroomWire,
} from '@shared/utils/quotaHeadroom';
import { api } from '../../utils/api.js';

const POLL_MS = 60_000;

/**
 * How many quotas the panel lists before collapsing the tail.
 *
 * The list is sorted tightest-first, so the truncated tail is always the least
 * interesting rows. The count of what was hidden is still rendered — a silent
 * cut would read as "that is all of them".
 */
const VISIBLE_ROWS = 8;

const TONE_BAR: Record<QuotaBandTone, string> = {
  danger: 'bg-red-500',
  warn: 'bg-amber-500',
  good: 'bg-emerald-500',
  muted: 'bg-gray-700',
};

const TONE_TEXT: Record<QuotaBandTone, string> = {
  danger: 'text-red-300',
  warn: 'text-amber-300',
  good: 'text-gray-300',
  muted: 'text-gray-500',
};

export interface InfraQuotaHeadroomPanelProps {
  projectId: string;
}

/**
 * Service quota headroom on the Overview tab.
 *
 * The failure this surfaces is the one no other panel can: nothing is down, and
 * you still cannot launch anything, because the account has run out of a quota.
 *
 * Read-only by design, which is why it takes no `showToast`: there is no write
 * to succeed or fail. Everything here is derived from the collection scope and
 * the hourly quota sweep, and the one action a full quota calls for — requesting
 * an increase — is an AWS-side write this integration deliberately cannot make.
 */
export default function InfraQuotaHeadroomPanel({
  projectId,
}: InfraQuotaHeadroomPanelProps): React.ReactElement {
  const [data, setData] = useState<QuotaHeadroomResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // When the readings on screen were last actually fetched, and the clock the
  // age is measured against. Both advance on every poll, successful or not, so
  // the staleness banner counts up while the panel is failing to refresh.
  const [loadedAtMs, setLoadedAtMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Stamps each in-flight read so a response for a project the operator has
  // already navigated away from cannot paint over the current one.
  const generation = useRef(0);

  const load = useCallback(() => {
    const gen = generation.current;
    const fail = (err: unknown) => {
      // The readings are deliberately kept. Clearing them would blank the panel
      // on any transient blip and throw away a still-useful last-known value;
      // the banner below is what stops them being mistaken for current.
      setError(err instanceof Error ? err.message : 'Failed to load quota headroom');
      setNowMs(Date.now());
    };
    // Wrapped because a synchronous throw here escapes the promise chain and
    // unmounts the whole Overview tab. This panel is the last one on the tab and
    // the least critical; it must not be able to take the scope editor and the
    // spend panel down with it.
    let pending: Promise<QuotaHeadroomResponse>;
    try {
      pending = api.getInfraQuotas(projectId);
    } catch (err: unknown) {
      fail(err);
      return;
    }
    pending
      .then((body) => {
        if (generation.current !== gen) return;
        const at = Date.now();
        setData(body);
        setError(null);
        setLoadedAtMs(at);
        setNowMs(at);
      })
      .catch((err: unknown) => {
        if (generation.current !== gen) return;
        fail(err);
      });
  }, [projectId]);

  useEffect(() => {
    generation.current += 1;
    setData(null);
    setError(null);
    setExpanded(false);
    // Cleared with the data it describes: carrying the previous project's fetch
    // time forward would date the next project's readings to the wrong moment.
    setLoadedAtMs(null);
    load();
  }, [load]);

  useEffect(() => {
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const header = (
    <div className="mb-3 flex items-center gap-2">
      <Gauge size={15} className="text-gray-400" />
      <h3 className="text-sm font-medium text-gray-200">Service quota headroom</h3>
      {!data && !error ? (
        <Loader2 size={13} className="animate-spin text-gray-500" aria-label="Loading" />
      ) : null}
    </div>
  );

  if (!data) {
    return (
      <section
        className="rounded-xl border border-gray-800 bg-gray-900/40 p-4"
        data-testid="infra-quota-panel"
      >
        {header}
        {error ? (
          <p
            className="rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300"
            role="alert"
            data-testid="infra-quota-error"
          >
            {error}
          </p>
        ) : (
          <p className="text-xs text-gray-500">Loading quota headroom…</p>
        )}
      </section>
    );
  }

  const shown = expanded ? data.quotas : data.quotas.slice(0, VISIBLE_ROWS);
  const hidden = data.quotas.length - shown.length;
  const staleNote = quotaRefreshFailureNote(error, loadedAtMs, nowMs);

  return (
    <section
      className="rounded-xl border border-gray-800 bg-gray-900/40 p-4"
      data-testid="infra-quota-panel"
    >
      {header}

      {staleNote ? (
        // Amber, not red: the readings below are real, they have just stopped
        // being refreshed. Red would read as "these numbers are wrong", which
        // would be its own kind of lie.
        <p
          className="mb-3 rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs leading-5 text-amber-300"
          role="alert"
          data-testid="infra-quota-stale"
        >
          {staleNote}
        </p>
      ) : null}

      <p className="mb-3 text-xs text-gray-500" data-testid="infra-quota-summary">
        {quotaSummaryLine(data.summary)}
      </p>

      {data.quotas.length === 0 ? (
        <p
          className="rounded-lg border border-dashed border-gray-800 px-3 py-4 text-center text-xs text-gray-500"
          data-testid="infra-quota-empty"
        >
          No service quotas are being watched yet. Add a <span className="font-medium">quota</span>{' '}
          scope to collect <span className="font-mono">AWS/Usage</span> metrics. Only quotas AWS
          publishes a usage metric for can be measured, which is a minority of them.
        </p>
      ) : (
        <ul className="space-y-2.5" data-testid="infra-quota-list">
          {shown.map((quota) => (
            <QuotaRow key={quota.resourceKey} quota={quota} />
          ))}
        </ul>
      )}

      {hidden > 0 ? (
        <button
          type="button"
          className="mt-3 rounded border border-gray-700 bg-gray-900 px-2.5 py-1.5 text-xs text-gray-300 hover:border-gray-600"
          onClick={() => setExpanded(true)}
          data-testid="infra-quota-show-all"
        >
          Show {hidden} more
        </button>
      ) : null}

      {data.quotas.length > 0 ? (
        <p className="mt-3 text-[11px] leading-5 text-gray-600" data-testid="infra-quota-legend">
          Utilization is <span className="font-mono">{data.expression}</span>, the expression AWS
          documents, with the applied quota read from ListServiceQuotas. Rows turn amber above{' '}
          {data.thresholds.warning}% and red at {data.thresholds.critical}%. A quota can read over
          100%: a quota decrease applies immediately while existing resources keep running.
        </p>
      ) : null}
    </section>
  );
}

function QuotaRow({ quota }: { quota: QuotaHeadroomWire }): React.ReactElement {
  const tone = quotaBandTone(quota.band);
  const reason = quotaUnknownReason(quota);

  return (
    <li data-testid="infra-quota-row" data-band={quota.band}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-xs text-gray-300" title={quota.quotaName}>
          {quota.quotaName}
        </span>
        <span
          className={`shrink-0 text-xs tabular-nums ${TONE_TEXT[tone]}`}
          data-testid="infra-quota-utilization"
        >
          {formatQuotaUtilization(quota.utilizationPercent)}
        </span>
      </div>

      <div
        className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-800"
        role="img"
        aria-label={`${quota.quotaName}: ${formatQuotaUtilization(quota.utilizationPercent)} of quota used (${quotaBandLabel(quota.band)})`}
      >
        <div
          className={`h-full rounded-full ${TONE_BAR[tone]}`}
          style={{ width: `${quotaBarPercent(quota.utilizationPercent)}%` }}
        />
      </div>

      <div className="mt-1 flex items-center justify-between gap-3 text-[11px] text-gray-600">
        <span className="truncate">
          {quota.serviceCode} · {quota.region}
          {quota.adjustable ? '' : ' · not adjustable'}
        </span>
        {reason ? (
          <span className="shrink-0 text-gray-500" data-testid="infra-quota-unknown-reason">
            {reason}
          </span>
        ) : (
          <span className="shrink-0 tabular-nums" data-testid="infra-quota-remaining">
            {formatQuotaHeadroom(quota.headroom, quota.unit)} left
          </span>
        )}
      </div>
    </li>
  );
}
