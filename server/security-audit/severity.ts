/**
 * severity.ts — normalise a vulnerability's severity into one of five
 * buckets (critical/high/medium/low/unknown).
 *
 * Two inputs feed this:
 *   1. A database label string. The GitHub Advisory DB (surfaced through
 *      OSV's `database_specific.severity`) gives `CRITICAL` / `HIGH` /
 *      `MODERATE` / `LOW` directly — preferred when present.
 *   2. A CVSS v3.x vector string (OSV `severity[].score` with type
 *      `CVSS_V3`). We compute the base score with the official FIRST CVSS
 *      v3.1 formula and bucket by the standard qualitative ranges.
 *
 * The CVSS base-score implementation is the full v3.1 spec (it is
 * backward-compatible with v3.0 metrics) so the buckets match GitHub /
 * NVD exactly. It is pure and deterministic — easy to unit test.
 */

import type { Severity } from './types.js';

/** Qualitative severity rating from a CVSS base score (FIRST §5, table). */
export function severityFromCvssScore(score: number): Severity {
  if (!Number.isFinite(score) || score <= 0) return 'unknown';
  if (score >= 9.0) return 'critical';
  if (score >= 7.0) return 'high';
  if (score >= 4.0) return 'medium';
  return 'low';
}

/** Normalise a textual database severity label. */
export function severityFromLabel(label: string | null | undefined): Severity {
  if (!label) return 'unknown';
  switch (label.trim().toUpperCase()) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'high';
    case 'MODERATE':
    case 'MEDIUM':
      return 'medium';
    case 'LOW':
      return 'low';
    default:
      return 'unknown';
  }
}

// ─── CVSS v3.1 base score ───────────────────────────────────────────────

const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC: Record<string, number> = { L: 0.77, H: 0.44 };
// Privileges Required is scope-dependent: the Changed-scope values differ.
const PR_UNCHANGED: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 };
const PR_CHANGED: Record<string, number> = { N: 0.85, L: 0.68, H: 0.5 };
const UI: Record<string, number> = { N: 0.85, R: 0.62 };
const CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0.0 };

/** Round up to one decimal place, per the CVSS v3.1 spec's `roundup`. */
function roundUp1(value: number): number {
  const int = Math.round(value * 100000);
  if (int % 10000 === 0) return int / 100000;
  return (Math.floor(int / 10000) + 1) / 10;
}

/**
 * Compute the CVSS v3.x base score from a vector string. Returns `null`
 * when the vector can't be parsed or is missing a required base metric.
 *
 * Accepts vectors with or without the `CVSS:3.x/` prefix.
 */
export function cvssV3BaseScore(vector: string): number | null {
  if (typeof vector !== 'string' || vector.length === 0) return null;
  const metrics: Record<string, string> = {};
  for (const part of vector.split('/')) {
    const [k, v] = part.split(':');
    if (k && v) metrics[k.toUpperCase()] = v.toUpperCase();
  }
  // Required base metrics (CVSS prefix's value, e.g. `3.1`, is ignored).
  const av = AV[metrics.AV];
  const ac = AC[metrics.AC];
  const ui = UI[metrics.UI];
  const c = CIA[metrics.C];
  const i = CIA[metrics.I];
  const a = CIA[metrics.A];
  const scopeChanged = metrics.S === 'C';
  const prTable = scopeChanged ? PR_CHANGED : PR_UNCHANGED;
  const pr = prTable[metrics.PR];

  if ([av, ac, pr, ui, c, i, a].some((x) => x === undefined)) return null;
  if (metrics.S !== 'C' && metrics.S !== 'U') return null;

  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = scopeChanged ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  const exploitability = 8.22 * av * ac * pr * ui;

  if (impact <= 0) return 0;
  const base = scopeChanged
    ? roundUp1(Math.min(1.08 * (impact + exploitability), 10))
    : roundUp1(Math.min(impact + exploitability, 10));
  return base;
}

/** Bucket a CVSS v3 vector string directly into a severity. */
export function severityFromCvssVector(vector: string): Severity {
  const score = cvssV3BaseScore(vector);
  return score === null ? 'unknown' : severityFromCvssScore(score);
}

/**
 * Resolve the best severity from the two possible inputs. A non-unknown
 * database label wins (it's the vendor's authoritative rating); otherwise
 * fall back to the CVSS vector; otherwise `unknown`.
 */
export function resolveSeverity(opts: {
  label?: string | null;
  cvssVector?: string | null;
}): Severity {
  const fromLabel = severityFromLabel(opts.label);
  if (fromLabel !== 'unknown') return fromLabel;
  if (opts.cvssVector) return severityFromCvssVector(opts.cvssVector);
  return 'unknown';
}

/** Sort key so we can order findings critical → low (higher = worse). */
export function severityRank(severity: Severity): number {
  switch (severity) {
    case 'critical':
      return 4;
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
    default:
      return 0;
  }
}
