// ─── Shared helpers for parsing agent action-block payloads ──────────────
//
// Action blocks (`<agenthub:close-card>`, `<handoff>`, `<delegate>`,
// `<agenthub:skill>`, `<agenthub:react>`, …) all share the same shape:
// an XML-style tag with a JSON body inside. Each detector historically
// did its own ad-hoc `text.match(/<tag>...<\/tag>/)` followed by a
// raw `JSON.parse(match[1])`. That is brittle in three real-world ways:
//
//   1. The model wraps the JSON in a markdown code fence inside the
//      tag, e.g. ` ```json\n{...}\n``` ` — JSON.parse chokes on the
//      backticks and the action silently no-ops.
//   2. The model emits a one-line prose lead-in before the JSON
//      object, e.g. `Here's the payload:\n{ ... }` — JSON.parse
//      chokes on the leading prose.
//   3. The model puts a literal newline (or carriage return / tab)
//      inside a JSON string value, e.g. `{"note": "line one\nline
//      two"}` where `\n` is a real \x0A byte — JSON.parse rejects
//      raw control characters inside strings (per RFC 8259 §7).
//
// `extractJsonFromTagBody` accepts the *body* between an opening and
// closing action-block tag (or fence) and returns a JSON string that
// `JSON.parse` will accept, or `null` when no salvageable JSON can
// be located. Each individual detector keeps its own typed validation
// of the parsed object — this helper only normalizes the lexical
// frame.
//
// The helper is deliberately permissive: we'd rather route a slightly
// malformed block through to typed validation (which produces a
// clear `reason: 'missing-toagent'` style error the agent can learn
// from) than silently drop the whole block.

/** Result of `extractJsonFromTagBody`: a JSON string ready for `JSON.parse`, or null. */
export function extractJsonFromTagBody(rawBody: string): string | null {
  if (typeof rawBody !== 'string') return null;
  let body = rawBody.trim();
  if (!body) return null;

  // Step 1: strip a markdown blockquote prefix (`> `) from every line if
  // every non-blank line is so prefixed. Some agents (and the GitHub web
  // UI when quoting) wrap action blocks in a blockquote, which leaves a
  // `> ` marker on each line of the JSON body.
  body = stripBlockquotePrefix(body);
  if (!body) return null;

  // Step 2: strip an outer markdown code fence the model may have wrapped
  // around the JSON inside the tag. Tolerate ```, ```json, ```javascript, etc.
  body = stripOuterMarkdownFence(body);
  if (!body) return null;

  // Step 3: locate the first balanced JSON value (object or array). This
  // skips any leading prose like "Here's the payload:" before the `{`.
  const sliced = sliceFirstBalancedJson(body);
  if (sliced === null) return null;

  // Step 4: normalize raw control characters inside string contexts.
  // JSON.parse rejects literal \n / \r / \t inside string values, so we
  // re-encode them. Outside strings, control chars are harmless to JSON
  // (whitespace) and we leave them alone.
  return normalizeControlCharsInsideStrings(sliced);
}

/**
 * If every non-blank line of `body` begins with a markdown blockquote
 * marker (`>` optionally followed by a single space/tab), strip that
 * marker from every line and return the unwrapped body. Returns `body`
 * unchanged when the blockquote prefix isn't uniform — we don't want to
 * mangle a legitimate JSON string value that happens to contain `>` at
 * the start of one line.
 *
 * Whitespace-only lines are tolerated (they don't need the prefix). At
 * least one non-blank line must carry the prefix or we no-op.
 */
export function stripBlockquotePrefix(body: string): string {
  if (typeof body !== 'string' || !body.length) return body;
  const lines = body.split('\n');
  let sawPrefixedLine = false;
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (!/^[ \t]*>[ \t]?/.test(line)) return body;
    sawPrefixedLine = true;
  }
  if (!sawPrefixedLine) return body;
  return lines.map((line) => line.replace(/^[ \t]*>[ \t]?/, '')).join('\n');
}

/**
 * If `body` is wrapped in a single outer markdown code fence (e.g.
 * ` ```json ... ``` `), strip the fence and return the inner contents.
 * Otherwise return `body` unchanged.
 *
 * Only strips a fence pair that actually wraps the entire body — does
 * NOT touch fences that appear in the middle (those would be inside
 * a JSON string and are the caller's responsibility).
 */
export function stripOuterMarkdownFence(body: string): string {
  if (typeof body !== 'string') return body;
  const trimmed = body.trim();
  // Match: opening fence (```, optionally with language hint), then any
  // content, then closing fence at end. Use a non-greedy capture so we
  // don't swallow extra fences mid-body.
  const m = trimmed.match(/^```[ \t]*[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/);
  if (m) {
    const inner = m[1].trim();
    if (inner) return inner;
  }
  // Also handle single-line fenced bodies: ```json {...} ```
  const oneLine = trimmed.match(/^```[ \t]*[A-Za-z0-9_-]*[ \t]*([\s\S]*?)```[ \t]*$/);
  if (oneLine) {
    const inner = oneLine[1].trim();
    if (inner) return inner;
  }
  return trimmed;
}

/**
 * Find the first balanced JSON object (`{...}`) or array (`[...]`) in
 * `body` and return that slice. Returns `null` when no opener exists,
 * or the body unchanged when an opener exists but no balanced close
 * could be found (the caller's `JSON.parse` will then fail with the
 * original error so the malformed-reason gate still fires).
 *
 * Tracks string state (with escape sequences) so braces/brackets
 * inside string literals don't corrupt the depth counter.
 */
export function sliceFirstBalancedJson(body: string): string | null {
  if (typeof body !== 'string' || !body.length) return null;

  // Find the first opener. We accept either { or [ (delegate emits an
  // array, the others an object).
  let openIdx = -1;
  let openCh = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '{' || ch === '[') {
      openIdx = i;
      openCh = ch;
      break;
    }
  }
  if (openIdx === -1) return null;

  const closeCh = openCh === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = openIdx; i < body.length; i += 1) {
    const ch = body[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === openCh) depth += 1;
    else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) {
        return body.slice(openIdx, i + 1);
      }
    }
  }

  // No balanced close found. Fall back to the slice from the opener to
  // end-of-body so JSON.parse can still produce a useful error message.
  return body.slice(openIdx);
}

/**
 * Walk `json` and replace literal control characters (newline, carriage
 * return, tab, form feed, backspace) with their JSON-escaped form
 * **only when they appear inside a string literal**. This makes
 * `JSON.parse` accept payloads where the agent emitted multi-line
 * strings without escaping the newlines.
 *
 * Outside strings, control chars are normal JSON whitespace and are
 * left untouched.
 */
export function normalizeControlCharsInsideStrings(json: string): string {
  if (typeof json !== 'string' || !json.length) return json;

  let out = '';
  let inString = false;
  let escape = false;

  for (let i = 0; i < json.length; i += 1) {
    const ch = json[i];

    if (escape) {
      out += ch;
      escape = false;
      continue;
    }

    if (inString) {
      if (ch === '\\') {
        out += ch;
        escape = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      // Inside a string: normalize raw control chars that JSON.parse
      // rejects per RFC 8259 §7.
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      if (ch === '\f') {
        out += '\\f';
        continue;
      }
      if (ch === '\b') {
        out += '\\b';
        continue;
      }
      out += ch;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    out += ch;
  }

  return out;
}

/**
 * Convenience wrapper: extract + parse. Returns the parsed value, or
 * `undefined` when extraction failed and a sentinel error tagged
 * object when JSON.parse threw. Callers that need the raw body for
 * error reporting should call `extractJsonFromTagBody` directly.
 */
export function parseTagBodyAsJson(rawBody: string): { ok: true; value: unknown } | { ok: false } {
  const extracted = extractJsonFromTagBody(rawBody);
  if (extracted === null) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(extracted) };
  } catch {
    return { ok: false };
  }
}
