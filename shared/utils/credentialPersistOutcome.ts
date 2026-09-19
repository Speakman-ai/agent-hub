/**
 * Classify a credential-request `persist` result for the post-submit line.
 * Uses only key names and skip reasons, never the submitted values.
 */

export interface CredentialPersistTarget {
  skillId: string;
  /** request field key → declared credential key name. */
  map: Record<string, string>;
}

export interface CredentialPersistResult {
  skillId?: string;
  stored?: string[];
  skipped?: Array<{ keyName: string; reason: string }>;
  error?: string;
}

export const PERSIST_SKILL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const PERSIST_KEY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const PERSIST_MAX_MAP_ENTRIES = 6;

/**
 * Normalize a persist target. Returns null (treat as ephemeral) when absent or
 * malformed. Duplicate destination key names are rejected: two fields mapping
 * to the same credential would overwrite silently while both report as stored.
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
  /** User-facing sentence. */
  line: string;
  savedKeys: string[];
  unsavedKeys: string[];
}

export const EPHEMERAL_DISCARD_LINE =
  'They are available to this session through the credential request API until they expire, then discarded.';

function uniqueTruthy(values: readonly (string | undefined | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0))];
}

/**
 * Classify `persisted` against the request's persist target.
 * `off` / `saved` / `partial` / `failed`. Unsaved = any requested key not in `stored`.
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

  // Denominator is requested keys only; extra stored keys cannot complete a miss.
  const requestedKeys = uniqueTruthy(Object.values(opts.persist.map ?? {}));
  const storedSet = new Set(uniqueTruthy(opts.persisted?.stored ?? []));
  const error = opts.persisted?.error?.trim() || '';

  const savedKeys = requestedKeys.filter((k) => storedSet.has(k));
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
