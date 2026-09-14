import { isLoopbackHost } from '../loopback-host.js';
import { AutopilotError } from './errors.js';
import type { AutopilotTarget } from './types.js';

/** Closed recovery contract. Only exact members count; prose is not parsed. */
export const AUTOPILOT_STORAGE_RECOVERY_KINDS = [
  'disposable',
  'backward-compatible',
  'unsupported',
  'unknown',
] as const;

export type AutopilotStorageRecoveryKind = (typeof AUTOPILOT_STORAGE_RECOVERY_KINDS)[number];

export const AUTOPILOT_SUPPORTED_STORAGE_RECOVERY = ['disposable', 'backward-compatible'] as const;
export type AutopilotSupportedStorageRecovery =
  (typeof AUTOPILOT_SUPPORTED_STORAGE_RECOVERY)[number];

const SUPPORTED_RECOVERY = new Set<AutopilotStorageRecoveryKind>(
  AUTOPILOT_SUPPORTED_STORAGE_RECOVERY,
);

const RECOVERY_DECISION_KEYS = new Set(['storage-recovery', 'storageRecovery']);

export interface AutopilotStorageRecoverySpec {
  storageRecovery?: unknown;
  specDecisions?: { key: string; decision: string }[];
}

/** Exact enum match only. Substrings and mixed sentences are not a contract. */
export function parseStorageRecoveryKind(raw: unknown): AutopilotStorageRecoveryKind | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return (AUTOPILOT_STORAGE_RECOVERY_KINDS as readonly string[]).includes(value)
    ? (value as AutopilotStorageRecoveryKind)
    : null;
}

/**
 * Resolve the scoped recovery contract. The dedicated field and an exact
 * `storage-recovery` spec decision are the only sources. Free-text `storage`
 * decisions are ignored. Disagreeing or non-enum sources are not deployable.
 */
export function resolveStorageRecovery(
  spec: AutopilotStorageRecoverySpec | null | undefined,
): { ok: true; kind: AutopilotStorageRecoveryKind } | { ok: false; reason: string } {
  if (!spec) {
    return { ok: false, reason: 'data compatibility cannot be established for rollback' };
  }
  const fieldRaw = spec.storageRecovery;
  const fieldPresent =
    fieldRaw !== undefined && fieldRaw !== null && String(fieldRaw).trim() !== '';
  const fromField = fieldPresent ? parseStorageRecoveryKind(fieldRaw) : null;

  const recoveryDecisions = (spec.specDecisions ?? []).filter((d) =>
    RECOVERY_DECISION_KEYS.has(d.key),
  );
  const decisionKinds = recoveryDecisions.map((d) => parseStorageRecoveryKind(d.decision));
  const validDecisionKinds = decisionKinds.filter(
    (k): k is AutopilotStorageRecoveryKind => k != null,
  );
  const uniqueDecisions = new Set(validDecisionKinds);
  const hasInvalidDecision = recoveryDecisions.some(
    (d) => parseStorageRecoveryKind(d.decision) === null,
  );

  if (uniqueDecisions.size > 1) {
    return { ok: false, reason: 'contradictory storage recovery contract' };
  }
  const fromDecision = uniqueDecisions.size === 1 ? [...uniqueDecisions][0] : null;
  if (fromField && fromDecision && fromField !== fromDecision) {
    return { ok: false, reason: 'contradictory storage recovery contract' };
  }
  if (hasInvalidDecision) {
    return { ok: false, reason: 'contradictory storage recovery contract' };
  }
  if (fieldPresent && fromField === null) {
    return { ok: false, reason: 'data compatibility cannot be established for rollback' };
  }
  const kind = fromField ?? fromDecision;
  if (!kind) {
    return { ok: false, reason: 'data compatibility cannot be established for rollback' };
  }
  return { ok: true, kind };
}

export interface AutopilotDeclaredEnvironment {
  /** Where this deploy.yaml environment deploys. Null when YAML omits origin. */
  origin: string | null;
  /** Readiness probe on that origin. Null when YAML omits readiness. */
  readinessProbeUrl: string | null;
  /** Live revision at the environment, or null on a first-cycle target. */
  currentRef: string | null;
  /** Deployment that produced currentRef, or null on a first-cycle target. */
  currentDeploymentId: string | null;
}

export interface AutopilotLocalTargetLookup {
  /**
   * Declared deploy.yaml environment plus live revision identity.
   * Null when the name is not in deploy.yaml.
   */
  getDeclaredEnvironment: (
    projectId: string,
    targetId: string,
  ) => AutopilotDeclaredEnvironment | null;
}

/**
 * Parse and require a dedicated local experiment target. Origin and readiness
 * probe must be http(s) loopback URLs on the same origin so the public browser
 * policy can keep blocking them while Autopilot's local worker uses the target.
 */
export function assertLocalTargetContract(target: AutopilotTarget): AutopilotTarget {
  const origin = requireLocalOrigin(target.origin, 'target.origin');
  const readinessProbeUrl = requireSameOriginUrl(
    target.readinessProbeUrl,
    origin,
    'target.readinessProbeUrl',
  );
  return { targetId: target.targetId, origin, readinessProbeUrl };
}

/**
 * Start-time check: the named environment is declared in deploy.yaml and its
 * origin, readiness probe, and revision identity are the Autopilot target.
 * Membership alone is not enough — a declared env that deploys elsewhere is
 * rejected even when the Autopilot payload supplies loopback URLs.
 */
export function assertLocalTargetReadyToRun(
  projectId: string,
  target: AutopilotTarget,
  lookup: AutopilotLocalTargetLookup,
): AutopilotTarget {
  const normalized = assertLocalTargetContract(target);
  const env = lookup.getDeclaredEnvironment(projectId, normalized.targetId);
  if (!env) {
    throw new AutopilotError(
      'invalid_config',
      `local target "${normalized.targetId}" is not a declared deploy.yaml environment`,
    );
  }
  if (!env.origin || !env.readinessProbeUrl) {
    throw new AutopilotError(
      'invalid_config',
      `local target "${normalized.targetId}" does not declare origin, readiness, and revision identity`,
    );
  }
  const envOrigin = requireHttpOrigin(env.origin, 'environment.origin');
  const envReadiness = requireSameOriginUrl(
    env.readinessProbeUrl,
    envOrigin,
    'environment.readiness',
  );
  if (envOrigin !== normalized.origin || envReadiness !== normalized.readinessProbeUrl) {
    throw new AutopilotError(
      'invalid_config',
      `declared environment "${normalized.targetId}" points at ${envOrigin}, not the Autopilot local target`,
    );
  }
  // Revision identity is the environment's live currentRef / currentDeploymentId.
  // A first-cycle target has both null; a live row is accepted as long as it
  // belongs to this bound environment (lookup is keyed by targetId).
  if (env.currentDeploymentId && !env.currentRef) {
    throw new AutopilotError(
      'invalid_config',
      `local target "${normalized.targetId}" has a live deployment without a reported revision`,
    );
  }
  return normalized;
}

/**
 * Deploy gate for data compatibility. Missing last-known-good is a separate
 * rollback concern and does not establish that the target holds disposable
 * data. Only an explicit supported contract (`disposable` or
 * `backward-compatible`) authorizes deploy. Mixed prose, unknown, unsupported,
 * and disagreeing structured sources cannot authorize deploy. Code rollback is
 * not a database rollback.
 */
export function assessStorageRecoverability(
  spec: AutopilotStorageRecoverySpec | null | undefined,
): { ok: true; kind: AutopilotSupportedStorageRecovery } | { ok: false; reason: string } {
  const resolved = resolveStorageRecovery(spec);
  if (!resolved.ok) return resolved;
  if (SUPPORTED_RECOVERY.has(resolved.kind)) {
    return { ok: true, kind: resolved.kind as AutopilotSupportedStorageRecovery };
  }
  if (resolved.kind === 'unsupported') {
    return {
      ok: false,
      reason: 'unsupported data migration cannot be rolled back with a code redeploy',
    };
  }
  return {
    ok: false,
    reason: 'data compatibility cannot be established for rollback',
  };
}

function requireHttpOrigin(raw: string | null | undefined, label: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new AutopilotError('invalid_config', `${label} is required`);
  }
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new AutopilotError('invalid_config', `${label} must be a valid http(s) URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new AutopilotError('invalid_config', `${label} must be an http(s) origin`);
  }
  if (u.username || u.password) {
    throw new AutopilotError('invalid_config', `${label} must not include credentials`);
  }
  if (u.pathname !== '/' || u.search || u.hash) {
    throw new AutopilotError(
      'invalid_config',
      `${label} must be an origin (scheme://host[:port]) with no path`,
    );
  }
  return u.origin;
}

function requireLocalOrigin(raw: string | null | undefined, label: string): string {
  const origin = requireHttpOrigin(raw, label);
  if (!isLoopbackHost(new URL(origin).hostname)) {
    throw new AutopilotError(
      'invalid_config',
      `${label} must be a local loopback origin, not a public host`,
    );
  }
  return origin;
}

function requireSameOriginUrl(
  raw: string | null | undefined,
  origin: string,
  label: string,
): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new AutopilotError('invalid_config', `${label} is required`);
  }
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new AutopilotError('invalid_config', `${label} must be a valid http(s) URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new AutopilotError('invalid_config', `${label} must be an http(s) URL`);
  }
  if (u.username || u.password) {
    throw new AutopilotError('invalid_config', `${label} must not include credentials`);
  }
  if (u.origin !== origin) {
    throw new AutopilotError(
      'invalid_config',
      `${label} must be on the same local origin as target.origin`,
    );
  }
  return u.href;
}
