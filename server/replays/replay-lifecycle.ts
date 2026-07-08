/**
 * replay-lifecycle.ts — S3-native lifecycle policy for segmented RUM replays.
 *
 * The segment store (`segment-store.ts`) writes append-only objects under the
 * `rum/<project>/<yyyy>/<mm>/<dd>/…` prefix. At multi-tenant volume the app can't
 * be the one that deletes those bytes: an O(n) list+delete sweep on the event
 * loop does not scale, and it can't tier cold objects to cheaper storage. So blob
 * expiry + storage-class tiering are pushed to **S3-native lifecycle rules** keyed
 * on the `rum/` prefix; the app sweeper is left owning only the SQLite index rows.
 *
 * This module is PURE (no AWS SDK, no IO): it builds the lifecycle configuration
 * and merges it into a bucket's existing rules. The SDK-backed port that actually
 * GETs/PUTs the bucket policy lives in `replay-lifecycle-s3.ts`, so the config
 * math here is unit-testable without touching S3.
 *
 * S3 constraints the builder must respect (verified against the S3 lifecycle docs,
 * 2026-07) so we never emit a config the API rejects:
 *   - A STANDARD_IA transition must be >= 30 days after creation.
 *   - Transitioning IA -> GLACIER requires >= 30 days sitting in IA first, so the
 *     Glacier day must be >= IA day + 30.
 *   - Every transition day must be strictly LESS than the expiration day (S3
 *     rejects a transition on/after expiration), and transition days within a rule
 *     must strictly increase.
 * Transitions that can't fit before expiration are simply dropped, which is why
 * the 30-day default retention emits an expiration-only rule (there is no room to
 * tier a 30-day object). Note also that S3 does not transition objects < 128 KB by
 * default; a ~60 KB segment therefore expires under this rule but is unlikely to
 * be tiered — the transitions matter for extended-retention tenants (T62).
 */

/** Storage prefix all segmented RUM objects live under (see `buildSegmentKey`). */
export const RUM_STORAGE_PREFIX = 'rum/';

/** Id of the single default-retention rule this module manages. */
export const RUM_LIFECYCLE_RULE_ID = 'agent-hub-rum-retention';

/** Every rule this module owns starts with this id prefix, so a merge can replace
 *  our rules without clobbering foreign rules an operator set on the bucket. */
export const RUM_MANAGED_RULE_ID_PREFIX = 'agent-hub-rum';

// ── S3 hard constraints ────────────────────────────────────────────
/** STANDARD_IA can't be entered before 30 days. */
const MIN_IA_TRANSITION_DAYS = 30;
/** An object must sit in IA >= 30 days before it can move to GLACIER. */
const MIN_DAYS_IN_IA_BEFORE_GLACIER = 30;
/** Reap dangling multipart uploads under the prefix so failed segment PUTs don't
 *  accrue storage. 7 days is the standard hygiene value. */
const ABORT_INCOMPLETE_MPU_DAYS = 7;

/** Default day a cold segment tiers to STANDARD_IA (the S3 minimum). */
export const DEFAULT_IA_TRANSITION_DAYS = 30;
/** Default day a cold segment tiers to GLACIER. */
export const DEFAULT_GLACIER_TRANSITION_DAYS = 90;

export interface LifecycleTransition {
  Days: number;
  StorageClass: string;
}

/**
 * A single S3 lifecycle rule. Fields are loose (mostly optional + an index
 * signature) because a bucket's EXISTING rules are read back and passed through a
 * merge unchanged — foreign rules may carry shapes we don't model, and we must
 * not drop their fields. The rules this module builds are always well-formed.
 */
export interface LifecycleRule {
  ID?: string;
  Status?: 'Enabled' | 'Disabled';
  Filter?: { Prefix?: string } | null;
  Transitions?: LifecycleTransition[];
  Expiration?: { Days?: number };
  AbortIncompleteMultipartUpload?: { DaysAfterInitiation?: number };
  [k: string]: unknown;
}

export interface LifecycleConfiguration {
  Rules: LifecycleRule[];
}

export interface RumLifecycleOptions {
  /** Delete (expire) objects this many days after creation. `<= 0` provisions
   *  NOTHING (the off/opt-in retention posture) — no bytes are ever expired until
   *  an operator sets a positive retention. */
  retentionDays: number;
  /** Day to tier to STANDARD_IA. Clamped up to the 30-day S3 minimum. */
  iaTransitionDays?: number | null;
  /** Day to tier to GLACIER. Clamped up to `iaDay + 30`. */
  glacierTransitionDays?: number | null;
  /** Prefix the rule scopes to. Defaults to `rum/` (segmented replays only, so
   *  session artifacts and monolithic `replays/` blobs are untouched). */
  prefix?: string;
  ruleId?: string;
  /** Emit IA/Glacier transitions. Default true; false = expiration-only. */
  enableTiering?: boolean;
}

/**
 * Build the lifecycle configuration for segmented RUM objects. Pure. Returns an
 * empty rule set when retention is disabled (`retentionDays <= 0`) so provisioning
 * touches nothing until an operator opts in. Transitions that can't legally fit
 * before expiration are dropped rather than emitted (which would make S3 reject
 * the whole config).
 */
export function buildRumLifecycleConfiguration(opts: RumLifecycleOptions): LifecycleConfiguration {
  const prefix = opts.prefix ?? RUM_STORAGE_PREFIX;
  const ruleId = opts.ruleId ?? RUM_LIFECYCLE_RULE_ID;
  const retention = Math.trunc(opts.retentionDays);

  if (!Number.isFinite(retention) || retention <= 0) {
    return { Rules: [] };
  }

  const transitions: LifecycleTransition[] = [];
  if (opts.enableTiering !== false) {
    let iaDays: number | null = null;
    const iaWanted = opts.iaTransitionDays ?? DEFAULT_IA_TRANSITION_DAYS;
    if (Number.isFinite(iaWanted) && iaWanted > 0) {
      const day = Math.max(Math.trunc(iaWanted), MIN_IA_TRANSITION_DAYS);
      // A transition only fires strictly before expiration.
      if (day < retention) {
        iaDays = day;
        transitions.push({ Days: day, StorageClass: 'STANDARD_IA' });
      }
    }

    const glacierWanted = opts.glacierTransitionDays ?? DEFAULT_GLACIER_TRANSITION_DAYS;
    if (Number.isFinite(glacierWanted) && glacierWanted > 0) {
      const floor =
        iaDays !== null ? iaDays + MIN_DAYS_IN_IA_BEFORE_GLACIER : MIN_IA_TRANSITION_DAYS;
      const day = Math.max(Math.trunc(glacierWanted), floor);
      // Must fit before expiration AND strictly after any IA transition.
      if (day < retention && (iaDays === null || day > iaDays)) {
        transitions.push({ Days: day, StorageClass: 'GLACIER' });
      }
    }
  }

  const rule: LifecycleRule = {
    ID: ruleId,
    Status: 'Enabled',
    Filter: { Prefix: prefix },
    Expiration: { Days: retention },
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: ABORT_INCOMPLETE_MPU_DAYS },
  };
  if (transitions.length > 0) rule.Transitions = transitions;

  return { Rules: [rule] };
}

/** True when a rule is one this module owns (id starts with the managed prefix). */
export function isManagedRumRule(
  rule: LifecycleRule,
  managedIdPrefix: string = RUM_MANAGED_RULE_ID_PREFIX,
): boolean {
  return typeof rule.ID === 'string' && rule.ID.startsWith(managedIdPrefix);
}

/**
 * Merge our managed rules into a bucket's existing rule set: drop any prior
 * managed rule (matched by id prefix) and append the new managed rules, keeping
 * every FOREIGN rule the operator configured. Foreign rules come first, our rules
 * last, so a re-run is stable (converges to no-op after the first apply).
 */
export function mergeManagedLifecycleRules(
  existing: LifecycleRule[],
  managed: LifecycleRule[],
  managedIdPrefix: string = RUM_MANAGED_RULE_ID_PREFIX,
): LifecycleRule[] {
  const foreign = existing.filter((r) => !isManagedRumRule(r, managedIdPrefix));
  return [...foreign, ...managed];
}

/** The fields this module authors on a managed rule. Equivalence is computed over
 *  ONLY these keys so that fields S3 adds/normalizes on read-back (or a differing
 *  key order from XML deserialization) don't spuriously look like a change. */
const MANAGED_RULE_KEYS = [
  'ID',
  'Status',
  'Filter',
  'Prefix',
  'Expiration',
  'Transitions',
  'AbortIncompleteMultipartUpload',
] as const;

/**
 * Deterministic JSON with recursively SORTED object keys. `GetBucketLifecycleConfiguration`
 * returns SDK objects whose key order (from XML deserialization) won't match our
 * freshly-built literal, so a raw `JSON.stringify` compare would report a change on
 * every boot and PUT forever. Sorting keys makes the compare order-insensitive.
 */
function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return null;
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(norm);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      const child = (v as Record<string, unknown>)[key];
      if (child === undefined) continue;
      out[key] = norm(child);
    }
    return out;
  };
  return JSON.stringify(norm(value));
}

/** Project a rule down to only the fields this module manages, dropping any extra
 *  fields S3 echoes back so equivalence is computed on our own shape. */
function projectManagedRule(rule: LifecycleRule): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of MANAGED_RULE_KEYS) {
    const val = (rule as Record<string, unknown>)[key];
    if (val !== undefined) out[key] = val;
  }
  return out;
}

/**
 * Whether the managed rules already on the bucket are SEMANTICALLY equal to the
 * ones we want — compared by managed-field projection + canonical (sorted-key,
 * order-insensitive-by-ID) JSON. This is what makes `applyRumLifecyclePolicy`
 * genuinely idempotent against the real SDK read-back (differing key order and
 * S3-defaulted fields), not just against an in-memory port that echoes our exact
 * literal.
 */
export function managedRulesEquivalent(
  existingManaged: LifecycleRule[],
  desiredManaged: LifecycleRule[],
): boolean {
  const key = (r: LifecycleRule): string => String(r.ID ?? '');
  const canon = (rules: LifecycleRule[]): string =>
    canonicalJson([...rules].sort((a, b) => key(a).localeCompare(key(b))).map(projectManagedRule));
  return canon(existingManaged) === canon(desiredManaged);
}

/**
 * The narrow S3 surface the apply step needs. Implemented by the SDK-backed port
 * in `replay-lifecycle-s3.ts`; mocked in tests. Keeping it an interface is what
 * lets the orchestration below stay pure and network-free.
 */
export interface LifecycleS3Port {
  /** Current bucket lifecycle rules; `[]` when the bucket has no configuration. */
  getBucketLifecycleRules(): Promise<LifecycleRule[]>;
  /** Replace the bucket lifecycle rules. An empty array clears the config. */
  putBucketLifecycleRules(rules: LifecycleRule[]): Promise<void>;
}

export interface ApplyRumLifecycleResult {
  /** Whether a PUT was issued (false = already in the desired state). */
  changed: boolean;
  /** Total rule count after merge. */
  ruleCount: number;
  /** How many of those rules this module manages. */
  managedRuleCount: number;
}

/**
 * Provision (or update) the RUM lifecycle rules on a bucket idempotently: read
 * the current rules, and PUT only when the managed rules on the bucket differ
 * SEMANTICALLY from what we want (see `managedRulesEquivalent` — robust to the
 * SDK read-back's key order / defaulted fields, so a steady state is a true
 * no-op). Foreign rules are always preserved. When retention is disabled the
 * managed rules are empty, so this REMOVES any previously-provisioned managed
 * rule while leaving foreign rules intact.
 */
export async function applyRumLifecyclePolicy(
  port: LifecycleS3Port,
  opts: RumLifecycleOptions,
): Promise<ApplyRumLifecycleResult> {
  const managed = buildRumLifecycleConfiguration(opts).Rules;
  const existing = await port.getBucketLifecycleRules();
  const existingManaged = existing.filter((r) => isManagedRumRule(r));

  if (managedRulesEquivalent(existingManaged, managed)) {
    return { changed: false, ruleCount: existing.length, managedRuleCount: managed.length };
  }

  const merged = mergeManagedLifecycleRules(existing, managed);
  await port.putBucketLifecycleRules(merged);
  return { changed: true, ruleCount: merged.length, managedRuleCount: managed.length };
}
