/** Declarative credential schema embedded in SKILL.md frontmatter (`credentials:`). */

export type SkillCredentialType = 'string' | 'secret' | 'file' | 'json';

export interface SkillCredentialSpec {
  name: string;
  label: string;
  description: string;
  required: boolean;
  type: SkillCredentialType;
  docs_url?: string;
}

export interface ParsedCredentials {
  credentials: SkillCredentialSpec[];
  /** Non-null when frontmatter is malformed; empty credentials + error for bad shapes. */
  error: string | null;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ALLOWED_TYPES: SkillCredentialType[] = ['string', 'secret', 'file', 'json'];

export function parseCredentialsDeclaration(raw: unknown): ParsedCredentials {
  if (raw === undefined || raw === null) {
    return { credentials: [], error: null };
  }
  if (!Array.isArray(raw)) {
    return { credentials: [], error: 'credentials must be an array' };
  }
  const credentials: SkillCredentialSpec[] = [];
  const names = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { credentials: [], error: `credentials[${i}] must be an object` };
    }
    const obj = entry as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name) {
      return { credentials: [], error: `credentials[${i}] missing name` };
    }
    if (!ENV_NAME_RE.test(name)) {
      return {
        credentials: [],
        error: `credentials[${i}] name "${name}" must look like a POSIX env var (e.g. LINEAR_API_KEY)`,
      };
    }
    if (names.has(name)) {
      return { credentials: [], error: `duplicate credential name "${name}"` };
    }
    names.add(name);
    const typeStr = typeof obj.type === 'string' ? obj.type.trim().toLowerCase() : '';
    const coerced = (typeStr === '' ? 'secret' : typeStr) as SkillCredentialType;
    if (!ALLOWED_TYPES.includes(coerced)) {
      return { credentials: [], error: `credentials[${i}] invalid type "${String(obj.type)}"` };
    }
    const label =
      typeof obj.label === 'string' && obj.label.trim() ? obj.label.trim().slice(0, 120) : name;
    const description =
      typeof obj.description === 'string' ? obj.description.trim().slice(0, 2000) : '';
    const docsUrlRaw = typeof obj.docs_url === 'string' ? obj.docs_url.trim() : '';
    const docs_url = docsUrlRaw ? docsUrlRaw.slice(0, 500) : undefined;
    const required = typeof obj.required === 'boolean' ? obj.required : true;
    credentials.push({
      name,
      label,
      description,
      required,
      type: coerced,
      ...(docs_url ? { docs_url } : {}),
    });
  }
  return { credentials, error: null };
}
