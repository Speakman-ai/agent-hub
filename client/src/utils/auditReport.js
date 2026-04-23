/**
 * Post-scaffold audit report — pure model + helpers.
 *
 * Drives Act IV of the New Project storyboard. After provisioning completes
 * successfully, the backend runs a short audit sweep over the freshly-scaffolded
 * repo and returns a structured report. This module is the client-side shape
 * plus helpers for rolling up category statuses into an overall readiness score.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Report shape (server → client):
 *
 *   {
 *     projectId: string,
 *     generatedAt: <ISO>,
 *     score: 0..100,               // optional — derived from categories if absent
 *     categories: [
 *       { id, label, status: 'ok'|'warn'|'fail'|'na', weight?: number,
 *         summary?: string }
 *     ],
 *     findings: [
 *       { id, severity: 'info'|'warn'|'error',
 *         category: <category-id>, message: string, hint?: string }
 *     ],
 *     gaps: [
 *       { id, label: string, hint?: string }
 *     ]
 *   }
 * ─────────────────────────────────────────────────────────────────────
 */

/** Default audit categories, shown in this order when the server returns
 *  a subset. Each has a default weight for score rollup; the server can
 *  override per project. */
export const DEFAULT_CATEGORIES = [
  { id: 'lint', label: 'Lint', weight: 15 },
  { id: 'tests', label: 'Tests', weight: 25 },
  { id: 'deps', label: 'Dependencies', weight: 20 },
  { id: 'auth', label: 'Auth & Secrets', weight: 20 },
  { id: 'aws', label: 'AWS / Deploy', weight: 20 },
];

const STATUS_WEIGHTS = {
  ok: 1,
  warn: 0.5,
  fail: 0,
  na: null, // excluded from the denominator
};

/**
 * Compute a 0–100 readiness score from category statuses. Categories with
 * status `na` are excluded from the denominator (not "fail"), so a project
 * that legitimately doesn't need AWS isn't penalized.
 *
 * Returns `null` when every category is `na` (nothing to score).
 */
export function computeReadinessScore(categories = []) {
  let totalWeight = 0;
  let earned = 0;
  for (const cat of categories) {
    const w = typeof cat.weight === 'number' ? cat.weight : defaultWeightFor(cat.id);
    const credit = STATUS_WEIGHTS[cat.status];
    if (credit == null) continue;
    totalWeight += w;
    earned += w * credit;
  }
  if (totalWeight === 0) return null;
  return Math.round((earned / totalWeight) * 100);
}

function defaultWeightFor(id) {
  const def = DEFAULT_CATEGORIES.find((c) => c.id === id);
  return def ? def.weight : 10;
}

/**
 * Bucket a numeric score into a qualitative band used by the UI for colour.
 *   >= 80 → green ("ready")
 *   >= 50 → amber ("needs work")
 *   else   → red   ("not ready")
 */
export function scoreBand(score) {
  if (score == null) return 'unknown';
  if (score >= 80) return 'green';
  if (score >= 50) return 'amber';
  return 'red';
}

/** Coalesce a raw server report into a normalized shape the UI can render
 *  safely even when fields are missing. Never throws — returns null if the
 *  input is not an object. */
export function normalizeReport(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const categories = Array.isArray(raw.categories)
    ? raw.categories.map((c) => ({
        id: c.id,
        label: c.label || defaultLabelFor(c.id),
        status: normalizeStatus(c.status),
        weight: typeof c.weight === 'number' ? c.weight : defaultWeightFor(c.id),
        summary: typeof c.summary === 'string' ? c.summary : null,
      }))
    : [];
  const findings = Array.isArray(raw.findings)
    ? raw.findings.map((f, i) => ({
        id: f.id || `f-${i}`,
        severity: normalizeSeverity(f.severity),
        category: f.category || null,
        message: typeof f.message === 'string' ? f.message : '',
        hint: typeof f.hint === 'string' ? f.hint : null,
      }))
    : [];
  const gaps = Array.isArray(raw.gaps)
    ? raw.gaps.map((g, i) => ({
        id: g.id || `g-${i}`,
        label: typeof g.label === 'string' ? g.label : '',
        hint: typeof g.hint === 'string' ? g.hint : null,
      }))
    : [];
  const score =
    typeof raw.score === 'number' && Number.isFinite(raw.score)
      ? clamp(Math.round(raw.score), 0, 100)
      : computeReadinessScore(categories);
  return {
    projectId: raw.projectId || null,
    generatedAt: raw.generatedAt || null,
    score,
    categories,
    findings,
    gaps,
  };
}

function defaultLabelFor(id) {
  const def = DEFAULT_CATEGORIES.find((c) => c.id === id);
  return def ? def.label : id || 'Category';
}

function normalizeStatus(s) {
  return s === 'ok' || s === 'warn' || s === 'fail' || s === 'na' ? s : 'na';
}

function normalizeSeverity(s) {
  return s === 'info' || s === 'warn' || s === 'error' ? s : 'info';
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** Group findings by category id for rendering them alongside the category
 *  row without losing the top-level finding list. Returns a Map<categoryId, finding[]>. */
export function findingsByCategory(findings = []) {
  const map = new Map();
  for (const f of findings) {
    const key = f.category || '_';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(f);
  }
  return map;
}

/** Highest severity among the given findings — used to flag a category row
 *  with a badge when the category status is already set. Order: error > warn > info. */
export function maxSeverity(findings = []) {
  let best = null;
  for (const f of findings) {
    if (f.severity === 'error') return 'error';
    if (f.severity === 'warn') best = best === 'error' ? best : 'warn';
    if (!best && f.severity === 'info') best = 'info';
  }
  return best;
}
