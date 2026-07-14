/**
 * Redaction + text normalization for ingested customer logs (decision
 * LOG-TRUST). Every ingested field is untrusted: we normalize control
 * characters (so log text can never inject terminal escapes or forge log
 * lines), then strip secrets with a key-based pass (redact the whole value of
 * a sensitively-named field) plus a value pattern pass (redact secret-looking
 * substrings anywhere in a string). Both run BEFORE persistence, so the store
 * never holds a plaintext credential.
 *
 * Pure and IO-free so it unit-tests without a DB or server. The route resolves
 * a project's operator-configured extra keys / regexes and folds them into the
 * built-ins via {@link buildRedactionConfig}.
 */

/** Shown in place of any redacted value or secret substring. */
export const REDACTION_PLACEHOLDER = '[redacted]';

/**
 * Attribute keys whose ENTIRE value is dropped regardless of shape. Matched
 * case-insensitively as a substring of the key, so `Authorization`,
 * `x-api-key`, `db_password`, and `AWS_SECRET_ACCESS_KEY` all hit. Non-global
 * (used with `.test`) so they carry no `lastIndex` state.
 */
const BUILTIN_KEY_PATTERNS: readonly RegExp[] = [
  // Intentionally conservative: substring/boundary matching may over-redact a
  // benign key such as `compass` or `tokenCount`. At this trust boundary a
  // false positive is preferable to persisting a credential in plaintext.
  /authorization/i,
  /\bcookie\b/i,
  /pass(word|wd|phrase)?\b/i,
  /\bpwd\b/i,
  /secret/i,
  /token/i,
  /api[-_ ]?key/i,
  /access[-_ ]?key/i,
  /private[-_ ]?key/i,
  /client[-_ ]?secret/i,
  /credential/i,
  /session[-_ ]?(id|key|token)/i,
  /connection[-_ ]?string/i,
  /\bdsn\b/i,
];

/**
 * Secret-looking VALUE patterns redacted anywhere they appear in a string
 * (body or attribute value). Each is global so `String.replace` masks every
 * occurrence; `.replace` is stateless per call, so sharing these across calls
 * is safe. Ordered private-key block first (multi-line, greedy) so it collapses
 * before the narrower token patterns run over its contents.
 */
const BUILTIN_VALUE_PATTERNS: readonly RegExp[] = [
  // PEM private-key blocks (RSA/EC/OpenSSH/PGP). Non-greedy to the matching END.
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  // Authorization header schemes: `Bearer <token>`, `Basic <b64>`.
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // JSON Web Tokens (three base64url segments).
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
  // `key=value` / `key: value` credential assignments in query/kv strings.
  /(?:password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|auth)\s*[=:]\s*"?[^\s"'&,;]+/gi,
  // URL userinfo with a password: scheme://user:pass@host → mask the userinfo.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi,
  // Cloud / vendor credential formats.
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/g, // AWS temporary access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub PAT / OAuth / app tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe secret / restricted keys
  /\bah(?:log|ub)_[A-Za-z0-9_-]{20,}\b/g, // Agent Hub ingest / API tokens
];

export interface RedactionConfig {
  /** Key matchers (built-ins + operator extras). Value fully dropped on match. */
  keyMatchers: readonly RegExp[];
  /** Value matchers (built-ins + operator extras). Matched substrings masked. */
  valueMatchers: readonly RegExp[];
}

/** Operator-supplied additions folded onto the built-ins. */
export interface RedactionOverrides {
  /** Extra attribute-key substrings whose value is always dropped. */
  redactKeys?: string[] | null;
  /** Extra value regex sources (JS syntax). Invalid patterns are skipped. */
  redactPatterns?: string[] | null;
}

/**
 * Compile a {@link RedactionConfig} from the built-ins plus any operator
 * overrides. Extra keys become case-insensitive substring matchers; extra
 * patterns are compiled with the global+insensitive flags. A malformed regex
 * or an over-long/oversized override list is skipped rather than throwing, so
 * bad project config can never break ingest.
 *
 * ReDoS note: operator `redactPatterns` run over every ingested body/attribute
 * string at ingest volume, so a catastrophically-backtracking pattern (e.g.
 * `(a+)+$`) could stall the event loop. This is bounded, not eliminated: the
 * source is only settable by a project admin (not by the untrusted log sender),
 * the list is capped (100 patterns, ≤500 chars each), and each pattern only
 * runs against inputs already length-bounded by the record/request caps
 * (`MAX_RECORD_BYTES` / `MAX_REQUEST_BYTES`). Node has no built-in per-regex
 * timeout; if untrusted-authored patterns ever become possible, move matching to
 * a worker with a wall-clock budget or a linear-time engine (re2). Keep
 * configured patterns simple (prefer anchored literals over nested quantifiers).
 */
export function buildRedactionConfig(overrides?: RedactionOverrides | null): RedactionConfig {
  const keyMatchers: RegExp[] = [...BUILTIN_KEY_PATTERNS];
  const valueMatchers: RegExp[] = [...BUILTIN_VALUE_PATTERNS];

  for (const raw of (overrides?.redactKeys ?? []).slice(0, 100)) {
    if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 200) continue;
    keyMatchers.push(new RegExp(escapeRegExp(raw.trim()), 'i'));
  }
  for (const raw of (overrides?.redactPatterns ?? []).slice(0, 100)) {
    if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 500) continue;
    try {
      valueMatchers.push(new RegExp(raw, 'gi'));
    } catch {
      // Skip an invalid user-supplied regex instead of failing the request.
    }
  }
  return { keyMatchers, valueMatchers };
}

/** Escape a literal string for safe inclusion in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Built from `\u` escapes (no literal control bytes in source):
//   ANSI CSI escape sequences (ESC `[` … final byte) — stripped so ingested
//   text can't smuggle terminal control codes into a later render.
// eslint-disable-next-line no-control-regex -- intentionally matches ESC to strip ANSI
const ANSI_ESCAPE = new RegExp('\\u001b\\[[0-9;?]*[ -/]*[@-~]', 'g');
//   C0 (0x00-0x1f) + DEL (0x7f) + C1 (0x80-0x9f) control chars, keeping TAB
//   (0x09) and LF (0x0a). CR is collapsed to LF before this runs.
// eslint-disable-next-line no-control-regex -- intentionally matches control chars to strip them
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]', 'g');

/**
 * Normalize untrusted log text so it renders as inert text: collapse CRLF/CR to
 * LF, drop ANSI escape sequences, and strip remaining control characters (TAB
 * and LF survive). This is what stops an ingested line from forging additional
 * log lines or injecting terminal escapes when later rendered.
 */
export function normalizeLogText(input: string): string {
  return input.replace(/\r\n?/g, '\n').replace(ANSI_ESCAPE, '').replace(CONTROL_CHARS, '');
}

/**
 * Normalize + redact a free-text string. Returns the cleaned text and the
 * number of secret substrings masked (for the ingest redaction metric).
 */
export function redactText(
  input: string,
  config: RedactionConfig,
): { value: string; redactions: number } {
  let value = normalizeLogText(input);
  let redactions = 0;
  for (const re of config.valueMatchers) {
    value = value.replace(re, () => {
      redactions++;
      return REDACTION_PLACEHOLDER;
    });
  }
  return { value, redactions };
}

/** Does this attribute key match a secret-key matcher? */
function isSecretKey(key: string, config: RedactionConfig): boolean {
  return config.keyMatchers.some((re) => re.test(key));
}

/**
 * Recursively redact a structured value (attributes / resource / scope blob):
 *
 *  - An entry whose KEY is sensitive has its whole value replaced, whatever its
 *    shape (string, number, nested object) — so a `{ password: {...} }` can't
 *    smuggle a secret past the string-only value pass.
 *  - Every remaining string leaf runs through {@link redactText}.
 *  - Objects and arrays are walked; other primitives pass through untouched.
 *
 * Depth-bounded so a pathological nesting can't blow the stack.
 */
export function redactStructured(
  value: unknown,
  config: RedactionConfig,
  depth = 0,
): { value: unknown; redactions: number } {
  if (depth > 32) return { value: REDACTION_PLACEHOLDER, redactions: 0 };

  if (typeof value === 'string') {
    return redactText(value, config);
  }
  if (Array.isArray(value)) {
    let redactions = 0;
    const out = value.map((item) => {
      const r = redactStructured(item, config, depth + 1);
      redactions += r.redactions;
      return r.value;
    });
    return { value: out, redactions };
  }
  if (value && typeof value === 'object') {
    let redactions = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(k, config)) {
        out[k] = REDACTION_PLACEHOLDER;
        redactions++;
        continue;
      }
      const r = redactStructured(v, config, depth + 1);
      redactions += r.redactions;
      out[k] = r.value;
    }
    return { value: out, redactions };
  }
  return { value, redactions: 0 };
}
