/**
 * credentialPersistOutcome.ts — the single source of truth for how a credential
 * box reports what happened to a `persist` target after submit.
 *
 * Background: a `agenthub:credential-request` block may declare a `persist`
 * target (a skill id + a map of request field → the skill's declared credential
 * key name). On submit the server tries to write those values into the session
 * owner's per-user skill credential store and returns a `persisted` result:
 *   { skillId, stored: string[], skipped: [{keyName, reason}], error? }
 *
 * The web and mobile cards previously each built the post-submit confirmation
 * message inline, and each looked only at whether `stored` was non-empty. That
 * produced two classes of wrong message:
 *   - a *total* failure (`stored: []`, `error` set) read as the normal
 *     ephemeral-discard copy, silently swallowing the failure; and
 *   - a *partial* success (username stored, password skipped) read as full
 *     "saved, will be reused", even though the next spawn will fail to auth.
 *
 * Both are the same underlying defect: the message ignored most of the server's
 * result. This helper classifies the whole result once — accounting for the
 * requested keys, what was actually stored, what was skipped, and any error —
 * so both clients render an honest message from one tested code path.
 *
 * Only non-secret data is used here: credential *key names* (env-var names the
 * skill declares) and the server's reason string. Never the submitted values.
 */

export interface CredentialPersistTarget {
  skillId: string;
  /** request field key → the skill's declared credential key name. */
  map: Record<string, string>;
}

export interface CredentialPersistResult {
  skillId?: string;
  stored?: string[];
  skipped?: Array<{ keyName: string; reason: string }>;
  error?: string;
}

/** Skill id shape shared by every persist-target normalizer. */
export const PERSIST_SKILL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** Declared-credential (env-var) key-name shape. */
export const PERSIST_KEY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Upper bound on how many field→key mappings one request may persist. */
export const PERSIST_MAX_MAP_ENTRIES = 6;

/**
 * The single authoritative validator/normalizer for a credential-request
 * `persist` target, shared 1:1 by the server route, the web client, and the
 * mobile client so the same rules can't drift between them.
 *
 * Returns `null` (persistence off) when the target is absent or malformed —
 * callers treat "no persist" and "bad persist" identically: skip persistence,
 * keep the ephemeral submit. Enforced invariants:
 *   - `skillId` matches PERSIST_SKILL_ID_RE.
 *   - `map` is a non-empty object with at most PERSIST_MAX_MAP_ENTRIES entries.
 *   - every mapped destination key name matches PERSIST_KEY_NAME_RE.
 *   - **destination key names are unique** — two fields mapping to the same
 *     declared credential key would upsert sequentially, the later value
 *     silently overwriting the earlier while both report as stored, leaving the
 *     wrong secret persisted (e.g. `{ password: "LOGIN", username: "LOGIN" }`).
 *     Such a map is rejected outright, never partially applied.
 *   - when `fieldKeys` is supplied (clients), every map key must be a real
 *     request field key.
 */
export function normalizeCredentialPersistTarget(
  raw: unknown,
  opts?: { fieldKeys?: ReadonlySet<string> },
): CredentialPersistTarget | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as { skillId?: unknown; map?: unknown };
  const skillId = typeof obj.skillId === 'string' ? obj.skillId.trim() : '';
  if (!PERSIST_SKILL_ID_RE.test(skillId)) return null;
  if (!obj.map || typeof obj.map !== 'object' || Array.isArray(obj.map)) return null;
  const entries = Object.entries(obj.map as Record<string, unknown>);
  if (entries.length === 0 || entries.length > PERSIST_MAX_MAP_ENTRIES) return null;
  const map: Record<string, string> = {};
  const seenKeyNames = new Set<string>();
  for (const [fieldKey, keyName] of entries) {
    if (opts?.fieldKeys && !opts.fieldKeys.has(fieldKey)) return null;
    if (typeof keyName !== 'string') return null;
    const trimmed = keyName.trim();
    if (!PERSIST_KEY_NAME_RE.test(trimmed)) return null;
    if (seenKeyNames.has(trimmed)) return null;
    seenKeyNames.add(trimmed);
    map[fieldKey] = trimmed;
  }
  return { skillId, map };
}

export type CredentialPersistOutcomeKind = 'off' | 'saved' | 'partial' | 'failed';

export interface CredentialPersistOutcome {
  kind: CredentialPersistOutcomeKind;
  /** The user-facing sentence describing what happened to the values. */
  line: string;
  /** Requested credential key names confirmed written to the store. */
  savedKeys: string[];
  /** Requested credential key names that were NOT written (skipped/omitted/failed). */
  unsavedKeys: string[];
}

export const EPHEMERAL_DISCARD_LINE =
  'They are available to this session through the credential request API until they expire, then discarded.';

function uniqueTruthy(values: readonly (string | undefined | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0))];
}

/**
 * Classify the server's `persisted` result against the request's `persist`
 * target into an outcome + honest user-facing line.
 *
 * - `off`     — no persist target was requested (ephemeral-only submit).
 * - `saved`   — every requested key was stored, nothing skipped, no error.
 * - `partial` — at least one requested key stored, but others were not.
 * - `failed`  — nothing was stored.
 */
export function describeCredentialPersistOutcome(opts: {
  service: string;
  persist?: CredentialPersistTarget | null;
  persisted?: CredentialPersistResult | null;
}): CredentialPersistOutcome {
  const service = opts.service || 'the';

  if (!opts.persist) {
    return { kind: 'off', line: EPHEMERAL_DISCARD_LINE, savedKeys: [], unsavedKeys: [] };
  }

  // The keys the request asked to persist. These are the denominator for
  // "did we save everything?" — a stored key we didn't ask for cannot make an
  // incomplete set complete.
  const requestedKeys = uniqueTruthy(Object.values(opts.persist.map ?? {}));
  const storedSet = new Set(uniqueTruthy(opts.persisted?.stored ?? []));
  const error = opts.persisted?.error?.trim() || '';

  const savedKeys = requestedKeys.filter((k) => storedSet.has(k));
  // Any requested key not confirmed stored is unsaved: this folds together
  // server-side `skipped` entries, keys the server omitted entirely, and the
  // nothing-stored case — we never need to trust `skipped` to be exhaustive.
  const unsavedKeys = requestedKeys.filter((k) => !storedSet.has(k));

  if (savedKeys.length > 0 && unsavedKeys.length === 0 && !error) {
    return {
      kind: 'saved',
      line: `They were also saved to your ${service} skill credentials and will be reused in future sessions.`,
      savedKeys,
      unsavedKeys,
    };
  }

  const reason = error ? ` (${error})` : '';

  if (savedKeys.length > 0) {
    return {
      kind: 'partial',
      line: `They were only partially saved to your ${service} skill credentials — ${savedKeys.join(
        ', ',
      )} stored, but ${unsavedKeys.join(
        ', ',
      )} could NOT be saved${reason}. Future sessions may still fail to authenticate until the missing value(s) are provided.`,
      savedKeys,
      unsavedKeys,
    };
  }

  return {
    kind: 'failed',
    line: `They could NOT be saved to your ${service} skill credentials for future sessions${reason}, so they are only available to this session until they expire.`,
    savedKeys,
    unsavedKeys,
  };
}
