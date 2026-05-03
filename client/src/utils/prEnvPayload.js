/**
 * PR-env settings save-payload helpers.
 *
 * Tier 2 (credentials) fields are no longer surfaced in the UI — GitHub
 * App credentials are inherited from the registered Reviewer App
 * (`config.githubApp`) and Route 53 access comes from the AWS SDK default
 * credential chain (IAM Role via IMDSv2 on EC2). Both are infrastructure-
 * managed (Terraform). The client now only sends Tier 1 fields plus the
 * port range; the server's PUT handler still accepts the credential keys
 * so the migration path (clearing a stored secret via `''`) keeps
 * working, but the UI never sends them.
 *
 * Extracted from the React component to make the form→payload logic
 * cheaply unit-testable without rendering.
 */

/** The mask sentinel used by GETs. Kept exported for legacy test helpers. */
export const MASK = '••••••••';

/** Tier 1 (general) string fields. */
export const TIER1_STRING_FIELDS = ['repoFullName', 'previewHost', 'previewBaseUrl'];

/** Tier 1 boolean fields. */
export const TIER1_BOOL_FIELDS = ['enabled', 'certRenewalLive'];

/**
 * Build a PUT payload from the current form state.
 *
 * Rules:
 *   - Tier 1 string fields → always include (server treats '' as "clear").
 *   - Booleans → always include.
 *   - portRangeMin/Max → both included together; '' / null / undefined → null (clear).
 *   - Tier 2 (credentials) → not sent at all. Inherited server-side from
 *     `config.githubApp` (GitHub App) and the AWS SDK default chain
 *     (Route 53). Editing those is an infrastructure / Terraform concern.
 */
export function buildPrEnvSavePayload(form) {
  const payload = {};

  for (const k of TIER1_STRING_FIELDS) {
    payload[k] = form[k] ?? '';
  }
  for (const k of TIER1_BOOL_FIELDS) {
    payload[k] = !!form[k];
  }

  // Port range: always send together. Empty string → null (clear).
  const minRaw = form.portRangeMin;
  const maxRaw = form.portRangeMax;
  const normalizePort = (raw) => {
    if (raw === '' || raw === null || raw === undefined) return null;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  payload.portRangeMin = normalizePort(minRaw);
  payload.portRangeMax = normalizePort(maxRaw);

  return payload;
}

/**
 * Validate the form client-side before hitting the server. Returns an array
 * of human-readable error strings — empty when valid.
 */
export function validatePrEnvForm(form) {
  const errors = [];
  const min =
    form.portRangeMin === '' || form.portRangeMin == null ? null : Number(form.portRangeMin);
  const max =
    form.portRangeMax === '' || form.portRangeMax == null ? null : Number(form.portRangeMax);
  if ((min === null) !== (max === null)) {
    errors.push('Port range: both min and max must be set (or both blank).');
  } else if (min !== null && max !== null) {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min <= 0 || max < min) {
      errors.push('Port range: must be positive integers with max ≥ min.');
    }
  }
  if (form.enabled && !form.repoFullName) {
    errors.push('Cannot enable without a repo (owner/name).');
  }
  return errors;
}
