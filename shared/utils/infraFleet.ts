/**
 * Framework-free helpers for the infrastructure fleet dashboard, shared by the
 * web Infrastructure module and the mobile Infrastructure screen.
 *
 * The third peer of `infraMetrics.ts` and `infraSpend.ts`, and here for the
 * same reason they are: the parts that decide *what* an operator reads are one
 * implementation, because a phone that formats 1.5 GiB of freeable memory as
 * "1610612736" while the desktop says "1.5 GB" is a parity bug that no amount
 * of per-surface polish fixes.
 *
 * The pixel mapping stays out, as in both peers. `sparklineFractions` emits
 * 0..1, and each surface maps that into an SVG viewbox or a stack of `View`s.
 *
 * Nothing here recomputes a metric. The server already reduced each headline to
 * a latest value and a bucketed sparkline; a null is a real answer ("collected,
 * nothing came back") and must survive to the screen as one rather than being
 * defaulted to zero somewhere in here.
 */

import { normalizeValueRange } from './infraMetrics.js';

/** How a headline value reads to a human, which is what decides its format. */
export type InfraHeadlineUnit = 'percent' | 'bytes' | 'count' | 'seconds';

export interface InfraFleetPointWire {
  tsMs: number;
  value: number;
}

/** One headline series on one resource, as the server reduced it. */
export interface InfraFleetMetricWire {
  metricName: string;
  namespace: string;
  stat: string;
  label: string;
  unit: InfraHeadlineUnit;
  description: string;
  /** Null when the series reported nothing in the window. Not zero. */
  latest: number | null;
  latestTsMs: number | null;
  min: number | null;
  max: number | null;
  points: InfraFleetPointWire[];
}

export interface InfraFleetResourceWire {
  resourceKey: string;
  service: string;
  resourceId: string;
  name: string | null;
  region: string;
  accountId: string;
  environment: string | null;
  state: string | null;
  lastSeen: number;
  /** Enough to open the full Metrics view for this resource without refetching. */
  metricDimensions: Record<string, unknown> | null;
  features: Record<string, unknown> | null;
  metrics: InfraFleetMetricWire[];
}

/** The `GET /api/projects/:projectId/infra/fleet` body. */
export interface InfraFleetWire {
  fromMs: number;
  toMs: number;
  bucketSeconds: number;
  services: string[];
  resources: InfraFleetResourceWire[];
  truncated: boolean;
}

/** Human label for a service token, for the card's badge. */
export function infraServiceLabel(service: string): string {
  switch (service) {
    case 'ec2':
      return 'EC2';
    case 'ecs':
      return 'ECS';
    case 'rds':
      return 'RDS';
    default:
      return service.toUpperCase();
  }
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/**
 * Format a headline value for a tile.
 *
 * Null renders as an em-dash rather than `0`, and that distinction is the whole
 * reason this takes a nullable: a stopped instance and an idle one produce very
 * different operational responses, and a dashboard that draws both as zero
 * hides the one worth acting on.
 *
 * Bytes use 1024-step units with the decimal names AWS's own console uses. The
 * `FreeStorageSpace` doc note is the reason a raw number is not acceptable
 * here: CloudWatch stores bytes while the RDS console shows GB, and an
 * unformatted figure reads a billion times off.
 */
export function formatHeadlineValue(value: number | null, unit: InfraHeadlineUnit): string {
  if (value == null || !Number.isFinite(value)) return '—';

  if (unit === 'percent') {
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}%`;
  }

  if (unit === 'seconds') {
    if (value < 1) return `${(value * 1000).toFixed(0)}ms`;
    if (value < 60) return `${value.toFixed(2)}s`;
    return `${(value / 60).toFixed(1)}m`;
  }

  if (unit === 'bytes') {
    const negative = value < 0;
    let scaled = Math.abs(value);
    let step = 0;
    while (scaled >= 1024 && step < BYTE_UNITS.length - 1) {
      scaled /= 1024;
      step += 1;
    }
    const digits = scaled >= 100 || step === 0 ? 0 : 1;
    return `${negative ? '-' : ''}${scaled.toFixed(digits)} ${BYTE_UNITS[step]}`;
  }

  // count
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  if (Number.isInteger(value)) return String(value);
  return abs >= 10 ? value.toFixed(0) : value.toFixed(2);
}

/**
 * A sparkline as 0..1 fractions, oldest first, with `1` at the top of the plot.
 *
 * Scaling is per-series rather than per-unit on purpose. A tile is 40 pixels
 * tall and its job is "did this change", not "how does it compare to the one
 * below it" — a shared axis across metrics measured in percent and bytes has no
 * meaning, and a CPU series pinned to 0..100 draws a flat line at the bottom
 * for every instance that is merely healthy.
 *
 * Returns an empty array for fewer than two points: one observation is a value,
 * not a trend, and drawing it as a line implies a slope that was never measured.
 */
export function sparklineFractions(points: readonly InfraFleetPointWire[]): number[] {
  const values = points.map((p) => p.value).filter((v) => Number.isFinite(v));
  if (values.length < 2) return [];
  const { minValue, valueSpan } = normalizeValueRange(values);
  return values.map((value) => {
    const fraction = (value - minValue) / valueSpan;
    return Math.min(1, Math.max(0, fraction));
  });
}

/**
 * SVG polyline points for a sparkline inside a `width` × `height` viewbox.
 *
 * Web-only geometry, and the reason it lives beside the fractions rather than
 * in the component is that mobile's bar mapping consumes the same fractions
 * directly — keeping both derivations adjacent is what stops one of them
 * silently inverting the y axis.
 */
export function sparklinePolyline(
  points: readonly InfraFleetPointWire[],
  width: number,
  height: number,
): string {
  const fractions = sparklineFractions(points);
  if (fractions.length === 0) return '';
  const step = fractions.length > 1 ? width / (fractions.length - 1) : 0;
  return fractions
    .map((fraction, i) => `${(i * step).toFixed(2)},${((1 - fraction) * height).toFixed(2)}`)
    .join(' ');
}

/** A resource's display name, falling back to its id when AWS gave it none. */
export function fleetResourceTitle(resource: InfraFleetResourceWire): string {
  const name = resource.name?.trim();
  return name && name !== resource.resourceId ? name : resource.resourceId;
}
