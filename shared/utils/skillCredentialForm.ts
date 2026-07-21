/**
 * skillCredentialForm.ts — pure helpers for the per-user skill-credential entry
 * form, shared by the web client (`SkillCard` in SkillsPage) and mobile
 * (`SkillCredentialSection` in SkillsScreen). Both surfaces render the same
 * schema-driven form: one input per declared credential spec, a saved-value
 * masked preview, required-field validation, and a secret/plaintext input mode.
 * Keeping the pure decisions here means the two clients cannot drift on which
 * saves are blocked or which inputs are masked.
 *
 * Everything here is PURE (schema + rows in → decision out) so it is trivially
 * unit-testable without React, a DB, or the network.
 */

/** A single declared credential from a skill's `credentials:` frontmatter. */
export interface SkillCredentialSpec {
  name: string;
  label?: string;
  description?: string;
  /** e.g. 'secret' | 'json' | 'text'. Secret/json render masked. */
  type?: string;
  required?: boolean;
  docs_url?: string;
}

/** A saved per-user credential row as returned by the credentials API. */
export interface SkillCredentialRow {
  id?: string | number;
  key_name?: string;
  masked_preview?: string;
  last_used_at?: string | null;
}

/** Find the saved credential row matching a spec key, if any. */
export function findCredentialRow(
  rows: SkillCredentialRow[] | null | undefined,
  keyName: string,
): SkillCredentialRow | undefined {
  if (!Array.isArray(rows)) return undefined;
  return rows.find((r) => r?.key_name === keyName);
}

/**
 * A secret-type credential (`secret` or `json`) is entered through a masked
 * input (web `type="password"`, mobile `secureTextEntry`); everything else is
 * plain text.
 */
export function isSecretCredential(spec: SkillCredentialSpec | null | undefined): boolean {
  return spec?.type === 'secret' || spec?.type === 'json';
}

/**
 * Validate a pending input value for a spec. Returns an error string when a
 * required credential is left blank (whitespace-only counts as blank),
 * otherwise `null`. Mirrors the web `saveCredential` guard so both clients
 * block empty required saves identically.
 */
export function validateCredentialValue(
  spec: SkillCredentialSpec | null | undefined,
  value: unknown,
): string | null {
  if (spec?.required && !String(value ?? '').trim()) {
    return 'This credential is required — enter a value before saving.';
  }
  return null;
}
