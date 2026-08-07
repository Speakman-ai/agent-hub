/**
 * Presentation helpers for the service quota headroom panel, shared by the web
 * and mobile Infrastructure modules so the two cannot describe the same reading
 * differently.
 *
 * Pure: no React, no platform APIs. Colour is expressed as a semantic token the
 * platform maps to Tailwind classes or a React Native style, because those two
 * cannot share a value but must share the decision.
 */

import { formatAgo } from './relativeTime.js';

/** Severity band, mirroring the server's `quotaHeadroomBand`. */
export type QuotaBand = 'critical' | 'warning' | 'ok' | 'unknown';

/** One quota as the API returns it. */
export interface QuotaHeadroomWire {
  resourceKey: string;
  accountId: string;
  region: string;
  serviceCode: string;
  quotaCode: string;
  quotaName: string;
  limit: number | null;
  unit: string | null;
  adjustable: boolean;
  usage: number | null;
  usageAtMs: number | null;
  metricName: string;
  utilizationPercent: number | null;
  headroom: number | null;
  band: QuotaBand;
}

export interface QuotaHeadroomResponse {
  quotas: QuotaHeadroomWire[];
  summary: { critical: number; warning: number; ok: number; unknown: number; total: number };
  thresholds: { warning: number; critical: number };
  expression: string;
  staleAfterMs: number;
}

/** Semantic colour token per band; platforms map these to their own styles. */
export type QuotaBandTone = 'danger' | 'warn' | 'good' | 'muted';

const BAND_TONES: Record<QuotaBand, QuotaBandTone> = {
  critical: 'danger',
  warning: 'warn',
  ok: 'good',
  unknown: 'muted',
};

export function quotaBandTone(band: QuotaBand): QuotaBandTone {
  return BAND_TONES[band] ?? 'muted';
}

const BAND_LABELS: Record<QuotaBand, string> = {
  critical: 'At or over quota',
  warning: 'Near quota',
  ok: 'Healthy',
  // Deliberately "not measured" rather than "no data": the distinction the
  // whole null-vs-zero discipline exists to preserve is that we did not look,
  // not that we looked and found nothing.
  unknown: 'Not measured',
};

export function quotaBandLabel(band: QuotaBand): string {
  return BAND_LABELS[band] ?? BAND_LABELS.unknown;
}

/**
 * Render a utilization percentage.
 *
 * Returns an em-dash for null rather than "0%", which would read as full
 * headroom — the single most dangerous misrendering on this panel.
 *
 * One decimal place below 10% and none above, because the difference between
 * 4.2% and 4.9% of a quota is noise while the difference between 94% and 95%
 * is not — and a column of "94.0%" wastes width to say nothing.
 */
export function formatQuotaUtilization(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return '—';
  if (percent < 10) return `${round(percent, 1)}%`;
  return `${Math.round(percent)}%`;
}

/**
 * Render an absolute headroom figure with its unit.
 *
 * The Service Quotas unit is frequently the literal string `None`, which means
 * "a plain count" rather than a unit worth printing. Rendering "512 None" would
 * be noise, so that value is suppressed.
 */
export function formatQuotaHeadroom(headroom: number | null, unit: string | null): string {
  if (headroom === null || !Number.isFinite(headroom)) return '—';
  const value = formatCount(headroom);
  const suffix = unit && unit !== 'None' && unit !== 'Count' ? ` ${unit}` : '';
  return `${value}${suffix}`;
}

/** Compact count: thousands separated, fractions kept only when meaningful. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const rounded = Number.isInteger(value) ? value : round(value, 2);
  return rounded.toLocaleString('en-US');
}

/**
 * One-line summary for the panel header.
 *
 * Leads with what needs action. When nothing does, it says how many quotas are
 * being watched rather than "all healthy", because an operator who has not
 * noticed that only three quotas are in scope would read "all healthy" as a
 * much stronger statement than it is.
 */
export function quotaSummaryLine(summary: QuotaHeadroomResponse['summary']): string {
  if (summary.total === 0) return 'No quotas collected yet';
  const parts: string[] = [];
  if (summary.critical > 0) parts.push(`${summary.critical} at or over quota`);
  if (summary.warning > 0) parts.push(`${summary.warning} near quota`);
  if (parts.length > 0) {
    return `${parts.join(', ')} of ${summary.total} watched`;
  }
  const measured = summary.total - summary.unknown;
  if (measured === 0) return `${summary.total} watched, none measured yet`;
  return `${measured} of ${summary.total} watched, all healthy`;
}

/**
 * Explain a null utilization, so an unmeasured row is never a bare dash.
 *
 * The two causes need different actions and must not be conflated: no applied
 * value is an AWS-side fact nothing can change, while no usage reading means
 * the collector has not run (or has stopped) and is worth investigating.
 */
export function quotaUnknownReason(quota: QuotaHeadroomWire): string | null {
  if (quota.utilizationPercent !== null) return null;
  if (quota.limit === null) {
    return 'AWS reports no applied value for this quota, so utilization cannot be computed.';
  }
  if (quota.usage === null) {
    return 'No recent usage reading. The metric collector has not reported this quota yet.';
  }
  return 'Utilization is not defined for this quota.';
}

/** Bar width as a percentage, clamped to the track. */
export function quotaBarPercent(percent: number | null): number {
  if (percent === null || !Number.isFinite(percent) || percent <= 0) return 0;
  // Clamped for *layout* only. The number beside the bar is never clamped, so
  // an over-quota reading still reads 140% next to a full bar.
  return Math.min(100, percent);
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * What to say when a refresh failed but a previous reading is still on screen.
 *
 * Returns `null` when there is nothing to warn about, so the caller renders the
 * banner only when it means something.
 *
 * ## Why the readings are kept rather than cleared
 *
 * Clearing them on a failed poll would blank the panel on any transient blip,
 * throwing away information that is still worth having: "you were at 82% three
 * minutes ago" is a materially better answer than nothing at all, and the
 * operator is the one who can judge whether three minutes matters.
 *
 * But keeping them silently is worse than either, and it is the specific bug
 * this exists to prevent. This whole feature is built so a number is never shown
 * unless it was actually measured — the server drops usage readings older than
 * its staleness bound for exactly that reason. A client that retained the last
 * successful body and rendered it identically to a fresh one would undo that,
 * and during an outage the panel would show reassuring capacity figures with no
 * hint they had stopped moving.
 *
 * So: keep the numbers, and say plainly that they have stopped refreshing and
 * when they were last true.
 */
export function quotaRefreshFailureNote(
  errorMessage: string | null | undefined,
  loadedAtMs: number | null | undefined,
  nowMs: number,
): string | null {
  if (!errorMessage) return null;
  const when =
    typeof loadedAtMs === 'number' && Number.isFinite(loadedAtMs)
      ? ` These readings were last updated ${formatAgo(nowMs - loadedAtMs)} and may have changed since.`
      : ' The readings below may be out of date.';
  return `Refresh failed: ${errorMessage}.${when}`;
}
