import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Loader2 } from 'lucide-react';

import {
  fleetResourceTitle,
  formatHeadlineValue,
  infraServiceLabel,
  sparklinePolyline,
  type InfraFleetMetricWire,
  type InfraFleetResourceWire,
  type InfraFleetWire,
} from '@shared/utils/infraFleet';
import { infraResourceHealth } from '@shared/utils/infraResourceState';
import { formatAgo } from '@shared/utils/relativeTime';
import { api } from '../../utils/api.js';

const POLL_MS = 60_000;

/**
 * Windows the dashboard offers.
 *
 * Deliberately shorter than the Metrics tab's 1h–90d range. This surface
 * answers "what is happening", and a 90-day sparkline in a 40-pixel tile
 * answers nothing; the Metrics tab is where a long window belongs.
 */
const WINDOWS: ReadonlyArray<{ label: string; ms: number }> = [
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '3h', ms: 3 * 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
];

const SPARK_WIDTH = 96;
const SPARK_HEIGHT = 26;

/** What a card hands the Metrics tab. Matches the browser's own selection shape. */
export interface InfraFleetSelection {
  resourceKey: string;
  resourceId: string;
  name: string | null;
  service: string;
  region: string;
  metricDimensions: Record<string, unknown> | null;
  features: Record<string, unknown> | null;
}

export interface InfraFleetDashboardProps {
  projectId: string;
  /** Deep-link into the Metrics tab for one resource. */
  onSelectResource?: (resource: InfraFleetSelection) => void;
}

function MetricTile({ metric }: { metric: InfraFleetMetricWire }): React.ReactElement {
  const polyline = sparklinePolyline(metric.points, SPARK_WIDTH, SPARK_HEIGHT);
  const hasReading = metric.latest != null;

  return (
    <div className="min-w-0 flex-1" data-testid={`infra-fleet-metric-${metric.metricName}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[11px] text-gray-500" title={metric.description}>
          {metric.label}
        </span>
        <span
          className={`shrink-0 text-sm tabular-nums ${hasReading ? 'text-gray-200' : 'text-gray-600'}`}
        >
          {formatHeadlineValue(metric.latest, metric.unit)}
        </span>
      </div>
      <div className="mt-1 h-[26px]">
        {polyline ? (
          <svg
            viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
            preserveAspectRatio="none"
            className="h-full w-full"
            role="img"
            aria-label={`${metric.label} trend`}
          >
            <polyline
              points={polyline}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
              className="text-sky-400"
            />
          </svg>
        ) : (
          // One observation is a value, not a trend. A line drawn through it
          // would imply a slope nothing measured.
          <div className="flex h-full items-center">
            <div className="h-px w-full bg-gray-800" />
          </div>
        )}
      </div>
    </div>
  );
}

function ResourceCard({
  resource,
  onSelect,
}: {
  resource: InfraFleetResourceWire;
  onSelect?: InfraFleetDashboardProps['onSelectResource'];
}): React.ReactElement {
  // Three outcomes, not two. Flagging everything that is not `running` marks a
  // healthy ECS cluster (`ACTIVE`) as a fault, and flagging everything
  // unrecognised marks a normal RDS backup window as one — AWS publishes no
  // closed enum for `DBInstanceStatus`. So only a positively-known-bad state
  // gets the amber warning; an unclassified one is shown, greyed, as itself.
  const health = infraResourceHealth(resource.state);

  return (
    <button
      type="button"
      onClick={() =>
        onSelect?.({
          resourceKey: resource.resourceKey,
          resourceId: resource.resourceId,
          name: resource.name,
          service: resource.service,
          region: resource.region,
          metricDimensions: resource.metricDimensions,
          features: resource.features,
        })
      }
      // The card is a shortcut into the full Metrics tab, not the only way to
      // read a number: everything below is already on screen without it.
      className="w-full rounded-lg border border-gray-800 bg-gray-900/40 p-3 text-left transition hover:border-gray-700 hover:bg-gray-900/70"
      data-testid={`infra-fleet-card-${resource.resourceKey}`}
    >
      <div className="flex items-center gap-2">
        <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-medium text-gray-400">
          {infraServiceLabel(resource.service)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-gray-200">
          {fleetResourceTitle(resource)}
        </span>
        {health !== 'healthy' && resource.state && (
          <span
            className={`shrink-0 text-[10px] ${
              health === 'unhealthy' ? 'text-amber-400' : 'text-gray-500'
            }`}
            data-testid={`infra-fleet-state-${health}`}
          >
            {resource.state}
          </span>
        )}
      </div>
      <div className="mt-0.5 truncate text-[11px] text-gray-600">
        {resource.region}
        {resource.environment ? ` · ${resource.environment}` : ''}
      </div>
      <div className="mt-3 flex gap-4">
        {resource.metrics.length > 0 ? (
          resource.metrics.map((metric) => (
            <MetricTile key={`${metric.namespace}/${metric.metricName}`} metric={metric} />
          ))
        ) : (
          <span className="text-[11px] text-gray-600">no headline metrics for this resource</span>
        )}
      </div>
    </button>
  );
}

/**
 * The fleet dashboard: every EC2 instance, ECS cluster/service and RDS instance
 * in scope, each with its headline metrics already on screen.
 *
 * This exists because the Metrics tab answers the wrong question first. That
 * surface is one resource, one metric, one chart — the right shape for
 * investigating something and the wrong shape for *noticing* it, since
 * answering "is anything wrong" through it costs a click per resource and
 * another per metric. Nobody pays that, so the module gets read as an inventory
 * list and the metrics go unlooked-at.
 *
 * One request fills the whole grid (`GET /infra/fleet`). Building the same view
 * out of `/infra/metrics` would be resources × metrics round trips, which is
 * why the batch endpoint exists rather than a loop in here.
 *
 * Read-only, so no `showToast`: there is no write to succeed or fail.
 */
export default function InfraFleetDashboard({
  projectId,
  onSelectResource,
}: InfraFleetDashboardProps): React.ReactElement {
  const [data, setData] = useState<InfraFleetWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [windowMs, setWindowMs] = useState(WINDOWS[1].ms);
  // When the readings on screen were last actually fetched. Only advanced on a
  // successful read, so the age counts up while the grid is failing to refresh
  // and stale numbers cannot pass for current ones.
  const [loadedAtMs, setLoadedAtMs] = useState<number | null>(null);
  /**
   * Sequence numbers guarding which response is allowed to paint.
   *
   * `issuedSeq` stamps every individual read; `appliedSeq` is the highest one
   * that has already settled. A response is applied only when it is *newer*
   * than whatever is on screen, which covers two different races with one
   * counter:
   *
   *   - **Overlapping polls.** The 60s interval fires regardless of whether the
   *     previous read came back, so a slow request can still be in flight when
   *     the next one starts. Stamping the whole batch with a single generation
   *     lets both pass the guard, and if the slow one lands last it overwrites
   *     fresh readings with older ones — a dashboard silently showing the past.
   *   - **Project or window switches.** The effect below moves `appliedSeq` up
   *     to the last issued value, which retires every request already in
   *     flight, so a response for a project the operator has navigated away
   *     from cannot paint over the current one.
   *
   * A sequence rather than an `AbortSignal` because the fix has to be about
   * *which response wins*, not about cancelling work: an aborted fetch and a
   * superseded one both have to end in "do not paint", and only the ordering
   * check gets that right when a response is already in the microtask queue by
   * the time an abort would fire. `api.getInfraFleet` takes no signal today, so
   * plumbing one through would also widen the API layer for no extra safety.
   */
  const issuedSeq = useRef(0);
  const appliedSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++issuedSeq.current;
    // Whether this read is the one that painted, which is what decides if it
    // also owns clearing the spinner. A superseded read must not, or a stale
    // response would report the newer request's work as finished.
    let applied = false;
    const claim = (): boolean => {
      if (seq <= appliedSeq.current) return false;
      appliedSeq.current = seq;
      applied = true;
      return true;
    };

    api
      .getInfraFleet(projectId, { windowMs })
      .then((body) => {
        if (!claim()) return;
        setData(body);
        setLoadedAtMs(Date.now());
        setError(null);
      })
      .catch((err: unknown) => {
        if (!claim()) return;
        // The readings are deliberately kept on failure. Blanking the grid on a
        // transient blip throws away a still-useful last-known value; the
        // banner is what stops it being mistaken for current.
        setError(err instanceof Error ? err.message : 'Failed to load fleet metrics');
      })
      .finally(() => {
        if (applied) setLoading(false);
      });
  }, [projectId, windowMs]);

  useEffect(() => {
    // Retire everything already in flight: those responses describe the
    // previous project or window and must never reach this one.
    appliedSeq.current = issuedSeq.current;
    setData(null);
    setLoadedAtMs(null);
    // Cleared here even though a *refresh* failure deliberately keeps its
    // banner. The two cases are opposites: on a refresh the readings survive,
    // so the banner is what stops them passing for current, but a context
    // switch discards them — leaving the message behind would attribute one
    // project or window's failure to another, and it would say so until the
    // replacement request settles, which a slow or hung one never does.
    setError(null);
    setLoading(true);
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const resources = data?.resources ?? [];

  return (
    <section
      className="rounded-xl border border-gray-800 bg-gray-900/30 p-4"
      data-testid="infra-fleet-dashboard"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-2 text-sm font-medium text-gray-200">
          <Activity size={14} className="text-sky-400" />
          Fleet
          {loading && !data && <Loader2 size={12} className="animate-spin text-gray-600" />}
        </h3>
        <div className="inline-flex rounded-md border border-gray-800">
          {WINDOWS.map((option) => (
            <button
              key={option.label}
              type="button"
              onClick={() => setWindowMs(option.ms)}
              aria-pressed={windowMs === option.ms}
              className={`px-2 py-1 text-[11px] ${
                windowMs === option.ms
                  ? 'bg-gray-800 text-gray-200'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <p className="mt-2 text-xs text-amber-300" data-testid="infra-fleet-error">
          {error}
        </p>
      )}

      {/* Gated on a response, not on `!loading`. "Nothing is being polled" is a
          claim about the AWS account, and only the server is in a position to
          make it — a read that failed leaves the fleet unknown, and saying it
          is empty would send an operator to check a collection scope that may
          be entirely fine. With no data the error banner above stands alone. */}
      {data && resources.length === 0 ? (
        <p className="mt-3 text-xs text-gray-500" data-testid="infra-fleet-empty">
          No EC2, ECS or RDS resources are being polled yet. Add them to the collection scope above,
          then give the hourly describe sweep a cycle to find them.
        </p>
      ) : (
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {resources.map((resource) => (
            <ResourceCard
              key={resource.resourceKey}
              resource={resource}
              onSelect={onSelectResource}
            />
          ))}
        </div>
      )}

      {data && (
        <p className="mt-3 text-[11px] text-gray-600">
          {resources.length} resource{resources.length === 1 ? '' : 's'}
          {data.truncated && ' (more exist, narrow the scope or use the Resources tab)'}
          {loadedAtMs != null && ` · updated ${formatAgo(Date.now() - loadedAtMs)}`}
        </p>
      )}
    </section>
  );
}
