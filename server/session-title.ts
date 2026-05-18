/**
 * session-title.ts — derive a concise session name from the user's first message.
 *
 * Two layers:
 *  1. `deriveHeuristicTitle(content)` — pure, synchronous. Strips conversational
 *     filler, picks the first sentence, truncates at a word boundary, caps at
 *     60 chars. Always returns a non-empty string.
 *  2. `generateLlmTitle(opts)` — optional, async. Calls a fast model (Anthropic
 *     Haiku or OpenAI gpt-4o-mini) to produce a 4–8 word title. Returns `null`
 *     on any failure (missing key, network error, malformed response). The
 *     caller is expected to fall back to the heuristic value.
 *
 * The heuristic exists so the *initial* rename happens synchronously and the
 * sidebar updates immediately. The LLM path is a deferred upgrade that fires
 * once the first turn has committed; if it succeeds, the caller broadcasts a
 * second `session-updated`.
 */

const MAX_TITLE_LEN = 60;

// Conversational filler patterns. Each is applied repeatedly against the
// start of the string until no further reduction happens.
const FILLER_PATTERNS: RegExp[] = [
  // Greetings.
  /^(?:hey|hi|hello|yo|ok|okay|so|um|uh|well)[,!?.\s:-]+/i,
  // Politeness.
  /^(?:please|pls|kindly)[,!?.\s:-]+/i,
  // "Can you / could you / would you / will you ...".
  /^(?:can|could|would|will)\s+(?:you|we|i|someone)[,?\s:-]+/i,
  // "I want / I need / I'd like / I am trying / I'm trying ...".
  /^(?:i)(?:'m|\s+am)?\s+(?:want|need|would\s+like|trying|hoping|looking|wondering)\s+(?:to|if|whether|how|why)[,?\s:-]+/i,
  /^(?:i)(?:'d)?\s+(?:like|love)\s+(?:to|you\s+to|us\s+to)[,?\s:-]+/i,
  // "Help me ...".
  /^help\s+(?:me|us)[,?\s:-]+/i,
  // "Let's / Let me ...".
  /^let'?s[,?\s:-]+/i,
  /^let\s+me[,?\s:-]+/i,
  // Lead-ins.
  /^(?:just|quick(?:ly)?|maybe|perhaps)[,!?.\s:-]+/i,
  // Question lead-ins.
  /^(?:do|does|did)\s+(?:you|we)[,?\s:-]+/i,
];

function stripLeadingFiller(input: string): string {
  let s = input.trim();
  // Strip leading punctuation (quotes, dashes, etc.).
  s = s.replace(/^[\s"'`*_>#\-–—]+/, '');
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of FILLER_PATTERNS) {
      const next = s.replace(re, '');
      if (next.length < s.length) {
        s = next;
        changed = true;
      }
    }
    s = s.replace(/^[\s"'`*_>#\-–—]+/, '');
  }
  return s.trim();
}

function firstSentence(input: string): string {
  // Treat newlines as hard breaks so a one-liner intro followed by a code block
  // doesn't pull the code into the title. Note: `.split` with limit 1 returns
  // only the first segment in Node — matches the behaviour we want.
  const firstLine = input.split(/\r?\n/, 1)[0] ?? '';
  // Match up to the first sentence terminator followed by whitespace or EOL.
  // Capture the punctuation separately so we can drop trailing `.` (clutter
  // in a sidebar title) while keeping `?` and `!`.
  // `chat.ts` and `api.test.ts` style identifiers don't trip this because the
  // `.` there isn't followed by whitespace / EOL.
  const m = firstLine.match(/^(.+?)([.!?])(?:\s|$)/);
  if (m) {
    return (m[2] === '.' ? m[1] : m[1] + m[2]).trim();
  }
  return firstLine.trim();
}

function capitalize(input: string): string {
  if (!input) return input;
  // Don't change case if the first token looks like an identifier the user
  // wrote intentionally (camelCase / PascalCase / SCREAMING / contains a `_`
  // or `.`). Otherwise upper-case the first character.
  const firstWord = input.split(/\s+/, 1)[0] ?? '';
  if (/[A-Z]/.test(firstWord) || /[._]/.test(firstWord)) return input;
  return input[0].toUpperCase() + input.slice(1);
}

function truncateAtWordBoundary(input: string, maxLen: number): string {
  if (input.length <= maxLen) return input;
  const slice = input.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > Math.floor(maxLen * 0.6)) {
    return slice.slice(0, lastSpace).replace(/[\s,;:.!?-]+$/, '');
  }
  return slice.replace(/[\s,;:.!?-]+$/, '');
}

/**
 * Derive a concise session title from a raw user message.
 *
 * Guarantees:
 *  - Returns a non-empty string (falls back to `'New chat'` for empty / pure-
 *    punctuation inputs).
 *  - Length is ≤ MAX_TITLE_LEN.
 *  - Never appends `'...'` — truncation happens on a word boundary.
 */
export function deriveHeuristicTitle(content: string): string {
  if (typeof content !== 'string') return 'New chat';
  const normalized = content.replace(/[\t \u00a0]+/g, ' ').trim();
  if (!normalized) return 'New chat';

  // Cheap signal: if the message is just code or contains no letters, bail.
  if (!/[A-Za-z]/.test(normalized)) {
    return truncateAtWordBoundary(normalized, MAX_TITLE_LEN) || 'New chat';
  }

  // Strip leading conversational filler from the *raw first line* first so the
  // sentence-boundary logic operates on the real content. For "Hi! Please fix
  // X." the filler strip removes "Hi! Please " and leaves "fix X." for the
  // first-sentence pick — which is what we want as the title.
  const firstLine = normalized.split(/\r?\n/, 1)[0] ?? '';
  let candidate = stripLeadingFiller(firstLine);

  if (!candidate) {
    // Filler stripping consumed the whole line — fall back to the first
    // sentence of the raw input.
    candidate = firstSentence(normalized);
  } else {
    candidate = firstSentence(candidate);
  }
  if (!candidate) {
    candidate = normalized;
  }

  candidate = capitalize(candidate);
  candidate = truncateAtWordBoundary(candidate, MAX_TITLE_LEN);
  // Strip leftover quote/markup chrome the user may have wrapped the text in.
  candidate = candidate.replace(/^["'`*_]+|["'`*_]+$/g, '').trim();

  return candidate || 'New chat';
}

// ---------------------------------------------------------------------------
// LLM-backed title generation
// ---------------------------------------------------------------------------

export interface LlmTitleOptions {
  content: string;
  /** Anthropic API key. If both are set, Anthropic wins. */
  anthropicApiKey?: string | null;
  /** OpenAI API key. Used when no Anthropic key is set. */
  openaiApiKey?: string | null;
  /** Override the Anthropic model. Defaults to `claude-haiku-4-5`. */
  anthropicModel?: string;
  /** Override the OpenAI model. Defaults to `gpt-4o-mini`. */
  openaiModel?: string;
  /** Abort after this many ms. Default: 8000. */
  timeoutMs?: number;
  /** Injected fetch for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

const TITLE_PROMPT = [
  'You generate concise session titles for a chat app.',
  "Given the user's first message, write a 4-to-8 word title that captures the topic or intent.",
  'Rules:',
  '- Output ONLY the title text. No quotes, no trailing punctuation, no preamble.',
  '- Title case is fine; sentence case is fine. No ALL CAPS.',
  '- Do not exceed 60 characters.',
  '- Focus on the subject, not the speaker (avoid "User wants to...").',
].join('\n');

function sanitizeLlmTitle(raw: string): string {
  let t = raw.trim();
  // Strip surrounding quotes / backticks.
  t = t.replace(/^["'`*_]+|["'`*_]+$/g, '');
  // Collapse internal whitespace.
  t = t.replace(/\s+/g, ' ');
  // Drop trailing punctuation except `?` / `!`.
  t = t.replace(/[.,;:]+$/, '');
  t = t.trim();
  return truncateAtWordBoundary(t, MAX_TITLE_LEN);
}

/**
 * Ask a fast LLM to produce a concise session title. Returns `null` if no API
 * key is configured, the call fails, or the response is malformed. Never
 * throws.
 */
export async function generateLlmTitle(opts: LlmTitleOptions): Promise<string | null> {
  const content = (opts.content ?? '').toString();
  if (!content.trim()) return null;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;

  const timeoutMs = Math.max(500, opts.timeoutMs ?? 8_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (opts.anthropicApiKey) {
      const model = opts.anthropicModel || 'claude-haiku-4-5';
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-api-key': opts.anthropicApiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 40,
          system: TITLE_PROMPT,
          messages: [{ role: 'user', content: content.slice(0, 4_000) }],
        }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const text = json.content?.find((b) => b.type === 'text')?.text ?? '';
      const cleaned = sanitizeLlmTitle(text);
      return cleaned || null;
    }
    if (opts.openaiApiKey) {
      const model = opts.openaiModel || 'gpt-4o-mini';
      const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${opts.openaiApiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 40,
          messages: [
            { role: 'system', content: TITLE_PROMPT },
            { role: 'user', content: content.slice(0, 4_000) },
          ],
        }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = json.choices?.[0]?.message?.content ?? '';
      const cleaned = sanitizeLlmTitle(text);
      return cleaned || null;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
