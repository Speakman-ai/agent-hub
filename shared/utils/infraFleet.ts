/**
 * Fleet dashboard helpers. Server already reduced headlines; a null is "nothing
 * came back", not zero. Pixel mapping stays per surface.
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
 * Headline tile. Null → dash, not `0`. Bytes use 1024-step units with AWS's
 * decimal names (CloudWatch stores bytes; RDS console shows GB).
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
 * Sparkline as 0..1, oldest first, `1` at the top. Scaled per series. Empty
 * when fewer than two points (one observation is not a trend).
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

/** SVG polyline in a `width` × `height` viewbox. Same fractions as mobile bars. */
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
