/**
 * PR-env settings save-payload helpers.
 *
 * The backend PUT is partial-preserving: any secret field equal to the mask
 * sentinel is left untouched server-side. On the client we mirror the
 * convention so the UI can post the whole form back without tracking which
 * secrets the user actually edited.
 *
 * Extracted from the React component to make the mask-preservation logic
 * cheaply unit-testable without rendering.
 */

export const MASK = '••••••••';

/** Field names whose values are AES-GCM encrypted at rest and returned masked. */
export const SECRET_FIELDS = ['githubPrivateKey', 'route53SecretAccessKey'];

/** Tier 1 (general) string fields. */
export const TIER1_STRING_FIELDS = ['repoFullName', 'previewHost', 'previewBaseUrl'];

/** Tier 1 boolean fields. */
export const TIER1_BOOL_FIELDS = ['enabled', 'certRenewalLive'];

/** Tier 2 (credentials) string fields — plaintext on the wire, encrypted at rest. */
export const TIER2_STRING_FIELDS = [
  'githubAppId',
  'githubInstallationId',
  'githubPrivateKey',
  'route53AccessKeyId',
  'route53SecretAccessKey',
  'route53HostedZoneId',
];

/**
 * True iff `value` is the mask sentinel. Used to decide whether the user
 * actually edited a secret field or if they left the masked value in place.
 */
export function isMaskValue(value) {
  return value === MASK;
}

/**
 * Build a PUT payload from the current form state.
 *
 * Rules:
 *   - Mask sentinel for secrets → drop from payload (server preserves existing value).
 *   - Empty string for secrets → send as '' (explicit clear).
 *   - Non-secret string fields → always include (cheap; no preservation needed).
 *   - Booleans → always include.
 *   - portRangeMin/Max → both included together if either is set, otherwise both null.
 */
export function buildPrEnvSavePayload(form) {
  const payload = {};

  for (const k of TIER1_STRING_FIELDS) {
    payload[k] = form[k] ?? '';
  }
  for (const k of TIER1_BOOL_FIELDS) {
    payload[k] = !!form[k];
  }
  for (const k of TIER2_STRING_FIELDS) {
    const v = form[k];
    if (SECRET_FIELDS.includes(k)) {
      // Drop masked secrets so the server preserves whatever it already has.
      if (v === undefined || v === null || isMaskValue(v)) continue;
      payload[k] = v;
    } else {
      payload[k] = v ?? '';
    }
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
