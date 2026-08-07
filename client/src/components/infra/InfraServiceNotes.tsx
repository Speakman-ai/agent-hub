/**
 * What a service's pack says that a chart cannot.
 *
 * An empty Metrics tab has three quite different causes — the metric does not
 * exist for this instance type, it needs a monitoring mode nobody enabled, or
 * collection is broken — and all three render as the same blank rectangle. The
 * operator's first two questions about an EC2 instance are almost always "where
 * is memory" and "where is disk usage", and the honest answer (neither exists
 * from the hypervisor) is not discoverable from the chart. This panel says it.
 *
 * Presentational: the pack is a prop, fetched once by the page rather than per
 * mount, because the catalog is static and identical for every project.
 */
import { AlertTriangle, Info, Lock } from 'lucide-react';
import {
  featureNotices,
  metricCaveats,
  summarizeDefaultRule,
  type InfraPackResource,
  type InfraServicePackWire,
} from '@shared/utils/infraPacks';

export interface InfraServiceNotesProps {
  pack: InfraServicePackWire | null;
  /** The service token the caller wanted, used only to explain a missing pack. */
  service?: string | null;
  /**
   * The resource in view. Required for the paid-feature notices, because a
   * feature like Container Insights is a property of one cluster rather than of
   * the project — with nothing selected there is no honest claim to make.
   */
  resource?: InfraPackResource | null;
  /** Show the recommended alert rules. Off on the Metrics tab, on for Alerts. */
  showDefaultRules?: boolean;
}

export default function InfraServiceNotes({
  pack,
  service,
  resource = null,
  showDefaultRules = false,
}: InfraServiceNotesProps): React.ReactElement | null {
  if (!pack) {
    if (!service) return null;
    return (
      <div
        className="rounded-xl border border-gray-800 bg-gray-900/40 p-4 text-xs text-gray-500"
        data-testid="infra-service-notes-missing"
      >
        No metric pack declares <code className="text-gray-300">{service}</code>, so nothing is
        collected for it and there is nothing to explain yet.
      </div>
    );
  }

  const conditional = pack.metrics.filter((m) => metricCaveats(m).length > 0);
  const offFeatures = featureNotices(pack, resource);

  return (
    <div className="space-y-3" data-testid="infra-service-notes">
      {offFeatures.map(({ feature, gatedMetricNames }) => (
        <section
          key={feature.key}
          className="rounded-xl border border-amber-900/60 bg-amber-950/20 p-4"
          data-testid={`infra-feature-off-${feature.key}`}
        >
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-amber-200">
            <Lock size={14} className="text-amber-400" />
            {feature.label} is off for this resource
          </h3>
          <p className="mt-1.5 text-[11px] leading-5 text-gray-400">{feature.whenOff}</p>
          <p className="mt-2 text-[11px] leading-5 text-gray-500">
            <span className="font-medium text-gray-400">What it costs: </span>
            {feature.costNote}{' '}
            <a
              href={feature.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sky-400 hover:underline"
            >
              AWS documentation
            </a>
          </p>
          <p className="mt-2 text-[11px] leading-5 text-gray-500">
            <span className="font-medium text-gray-400">Not collected: </span>
            <code className="text-gray-400">{gatedMetricNames.join(', ')}</code>
          </p>
        </section>
      ))}

      {pack.absentMetrics.length > 0 && (
        <section className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-gray-200">
            <Info size={14} className="text-gray-400" />
            What {pack.label} does not publish
          </h3>
          <dl className="mt-2 space-y-2.5">
            {pack.absentMetrics.map((absent) => (
              <div key={absent.label}>
                <dt className="text-xs font-medium text-gray-300">{absent.label}</dt>
                <dd className="text-[11px] leading-5 text-gray-500">
                  {absent.reason}
                  {absent.remedy ? <span className="text-gray-400"> {absent.remedy}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {conditional.length > 0 && (
        <section
          className="rounded-xl border border-gray-800 bg-gray-900/40 p-4"
          data-testid="infra-service-notes-conditional"
        >
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-gray-200">
            <AlertTriangle size={14} className="text-amber-400" />
            Metrics only some resources publish
          </h3>
          <ul className="mt-2 space-y-1.5">
            {conditional.map((metric) => (
              <li key={`${metric.metricName}/${metric.stat}`} className="text-[11px] leading-5">
                <code className="text-gray-300">{metric.metricName}</code>
                <span className="text-gray-500"> — {metricCaveats(metric).join(' ')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {showDefaultRules && pack.defaultAlertRules.length > 0 && (
        <section
          className="rounded-xl border border-gray-800 bg-gray-900/40 p-4"
          data-testid="infra-service-default-rules"
        >
          <h3 className="text-sm font-medium text-gray-200">
            Recommended {pack.label} alert rules
          </h3>
          <p className="mt-1 text-[11px] text-gray-500">
            AWS&rsquo;s own published alarm guidance. Nothing here is active until you create it as
            a rule.
          </p>
          <ul className="mt-2 space-y-2">
            {pack.defaultAlertRules.map((rule) => (
              <li key={rule.name} className="text-[11px] leading-5">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-xs font-medium text-gray-200">{rule.name}</span>
                  <span
                    className={
                      rule.severity === 'critical'
                        ? 'text-red-400'
                        : rule.severity === 'warning'
                          ? 'text-amber-400'
                          : 'text-sky-400'
                    }
                  >
                    {rule.severity}
                  </span>
                  <code className="text-gray-400">
                    {rule.metricName} {summarizeDefaultRule(rule)}
                  </code>
                </div>
                <div className="text-gray-500">{rule.description}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
