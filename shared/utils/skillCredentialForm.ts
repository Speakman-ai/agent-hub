/**
 * Per-user skill-credential form helpers: required-field validation and masked vs plaintext.
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

/** Mask `secret`/`json`; everything else is plain text. */
export function isSecretCredential(spec: SkillCredentialSpec | null | undefined): boolean {
  return spec?.type === 'secret' || spec?.type === 'json';
}

/** Error string if a required credential is blank (whitespace counts). */
export function validateCredentialValue(
  spec: SkillCredentialSpec | null | undefined,
  value: unknown,
): string | null {
  if (spec?.required && !String(value ?? '').trim()) {
    return 'This credential is required — enter a value before saving.';
  }
  return null;
}
