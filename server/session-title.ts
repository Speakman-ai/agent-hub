/**
 * session-title.ts — derive a concise session name from user messages.
 *
 * Three layers:
 *  1. `deriveHeuristicTitle(content)` — pure, synchronous. Strips conversational
 *     filler, picks the first sentence, truncates at a word boundary, caps at
 *     60 chars. Always returns a non-empty string.
 *  2. `generateLlmTitle(opts)` — optional, async. Calls a fast model (Anthropic
 *     Haiku or OpenAI gpt-4o-mini) to produce a 4–8 word title. Returns `null`
 *     on any failure (missing key, network error, malformed response). The
 *     caller is expected to fall back to the heuristic value.
 *  3. `scheduleTitleUpgrade(opts)` — orchestrator. Glues 2 onto a session-name
 *     store with a TOCTOU guard so a concurrent rename is never clobbered.
 *
 * The heuristic exists so automatic renames happen synchronously and the
 * sidebar updates immediately. The LLM path is a deferred upgrade that fires
 * after an auto-generated heuristic title is written; if it succeeds, the
 * caller broadcasts a second `session-updated`.
 */

import { clipUtf8StringToMaxBytes } from './utf8-clip.js';

const MAX_TITLE_LEN = 60;

/**
 * Default fast model for LLM-backed title generation. Tracks the same Haiku
 * generation as the rest of the codebase (see `config.ts`
 * DEFAULT_ENGINE_VALID_MODELS['claude-code'] and `routes/claude-auth.ts`'s
 * auth ping). Bump in lockstep when those bump.
 */
export const DEFAULT_TITLE_ANTHROPIC_MODEL = 'claude-haiku-4-6';

/**
 * Default fast model for LLM-backed title generation on the OpenAI path.
 */
export const DEFAULT_TITLE_OPENAI_MODEL = 'gpt-4o-mini';

/**
 * Maximum UTF-8 byte length of the user content forwarded to the title model.
 * Plenty for a title prompt; matches typical first-message length even for
 * verbose users.
 */
const MAX_CONTENT_BYTES = 4_000;

/**
 * Maximum UTF-8 byte length of the whole-session transcript forwarded to the
 * title model when titling from session theme (multiple user messages).
 */
const MAX_TRANSCRIPT_BYTES = 6_000;

/**
 * Maximum UTF-8 byte length kept from any single message inside a transcript.
 * Keeps one verbose turn from crowding out the rest of the session.
 */
const MAX_TRANSCRIPT_MESSAGE_BYTES = 1_000;

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
  /^(?:now|just|quick(?:ly)?|maybe|perhaps)[,!?.\s:-]+/i,
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
 * Pick the initial synchronous title for a brand-new session.
 *
 * Precedence (first non-empty wins):
 *   1. `explicitTitle` — e.g. a `UserPromptSubmit` hook's `sessionTitle`.
 *   2. `linkedCardTitle` — the kanban card the session was spawned from.
 *   3. Heuristic derived from `content` via `deriveHeuristicTitle`.
 *
 * The caller persists the returned `title` and, when `usedHeuristic` is true,
 * is expected to schedule an LLM upgrade via `scheduleTitleUpgrade` for a
 * sharper version once any fast model is configured.
 */
export interface InitialSessionTitlePickInput {
  /** Raw first user message. */
  content: string;
  /** Optional explicit hint (e.g. hookSpecificOutput.sessionTitle). */
  explicitTitle?: string | null;
  /** Optional linked kanban card title. */
  linkedCardTitle?: string | null;
}

export interface InitialSessionTitlePick {
  title: string;
  /** Source of the chosen title — for logging/telemetry. */
  source: 'hint' | 'card' | 'heuristic';
  /** True when only the heuristic was applied (LLM upgrade is worthwhile). */
  usedHeuristic: boolean;
}

export function pickInitialSessionTitle(
  input: InitialSessionTitlePickInput,
): InitialSessionTitlePick {
  const explicit = (input.explicitTitle ?? '').trim();
  if (explicit) {
    return { title: explicit, source: 'hint', usedHeuristic: false };
  }
  const card = (input.linkedCardTitle ?? '').trim();
  if (card) {
    return { title: card, source: 'card', usedHeuristic: false };
  }
  return {
    title: deriveHeuristicTitle(input.content),
    source: 'heuristic',
    usedHeuristic: true,
  };
}

export interface TurnSessionTitlePickInput {
  /** Current persisted session name. */
  currentTitle?: string | null;
  /** `sessions.title_source`; null for legacy rows. */
  currentTitleSource?: string | null;
  /** Raw current user message. */
  content: string;
  /** Previous user messages, oldest first. */
  priorUserMessages?: string[];
  /** Optional explicit hint from the current turn. */
  explicitTitle?: string | null;
  /** Optional linked kanban card title. */
  linkedCardTitle?: string | null;
}

const PLACEHOLDER_SESSION_TITLE_RE =
  /^Session\s+\d{1,2}\/\d{1,2}\/\d{4},\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?$/i;

export function isPlaceholderSessionTitle(title: string | null | undefined): boolean {
  return PLACEHOLDER_SESSION_TITLE_RE.test((title ?? '').trim());
}

export function titleSourceForPick(source: InitialSessionTitlePick['source']): string {
  return source === 'heuristic' ? 'auto' : source;
}

export function shouldPersistTurnSessionTitlePick(
  pick: InitialSessionTitlePick | null,
  currentTitle: string | null | undefined,
  currentTitleSource: string | null | undefined,
): pick is InitialSessionTitlePick {
  if (!pick) return false;
  const nextTitle = pick.title.trim();
  const existingTitle = (currentTitle ?? '').trim();
  const nextSource = titleSourceForPick(pick.source);
  const existingSource = (currentTitleSource ?? '').trim();
  return nextTitle !== existingTitle || nextSource !== existingSource;
}

function isAutoTitleForPriorUserMessage(title: string, priorUserMessages: string[]): boolean {
  const current = title.trim();
  if (!current) return false;
  for (let i = priorUserMessages.length - 1; i >= 0; i -= 1) {
    const prior = priorUserMessages[i];
    if (!prior?.trim()) continue;
    if (deriveHeuristicTitle(prior) === current) return true;
  }
  return false;
}

const GENERIC_FOLLOW_UP_TITLE_RE =
  /^(?:ok(?:ay)?|continue|go on|keep going|next|fix it|do it|yes|no|yep|nope|what about .+)\??$/i;

function isGenericFollowUpTitle(title: string): boolean {
  return GENERIC_FOLLOW_UP_TITLE_RE.test(title.trim());
}

/**
 * Decide whether the current user turn should automatically rename a session.
 *
 * Manual names are never clobbered. Hook/card names stay pinned once written,
 * but the current turn may still promote an auto/legacy title to a hook/card
 * title when those sources are present. Legacy rows have no `title_source`, so
 * follow-up turns only treat titles as auto-owned when they still look like a
 * placeholder or exactly match the deterministic title derived from a previous
 * user message.
 */
export function pickTurnSessionTitle(
  input: TurnSessionTitlePickInput,
): InitialSessionTitlePick | null {
  const currentTitle = (input.currentTitle ?? '').trim();
  const currentTitleSource = (input.currentTitleSource ?? '').trim();
  const priorUserMessages = input.priorUserMessages ?? [];
  const isFirstUserMessage = priorUserMessages.length === 0;
  if (currentTitleSource && currentTitleSource !== 'auto') {
    return null;
  }
  const canAutoRename =
    currentTitleSource === 'auto' ||
    isPlaceholderSessionTitle(currentTitle) ||
    isAutoTitleForPriorUserMessage(currentTitle, priorUserMessages);
  if (!canAutoRename) return null;

  const explicit = (input.explicitTitle ?? '').trim();
  if (explicit) {
    return { title: explicit, source: 'hint', usedHeuristic: false };
  }
  const card = (input.linkedCardTitle ?? '').trim();
  if (card && currentTitle !== card) {
    return { title: card, source: 'card', usedHeuristic: false };
  }
  if (card) return { title: card, source: 'card', usedHeuristic: false };

  if (isFirstUserMessage) {
    return pickInitialSessionTitle({
      content: input.content,
      explicitTitle: input.explicitTitle,
      linkedCardTitle: input.linkedCardTitle,
    });
  }

  const heuristicTitle = deriveHeuristicTitle(input.content);
  if (heuristicTitle === currentTitle || isGenericFollowUpTitle(heuristicTitle)) return null;

  return {
    title: heuristicTitle,
    source: 'heuristic',
    usedHeuristic: true,
  };
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

/**
 * Build a compact transcript of the user's messages for whole-session theme
 * titling.
 *
 * The first message (the session anchor — usually where intent is stated) is
 * always kept; the remaining byte budget is filled with the most-recent
 * messages so the title reflects both where the session started AND where it
 * is now. Selected messages are emitted in chronological order, one per line,
 * each whitespace-collapsed and clipped on a UTF-8 codepoint boundary.
 *
 * Returns an empty string for no usable input, and a single clipped message
 * (no transcript framing) when only one message is present.
 */
export function buildTitleTranscript(userMessages: readonly string[]): string {
  const msgs = (userMessages ?? [])
    .map((m) => (typeof m === 'string' ? m : '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (msgs.length === 0) return '';
  if (msgs.length === 1) return clipUtf8StringToMaxBytes(msgs[0], MAX_CONTENT_BYTES);

  const clipped = msgs.map((m) => clipUtf8StringToMaxBytes(m, MAX_TRANSCRIPT_MESSAGE_BYTES));
  // Always keep the first message; fill the rest of the budget newest-first.
  const include = new Set<number>([0]);
  let used = Buffer.byteLength(clipped[0], 'utf-8');
  for (let i = clipped.length - 1; i >= 1; i -= 1) {
    if (include.has(i)) continue;
    const cost = Buffer.byteLength(clipped[i], 'utf-8') + 1; // +1 for the joining newline
    if (used + cost > MAX_TRANSCRIPT_BYTES) break;
    include.add(i);
    used += cost;
  }
  return [...include]
    .sort((a, b) => a - b)
    .map((i) => clipped[i])
    .join('\n');
}

// ---------------------------------------------------------------------------
// LLM-backed title generation
// ---------------------------------------------------------------------------

export interface LlmTitleOptions {
  content: string;
  /**
   * Ordered user messages for the session, oldest first (the latest turn
   * last). When 2+ messages are supplied the title is generated from the
   * whole-session theme rather than from `content` alone — this is what keeps
   * a session name from chasing whatever the latest turn happens to be about.
   * Omit (or pass 0–1 entries) to fall back to the single-message behaviour
   * using `content`.
   */
  messages?: readonly string[] | null;
  /** Anthropic API key. If both are set, Anthropic wins. */
  anthropicApiKey?: string | null;
  /** OpenAI API key. Used when no Anthropic key is set. */
  openaiApiKey?: string | null;
  /** Override the Anthropic model. Defaults to `DEFAULT_TITLE_ANTHROPIC_MODEL`. */
  anthropicModel?: string;
  /** Override the OpenAI model. Defaults to `DEFAULT_TITLE_OPENAI_MODEL`. */
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

const SESSION_TITLE_PROMPT = [
  'You generate concise session titles for a chat app.',
  "Given the user's messages from one chat session (oldest first, latest last), write a 4-to-8 word title that captures the OVERALL theme or goal of the whole session — not just the most recent message.",
  'Rules:',
  '- Output ONLY the title text. No quotes, no trailing punctuation, no preamble.',
  '- Title case is fine; sentence case is fine. No ALL CAPS.',
  '- Do not exceed 60 characters.',
  '- Capture the through-line of the session. If a later message narrows or shifts focus, prefer the dominant overall topic over any single turn.',
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
  const messages = (opts.messages ?? []).filter(
    (m): m is string => typeof m === 'string' && m.trim().length > 0,
  );
  // 2+ messages → title the whole-session theme; otherwise fall back to the
  // single-message behaviour using `messages[0]` (when present) or `content`.
  const useSessionTheme = messages.length > 1;

  let content: string;
  let systemPrompt: string;
  if (useSessionTheme) {
    // `buildTitleTranscript` already collapses whitespace and clips each
    // message + the total on UTF-8 codepoint boundaries.
    content = buildTitleTranscript(messages);
    systemPrompt = SESSION_TITLE_PROMPT;
  } else {
    const single = messages.length === 1 ? messages[0] : (opts.content ?? '').toString();
    // Byte-aware clip so a 4-byte emoji at the boundary doesn't end up as a
    // lone UTF-16 surrogate or a mojibake replacement char in the JSON body.
    content = clipUtf8StringToMaxBytes(single, MAX_CONTENT_BYTES);
    systemPrompt = TITLE_PROMPT;
  }
  if (!content.trim()) return null;

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;
  // Short-circuit before allocating the AbortController + timer when no key
  // is configured — keeps the no-op path allocation-free.
  if (!opts.anthropicApiKey && !opts.openaiApiKey) return null;

  const timeoutMs = Math.max(500, opts.timeoutMs ?? 8_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (opts.anthropicApiKey) {
      const model = opts.anthropicModel || DEFAULT_TITLE_ANTHROPIC_MODEL;
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
          system: systemPrompt,
          messages: [{ role: 'user', content }],
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
      const model = opts.openaiModel || DEFAULT_TITLE_OPENAI_MODEL;
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
            { role: 'system', content: systemPrompt },
            { role: 'user', content },
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

// ---------------------------------------------------------------------------
// scheduleTitleUpgrade — orchestrator with TOCTOU guard
// ---------------------------------------------------------------------------

export interface ScheduleTitleUpgradeOptions {
  sessionId: string;
  /** Heuristic title we already wrote synchronously. The upgrade only takes
   *  effect if `getSessionName(sessionId)` still equals this value, so a
   *  concurrent user/system rename is never clobbered. */
  heuristicTitle: string;
  /** Raw user message text — passed unmodified to `generate`. */
  content: string;
  /**
   * Ordered user messages for the session, oldest first (latest turn last).
   * Forwarded to `generate` so the upgraded title reflects the whole-session
   * theme rather than just `content`. Omit for single-message behaviour.
   */
  messages?: readonly string[] | null;
  /** API-key config snapshot. If both are null/empty, the call is a no-op. */
  config: {
    anthropicApiKey?: string | null;
    openaiApiKey?: string | null;
  };
  /** Read the session's current `name` from storage. Return null if missing. */
  getSessionName: (sessionId: string) => string | null;
  /** Read the session's current title ownership, when the caller stores it. */
  getSessionTitleSource?: (sessionId: string) => string | null;
  /** Persist the new title only if the current title still matches. */
  updateSessionName: (title: string, sessionId: string, expectedCurrentTitle: string) => boolean;
  /** Called after a successful rename; the caller broadcasts `session-updated`. */
  onUpgrade: (newTitle: string) => void;
  /** Generator override for tests. Defaults to `generateLlmTitle`. */
  generate?: (opts: LlmTitleOptions) => Promise<string | null>;
}

/**
 * Run the async title-upgrade flow. Never throws. Resolves to `true` when a
 * rename actually happened, `false` otherwise (no key, no upgrade, TOCTOU
 * miss, identical title, generator failure).
 *
 * The chat.ts caller does `void scheduleTitleUpgrade(...)`; the return value
 * exists for tests so they can await completion.
 */
export async function scheduleTitleUpgrade(opts: ScheduleTitleUpgradeOptions): Promise<boolean> {
  const hasKey = Boolean(opts.config.anthropicApiKey || opts.config.openaiApiKey);
  if (!hasKey) return false;
  const generate = opts.generate ?? generateLlmTitle;
  try {
    const llmTitle = await generate({
      content: opts.content,
      messages: opts.messages ?? null,
      anthropicApiKey: opts.config.anthropicApiKey ?? null,
      openaiApiKey: opts.config.openaiApiKey ?? null,
    });
    if (!llmTitle || llmTitle === opts.heuristicTitle) return false;
    const currentName = opts.getSessionName(opts.sessionId);
    if (currentName !== opts.heuristicTitle) return false;
    if (opts.getSessionTitleSource && opts.getSessionTitleSource(opts.sessionId) !== 'auto') {
      return false;
    }
    const updated = opts.updateSessionName(llmTitle, opts.sessionId, opts.heuristicTitle);
    if (!updated) return false;
    opts.onUpgrade(llmTitle);
    return true;
  } catch {
    return false;
  }
}
