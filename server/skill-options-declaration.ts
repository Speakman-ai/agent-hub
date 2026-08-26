/**
 * Declarative, non-secret option schema embedded in SKILL.md frontmatter
 * (`options:`). The skill owner defines a set of named options, each with a
 * fixed list of allowed choices and a default. A user of the skill selects one
 * choice per option; the selection is injected as an env var into that user's
 * spawns (see `skill-options-spawn.ts`).
 *
 * This is the non-secret sibling of `credentials:` (see
 * `skill-credentials-declaration.ts`): options are owner-curated enums (e.g.
 * "dev" vs "prod"), never free-text secrets. They are stored in plaintext and
 * are safe to render in a picker.
 */

export interface SkillOptionChoice {
  value: string;
  label: string;
}

export interface SkillOptionSpec {
  name: string;
  label: string;
  description: string;
  choices: SkillOptionChoice[];
  /** Always one of `choices[].value`. Falls back to the first choice. */
  default: string;
  required: boolean;
}

export interface ParsedOptions {
  options: SkillOptionSpec[];
  /** Non-null when frontmatter is malformed; empty options + error for bad shapes. */
  error: string | null;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function coerceChoice(raw: unknown): SkillOptionChoice | null {
  // A bare string is shorthand for `{ value, label }` with value === label.
  if (typeof raw === 'string') {
    const value = raw.trim();
    if (!value) return null;
    return { value: value.slice(0, 200), label: value.slice(0, 200) };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const value = typeof obj.value === 'string' ? obj.value.trim() : '';
  if (!value) return null;
  const label =
    typeof obj.label === 'string' && obj.label.trim()
      ? obj.label.trim().slice(0, 200)
      : value.slice(0, 200);
  return { value: value.slice(0, 200), label };
}

export function parseOptionsDeclaration(raw: unknown): ParsedOptions {
  if (raw === undefined || raw === null) {
    return { options: [], error: null };
  }
  if (!Array.isArray(raw)) {
    return { options: [], error: 'options must be an array' };
  }
  const options: SkillOptionSpec[] = [];
  const names = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { options: [], error: `options[${i}] must be an object` };
    }
    const obj = entry as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name) {
      return { options: [], error: `options[${i}] missing name` };
    }
    if (!ENV_NAME_RE.test(name)) {
      return {
        options: [],
        error: `options[${i}] name "${name}" must look like a POSIX env var (e.g. SURVEY_TRACKER_ENV)`,
      };
    }
    if (names.has(name)) {
      return { options: [], error: `duplicate option name "${name}"` };
    }
    names.add(name);

    if (!Array.isArray(obj.choices) || obj.choices.length === 0) {
      return {
        options: [],
        error: `options[${i}] "${name}" must declare a non-empty choices array`,
      };
    }
    const choices: SkillOptionChoice[] = [];
    const choiceValues = new Set<string>();
    for (let j = 0; j < obj.choices.length; j++) {
      const choice = coerceChoice(obj.choices[j]);
      if (!choice) {
        return { options: [], error: `options[${i}].choices[${j}] is invalid` };
      }
      if (choiceValues.has(choice.value)) {
        return {
          options: [],
          error: `options[${i}] "${name}" has duplicate choice value "${choice.value}"`,
        };
      }
      choiceValues.add(choice.value);
      choices.push(choice);
    }

    const label =
      typeof obj.label === 'string' && obj.label.trim() ? obj.label.trim().slice(0, 120) : name;
    const description =
      typeof obj.description === 'string' ? obj.description.trim().slice(0, 2000) : '';

    // Default must resolve to a real choice. An explicit but unknown default is
    // an authoring error; an omitted default falls back to the first choice.
    const declaredDefault = typeof obj.default === 'string' ? obj.default.trim() : '';
    if (declaredDefault && !choiceValues.has(declaredDefault)) {
      return {
        options: [],
        error: `options[${i}] "${name}" default "${declaredDefault}" is not one of its choices`,
      };
    }
    const def = declaredDefault || choices[0]!.value;

    const required = typeof obj.required === 'boolean' ? obj.required : false;

    options.push({ name, label, description, choices, default: def, required });
  }
  return { options, error: null };
}

/**
 * Validate a candidate value against an option spec. Returns the value when it
 * is a legal choice, else null (caller falls back to the default).
 */
export function isValidOptionValue(spec: SkillOptionSpec, value: unknown): boolean {
  return typeof value === 'string' && spec.choices.some((c) => c.value === value);
}
