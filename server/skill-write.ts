/**
 * Write-side helpers for authoring project skills (Skill Builder, Phase 1).
 *
 * The read side (GET/DELETE) lives in `routes/skills.ts`; the discovery merge
 * lives in `agent-skills-list.ts`. This module is the pure, framework-free
 * core that validates an author-supplied skill payload and composes the
 * canonical `SKILL.md` (YAML frontmatter + Markdown body) that gets written to
 * `<dataDir>/project-skills/<projectId>/<id>/SKILL.md`.
 *
 * Kept side-effect free (no fs, no express) so the route handlers stay thin
 * and the validation rules are unit-testable in isolation. Credential
 * frontmatter is validated through the same `parseCredentialsDeclaration`
 * used at read/spawn time, so a skill that round-trips through this writer can
 * never declare credentials the rest of the system would reject.
 */

import matter from 'gray-matter';
import { parseCredentialsDeclaration } from './skill-credentials-declaration.js';

/**
 * Skill ids / frontmatter `name` are slugs: lowercase alphanumerics and
 * hyphens, must start with an alphanumeric. This matches the on-disk folder
 * name and the `<agenthub:skill>{"name":"..."}` load id, so the two can never
 * drift.
 */
export const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
export const SKILL_ID_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 4000;
export const SKILL_VERSION_MAX = 32;

/** Allowed `category` frontmatter values. Defaults to `general` when omitted. */
export const ALLOWED_SKILL_CATEGORIES = [
  'general',
  'integration',
  'platform',
  'workflow',
  'automation',
  'tooling',
  'data',
  'communication',
] as const;

export type SkillCategory = (typeof ALLOWED_SKILL_CATEGORIES)[number];

export interface SkillWriteInput {
  name?: unknown;
  description?: unknown;
  category?: unknown;
  version?: unknown;
  body?: unknown;
  credentials?: unknown;
  keepCodingInstructions?: unknown;
  /**
   * Raw SKILL.md text (frontmatter + body). When provided, its parsed
   * frontmatter supplies any field not given explicitly, so the editor can
   * post a single textarea. Explicit structured fields still win over the
   * raw frontmatter (e.g. PUT forcing `name` to the path id).
   */
  content?: unknown;
}

/**
 * Frontmatter keys this module owns: it parses them into structured fields,
 * validates them, and re-emits them in a canonical order. Every OTHER key in a
 * raw `content` SKILL.md is "unrecognized" and must be preserved verbatim on a
 * round-trip (see `fieldsFromRawContent` / `validateAndComposeSkill`) so an
 * unchanged save never silently drops valid or future metadata (e.g.
 * `allowed-tools`, `license`, `model`).
 */
const MANAGED_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'category',
  'version',
  'credentials',
  'keep-coding-instructions',
]);

/**
 * Pull structured fields out of a raw SKILL.md string. `extra` carries every
 * frontmatter key this module does NOT manage, so the caller can re-emit them
 * verbatim and keep the edit lossless. Malformed YAML surfaces as a parse
 * error the caller turns into a 400.
 */
function fieldsFromRawContent(
  raw: string,
): { fields: SkillWriteInput; body: string; extra: Record<string, unknown> } | { error: string } {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (err) {
    return { error: `could not parse SKILL.md frontmatter: ${(err as Error).message}` };
  }
  const data = parsed.data as Record<string, unknown>;
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!MANAGED_FRONTMATTER_KEYS.has(key)) extra[key] = value;
  }
  return {
    fields: {
      name: data.name,
      description: data.description,
      category: data.category,
      version: data.version,
      credentials: data.credentials,
      keepCodingInstructions: data['keep-coding-instructions'],
    },
    body: parsed.content.replace(/^\n+/, ''),
    extra,
  };
}

export interface SkillComposeOk {
  ok: true;
  /** Normalized slug derived from `name` — the on-disk folder id. */
  slug: string;
  /** Full SKILL.md text (frontmatter + body), ready to write to disk. */
  content: string;
}

export interface SkillComposeErr {
  ok: false;
  error: string;
}

export type SkillComposeResult = SkillComposeOk | SkillComposeErr;

function asTrimmedString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Validate a slug for use as a skill id / frontmatter name. Returns the
 * normalized (trimmed) slug or an error message.
 */
export function validateSkillSlug(
  raw: unknown,
  field = 'name',
): { slug: string } | { error: string } {
  const slug = asTrimmedString(raw);
  if (!slug) return { error: `${field} is required` };
  if (slug.length > SKILL_ID_MAX)
    return { error: `${field} must be <= ${SKILL_ID_MAX} characters` };
  if (!SKILL_ID_RE.test(slug)) {
    return {
      error: `${field} "${slug}" must be a slug: lowercase letters, digits and hyphens, starting with a letter or digit (e.g. my-skill)`,
    };
  }
  return { slug };
}

/**
 * Validate an author payload and compose the canonical SKILL.md.
 *
 * `expectedSlug` (used by PUT, where the id is fixed by the URL path) forces
 * the resulting slug to match the path param — a rename via PUT is rejected so
 * the folder id and frontmatter `name` can never diverge.
 */
export function validateAndComposeSkill(
  rawInput: SkillWriteInput,
  opts: { expectedSlug?: string } = {},
): SkillComposeResult {
  let input = rawInput;
  // Unrecognized frontmatter keys from a raw `content` edit, preserved verbatim
  // so a round-trip (fetch raw SKILL.md → PUT it back) never drops metadata the
  // composer doesn't manage.
  let extraFrontmatter: Record<string, unknown> = {};
  // When raw SKILL.md text is posted, merge its parsed frontmatter underneath
  // any explicit structured fields (explicit fields win). The markdown body
  // becomes the default `body` when none is given explicitly.
  if (typeof rawInput.content === 'string' && rawInput.content.trim()) {
    const extracted = fieldsFromRawContent(rawInput.content);
    if ('error' in extracted) return { ok: false, error: extracted.error };
    const fm = extracted.fields;
    extraFrontmatter = extracted.extra;
    input = {
      name: rawInput.name ?? fm.name,
      description: rawInput.description ?? fm.description,
      category: rawInput.category ?? fm.category,
      version: rawInput.version ?? fm.version,
      credentials: rawInput.credentials ?? fm.credentials,
      keepCodingInstructions: rawInput.keepCodingInstructions ?? fm.keepCodingInstructions,
      body: rawInput.body ?? extracted.body,
    };
  }

  // name → slug
  const nameRaw = input.name === undefined && opts.expectedSlug ? opts.expectedSlug : input.name;
  const slugRes = validateSkillSlug(nameRaw, 'name');
  if ('error' in slugRes) return { ok: false, error: slugRes.error };
  const slug = slugRes.slug;

  if (opts.expectedSlug && slug !== opts.expectedSlug) {
    return {
      ok: false,
      error: `name "${slug}" must match the skill id "${opts.expectedSlug}" (rename is not supported)`,
    };
  }

  // description (required)
  const description = asTrimmedString(input.description);
  if (!description) return { ok: false, error: 'description is required' };
  if (description.length > SKILL_DESCRIPTION_MAX) {
    return { ok: false, error: `description must be <= ${SKILL_DESCRIPTION_MAX} characters` };
  }

  // category (optional, allowlisted)
  let category: string = 'general';
  if (input.category !== undefined && input.category !== null && input.category !== '') {
    const cat = asTrimmedString(input.category);
    if (!(ALLOWED_SKILL_CATEGORIES as readonly string[]).includes(cat)) {
      return {
        ok: false,
        error: `category "${cat}" is not allowed (one of: ${ALLOWED_SKILL_CATEGORIES.join(', ')})`,
      };
    }
    category = cat;
  }

  // version (optional)
  let version: string | undefined;
  if (input.version !== undefined && input.version !== null && input.version !== '') {
    if (typeof input.version !== 'string') {
      return { ok: false, error: 'version must be a string' };
    }
    const v = input.version.trim();
    if (v.length > SKILL_VERSION_MAX) {
      return { ok: false, error: `version must be <= ${SKILL_VERSION_MAX} characters` };
    }
    version = v;
  }

  // credentials (optional) — validated through the shared declaration parser.
  const parsedCreds = parseCredentialsDeclaration(input.credentials);
  if (parsedCreds.error) {
    return { ok: false, error: `invalid credentials: ${parsedCreds.error}` };
  }

  // body (optional markdown). Reject embedded frontmatter fences so authors
  // don't accidentally double-wrap; the frontmatter is composed from fields.
  const body = typeof input.body === 'string' ? input.body : '';
  if (/^\s*---\s*\n/.test(body)) {
    return {
      ok: false,
      error:
        'body must be Markdown only — do not include a YAML frontmatter block; use the frontmatter fields instead',
    };
  }

  const keepCodingInstructions = input.keepCodingInstructions === true;

  const frontmatter: Record<string, unknown> = { name: slug, description, category };
  if (version) frontmatter.version = version;
  if (keepCodingInstructions) frontmatter['keep-coding-instructions'] = true;
  if (parsedCreds.credentials.length > 0) frontmatter.credentials = parsedCreds.credentials;
  // Re-emit unrecognized keys from a raw content edit after the managed block,
  // so the round-trip is lossless. (Managed keys are already excluded from
  // `extraFrontmatter` by `fieldsFromRawContent`; the guard is belt-and-braces.)
  for (const [key, value] of Object.entries(extraFrontmatter)) {
    if (!MANAGED_FRONTMATTER_KEYS.has(key)) frontmatter[key] = value;
  }

  const normalizedBody = body.endsWith('\n') || body === '' ? body : body + '\n';
  const content = matter.stringify(normalizedBody, frontmatter);

  return { ok: true, slug, content };
}
