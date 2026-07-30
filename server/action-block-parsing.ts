// ─── Shared helpers for parsing agent action-block payloads ──────────────
//
// Action blocks (`<agenthub:close-card>`,
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

  // Find the first opener. Action payloads may be objects or arrays.
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

/**
 * Replace the *body* of every fenced markdown code block in `text` with
 * empty lines, preserving the opening and closing fences (and the line
 * count) so callers can still scan the surrounding prose without the
 * fenced contents leaking into their regex matches.
 *
 * Why this exists
 * ───────────────
 * The agent-side action-block detectors (`<agenthub:skill>`,
 * `<agenthub:react>`, `<agenthub:wiki>`) historically did a naive
 * `text.match(/<tag>.*?<\/tag>/)` on the assistant's raw output. That
 * works fine for real invocations, but it also matches *documentation
 * examples* the agent legitimately quotes inside ```/~~~ fences when
 * explaining how to use a skill — and a false-positive detection drops
 * the example skill into `pending_skill_context`, which flips
 * `continuationContextAdded` true and triggers an auto-continuation
 * turn the agent never asked for. Repeating the same explanation
 * (with the same example block) on the next turn re-fires the loop
 * until the depth cap kills it.
 *
 * Pre-stripping fenced bodies before the detector regex runs makes the
 * documented behavior real: only blocks the agent emits as *naked*
 * top-level XML tags count as invocations. Quoted examples inside
 * ` ``` ` or `~~~` are inert.
 *
 * Conservative scope
 * ──────────────────
 * - Only fenced (```/~~~) blocks are masked. Inline backtick spans
 *   (`` ` ``) and indented (4-space) code blocks are left alone — the
 *   bug we're fixing only manifests in multi-line fences, and inline
 *   spans rarely contain a full agent-tag pair anyway.
 * - The opening and closing fence lines themselves are kept verbatim
 *   so other passes that count newlines or scan for fence markers
 *   still see them.
 * - Closing fence rule follows the CommonMark contract: the closer
 *   must use the same fence character as the opener and be at least
 *   as long. A mismatched closer is treated as fenced content, which
 *   matches how real markdown renderers behave.
 */
export function stripFencedCodeBlockBodies(text: string): string {
  if (typeof text !== 'string' || !text.length) return text;
  if (text.indexOf('`') === -1 && text.indexOf('~') === -1) return text;

  const lines = text.split('\n');
  let openFence: { char: string; len: number } | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const m = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (openFence === null) {
      if (m) {
        openFence = { char: m[1]![0]!, len: m[1]!.length };
      }
      continue;
    }
    // Inside a fenced block.
    if (m && m[1]![0] === openFence.char && m[1]!.length >= openFence.len) {
      // Closing fence — keep the line verbatim and exit fenced mode.
      openFence = null;
      continue;
    }
    // Fenced body line — blank it so detectors can't match across it.
    lines[i] = '';
  }

  return lines.join('\n');
}

/**
 * Fallback detector for action blocks that are wrapped inside a fenced code
 * block at the **very end** of the message. This handles a real-world bug where
 * agents follow the documentation example too literally and wrap the action block
 * in triple-backtick fences instead of emitting it as a naked XML tag.
 *
 * When an agent outputs:
 * ```
 * <agenthub:skill>{"name":"kanban"}</agenthub:skill>
 * ```
 * the primary detectors (`detectSkillBlock`, `detectReActBlock`) use
 * `stripFencedCodeBlockBodies` to mask fenced content — which correctly prevents
 * false-positives from in-body documentation examples, but also swallows genuine
 * end-of-turn invocations that happen to be inside a fence.
 *
 * Safety constraint: we **only** search the LAST fenced block, AND only when it
 * appears at the tail of the message (nothing meaningful after its closing fence).
 * This preserves the documentation-example guard for mid-message fences while
 * rescuing end-of-turn invocations.
 *
 * @param text     Full assistant message text.
 * @param tagName  The XML tag name to look for (e.g. `agenthub:skill`).
 * @returns The matched block string, or `null` if none found.
 */
export function detectTagBlockInLastFence(text: string, tagName: string): string | null {
  if (typeof text !== 'string' || !text.trim()) return null;

  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tagRe = new RegExp(`<${escaped}>\\s*[\\s\\S]*?\\s*</${escaped}>`, 'i');

  /** Last ``` or ~~~ fence that runs to EOF, with the same fence char on open/close. */
  const candidates: Array<{ block: string; matchIndex: number }> = [];
  for (const fence of ['```', '~~~'] as const) {
    const notInInfo = fence === '```' ? '[^\n`]*' : '[^\n~]*';
    const fenceTailRe = new RegExp(
      `${fence}${notInInfo}?\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*${fence}[ \\t]*$`,
    );
    const m = text.match(fenceTailRe);
    if (!m || m.index === undefined) continue;
    const fenceBody = m[1] ?? '';
    const tagMatch = fenceBody.match(tagRe);
    if (tagMatch) {
      candidates.push({ block: tagMatch[0], matchIndex: m.index });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.matchIndex - b.matchIndex);
  return candidates[candidates.length - 1]!.block;
}
