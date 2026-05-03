/**
 * PR-env settings payload helpers (mobile).
 *
 * Mirrors `client/src/utils/prEnvPayload.js` but scoped to the MVP mobile
 * surface, which only round-trips the `enabled` flag and renders the
 * 4-row Validate response. Tier 1 (general) fields and Tier 2
 * (credentials) editing remain web-only for now.
 *
 * Extracted from the React Native component so the form→payload logic
 * and the validate-response shaping are unit-testable without an Expo
 * runner (mobile vitest only includes `src/utils/**`).
 */

/** Mask sentinel emitted by GET /api/settings/pr-env for set-but-hidden secrets. */
export const MASK = '••••••••';

/** Human-readable display sentinel for masked values in mobile rows. */
export const DISPLAY_MASK = '•••••';

/** Map server check name → human label. Mirrors `CHECK_LABELS` on web. */
export const CHECK_LABELS = {
  docker: 'Docker daemon',
  nginx: 'Nginx sites dirs',
  'github-app': 'GitHub App',
  route53: 'Route53 hosted zone',
};

/** Stable display order for the 4 known checks. Unknowns are appended in arrival order. */
export const CHECK_ORDER = ['docker', 'nginx', 'github-app', 'route53'];

/**
 * Build a PUT payload for the MVP mobile toggle. The backend partial-
 * preserves any field not included; we deliberately ship only `enabled`
 * so the mobile surface can never accidentally clear a Tier 1 / Tier 2
 * value the operator set on web.
 */
export function buildEnabledTogglePayload(enabled) {
  return { enabled: !!enabled };
}

/**
 * Render a value into the masked display string the UI shows.
 *
 * - `null` / `undefined` / `''`            → '—'  (unset on the server)
 * - the MASK sentinel                       → DISPLAY_MASK ('•••••')
 * - everything else                         → the value, stringified
 */
export function maskedDisplay(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (value === MASK) return DISPLAY_MASK;
  return String(value);
}

/**
 * Pretty-print the saved port range for a read-only row.
 * Returns '—' when either bound is missing.
 */
export function formatPortRange(min, max) {
  const mn = min === null || min === undefined || min === '' ? null : Number(min);
  const mx = max === null || max === undefined || max === '' ? null : Number(max);
  if (mn === null || mx === null || !Number.isFinite(mn) || !Number.isFinite(mx)) return '—';
  return `${mn}–${mx}`;
}

/**
 * Normalize the `/validate` response into 4 stable rows so the UI can
 * always render the canonical set even if the server omits a check
 * (defensive — current backend always returns all four). Unknown
 * server-side names are appended after the canonical ones so we never
 * silently drop them.
 */
export function formatValidateRows(result) {
  if (!result || !Array.isArray(result.checks)) return [];
  const byName = new Map();
  for (const c of result.checks) {
    if (c && typeof c.name === 'string') byName.set(c.name, c);
  }
  const rows = [];
  for (const name of CHECK_ORDER) {
    const c = byName.get(name);
    rows.push({
      name,
      label: CHECK_LABELS[name] || name,
      pass: !!(c && c.pass),
      message: c ? String(c.message ?? '') : 'No result returned for this check.',
      missing: !c,
    });
  }
  for (const c of result.checks) {
    if (!CHECK_ORDER.includes(c.name)) {
      rows.push({
        name: c.name,
        label: CHECK_LABELS[c.name] || c.name,
        pass: !!c.pass,
        message: String(c.message ?? ''),
        missing: false,
      });
    }
  }
  return rows;
}
