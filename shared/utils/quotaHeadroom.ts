/**
 * Quota headroom presentation. Colour is a semantic token each platform maps.
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
  // "Not measured", not "no data": we did not look, vs looked and found nothing.
  unknown: 'Not measured',
};

export function quotaBandLabel(band: QuotaBand): string {
  return BAND_LABELS[band] ?? BAND_LABELS.unknown;
}

/**
 * Utilization. Null → dash, never "0%" (that reads as full headroom).
 * One decimal below 10%, none above.
 */
export function formatQuotaUtilization(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return '—';
  if (percent < 10) return `${round(percent, 1)}%`;
  return `${Math.round(percent)}%`;
}

/**
 * Absolute headroom plus unit. Suppress the literal unit `None` (plain count).
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
 * Header summary. Lead with what needs action. If nothing does, say how many
 * quotas are watched, not "all healthy".
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
 * Explain a null utilization. No applied value vs no usage reading need
 * different actions.
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
  // Layout only. The number beside the bar is never clamped (140% still reads 140%).
  return Math.min(100, percent);
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Banner when a refresh failed but a previous reading is still shown.
 * Keep the numbers and say they have stopped refreshing. Silent reuse of a
 * stale body is the bug this exists to prevent.
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
